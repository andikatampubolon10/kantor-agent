/**
 * Kirim file balik ke WhatsApp (gambar, audio, dokumen) dari hasil kerja agen OWNER.
 * ------------------------------------------------------------
 * Agen menyimpan file di MEDIA_OUTBOX_DIR lalu menulis blok:
 *   ```kirim-file
 *   { "path": "laporan.pdf", "caption": "Laporan minggu ini" }
 *   ```
 * Fitur ini bisa menjadi jalur pencurian file bila agen terkecoh prompt injection,
 * jadi berlapis:
 *  1. Hanya file DI DALAM media-outbox/ (realpath, tolak symlink & "..").
 *  2. Ekstensi harus ada di daftar izin; nama/ekstensi sensitif & arsip ditolak.
 *  3. File teks dipindai pola rahasia (private key, token cloud, sesi WhatsApp).
 *  4. Kebijakan penerima (lihat canSendFiles): hanya owner; ke grup / chat orang lain
 *     hanya bila pesan owner sendiri meminta file secara eksplisit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIA_OUTBOX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'media-outbox');
export const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_REPLY = 5;
const SCAN_BYTES = 2 * 1024 * 1024;

const TYPES = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.webp': ['image', 'image/webp'],
  '.mp3': ['audio', 'audio/mpeg'], '.ogg': ['audio', 'audio/ogg; codecs=opus'], '.m4a': ['audio', 'audio/mp4'], '.wav': ['audio', 'audio/wav'],
  '.pdf': ['document', 'application/pdf'],
  '.docx': ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.pptx': ['document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.csv': ['document', 'text/csv'], '.txt': ['document', 'text/plain'], '.md': ['document', 'text/markdown'],
  '.html': ['document', 'text/html'], '.svg': ['document', 'image/svg+xml'], '.gif': ['document', 'image/gif']
};
const TEXT_EXT = new Set(['.csv', '.txt', '.md', '.html', '.svg']);

// Nama file sensitif (dicek walau ekstensinya diizinkan, mis. "id_rsa.txt", "creds.md").
const BLOCKED_NAME = /(?:^|[._-])(?:id_rsa|id_ed25519|creds?|credentials?|secrets?|cookies?|password|passwd|token|private[-_]?key|aws[-_]?key|joko-aws-key|pre-key|session-|app-state-sync)(?:[._-]|$)|\.(?:pem|key|env|p12|pfx|sqlite|db|kdbx|zip|tar|gz|7z|rar)(?:\.|$)/i;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /aws_secret_access_key/i,
  /\bghp_[A-Za-z0-9]{36}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /"(?:noiseKey|signedIdentityKey|signedPreKey|advSecretKey)"/,
  /\bsessionid\b["']?\s*[:=]/i
];

/** Jenis kiriman WhatsApp & mimetype dari ekstensi (null = tidak diizinkan). */
export function fileKindOf(fileName) {
  const t = TYPES[path.extname(String(fileName)).toLowerCase()];
  return t ? { kind: t[0], mimetype: t[1] } : null;
}

/** Ambil blok ```kirim-file``` dari jawaban agen. Blok selalu dibuang dari teks. */
export function extractFileBlocks(responseText) {
  const requests = [];
  const re = /```(?:kirim-file|kirim_file|send-file)\s*([\s\S]*?)\s*```/gi;
  let m;
  while ((m = re.exec(String(responseText ?? ''))) !== null) {
    const body = m[1].trim();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : body.split(/\r?\n/).map(p => ({ path: p }));
    for (const it of list) {
      const p = typeof it === 'string' ? it : it?.path;
      if (typeof p === 'string' && p.trim()) {
        requests.push({ path: p.trim(), caption: typeof it?.caption === 'string' ? it.caption.trim().slice(0, 500) : '' });
      }
    }
  }
  const clean = String(responseText ?? '').replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { clean, requests };
}

/** Cari pola rahasia di isi file teks. */
export function containsSecret(buffer) {
  const text = buffer.subarray(0, SCAN_BYTES).toString('utf8');
  return SECRET_PATTERNS.some(re => re.test(text));
}

/**
 * Validasi permintaan kirim file.
 * @returns {{ok:true, file:string, fileName:string, kind:string, mimetype:string, buffer:Buffer} | {ok:false, reason:string}}
 */
export function resolveOutboxFile(requestPath, dir = MEDIA_OUTBOX_DIR) {
  let root;
  try { root = fs.realpathSync(dir); } catch { return { ok: false, reason: 'folder media-outbox belum ada' }; }

  const raw = String(requestPath ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!raw) return { ok: false, reason: 'path kosong' };
  const candidate = path.isAbsolute(raw) ? raw : path.join(root, raw);

  let real;
  try { real = fs.realpathSync(candidate); } catch { return { ok: false, reason: 'file tidak ditemukan' }; }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'file berada di luar folder media-outbox' };

  const fileName = path.basename(real);
  if (BLOCKED_NAME.test(fileName)) return { ok: false, reason: 'jenis/nama file ini diblokir demi keamanan' };
  const type = fileKindOf(fileName);
  if (!type) return { ok: false, reason: `ekstensi ${path.extname(fileName) || '(tanpa ekstensi)'} tidak diizinkan` };

  let st;
  try { st = fs.lstatSync(candidate); } catch { return { ok: false, reason: 'file tidak ditemukan' }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink tidak diizinkan' };
  const realSt = fs.statSync(real);
  if (!realSt.isFile()) return { ok: false, reason: 'bukan file' };
  if (realSt.size === 0) return { ok: false, reason: 'file kosong' };
  if (realSt.size > MAX_FILE_BYTES) return { ok: false, reason: `ukuran melebihi ${MAX_FILE_BYTES / 1024 / 1024} MB` };

  const buffer = fs.readFileSync(real);
  const ext = path.extname(fileName).toLowerCase();
  if ((TEXT_EXT.has(ext) || type.kind === 'document') && containsSecret(buffer)) {
    return { ok: false, reason: 'isi file terdeteksi memuat data rahasia (kunci/token)' };
  }
  return { ok: true, file: real, fileName, ...type, buffer };
}

/**
 * Kebijakan penerima: hanya OWNER. Ke chat owner sendiri selalu boleh; ke grup atau
 * chat orang lain hanya bila pesan owner pada giliran ini meminta file secara eksplisit.
 */
export function canSendFiles({ isOwner, isOwnerChat, ownerAskedForFile }) {
  return !!isOwner && (!!isOwnerChat || !!ownerAskedForFile);
}

/** Hapus file outbox lebih tua dari batas retensi. */
export function cleanupOutbox(dir = MEDIA_OUTBOX_DIR, maxAgeMs = OUTBOX_RETENTION_MS, now = Date.now()) {
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const file = path.join(dir, e.name);
    try {
      const st = fs.lstatSync(file);
      if (now - st.mtimeMs <= maxAgeMs) continue;
      if (e.isDirectory()) fs.rmSync(file, { recursive: true, force: true }); else fs.unlinkSync(file);
      removed++;
    } catch {}
  }
  return removed;
}

// ---------- Panel admin: daftar, hapus, & perpanjang file outbox ----------
const PREVIEW_DIR = '.pratinjau';
const stemOf = (name) => name.replace(/\.[^.]+$/, '');

/** Pratinjau halaman/slide milik sebuah file (path relatif terhadap outbox). */
export function previewsOf(fileName, dir = MEDIA_OUTBOX_DIR) {
  const stem = stemOf(fileName);
  try {
    return fs.readdirSync(path.join(dir, PREVIEW_DIR))
      .filter(f => (f.startsWith(`${stem}-hal`) || f.startsWith(`${stem}-slide`)) && f.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map(f => `${PREVIEW_DIR}/${f}`);
  } catch { return []; }
}

/** File kiriman di outbox (tanpa folder pratinjau), terbaru dulu. */
export function listOutboxFiles(dir = MEDIA_OUTBOX_DIR, maxAgeMs = OUTBOX_RETENTION_MS) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      const type = fileKindOf(e.name);
      out.push({ name: e.name, size: st.size, modifiedAt: st.mtimeMs, expiresAt: st.mtimeMs + maxAgeMs, kind: type?.kind || null, sendable: !!type, previews: previewsOf(e.name, dir) });
    } catch {}
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function outboxEntry(name, dir) {
  const base = path.basename(String(name || ''));
  if (!base || base !== String(name) || base.startsWith('.')) return null;
  const file = path.join(dir, base);
  try { if (!fs.lstatSync(file).isFile()) return null; } catch { return null; }
  return { base, file };
}

/** Hapus file outbox beserta pratinjaunya. */
export function deleteOutboxFile(name, dir = MEDIA_OUTBOX_DIR) {
  const e = outboxEntry(name, dir);
  if (!e) return false;
  for (const p of previewsOf(e.base, dir)) { try { fs.unlinkSync(path.join(dir, p)); } catch {} }
  fs.unlinkSync(e.file);
  return true;
}

/** Perpanjang masa simpan (hitung ulang 24 jam dari sekarang), termasuk pratinjaunya. */
export function keepOutboxFile(name, dir = MEDIA_OUTBOX_DIR, now = new Date()) {
  const e = outboxEntry(name, dir);
  if (!e) return false;
  fs.utimesSync(e.file, now, now);
  try { fs.utimesSync(path.join(dir, PREVIEW_DIR), now, now); } catch {}
  for (const p of previewsOf(e.base, dir)) { try { fs.utimesSync(path.join(dir, p), now, now); } catch {} }
  return true;
}
