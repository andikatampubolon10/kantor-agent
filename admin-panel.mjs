/**
 * Panel admin Joko: http://127.0.0.1:8795/admin
 * ------------------------------------------------------------
 * Fase 1: Beranda (status & tombol aksi), Model & Routing, Log.
 *
 * Keamanan:
 *  - Server Joko hanya mendengarkan di 127.0.0.1; header Host juga dicek (cegah DNS rebinding).
 *  - Login dengan token admin acak di file .joko-admin-token (tidak pernah dikirim lewat chat).
 *    Cookie sesi = HMAC token (HttpOnly, SameSite=Strict) sehingga tetap berlaku setelah Joko
 *    dimulai ulang; hapus file token untuk mencabut semua sesi.
 *  - Semua POST wajib Origin lokal + header X-Joko-Admin (cegah CSRF).
 *  - API tidak pernah mengirim kunci, token, cookie, atau isi sesi WhatsApp.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'joko_admin';
const MAX_BODY = 64 * 1024;
const LOG_TAIL_BYTES = 192 * 1024;
const LOG_CHUNK_MAX = 512 * 1024;

export function loadOrCreateAdminToken(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Baca bagian log: dari offset tertentu (live) atau ekor file (awal). */
export function readLogChunk(file, from) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { exists: false, size: 0, from: 0, text: '' }; }
  let start = Number.isFinite(from) && from >= 0 ? from : Math.max(0, size - LOG_TAIL_BYTES);
  if (start > size) start = Math.max(0, size - LOG_TAIL_BYTES); // file berganti / terpotong
  const len = Math.min(size - start, LOG_CHUNK_MAX);
  if (len <= 0) return { exists: true, size, from: start, text: '' };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf8');
  let end = start + len;
  // Mulai dari ekor: buang baris pertama yang terpotong.
  if (!(Number.isFinite(from) && from >= 0) && start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  // Jangan kirim baris terakhir yang belum lengkap; ambil lagi di permintaan berikutnya.
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < text.length - 1) {
    const tail = text.slice(lastNl + 1);
    end -= Buffer.byteLength(tail);
    text = text.slice(0, lastNl + 1);
  }
  return { exists: true, size, from: start, next: end, text };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.tokenFile
 * @param {string} o.logDir
 * @param {() => object} o.getStatus
 * @param {() => object} o.getModelInfo
 * @param {(input: object) => object} o.saveModelSettings  melempar Error bila tidak valid
 * @param {(text: string, draft?: object) => object} o.testRoute
 * @param {() => object} o.getPairing
 * @param {Record<string, (body: object) => Promise<object>>} o.actions
 * @returns {(req, res) => Promise<boolean>} true bila permintaan ditangani panel
 */
export function createAdminPanel({ port, tokenFile, logDir, getStatus, getModelInfo, saveModelSettings, testRoute, getPairing, actions }) {
  const token = loadOrCreateAdminToken(tokenFile);
  const sessionValue = crypto.createHmac('sha256', token).update('joko-admin-session-v1').digest('hex');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map(h => `http://${h}`));
  const htmlFile = path.join(HERE, 'admin-ui.html');
  const failures = []; // waktu login gagal (batasi tebakan token)

  const send = (res, code, obj, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
  };

  async function readBody(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) throw new HttpError(413, 'Permintaan terlalu besar.');
    }
    if (!body) return {};
    try { return JSON.parse(body); } catch { throw new HttpError(400, 'JSON tidak valid.'); }
  }

  const isAuthed = (req) => safeEqual(parseCookies(req.headers.cookie)[COOKIE], sessionValue);
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

  function logFileFor(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'Tanggal log tidak valid.');
    return path.join(logDir, `joko-${day}.log`);
  }
  function logDays() {
    try {
      return fs.readdirSync(logDir).map(f => f.match(/^joko-(\d{4}-\d{2}-\d{2})\.log$/)?.[1]).filter(Boolean).sort().reverse();
    } catch { return []; }
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && (p === '/admin' || p === '/admin/')) {
      let html;
      try { html = fs.readFileSync(htmlFile, 'utf8'); } catch { throw new HttpError(500, 'admin-ui.html tidak ditemukan.'); }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      });
      res.end(html);
      return;
    }

    if (!p.startsWith('/admin/api/')) throw new HttpError(404, 'Tidak ditemukan.');
    const api = p.slice('/admin/api/'.length);

    if (method === 'POST') {
      if (!allowedOrigins.has(req.headers.origin || '') || req.headers['x-joko-admin'] !== '1') {
        throw new HttpError(403, 'Permintaan ditolak (asal tidak dikenal).');
      }
    }

    if (method === 'POST' && api === 'login') {
      const now = Date.now();
      while (failures.length && now - failures[0] > 60000) failures.shift();
      if (failures.length >= 10) throw new HttpError(429, 'Terlalu banyak percobaan. Tunggu 1 menit.');
      const body = await readBody(req);
      if (!safeEqual(String(body.token || '').trim(), token)) {
        failures.push(now);
        throw new HttpError(401, 'Token salah.');
      }
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(sessionValue, 30 * 86400) });
    }
    if (method === 'POST' && api === 'logout') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }

    if (!isAuthed(req)) throw new HttpError(401, 'Belum masuk.');

    if (method === 'GET' && api === 'status') return send(res, 200, getStatus());
    if (method === 'GET' && api === 'pairing') return send(res, 200, getPairing());
    if (method === 'GET' && api === 'models') return send(res, 200, getModelInfo());
    if (method === 'POST' && api === 'models') {
      const body = await readBody(req);
      try { saveModelSettings(body.reset ? null : body.settings || {}); }
      catch (err) { throw new HttpError(400, err.message); }
      return send(res, 200, getModelInfo());
    }
    if (method === 'POST' && api === 'models/test') {
      const body = await readBody(req);
      try { return send(res, 200, testRoute(String(body.text || '').slice(0, 2000), body.draft)); }
      catch (err) { throw new HttpError(400, err.message); }
    }
    if (method === 'GET' && api === 'logs/days') return send(res, 200, { days: logDays() });
    if (method === 'GET' && api === 'logs') {
      const days = logDays();
      const day = url.searchParams.get('day') || days[0];
      if (!day) return send(res, 200, { day: null, exists: false, text: '', size: 0, next: 0 });
      const fromRaw = url.searchParams.get('from');
      const chunk = readLogChunk(logFileFor(day), fromRaw == null ? undefined : Number(fromRaw));
      return send(res, 200, { day, ...chunk });
    }
    const m = api.match(/^actions\/([a-z-]+)$/);
    if (method === 'POST' && m && Object.hasOwn(actions, m[1])) {
      const body = await readBody(req);
      try { return send(res, 200, { ok: true, ...(await actions[m[1]](body)) }); }
      catch (err) { throw new HttpError(err.status || 400, err.message); }
    }
    throw new HttpError(404, 'Tidak ditemukan.');
  }

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;
    try {
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, 'Host tidak diizinkan.');
      await route(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[Admin] Error:', err.message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Terjadi kesalahan di server.' : err.message });
      else res.end();
    }
    return true;
  };
}
