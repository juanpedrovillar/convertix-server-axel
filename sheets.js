// sheets.js — espejo de contactos en Google Sheets vía Apps Script
//
// La fuente de verdad es Postgres. Esto es una vista para Axel.
// Nunca tira una excepción hacia arriba: si Google falla, el server sigue.
//
// Requiere en Railway:
//   GOOGLE_SCRIPT_URL    = https://script.google.com/macros/s/.../exec
//   GOOGLE_SCRIPT_TOKEN  = el mismo TOKEN que está en el .gs

const URL = process.env.GOOGLE_SCRIPT_URL;
const TOKEN = process.env.GOOGLE_SCRIPT_TOKEN;

export const HEADERS = ['Nº cliente', 'Teléfono', 'Nombre', 'Estado', 'Notas'];

export function sheetsEnabled() {
  return Boolean(URL && TOKEN);
}

/**
 * Llama al Apps Script.
 * Apps Script responde 302 hacia googleusercontent; el POST ya se ejecutó
 * antes del redirect, así que seguirlo con GET es correcto y devuelve el JSON.
 */
async function call(action, payload = {}, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita el preflight de Apps Script
      body: JSON.stringify({ token: TOKEN, action, ...payload }),
      redirect: 'follow',
      signal: ctrl.signal,
    });

    const texto = await res.text();

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${texto.slice(0, 200)}`);

    let data;
    try {
      data = JSON.parse(texto);
    } catch {
      // Casi siempre significa que el deploy quedó como "solo yo" y Google
      // devolvió el HTML del login en vez del JSON.
      throw new Error(
        'respuesta no-JSON (revisá que el deploy esté como "Cualquier persona")'
      );
    }

    if (!data.ok) throw new Error(data.error || 'error desconocido');
    return data;
  } finally {
    clearTimeout(t);
  }
}

// ---------- operaciones ----------

/** Chequeo de vida. Devuelve cuántos contactos hay en la hoja. */
export async function ping() {
  return call('ping');
}

/** El .gs crea la pestaña y los encabezados solo. Queda por compatibilidad. */
export async function ensureHeaders() {
  await call('ping');
  return true;
}

/** Agrega un contacto al final. Devuelve el número de fila para actualizarlo después. */
export async function appendContacto(c) {
  const r = await call('append', { contacto: normalizar(c) });
  return r.row || null;
}

/** Reescribe una fila existente. */
export async function updateContacto(rowNumber, c) {
  if (!rowNumber) return false;
  await call('update', { row: rowNumber, contacto: normalizar(c) });
  return true;
}

/** Reconstruye la hoja entera desde la DB. Para cuando el Sheet se desincroniza. */
export async function rebuild(contactos) {
  const r = await call('rebuild', { contactos: contactos.map(normalizar) });
  return r.contactos;
}

/** Lee la hoja, incluidas las ediciones manuales de Axel. */
export async function leerEdiciones() {
  const r = await call('read');
  return r.filas || [];
}

function normalizar(c) {
  return {
    nro: c.nro ?? '',
    telefono: c.telefono || '',
    nombre: c.nombre || '',
    estado: c.estado || '',
    notas: c.notas || '',
  };
}

// ---------- wrapper tolerante a fallos ----------

/**
 * Envolvé toda llamada desde server.js con esto.
 * Loguea y devuelve null en vez de romper el webhook.
 */
export async function safe(label, fn) {
  if (!sheetsEnabled()) return null;
  try {
    return await fn();
  } catch (e) {
    console.error(`[sheets] ${label} falló:`, e.message);
    return null;
  }
}
