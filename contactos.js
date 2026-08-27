// contactos.js — fuente de verdad de los contactos (Postgres) + clasificación con Haiku
// Sobrevive a un baneo de WhatsApp: los datos no viven en el celular.

import * as sheets from './sheets.js';

const MODELO = 'claude-3-5-haiku-20241022';

export const ESTADOS = [
  'nuevo',          // escribió por primera vez
  'interesado',     // preguntó precio / servicio
  'consultando',    // ida y vuelta, sin definir
  'esperando_pago', // dijo que iba a pagar
  'pago',           // mandó comprobante válido
  'sin_respuesta',  // escribió y no siguió
  'spam',
];

// ---------- schema ----------

export async function initSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contactos (
      id          SERIAL PRIMARY KEY,
      nro         INTEGER UNIQUE,
      telefono    TEXT UNIQUE NOT NULL,
      nombre      TEXT DEFAULT '',
      estado      TEXT DEFAULT 'nuevo',
      notas       TEXT DEFAULT '',
      sheet_row   INTEGER,
      origen      TEXT DEFAULT 'directo',
      primer_msg  TIMESTAMPTZ DEFAULT NOW(),
      ultimo_msg  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // para bases que ya existían sin la columna
  await pool.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'directo';`);

  // nro secuencial propio, independiente del id interno
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS contactos_nro_seq OWNED BY contactos.nro;
  `);
  await pool.query(`
    ALTER TABLE contactos ALTER COLUMN nro SET DEFAULT nextval('contactos_nro_seq');
  `);
  console.log('[contactos] schema listo');
}

// ---------- clasificación ----------

const PROMPT = `Sos un asistente que clasifica mensajes de WhatsApp entrantes de clientes.

Estados posibles: ${ESTADOS.join(', ')}

Devolvé SOLO un JSON válido, sin markdown ni explicación:
{"estado": "<uno de los estados>", "nota": "<resumen en menos de 12 palabras, en español>"}

Reglas:
- "nuevo" solo si es un saludo sin contenido.
- "interesado" si pregunta precio, disponibilidad o qué incluye.
- "esperando_pago" si dice que va a transferir o pide datos de pago.
- "pago" solo si menciona que YA pagó o mandó comprobante.
- "spam" si es promoción, cadena o mensaje automático.
- La nota describe lo que el cliente quiere, no lo que vos harías.`;

/**
 * Clasifica un mensaje. Barato (Haiku, ~60 tokens de salida).
 * Si falla, devuelve un fallback y no rompe nada.
 */
export async function clasificar(texto, apiKey) {
  if (!texto || !apiKey) return { estado: 'nuevo', nota: '' };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 100,
        system: PROMPT,
        messages: [{ role: 'user', content: texto.slice(0, 1500) }],
      }),
    });

    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '';
    const json = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());

    return {
      estado: ESTADOS.includes(json.estado) ? json.estado : 'nuevo',
      nota: String(json.nota || '').slice(0, 120),
    };
  } catch (e) {
    console.error('[contactos] clasificar falló:', e.message);
    return { estado: 'nuevo', nota: '' };
  }
}

// ---------- upsert ----------

const hoy = () =>
  new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });

/** Acumula notas en vez de pisarlas: lo que Axel escriba a mano sobrevive. */
function agregarNota(previas, nota) {
  if (!nota) return previas || '';
  const linea = `${hoy()}: ${nota}`;
    if ((previas || '').includes(nota)) return previas; // no repetir
  return previas ? `${previas}\n${linea}` : linea;
}

/**
 * Registra o actualiza un contacto y sincroniza la fila del Sheet.
 * Llamalo desde el webhook por cada mensaje entrante.
 */
export async function registrarContacto(pool, { telefono, nombre, texto, apiKey, origen = 'directo' }) {
  if (!telefono) return null;

  const { rows: existentes } = await pool.query(
    'SELECT * FROM contactos WHERE telefono = $1',
    [telefono]
  );
  const previo = existentes[0] || null;

  // no gastamos en clasificar si ya está marcado como pago o spam
  const saltear = previo && ['pago', 'spam'].includes(previo.estado);
  const { estado, nota } = saltear
    ? { estado: previo.estado, nota: '' }
    : await clasificar(texto, apiKey);

  const notas = agregarNota(previo?.notas, nota);

  const { rows } = await pool.query(
    `INSERT INTO contactos (telefono, nombre, estado, notas, origen)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telefono) DO UPDATE SET
       nombre     = COALESCE(NULLIF(EXCLUDED.nombre, ''), contactos.nombre),
       estado     = EXCLUDED.estado,
       notas      = EXCLUDED.notas,
       -- si alguna vez vino de la landing, ese origen no se pisa nunca
       origen     = CASE WHEN contactos.origen = 'landing' THEN 'landing' ELSE EXCLUDED.origen END,
       ultimo_msg = NOW()
     RETURNING *`,
    [telefono, nombre || '', estado, notas, origen]
  );

  const c = rows[0];

  // espejo en el Sheet — nunca bloquea el webhook
  if (c.sheet_row) {
    await sheets.safe('update', () => sheets.updateContacto(c.sheet_row, c));
  } else {
    const row = await sheets.safe('append', () => sheets.appendContacto(c));
    if (row) {
      await pool.query('UPDATE contactos SET sheet_row = $1 WHERE id = $2', [row, c.id]);
      c.sheet_row = row;
    }
  }

  return c;
}

/** Marca un contacto como pago (llamalo cuando el comprobante se valida). */
export async function marcarPago(pool, telefono, { monto, moneda } = {}) {
  const nota = monto ? `pagó ${moneda || 'ARS'} ${monto}` : 'pago confirmado';
  const { rows } = await pool.query(
    `UPDATE contactos
     SET estado = 'pago',
         -- sin salto de línea inicial cuando la ficha todavía no tenía notas
         notas = CASE WHEN COALESCE(notas, '') = '' THEN $2 ELSE notas || chr(10) || $2 END,
         ultimo_msg = NOW()
     WHERE telefono = $1 RETURNING *`,
    [telefono, `${hoy()}: ${nota}`]
  );
  const c = rows[0];
  if (c) await sheets.safe('update-pago', () => sheets.updateContacto(c.sheet_row, c));
  return c || null;
}

export async function listar(pool) {
  const { rows } = await pool.query('SELECT * FROM contactos ORDER BY nro ASC');
  return rows;
}

/** Reconstruye el Sheet completo desde la DB. Para /api/contactos/resync */
export async function resync(pool) {
  const contactos = await listar(pool);
  await sheets.safe('ensure-headers', () => sheets.ensureHeaders());
  const n = await sheets.safe('rebuild', () => sheets.rebuild(contactos));
  if (n === null) return { ok: false, error: 'Sheets no disponible' };

  // reasignar sheet_row: header = fila 1, primer contacto = fila 2
  for (let i = 0; i < contactos.length; i++) {
    await pool.query('UPDATE contactos SET sheet_row = $1 WHERE id = $2', [
      i + 2,
      contactos[i].id,
    ]);
  }
  return { ok: true, contactos: n };
}
