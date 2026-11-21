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
    extra: {
      'GET skills': ({ query }) => ({ items: [], q: query.get('q') }),
      'POST memory/add': ({ body }) => { if (!body.text) throw Object.assign(new Error('Fakta kosong.'), { status: 400 }); calls.push(['mem', body.text]); return { ok: true }; },
      'POST files/delete': () => { throw Object.assign(new Error('File tidak ditemukan.'), { status: 404 }); }
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

test('panel fase 3: rute tambahan dengan login, CSRF & status galat', () => withServer(async ({ req, calls, login }) => {
  assert.equal((await req('/admin/api/skills')).status, 401);
  const cookie = await login();
  assert.deepEqual(await (await req('/admin/api/skills?q=a', { cookie })).json(), { items: [], q: 'a' });
  assert.equal((await req('/admin/api/memory/add', { method: 'POST', cookie, body: { text: 'x' }, origin: 'http://evil.test' })).status, 403);
  assert.equal((await req('/admin/api/memory/add', { method: 'POST', cookie, body: {} })).status, 400);
  assert.equal((await req('/admin/api/memory/add', { method: 'POST', cookie, body: { text: 'alergi udang' } })).status, 200);
  assert.deepEqual(calls, [['mem', 'alergi udang']]);
  const nf = await req('/admin/api/files/delete', { method: 'POST', cookie, body: { name: 'a' } });
  assert.equal(nf.status, 404);
  assert.match((await nf.json()).error, /tidak ditemukan/);
  assert.equal((await req('/admin/api/skills', { method: 'POST', cookie, body: {} })).status, 404); // metode salah
}));

test('panel lewat Tailscale: host & origin HTTPS terdaftar diterima, QR hanya untuk sesi login', async () => {
  const { serveTargetsPort } = await import('../tailscale-access.mjs');
  assert.equal(serveTargetsPort('{"Web":{"laptop.x.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8795"}}}}}', 8795), true);
  assert.equal(serveTargetsPort('{"Web":{"a:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:87950"}}}}}', 8795), false);
  assert.equal(serveTargetsPort('{}', 8795), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-remote-'));
  let hosts = [];
  const handler = createAdminPanel({
    port: 8795, tokenFile: path.join(dir, 'token'), logDir: dir,
    getStatus: () => ({ ok: 1 }), getModelInfo: () => ({}), saveModelSettings: () => {}, testRoute: () => ({}), getPairing: () => ({}), actions: {},
    remote: { hosts: () => hosts, info: () => ({ installed: true, running: true }), qr: (t) => `<svg>${t.length}</svg>` }
  });
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8');
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (p, { host, origin, method = 'GET', body, cookie } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host, ...(origin ? { origin, 'x-joko-admin': '1', 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) } }, (res) => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  try {
    const H = 'laptop.tail1234.ts.net';
    assert.equal((await call('/admin', { host: H })).status, 403); // belum dibagikan
    hosts = [H];
    assert.equal((await call('/admin', { host: H })).status, 200);
    assert.equal((await call('/admin', { host: 'evil.ts.net' })).status, 403);
    assert.equal((await call('/admin/api/login', { host: H, origin: `http://${H}`, method: 'POST', body: { token } })).status, 403); // harus https
    const ok = await call('/admin/api/login', { host: H, origin: `https://${H}`, method: 'POST', body: { token } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['set-cookie'][0], /; Secure$/);
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    assert.equal((await call('/admin/api/remote', { host: H })).status, 401);
    const r = JSON.parse((await call('/admin/api/remote', { host: H, cookie })).body);
    assert.equal(r.url, `https://${H}/admin`);
    assert.match(r.qrSvg, /^<svg>\d+<\/svg>$/);
    const local = await call('/admin/api/login', { host: '127.0.0.1:8795', origin: 'http://127.0.0.1:8795', method: 'POST', body: { token } });
    assert.ok(!/Secure/.test(local.headers['set-cookie'][0])); // http lokal tanpa Secure
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

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
