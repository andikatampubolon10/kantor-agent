import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAdminPanel, readLogChunk } from '../admin-panel.mjs';

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-admin-'));
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir);
  fs.writeFileSync(path.join(logDir, 'joko-2026-11-21.log'), '2026-11-21 07:00:00 [Agent] halo\n2026-11-21 07:00:01 [ERR] gagal\n');
  const calls = [];
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const handler = createAdminPanel({
    port,
    tokenFile: path.join(dir, 'token'),
    logDir,
    getStatus: () => ({ ok: 1 }),
    getModelInfo: () => ({ saved: null }),
    saveModelSettings: (s) => { if (s && s.heavy === 'bad') throw new Error('Nama model tidak valid.'); calls.push(['save', s]); },
    testRoute: (text) => ({ model: 'm', tier: 'ringan', reason: text }),
    getPairing: () => ({ ready: true }),
    actions: { restart: async () => { calls.push(['restart']); return { message: 'ok' }; } },
    getUsage: (days) => ({ days }),
    getConversations: () => [{ chat: 'a' }],
    getConversation: (chat) => ({ info: { chat }, items: [] }),
    chat: {
      start: (text) => { if (!text) throw new Error('Pesan masih kosong.'); calls.push(['chat', text]); return { id: 'abcdef0123456789', ahead: 0 }; },
      get: (id) => { if (id !== 'abcdef0123456789') throw Object.assign(new Error('Tugas tidak ditemukan.'), { status: 404 }); return { id, status: 'selesai', reply: 'hai' }; },
      reset: () => calls.push(['reset'])
    },
    openFile: (p) => {
      if (p === 'a.png') return { fileName: 'a.png', kind: 'image', mimetype: 'image/png', buffer: Buffer.from('png') };
      if (p === 'x.html') return { fileName: 'x.html', kind: 'document', mimetype: 'text/html', buffer: Buffer.from('<script>1</script>') };
      throw Object.assign(new Error('File sudah tidak ada.'), { status: 404 });
    }
  });
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8');
  server.on('request', async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404); res.end(); } });
  const base = `http://127.0.0.1:${port}`;
  const req = (p, { method = 'GET', body, cookie, origin = base, admin = true } = {}) => fetch(base + p, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === 'POST' ? { origin, 'content-type': 'application/json', ...(admin ? { 'x-joko-admin': '1' } : {}) } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const login = async () => (await req('/admin/api/login', { method: 'POST', body: { token } })).headers.get('set-cookie').split(';')[0];
  try { await fn({ req, token, calls, login, port }); } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('panel: halaman terbuka, API wajib login, token salah ditolak', () => withServer(async ({ req, token }) => {
  const page = await req('/admin');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await req('/admin/api/status')).status, 401);
  assert.equal((await req('/admin/api/login', { method: 'POST', body: { token: 'salah' } })).status, 401);
  const ok = await req('/admin/api/login', { method: 'POST', body: { token } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.ok(!cookie.includes(token)); // cookie bukan token mentah
  assert.deepEqual(await (await req('/admin/api/status', { cookie })).json(), { ok: 1 });
}));

test('panel: CSRF (origin/header) & host asing ditolak', () => withServer(async ({ req, calls, login, port }) => {
  const cookie = await login();
  assert.equal((await req('/admin/api/actions/restart', { method: 'POST', cookie, body: {}, origin: 'http://evil.test' })).status, 403);
  assert.equal((await req('/admin/api/actions/restart', { method: 'POST', cookie, body: {}, admin: false })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await req('/admin/api/actions/restart', { method: 'POST', cookie, body: {} })).status, 200);
  assert.deepEqual(calls, [['restart']]);
  assert.equal((await req('/admin/api/actions/hapus-semua', { method: 'POST', cookie, body: {} })).status, 404);
  // DNS rebinding: Host asing ditolak walau koneksi ke 127.0.0.1.
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/admin', headers: { host: `evil.test:${port}` } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
}));

test('panel: simpan model, galat validasi jadi 400, log dibaca', () => withServer(async ({ req, calls, login }) => {
  const cookie = await login();
  const bad = await req('/admin/api/models', { method: 'POST', cookie, body: { settings: { heavy: 'bad' } } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /tidak valid/);
  assert.equal((await req('/admin/api/models', { method: 'POST', cookie, body: { reset: true } })).status, 200);
  assert.deepEqual(calls.at(-1), ['save', null]);
  const logs = await (await req('/admin/api/logs', { cookie })).json();
  assert.equal(logs.day, '2026-11-21');
  assert.match(logs.text, /\[ERR\] gagal/);
  assert.equal((await req('/admin/api/logs?day=../../x', { cookie })).status, 400);
}));

test('panel fase 2: pemakaian, percakapan, chat, file aman', () => withServer(async ({ req, calls, login }) => {
  const cookie = await login();
  assert.deepEqual(await (await req('/admin/api/usage?days=99', { cookie })).json(), { days: 30 });
  assert.deepEqual(await (await req('/admin/api/conversations', { cookie })).json(), { items: [{ chat: 'a' }] });
  assert.equal((await (await req('/admin/api/conversation?chat=panel', { cookie })).json()).info.chat, 'panel');
  assert.equal((await req('/admin/api/conversation', { cookie })).status, 400);
  // chat
  assert.equal((await req('/admin/api/chat', { method: 'POST', cookie, body: { text: '' } })).status, 400);
  assert.equal((await req('/admin/api/chat', { method: 'POST', cookie, body: { text: 'hai' }, origin: 'http://evil.test' })).status, 403);
  const started = await (await req('/admin/api/chat', { method: 'POST', cookie, body: { text: 'hai' } })).json();
  assert.equal(started.id, 'abcdef0123456789');
  assert.equal((await (await req('/admin/api/chat/abcdef0123456789', { cookie })).json()).reply, 'hai');
  assert.equal((await req('/admin/api/chat/0000000000000000', { cookie })).status, 404);
  assert.equal((await req('/admin/api/chat/reset', { method: 'POST', cookie, body: {} })).status, 200);
  assert.deepEqual(calls, [['chat', 'hai'], ['reset']]);
  // file: gambar inline, HTML selalu diunduh (tidak dirender di origin panel)
  const img = await req('/admin/api/file?path=a.png', { cookie });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-disposition'), /^inline/);
  const html = await req('/admin/api/file?path=x.html', { cookie });
  assert.equal(html.headers.get('content-type'), 'application/octet-stream');
  assert.match(html.headers.get('content-disposition'), /^attachment/);
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await req('/admin/api/file?path=hilang.pdf', { cookie })).status, 404);
  assert.equal((await req('/admin/api/file?path=a.png')).status, 401);
}));

test('readLogChunk: baris belum lengkap ditahan, offset berlanjut', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-log-'));
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, 'satu\ndua\ntig');
  const a = readLogChunk(f);
  assert.equal(a.text, 'satu\ndua\n');
  fs.appendFileSync(f, 'a\nempat\n');
  const b = readLogChunk(f, a.next);
  assert.equal(b.text, 'tiga\nempat\n');
  assert.equal(readLogChunk(path.join(dir, 'tidak-ada.log')).exists, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
