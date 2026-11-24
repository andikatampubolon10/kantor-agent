/**
 * Connector layanan luar untuk agen Joko (lewat server MCP di Antigravity CLI).
 * ------------------------------------------------------------
 *  - Katalog connector yang didukung + aturan keamanannya (tool berisiko diblokir).
 *  - Menulis/menghapus entri di konfigurasi MCP Antigravity (~/.gemini/config/mcp_config.json)
 *    tanpa menyentuh server lain (mis. "joko").
 *  - Status untuk panel: terpasang? sudah tersambung (agy menyimpan daftar tool server
 *    yang berhasil tersambung di ~/.gemini/antigravity-cli/mcp/<server>/)? diizinkan?
 *  - Izin untuk agen owner: server diizinkan per connector dari panel; tool berisiko
 *    selalu ditolak (aturan deny "mcp(server/tool)" — diuji pada agy 1.5).
 *
 * Kunci rahasia (OAuth client secret, API key) TIDAK pernah dikirim ke panel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERPLEXITY_PKG = '@perplexity-ai/mcp-server@1.3.0';

export const CONNECTORS = Object.freeze([
  {
    id: 'gmail', label: 'Gmail', group: 'google', kind: 'http',
    url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'google-oauth',
    // Diperiksa dari daftar tool server (Nov 2026): tidak ada tool kirim. Membuang ke sampah /
    // menandai spam diblokir agar isi email jahat tidak bisa membuat Joko menyembunyikan email.
    deny: ['trash_message', 'trash_thread', 'apply_sensitive_message_label', 'apply_sensitive_thread_label', 'mark_message_spam', 'mark_thread_spam'],
    summary: 'Cari & baca email, beri label, dan buat DRAF balasan.',
    safety: 'Tidak ada tool kirim: Joko hanya membuat draf, Mas Andika yang menekan Kirim. Membuang ke sampah & menandai spam diblokir.'
  },
  {
    id: 'drive', label: 'Google Drive', group: 'google', kind: 'http',
    url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google-oauth',
    deny: ['upload_file_revision'],
    summary: 'Cari, baca, buat, dan salin file di Drive.',
    safety: 'Tidak ada tool hapus atau ubah izin berbagi. Menimpa isi file yang sudah ada diblokir.'
  },
  {
    id: 'calendar', label: 'Google Calendar', group: 'google', kind: 'http',
    url: 'https://calendarmcp.googleapis.com/mcp/v1', auth: 'google-oauth',
    deny: ['delete_event', 'respond_to_event'],
    summary: 'Lihat agenda, cari waktu kosong, buat & ubah acara.',
    safety: 'Menghapus acara dan membalas undangan diblokir.'
  },
  {
    // Jalur resmi untuk klien buatan sendiri (canva.dev, GA Okt 2026): aplikasi Developer Portal
    // dengan "Canva MCP" aktif -> Client ID + secret. Tidak ada tool hapus.
    id: 'canva', label: 'Canva', group: 'canva', kind: 'http',
    url: 'https://api.canva.com/connect/v1/mcp', auth: 'oauth-client',
    deny: ['publish-brand-template'],
    summary: 'Cari, buat, edit & ekspor desain Canva; buat gambar dari teks.',
    safety: 'Akses mengikuti hak akun Canva Mas Andika. Menerbitkan brand template ke tim diblokir.'
  },
  {
    id: 'perplexity', label: 'Perplexity', group: 'perplexity', kind: 'stdio',
    pkg: PERPLEXITY_PKG, auth: 'api-key', envKey: 'PERPLEXITY_API_KEY',
    deny: [],
    summary: 'Riset web dengan jawaban bersumber (search, ask, reason, deep research).',
    safety: 'Berbayar per pemakaian API Perplexity; riset mendalam paling mahal.'
  },
  {
    // Server MCP resmi GitHub (biner lokal, github/github-mcp-server). Dua lapis baca-saja:
    // flag --read-only (tool tulis tidak didaftarkan) + token fine-grained yang izinnya hanya Read.
    // --lockdown-mode: isi issue/PR dari orang tanpa akses tulis disaring (cegah prompt injection).
    id: 'github', label: 'GitHub', group: 'github', kind: 'stdio',
    auth: 'github-pat', envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    args: ['stdio', '--read-only', '--lockdown-mode', '--toolsets=context,repos,issues,pull_requests,actions'],
    deny: [],
    summary: 'Baca repo, issue, pull request, komentar, dan status CI (GitHub Actions).',
    safety: 'Mode BACA SAJA: server dijalankan dengan --read-only dan token fine-grained berizin Read. Isi dari orang tanpa akses tulis disaring (lockdown). Perubahan kode tetap lewat Mode Coding + Pull Request.'
  },
  {
    id: 'notebooklm', label: 'NotebookLM', group: 'notebooklm', kind: 'none',
    available: false, deny: [],
    summary: 'Tanya-jawab dari sumber di notebook NotebookLM.',
    safety: 'Belum ada API/MCP resmi untuk akun pribadi. Server komunitas mengendalikan browser dengan login Google Anda (rawan diblokir & rusak), jadi belum dipasang.'
  }
]);

export const CONNECTOR_GROUPS = Object.freeze({
  google: ['gmail', 'drive', 'calendar'],
  canva: ['canva'],
  perplexity: ['perplexity'],
  github: ['github']
});

/** Lokasi biner github-mcp-server (dipasang ke %LOCALAPPDATA%\Programs\github-mcp-server). */
export function githubMcpBinary({ env = process.env, platform = process.platform } = {}) {
  if (env.JOKO_GITHUB_MCP_BIN) return env.JOKO_GITHUB_MCP_BIN;
  if (platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Programs', 'github-mcp-server', 'github-mcp-server.exe');
  return 'github-mcp-server';
}

const byId = (id) => CONNECTORS.find(c => c.id === id) || null;

export function defaultMcpConfigPath(home = os.homedir()) {
  return path.join(home, '.gemini', 'config', 'mcp_config.json');
}
export function defaultMcpCacheDir(home = os.homedir()) {
  return path.join(home, '.gemini', 'antigravity-cli', 'mcp');
}

export class ConnectorError extends Error {}

/** Entri mcp_config.json untuk satu connector. secrets: { clientId, clientSecret, apiKey } */
export function connectorEntry(id, secrets = {}, { platform = process.platform } = {}) {
  const c = byId(id);
  if (!c || c.available === false) throw new ConnectorError(`connector tidak dikenal/tidak tersedia: ${id}`);
  if (c.auth === 'google-oauth') {
    const clientId = String(secrets.clientId || '').trim();
    const clientSecret = String(secrets.clientSecret || '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new ConnectorError('Client ID Google tidak valid (harus berakhiran .apps.googleusercontent.com).');
    if (clientSecret.length < 10) throw new ConnectorError('Client secret Google kosong/terlalu pendek.');
    return { disabled: false, serverUrl: c.url, oauth: { clientId, clientSecret } };
  }
  if (c.auth === 'oauth-client') {
    const clientId = String(secrets.clientId || '').trim();
    const clientSecret = String(secrets.clientSecret || '').trim();
    if (!/^[\w-]{6,128}$/.test(clientId)) throw new ConnectorError('Client ID tidak valid.');
    if (clientSecret.length < 10 || /\s/.test(clientSecret)) throw new ConnectorError('Client secret kosong/tidak valid.');
    return { disabled: false, serverUrl: c.url, oauth: { clientId, clientSecret } };
  }
  if (c.auth === 'oauth') return { disabled: false, serverUrl: c.url };
  if (c.auth === 'api-key') {
    const apiKey = String(secrets.apiKey || '').trim();
    if (apiKey.length < 20 || /\s/.test(apiKey)) throw new ConnectorError('API key tidak valid.');
    const npx = platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '-y', c.pkg] }
      : { command: 'npx', args: ['-y', c.pkg] };
    return { disabled: false, ...npx, env: { [c.envKey]: apiKey } };
  }
  if (c.auth === 'github-pat') {
    const token = String(secrets.apiKey || '').trim();
    // Wajib token fine-grained (github_pat_...) agar izin bisa dibatasi Read-only per repo.
    if (!/^github_pat_[A-Za-z0-9_]{40,}$/.test(token)) throw new ConnectorError('Token harus fine-grained (diawali github_pat_). Token klasik (ghp_) tidak bisa dibatasi baca saja.');
    return { disabled: false, command: secrets.binary || githubMcpBinary({ platform }), args: [...c.args], env: { [c.envKey]: token } };
  }
  throw new ConnectorError(`cara login tidak dikenal: ${c.auth}`);
}

export function readMcpConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { mcpServers: {} };
    throw err;
  }
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new ConnectorError('mcp_config.json tidak valid.');
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
  return data;
}

/** Tulis atomik + cadangan versi sebelumnya (mcp_config.json.bak). */
export function writeMcpConfig(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Konfigurasi baru dengan entri connector ditambah/diganti; server lain dibiarkan. */
export function withConnectors(config, entries) {
  const next = { ...config, mcpServers: { ...(config.mcpServers || {}) } };
  for (const [id, entry] of Object.entries(entries)) {
    if (!byId(id)) throw new ConnectorError(`connector tidak dikenal: ${id}`);
    next.mcpServers[id] = entry;
  }
  return next;
}

export function withoutConnectors(config, ids) {
  const next = { ...config, mcpServers: { ...(config.mcpServers || {}) } };
  for (const id of ids) {
    if (!byId(id)) throw new ConnectorError(`connector tidak dikenal: ${id}`);
    delete next.mcpServers[id];
  }
  return next;
}

/** Tool yang sudah diketahui agy untuk server ini (dari cache koneksi terakhir). */
export function cachedTools(cacheDir, server) {
  const dir = path.join(cacheDir, server);
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  const tools = [];
  let lastAt = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    try {
      const t = JSON.parse(fs.readFileSync(full, 'utf8'));
      tools.push({ name: String(t.name || f.slice(0, -5)), description: String(t.description || '').slice(0, 300) });
      lastAt = Math.max(lastAt, fs.statSync(full).mtimeMs);
    } catch {}
  }
  return tools.length ? { tools: tools.sort((a, b) => a.name.localeCompare(b.name)), lastAt } : null;
}

/** Izin connector dari pengaturan panel: { gmail: true, ... } (hanya id yang dikenal). */
export function normalizeConnectorSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const c of CONNECTORS) if (input[c.id] === true && c.available !== false) out[c.id] = true;
  return out;
}

/**
 * Aturan izin agen owner. Server MCP yang tidak diizinkan di sini otomatis ditolak
 * agy di mode print (tidak ada yang bisa menyetujui dialog).
 */
export function ownerMcpPermissions({ base = ['joko'], allowed = {}, installed = [] } = {}) {
  const servers = [...base];
  const deny = [];
  for (const c of CONNECTORS) {
    if (!allowed[c.id] || !installed.includes(c.id)) continue;
    servers.push(c.id);
    for (const tool of c.deny) deny.push(`mcp(${c.id}/${tool})`);
  }
  return { servers, deny };
}

/** Status per connector untuk panel (tanpa rahasia). */
export function connectorStatus({ config, cacheDir, allowed = {} }) {
  const servers = config?.mcpServers || {};
  return CONNECTORS.map(c => {
    const entry = servers[c.id];
    const cache = entry ? cachedTools(cacheDir, c.id) : null;
    const credentials = !entry ? false
      : c.auth === 'google-oauth' || c.auth === 'oauth-client' ? !!entry.oauth?.clientId && !!entry.oauth?.clientSecret
      : c.auth === 'api-key' || c.auth === 'github-pat' ? !!entry.env?.[c.envKey]
      : true;
    return {
      id: c.id, label: c.label, group: c.group, summary: c.summary, safety: c.safety,
      available: c.available !== false, experimental: !!c.experimental, auth: c.auth,
      blocked: c.deny,
      installed: !!entry,
      disabled: entry?.disabled === true,
      credentials,
      connected: !!cache,
      tools: cache?.tools || [],
      lastConnectedAt: cache?.lastAt || null,
      allowed: !!allowed[c.id]
    };
  });
}
