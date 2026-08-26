import express from 'express';
import fetch from 'node-fetch';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import pg from 'pg';
import * as contactos from './contactos.js';
import { buildXlsx } from './excel.js';

const { Pool } = pg;

function sha256(str) {
  return createHash('sha256').update((str||'').toLowerCase().trim()).digest('hex');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Cargar .env si existe ──────────────────────────────────────────────────
if (existsSync('.env')) {
  const lines = readFileSync('.env', 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

function landingPorInstancia(porDefecto = 'landing.html') {
  const inst = process.env.EVOLUTION_INSTANCE || '';
  const propia = `${inst}_landing.html`;
  try {
    if (inst && existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), propia))) return propia;
  } catch {}
  return porDefecto;
}

const CONFIG = {
  EVOLUTION_URL:      process.env.EVOLUTION_URL      || 'https://evolution-api-production-c34d.up.railway.app',
  EVOLUTION_APIKEY:   process.env.EVOLUTION_APIKEY   || 'convertix123',
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || 'axel',
  ANTHROPIC_KEY:      process.env.ANTHROPIC_API_KEY,
  META_PIXEL_ID:      process.env.META_PIXEL_ID      || '1773629100730813',
  META_CAPI_TOKEN:    process.env.META_CAPI_TOKEN,
  META_TEST_CODE:     process.env.META_TEST_CODE      || '',
  DATABASE_URL:       process.env.DATABASE_URL,

  // ── Identidad del cliente ────────────────────────────────────────────────
  // Nada de nombres de clientes hardcodeados: cada Railway define quién es.
  // Si no está seteada, busca "<instancia>_landing.html" y si no existe usa la genérica.
  // Sigue sin haber nombres de clientes en el código.
  CLIENT_LANDING:     process.env.CLIENT_LANDING     || landingPorInstancia('axel_landing.html'),
  // KEYWORD_LANDING es el nombre que ya existía en Railway; se respeta por compatibilidad.
  CLIENT_KEYWORD:     process.env.CLIENT_KEYWORD || process.env.KEYWORD_LANDING || 'necesito tu ayuda',
  CLIENT_NAME:        process.env.CLIENT_NAME        || 'Axel',
  // Datos del cliente que antes estaban escritos a mano en medio del código.
  CLIENT_SITE_URL:    process.env.CLIENT_SITE_URL    || 'https://convertix-server-production.up.railway.app',
  CLIENT_WPP_NUMBER:  process.env.CLIENT_WPP_NUMBER  || '543518769844',
  CLIENT_WPP_MSG:     process.env.CLIENT_WPP_MSG     || 'Hola Axel, necesito tu ayuda...',
};

// ── Postgres ───────────────────────────────────────────────────────────────
let pool = null;
if (CONFIG.DATABASE_URL) {
  pool = new Pool({ connectionString: CONFIG.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  contactos.initSchema(pool).catch(e => console.error('[contactos] initSchema:', e.message));
  pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGINT PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      tipo TEXT NOT NULL,
      msg TEXT,
      data JSONB
    )
  `).catch(e => console.error('Error creando tabla events:', e.message));
  pool.query(`
    CREATE TABLE IF NOT EXISTS landing_phones (
      phone TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.error('Error creando tabla landing_phones:', e.message));
}

// ── Sesiones de click para correlacionar con Purchase CAPI ────────────────
// Guarda los últimos clicks con sus datos de browser (fbc, fbp, ip, ua)
// para usarlos en el evento Purchase cuando llega el comprobante por WPP
const recentClicks = []; // [{ fbc, fbp, ip, ua, ts, ref }]
const landingPhones = new Set(); // teléfonos que iniciaron desde la landing (keyword)

// ── Log en memoria (cache) + Postgres ─────────────────────────────────────
let events = [];

async function cargarEventosIniciales() {
  if (!pool) return;
  try {
    // Cargar últimos 500 eventos recientes + TODAS las TRANSFERENCIAS y MENSAJES (pueden ser más antiguas)
    const [{ rows: recientes }, { rows: transfers }, { rows: mensajes }] = await Promise.all([
      pool.query('SELECT * FROM events ORDER BY ts DESC LIMIT 500'),
      pool.query("SELECT * FROM events WHERE tipo = 'TRANSFERENCIA' ORDER BY ts DESC"),
      pool.query("SELECT * FROM events WHERE tipo = 'MENSAJE' ORDER BY ts DESC")
    ]);
    // Merge y deduplicar por id
    const seen = new Set();
    const allRows = [...recientes, ...transfers, ...mensajes].filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }).sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    events = allRows.map(r => ({ id: r.id, ts: r.ts, tipo: r.tipo, msg: r.msg, ...r.data }));
    // Repoblar landingPhones desde tabla dedicada
    const { rows: phones } = await pool.query('SELECT phone FROM landing_phones');
    phones.forEach(r => landingPhones.add(r.phone.split('@')[0]));
    // También desde MENSAJE events como fallback
    mensajes.forEach(r => { if (r.data?.phone) landingPhones.add(r.data.phone.split('@')[0]); });
    console.log(`[DB] Cargados ${events.length} eventos (${transfers.length} transferencias, ${mensajes.length} mensajes), ${landingPhones.size} landing phones`);
  } catch (e) {
    console.error('Error cargando eventos:', e.message);
  }
}

async function guardarEvento(evento) {
  events.unshift(evento);
  if (events.length > 600) {
    const importantes = events.filter(e => e.tipo === 'TRANSFERENCIA' || e.tipo === 'MENSAJE');
    const recientes = events.filter(e => e.tipo !== 'TRANSFERENCIA' && e.tipo !== 'MENSAJE').slice(0, 500);
    events = [...importantes, ...recientes].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }
  broadcast(JSON.stringify({ type: 'new_event', data: evento }));
  if (pool) {
    const { id, ts, tipo, msg, ...data } = evento;
    pool.query(
      'INSERT INTO events (id, ts, tipo, msg, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
      [id, ts, tipo, msg, data]
    ).catch(e => console.error('Error guardando evento:', e.message));
  }
}

function logEntry(tipo, msg, extra = {}) {
  const entry = { id: Date.now(), ts: new Date().toISOString(), tipo, msg, ...extra };
  console.log(`[${entry.ts}] [${tipo}] ${msg}`);
  guardarEvento(entry);
  return entry;
}

// ── WebSocket para tiempo real ─────────────────────────────────────────────
const app = express();

// CORS — permite conexiones desde file:// y cualquier origen local
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname, {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(jpg|jpeg|webp|png|gif|ico|svg)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
}));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', ws => {
  // Al conectar, enviar los últimos 50 eventos
  ws.send(JSON.stringify({ type: 'history', data: events.slice(0, 50) }));
});

// ── Landing page ───────────────────────────────────────────────────────────
app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, CONFIG.CLIENT_LANDING));
});

// ── API endpoints ──────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    service: 'Evolution Conversion',
    version: '2.0.0',
    instance: CONFIG.EVOLUTION_INSTANCE,
    landing: CONFIG.CLIENT_LANDING,
    keyword: CONFIG.CLIENT_KEYWORD,
    pixel: CONFIG.META_PIXEL_ID,
    anthropic_key: CONFIG.ANTHROPIC_KEY ? '✅ cargada' : '❌ falta',
    meta_token: CONFIG.META_CAPI_TOKEN ? '✅ cargado' : '❌ falta',
    test_mode: !!CONFIG.META_TEST_CODE,
    uptime_s: Math.floor(process.uptime()),
    total_events: events.length,
    transferencias: events.filter(e => e.tipo === 'TRANSFERENCIA').length,
  });
});

app.get('/api/wa-status', (req, res) => {
  res.json(waStatus);
});

// Endpoint de diagnóstico: muestra los phones registrados en landingPhones
app.get('/api/debug-phones', (req, res) => {
  res.json({ count: landingPhones.size, phones: [...landingPhones] });
});

app.get('/api/events', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  if (pool) {
    try {
      const [{ rows: recientes }, { rows: transfers }] = await Promise.all([
        pool.query('SELECT * FROM events ORDER BY ts DESC LIMIT $1', [limit]),
        pool.query("SELECT * FROM events WHERE tipo IN ('TRANSFERENCIA','MENSAJE') ORDER BY ts DESC")
      ]);
      const seen = new Set();
      const merged = [...recientes, ...transfers].filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      }).sort((a, b) => (a.ts < b.ts ? 1 : -1));
      return res.json(merged.map(r => ({ id: r.id, ts: r.ts, tipo: r.tipo, msg: r.msg, ...r.data })));
    } catch (e) {
      console.error('Error leyendo eventos:', e.message);
    }
  }
  res.json(events.slice(0, limit));
});

app.delete('/api/events', async (req, res) => {
  events = [];
  if (pool) {
    try { await pool.query('DELETE FROM events'); } catch {}
  }
  broadcast(JSON.stringify({ type: 'cleared' }));
  res.json({ ok: true });
});

// ── TRACK — Landing page visits & clicks ──────────────────────────────────
app.post('/api/track', (req, res) => {
  const { type, ref, page, fbclid, fbp } = req.body;

  // IP real (Railway pasa x-forwarded-for)
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ua = req.headers['user-agent'] || '';
  // Construir fbc según spec de Meta: fb.1.{timestamp}.{fbclid}
  const fbc = fbclid ? `fb.1.${Date.now()}.${fbclid}` : null;

  const browserData = { ip, ua, fbc, fbp: fbp || null };

  if (type === 'visit') {
    logEntry('VISITA', `Visita a landing${ref ? ` — ref: ${ref}` : ''}`, { ref: ref || 'organico', page });
    dispararMetaCAPILanding('PageView', ref, browserData);
  } else if (type === 'click') {
    // Guardar sesión de click para correlacionar con el Purchase futuro
    recentClicks.unshift({ ...browserData, ref: ref || 'organico', ts: Date.now() });
    if (recentClicks.length > 100) recentClicks.pop();
    logEntry('CLICK', `Click al botón WPP${ref ? ` — ref: ${ref}` : ''}`, { ref: ref || 'organico', page, fbc: fbc || undefined });
    dispararMetaCAPILanding('Lead', ref, browserData);
  } else if (type === 'view_content') {
    logEntry('VIEW_CONTENT', `Scroll profundo${ref ? ` — ref: ${ref}` : ''}`, { ref: ref || 'organico', page });
    dispararMetaCAPILanding('ViewContent', ref, browserData);
  } else if (type === 'time_on_page') {
    logEntry('TIME_ON_PAGE', `30s en landing${ref ? ` — ref: ${ref}` : ''}`, { ref: ref || 'organico', page });
  }
  res.json({ ok: true });
});

// ── WPP REDIRECT — Captura sesión completa y redirige a WhatsApp ──────────
// El botón WPP apunta acá en vez de a wa.me directo.
// Ventaja: IP y UA son del browser real (no del fetch async), y el redirect
// ocurre solo después de que el servidor guardó la sesión.
app.get('/api/wpp-redirect', (req, res) => {
  const { ref, fbclid, fbp, number, msg } = req.query;

  const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ua  = req.headers['user-agent'] || '';
  const fbc = fbclid ? `fb.1.${Date.now()}.${fbclid}` : null;

  const session = { ip, ua, fbc, fbp: fbp || null, ref: ref || 'organico', ts: Date.now() };
  recentClicks.unshift(session);
  if (recentClicks.length > 100) recentClicks.pop();

  logEntry('CLICK', `Click WPP desde landing — ref: ${ref || 'organico'}`, {
    ref: ref || 'organico', fbc: fbc || undefined, ip
  });
  dispararMetaCAPILanding('Lead', ref, { ip, ua, fbc, fbp: fbp || null });

  const wppNumber = number || CONFIG.CLIENT_WPP_NUMBER;
  const wppMsg    = msg || CONFIG.CLIENT_WPP_MSG;
  res.redirect(302, `https://wa.me/${wppNumber}?text=${encodeURIComponent(wppMsg)}`);
});

// ── QR — Obtener QR de Evolution API ──────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  try {
    // Si la instancia está cerrada, hacer restart antes de pedir el QR
    const statusR = await fetch(
      `${CONFIG.EVOLUTION_URL}/instance/fetchInstances`,
      { headers: { 'apikey': CONFIG.EVOLUTION_APIKEY } }
    );
    const statusData = await statusR.json();
    const list = Array.isArray(statusData) ? statusData : [statusData];
    const inst = list.find(i =>
      i.instance?.name === CONFIG.EVOLUTION_INSTANCE ||
      i.name           === CONFIG.EVOLUTION_INSTANCE
    );
    const connStatus = inst?.connectionStatus || inst?.instance?.connectionStatus || '';
    const disconnCode = inst?.disconnectionReasonCode || inst?.instance?.disconnectionReasonCode;
    // Si tiene código 401 (logout), hacer logout real para forzar nuevo QR
    if (disconnCode === 401 || connStatus === 'close' || connStatus === '') {
      await fetch(
        `${CONFIG.EVOLUTION_URL}/instance/logout/${CONFIG.EVOLUTION_INSTANCE}`,
        { method: 'DELETE', headers: { 'apikey': CONFIG.EVOLUTION_APIKEY } }
      );
      await new Promise(r => setTimeout(r, 2000));
    }

    const r = await fetch(
      `${CONFIG.EVOLUTION_URL}/instance/connect/${CONFIG.EVOLUTION_INSTANCE}`,
      { headers: { 'apikey': CONFIG.EVOLUTION_APIKEY } }
    );
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INSTANCE STATUS ────────────────────────────────────────────────────────
app.get('/api/instance-status', async (req, res) => {
  try {
    const r = await fetch(
      `${CONFIG.EVOLUTION_URL}/instance/fetchInstances`,
      { headers: { 'apikey': CONFIG.EVOLUTION_APIKEY } }
    );
    const data = await r.json();
    const list = Array.isArray(data) ? data : [data];
    const inst = list.find(i =>
      i.instance?.instanceName === CONFIG.EVOLUTION_INSTANCE ||
      i.instance?.name         === CONFIG.EVOLUTION_INSTANCE ||
      i.instanceName           === CONFIG.EVOLUTION_INSTANCE ||
      i.name                   === CONFIG.EVOLUTION_INSTANCE
    );
    if (!inst) return res.json({ connected: false, status: 'unknown' });
    const raw = inst.instance?.connectionStatus || inst.connectionStatus || 'unknown';
    const ownerJid = inst.instance?.ownerJid || inst.ownerJid || '';
    const number = ownerJid.replace('@s.whatsapp.net', '').replace('@g.us', '') || null;
    const profileName = inst.instance?.profileName || inst.profileName || null;
    res.json({ connected: raw === 'open', status: raw, number, profileName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DESCONECTAR INSTANCIA WhatsApp ────────────────────────────────────────
app.post('/api/instance-disconnect', async (req, res) => {
  try {
    const r = await fetch(
      `${CONFIG.EVOLUTION_URL}/instance/logout/${CONFIG.EVOLUTION_INSTANCE}`,
      { method: 'DELETE', headers: { 'apikey': CONFIG.EVOLUTION_APIKEY } }
    );
    const data = await r.json();
    logEntry('INFO', `WhatsApp desconectado manualmente`);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONFIGURAR WEBHOOK en Evolution API ───────────────────────────────────
app.post('/api/set-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Se requiere url' });
  try {
    const r = await fetch(
      `${CONFIG.EVOLUTION_URL}/webhook/set/${CONFIG.EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: { 'apikey': CONFIG.EVOLUTION_APIKEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhook: {
            enabled: true,
            url: `${url}/webhook`,
            webhookByEvents: false,
            webhookBase64: true,
            events: ['MESSAGES_UPSERT'],
          }
        })
      }
    );
    const data = await r.json();
    logEntry('INFO', `Webhook configurado → ${url}/webhook`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WEBHOOK — Evolution API ────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const { event, data } = req.body;
    if (event !== 'messages.upsert') return;
    if (data?.key?.fromMe) return;
    if (!data?.message) return;

    const messageType = data.messageType;
    const phone = data.key.remoteJid.split('@')[0];
    const name  = data.pushName || 'Desconocido';

    // Detectar chats iniciados desde la landing (mensaje pre-llenado del botón WPP)
    const textMsg = data.message?.conversation || data.message?.extendedTextMessage?.text || '';
    if (matchKeyword(textMsg, CONFIG.CLIENT_KEYWORD)) {
      landingPhones.add(phone);
      if (pool) pool.query('INSERT INTO landing_phones (phone) VALUES ($1) ON CONFLICT DO NOTHING', [phone]).catch(() => {});
      logEntry('MENSAJE', `Chat desde landing — ${name} (${phone})`, { phone, name });
      registrarContactoSeguro(phone, name, textMsg);
      // Señal CAPI: Contact (mensaje recibido = interés real)
      dispararMetaCAPILanding('Contact', 'organico', { ph: phone });
      return;
    }

    // Solo procesar comprobantes de clientes que iniciaron desde la landing
    if (!landingPhones.has(phone)) return;

    // Cada mensaje actualiza la ficha del contacto (no bloquea el flujo)
    if (textMsg) registrarContactoSeguro(phone, name, textMsg);

    // Solo procesar imágenes y documentos (comprobantes reales).
    let resultado;
    if (messageType === 'imageMessage') {
      resultado = await analizarImagen(data);
    } else if (messageType === 'documentMessage' || messageType === 'documentWithCaptionMessage') {
      resultado = await analizarDocumento(data);
    } else {
      return; // texto sin keyword → ignorar silenciosamente
    }

    if (!resultado) return;

    if (resultado.es_transferencia && resultado.monto) {
      const USD_TO_ARS = 1510;
      const montoDisplay = resultado.moneda === 'USD' ? Math.round(resultado.monto * USD_TO_ARS) : resultado.monto;
      const monedaDisplay = resultado.moneda === 'USD' ? 'ARS' : (resultado.moneda || 'ARS');
      logEntry('TRANSFERENCIA', `${resultado.nombre_emisor || name} → $${montoDisplay} ${monedaDisplay}`, {
        phone, name, ...resultado, monto: montoDisplay, moneda: monedaDisplay,
      });
      await dispararMetaCAPI({ phone, name, ...resultado });
      if (pool) {
        contactos.marcarPago(pool, phone, { monto: montoDisplay, moneda: monedaDisplay })
          .catch(e => console.error('[contactos] marcarPago:', e.message));
      }
    } else {
      logEntry('NO_TRANSFERENCIA', `Mensaje de ${name} descartado`, { phone });
    }

  } catch (err) {
    logEntry('ERROR', err.message);
  }
});

// ── IMAGEN — Claude Vision ─────────────────────────────────────────────────
async function llamarClaude(payload, intento = 1) {
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CONFIG.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const claudeData = await claudeRes.json();
  if (!claudeData.content && intento < 3) {
    logEntry('WARN', `Anthropic sin respuesta (intento ${intento}), reintentando en 3s...`, { error: claudeData.error?.message });
    await new Promise(r => setTimeout(r, 3000));
    return llamarClaude(payload, intento + 1);
  }
  return claudeData;
}

async function analizarImagen(data) {
  try {
    let mediaData;
    try {
      const mediaRes = await fetch(
        `${CONFIG.EVOLUTION_URL}/chat/getBase64FromMediaMessage/${CONFIG.EVOLUTION_INSTANCE}`,
        {
          method: 'POST',
          headers: { 'apikey': CONFIG.EVOLUTION_APIKEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              key: data.key,
              message: { imageMessage: data.message.imageMessage },
              messageType: 'imageMessage',
            },
          }),
        }
      );
      mediaData = await mediaRes.json();
    } catch (fetchErr) {
      logEntry('ERROR', `Fallo al descargar imagen de Evolution API: ${fetchErr.message}`, { remoteJid: data.key?.remoteJid });
      return null;
    }

    if (!mediaData.base64) {
      logEntry('ERROR', `Evolution API no devolvió base64 para imagen`, { respuesta: JSON.stringify(mediaData).slice(0, 200), remoteJid: data.key?.remoteJid });
      return null;
    }

    const imageData = mediaData.base64.split(',')[1] || mediaData.base64;

    const claudeData = await llamarClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaData.mimetype || 'image/jpeg', data: imageData } },
          { type: 'text', text: 'Analizá este comprobante de pago. Puede ser:\n1) Transferencia bancaria argentina\n2) Pago de PayPal — reconocés esto por frases como "Has enviado", "Ha enviado", "Usted envió", "Le diremos", "Le avisaremos", "Dinero enviado", o por el logo/dominio de PayPal + un monto en USD.\n¿Es un pago completado? Identificá el monto (convertí comas decimales a punto, ej: 40,00 → 40) y moneda (ARS o USD), el nombre del emisor y el receptor.\nRespondé SOLO con JSON válido sin markdown.\nFormato: {"es_transferencia": true o false, "monto": número o null, "moneda": "ARS" o "USD" o null, "nombre_emisor": string o null, "nombre_receptor": string o null}' },
        ],
      }],
    });

    if (!claudeData.content?.[0]?.text) {
      logEntry('ERROR', `Anthropic no devolvió texto tras reintentos`, { claudeError: claudeData.error?.message, remoteJid: data.key?.remoteJid });
      return null;
    }

    const resultado = parsearJSON(claudeData.content[0].text);
    if (resultado && resultado.es_transferencia) {
      resultado.imagen_base64 = `data:${mediaData.mimetype || 'image/jpeg'};base64,${imageData}`;
    }
    return resultado;
  } catch (err) {
    logEntry('ERROR', `analizarImagen excepción: ${err.message}`, { remoteJid: data.key?.remoteJid });
    return null;
  }
}

// ── DOCUMENTO (PDF) — Claude Vision ───────────────────────────────────────
async function analizarDocumento(data) {
  try {
    let mediaData;
    try {
      const mediaRes = await fetch(
        `${CONFIG.EVOLUTION_URL}/chat/getBase64FromMediaMessage/${CONFIG.EVOLUTION_INSTANCE}`,
        {
          method: 'POST',
          headers: { 'apikey': CONFIG.EVOLUTION_APIKEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              key: data.key,
              message: { documentMessage: data.message.documentMessage },
              messageType: 'documentMessage',
            },
          }),
        }
      );
      mediaData = await mediaRes.json();
    } catch (fetchErr) {
      logEntry('ERROR', `Fallo al descargar documento de Evolution API: ${fetchErr.message}`, { remoteJid: data.key?.remoteJid });
      return null;
    }

    if (!mediaData.base64) {
      logEntry('ERROR', `Evolution API no devolvió base64 para documento`, { respuesta: JSON.stringify(mediaData).slice(0, 200), remoteJid: data.key?.remoteJid });
      return null;
    }

    const docData = mediaData.base64.split(',')[1] || mediaData.base64;
    const mimeType = mediaData.mimetype || 'application/pdf';

    const claudeData = await llamarClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: mimeType, data: docData } },
          { type: 'text', text: 'Analizá este comprobante de pago. Puede ser:\n1) Transferencia bancaria argentina\n2) Pago de PayPal — reconocés esto por frases como "Has enviado", "Ha enviado", "Usted envió", "Le diremos", "Le avisaremos", "Dinero enviado", o por el logo/dominio de PayPal + un monto en USD.\n¿Es un pago completado? Identificá el monto (convertí comas decimales a punto, ej: 40,00 → 40) y moneda (ARS o USD), el nombre del emisor y el receptor.\nRespondé SOLO con JSON válido sin markdown.\nFormato: {"es_transferencia": true o false, "monto": número o null, "moneda": "ARS" o "USD" o null, "nombre_emisor": string o null, "nombre_receptor": string o null}' },
        ],
      }],
    });

    if (!claudeData.content?.[0]?.text) {
      logEntry('ERROR', `Anthropic no devolvió texto (doc) tras reintentos`, { claudeError: claudeData.error?.message, remoteJid: data.key?.remoteJid });
      return null;
    }

    const resultado = parsearJSON(claudeData.content[0].text);
    return resultado;
  } catch (err) {
    logEntry('ERROR', `analizarDocumento excepción: ${err.message}`, { remoteJid: data.key?.remoteJid });
    return null;
  }
}

// ── META CAPI — Landing events (PageView, Lead, ViewContent) ───────────────
async function dispararMetaCAPILanding(eventName, ref, browserData = {}) {
  if (!CONFIG.META_CAPI_TOKEN) return;
  const { ip, ua, fbc, fbp, ph } = browserData;
  const user_data = {};
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;
  if (fbc) user_data.fbc = fbc;
  if (fbp) user_data.fbp = fbp;
  if (ph) user_data.ph = sha256(ph); // teléfono hasheado para mejor matching

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: `${CONFIG.CLIENT_SITE_URL}/landing`,
      user_data,
      custom_data: { ref: ref || 'organico', page: 'landing' },
    }],
  };
  if (CONFIG.META_TEST_CODE) payload.test_event_code = CONFIG.META_TEST_CODE;
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${CONFIG.META_PIXEL_ID}/events?access_token=${CONFIG.META_CAPI_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const result = await r.json();
    if (result.error) logEntry('ERROR_CAPI', `CAPI landing ${eventName}: ${result.error.message}`);
    else logEntry('CAPI_OK', `CAPI landing → ${eventName}`, { ref });
  } catch (e) {
    logEntry('ERROR_CAPI', `CAPI landing ${eventName} excepción: ${e.message}`);
  }
}

// ── META CONVERSIONS API ───────────────────────────────────────────────────
async function dispararMetaCAPI({ phone, name, nombre_emisor, monto, moneda }) {
  const nombreLimpio = nombre_emisor || name || '';
  const partes = nombreLimpio.trim().split(/\s+/);
  const fn = partes[0] || '';
  const ln = partes.slice(1).join(' ') || '';
  const phoneClean = (phone || '').replace(/\D/g, '');

  // Argentina: WhatsApp agrega "9" → 549XXXXXXXXX, Meta puede tener 54XXXXXXXXX
  // Enviamos ambas variantes para máxima coincidencia
  const phones = [sha256(phoneClean)];
  if (phoneClean.startsWith('549') && phoneClean.length >= 12) {
    phones.push(sha256('54' + phoneClean.slice(3)));
  }

  // Buscar sesión de click reciente (últimos 7 días) para máxima match quality
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const session = recentClicks.find(c => c.ts > cutoff) || {};

  const user_data = {
    ph:          phones,
    external_id: [sha256(phoneClean)],
  };
  if (session.ip) user_data.client_ip_address = session.ip;
  if (session.ua) user_data.client_user_agent = session.ua;
  if (session.fbc) user_data.fbc = session.fbc;
  if (session.fbp) user_data.fbp = session.fbp;
  if (fn) user_data.fn = [sha256(fn.toLowerCase())];
  if (ln) user_data.ln = [sha256(ln.toLowerCase())];

  const LANDING_URL = `${CONFIG.CLIENT_SITE_URL}/landing`;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: LANDING_URL,
      user_data,
      custom_data: {
        currency: moneda || 'ARS',
        value: monto,
        content_name: 'Lectura de Tarot',
        content_type: 'product',
        content_ids: ['tarot-lectura'],
      },
    }],
  };

  if (CONFIG.META_TEST_CODE) payload.test_event_code = CONFIG.META_TEST_CODE;

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${CONFIG.META_PIXEL_ID}/events?access_token=${CONFIG.META_CAPI_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );

  const result = await res.json();
  if (result.error) {
    logEntry('ERROR_CAPI', `Meta CAPI error: ${result.error.message}`);
  } else {
    logEntry('CAPI_OK', `Meta CAPI → events_received: ${result.events_received}`, { monto, moneda, phone });
  }
}

// ── HELPER ─────────────────────────────────────────────────────────────────
/** Compara ignorando mayúsculas, acentos y espacios de más. */
function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchKeyword(texto, keyword) {
  if (!keyword) return false;
  return normalizar(texto).includes(normalizar(keyword));
}

function parsearJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
    logEntry('ERROR', `No se pudo parsear JSON de Claude: ${text}`);
    return null;
  }
}

// ── Monitor de conexión WhatsApp ───────────────────────────────────────────
let waStatus = { state: 'unknown', checkedAt: null };

async function checkWAConnection() {
  try {
    const res = await fetch(
      `${CONFIG.EVOLUTION_URL}/instance/fetchInstances`,
      { headers: { apikey: CONFIG.EVOLUTION_APIKEY } }
    );
    const data = await res.json();
    const inst = Array.isArray(data) ? data.find(i => i.name === CONFIG.EVOLUTION_INSTANCE) : null;

    const prevState = waStatus.state;
    waStatus.checkedAt = new Date().toISOString();

    if (!inst) {
      waStatus.state = 'not_found';
      console.warn(`⚠️  [WA] Instancia "${CONFIG.EVOLUTION_INSTANCE}" no encontrada`);
      return;
    }

    // Si tiene disconnectionReasonCode reciente (< 1h desde disconnectionAt), está desconectada
    const disconnAt = inst.disconnectionAt ? new Date(inst.disconnectionAt) : null;
    const secsSinceDisconn = disconnAt ? (Date.now() - disconnAt.getTime()) / 1000 : Infinity;
    const reportedState = inst.connectionStatus;

    if (reportedState === 'open') {
      waStatus.state = 'open';
      if (prevState !== 'open') {
        console.log(`🟢 [WA] Conectado — ${inst.profileName || CONFIG.EVOLUTION_INSTANCE}`);
      }
    } else {
      waStatus.state = reportedState || 'unknown';
      console.warn(`🟡 [WA] Estado: ${waStatus.state}`);
    }
  } catch (e) {
    waStatus.state = 'error';
    console.error(`❌ [WA] Error al verificar conexión: ${e.message}`);
  }
}

// ── CONTACTOS ──────────────────────────────────────────────────────────────

/** Registra sin bloquear el webhook: si falla, se loguea y sigue. */
function registrarContactoSeguro(telefono, nombre, texto) {
  if (!pool) return;
  contactos
    .registrarContacto(pool, { telefono, nombre, texto, apiKey: CONFIG.ANTHROPIC_KEY })
    .then(c => { if (c) broadcast({ type: 'contacto', data: c }); })
    .catch(e => console.error('[contactos] registrar:', e.message));
}

app.get('/api/contactos', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    res.json(await contactos.listar(pool));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Edición manual de Estado y Notas desde el dashboard
app.post('/api/contactos/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'sin base de datos' });
  try {
    const { estado, notas, nombre } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE contactos SET
         estado = COALESCE($2, estado),
         notas  = COALESCE($3, notas),
         nombre = COALESCE($4, nombre)
       WHERE id = $1 RETURNING *`,
      [req.params.id, estado ?? null, notas ?? null, nombre ?? null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'no existe' });
    broadcast({ type: 'contacto', data: rows[0] });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/contactos/export.xlsx', async (req, res) => {
  if (!pool) return res.status(503).send('sin base de datos');
  try {
    const lista = await contactos.listar(pool);
    const buf = buildXlsx(
      ['Nº cliente', 'Teléfono', 'Nombre', 'Estado', 'Notas'],
      lista.map(c => [c.nro || '', String(c.telefono || ''), c.nombre || '', c.estado || '', c.notas || '']),
      'Contactos'
    );
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="contactos-${CONFIG.EVOLUTION_INSTANCE}-${fecha}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('[contactos] export:', e.message);
    res.status(500).send(e.message);
  }
});

// Re-sincroniza el Google Sheet si algún día se activa (opcional, no usado por defecto)
app.post('/api/contactos/resync', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'sin base de datos' });
  res.json(await contactos.resync(pool));
});

// ── INICIO ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
cargarEventosIniciales().then(async () => {
  httpServer.listen(PORT, () => {
    console.log(`🚀 Convertix corriendo en http://localhost:${PORT}`);
    console.log(`👤 Cliente: ${CONFIG.EVOLUTION_INSTANCE} | landing: ${CONFIG.CLIENT_LANDING} | keyword: "${CONFIG.CLIENT_KEYWORD}"`);
    if (!process.env.CLIENT_KEYWORD && !process.env.KEYWORD_LANDING) {
      console.warn('⚠️  Falta CLIENT_KEYWORD (o KEYWORD_LANDING) — usando el valor por defecto.');
    }
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`🔗 Webhook URL para Evolution API: http://TU-NGROK-URL/webhook`);
  });

  // Verificar estado WA al iniciar y cada 5 minutos
  await checkWAConnection();
  setInterval(checkWAConnection, 5 * 60 * 1000);
});
