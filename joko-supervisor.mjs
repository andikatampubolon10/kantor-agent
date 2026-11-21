#!/usr/bin/env node
/**
 * Supervisor Joko untuk laptop (pengganti pm2 di EC2).
 * ------------------------------------------------------------
 *  - Satu instance: dua proses Joko dengan sesi WhatsApp yang sama merusak sesi
 *    enkripsi (Bad MAC) dan membalas dobel. Dijaga dengan lock file + cek port.
 *  - Restart otomatis bila Joko berhenti, dengan jeda bertahap 2 detik -> 60 detik
 *    (kembali 2 detik bila Joko sempat berjalan stabil >= 5 menit).
 *  - Log harian di logs/joko-YYYY-MM-DD.log (stderr diberi awalan [ERR]), disimpan 14 hari.
 *  - Berhenti rapi: buat file logs/joko-supervisor.stop atau jalankan stop-wa-assistant.bat.
 *    Supervisor meminta Joko (lewat IPC) menyimpan sesi WhatsApp & menutup koneksi dulu.
 *
 * Jalankan: node joko-supervisor.mjs   (otomatis lewat start-wa-assistant.vbs saat login)
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, 'logs');
const LOCK_FILE = path.join(LOG_DIR, 'joko-supervisor.lock');
const STOP_FILE = path.join(LOG_DIR, 'joko-supervisor.stop');
const PORT = Number(process.env.PORT || 8795);
const KEEP_DAYS = 14;
const STABLE_MS = 5 * 60 * 1000;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;

fs.mkdirSync(LOG_DIR, { recursive: true });

const today = () => {
  const d = new Date(Date.now() + 7 * 3600 * 1000); // WIB
  return d.toISOString().slice(0, 10);
};
const stamp = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

let logDay = '';
let logStream = null;
function logFile() {
  const day = today();
  if (day !== logDay) {
    logStream?.end();
    logDay = day;
    logStream = fs.createWriteStream(path.join(LOG_DIR, `joko-${day}.log`), { flags: 'a' });
    pruneOldLogs();
  }
  return logStream;
}
function writeLines(chunk, prefix = '') {
  const text = String(chunk).replace(/\r?\n$/, '');
  if (!text) return;
  const out = text.split(/\r?\n/).map(l => `${stamp()} ${prefix}${l}`).join('\n') + '\n';
  logFile().write(out);
}
const say = (msg) => writeLines(`[Supervisor] ${msg}`);

function pruneOldLogs() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (!/^joko-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
    const p = path.join(LOG_DIR, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
  }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

/** Ambil lock satu instance. Mengembalikan alasan gagal, atau null bila berhasil. */
async function acquireLock() {
  try {
    const old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (old?.pid && old.pid !== process.pid && isPidAlive(old.pid)) return `supervisor lain sudah berjalan (PID ${old.pid})`;
  } catch {}
  if (await portInUse(PORT)) return `port ${PORT} sudah dipakai (Joko sudah berjalan di luar supervisor)`;
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return null;
}

function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (cur?.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

let child = null;
let stopping = false;
let delay = MIN_DELAY_MS;

function startJoko() {
  if (stopping) return;
  const startedAt = Date.now();
  child = spawn(process.execPath, [path.join(HERE, 'wa-assistant.mjs')], {
    cwd: HERE,
    env: process.env,
    // Kanal 'ipc' untuk perintah berhenti rapi (lihat shutdown()).
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  say(`Joko dijalankan (PID ${child.pid}).`);
  child.stdout.on('data', d => writeLines(d));
  child.stderr.on('data', d => writeLines(d, '[ERR] '));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    const ranMs = Date.now() - startedAt;
    if (ranMs >= STABLE_MS) delay = MIN_DELAY_MS;
    say(`Joko berhenti (kode ${code ?? '-'}${signal ? `, sinyal ${signal}` : ''}) setelah ${Math.round(ranMs / 1000)} detik. Restart dalam ${Math.round(delay / 1000)} detik.`);
    setTimeout(startJoko, delay);
    delay = Math.min(MAX_DELAY_MS, delay * 2);
  });
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  say(`Berhenti: ${reason}.`);
  const done = () => { releaseLock(); try { fs.unlinkSync(STOP_FILE); } catch {} logStream?.end(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
  if (child) {
    child.once('exit', done);
    // Minta Joko menyimpan sesi WhatsApp & menutup koneksi dulu. kill() di Windows langsung
    // mematikan proses (tanpa sinyal yang bisa ditangkap), jadi hanya dipakai sebagai cadangan.
    let asked = false;
    try { asked = child.connected && child.send({ type: 'shutdown' }); } catch {}
    if (!asked) child.kill();
    setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 8000);
  } else {
    done();
  }
}

const reason = await acquireLock();
if (reason) {
  // Tulis sinkron: proses langsung keluar, stream log belum sempat di-flush.
  fs.appendFileSync(path.join(LOG_DIR, `joko-${today()}.log`), `${stamp()} [Supervisor] Tidak dijalankan: ${reason}.\n`);
  process.exit(0);
}
try { fs.unlinkSync(STOP_FILE); } catch {}
say(`Supervisor aktif (PID ${process.pid}). Log: ${LOG_DIR}`);
startJoko();

// Permintaan berhenti rapi dari stop-wa-assistant.bat (Windows tidak punya SIGTERM yang andal).
setInterval(() => { if (fs.existsSync(STOP_FILE)) shutdown('diminta lewat file stop'); }, 2000).unref();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', releaseLock);
