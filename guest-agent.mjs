/**
 * Guest Agent Runner untuk Joko
 * ------------------------------------------------------------
 * Menjalankan permintaan dari NON-OWNER (anggota grup yang diberi akses, teman di
 * whitelist personal) lewat Antigravity CLI dalam mode terkunci:
 *  - Folder kerja kosong sekali pakai (dibuat & dihapus per permintaan), sehingga
 *    tidak ada file proyek yang terlihat.
 *  - --sandbox + aturan deny eksplisit untuk terminal, baca/tulis/edit file,
 *    pembaca URL, browser, dan MCP. Diuji: tanpa deny, terminal di sandbox tetap
 *    bisa membaca file mana pun, jadi deny rule ini wajib.
 *  - Tidak pernah memakai/melanjutkan sesi percakapan owner (tanpa -c / conversation).
 *  - --disable-slash-commands agar teks tamu tidak bisa memicu slash command/skill.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GUEST_DENY_RULES = Object.freeze([
  'command(*)',
  'read_file(*)',
  'write_file(*)',
  'edit_file(*)',
  'read_url(*)',
  'browser(*)',
  'mcp(*)'
]);

const DEFAULT_TIMEOUT_MS = 130000;

/** Susun argumen CLI. Semua flag diletakkan sebelum -p karena -p memakan argumen berikutnya. */
export function buildGuestAgyArgs(prompt, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const printTimeoutSec = Math.max(30, Math.floor(timeoutMs / 1000) - 15);
  return [
    '--sandbox',
    '--disable-slash-commands',
    '--settings', JSON.stringify({ permissions: { deny: [...GUEST_DENY_RULES] } }),
    '--print-timeout', `${printTimeoutSec}s`,
    '-p', String(prompt)
  ];
}

const FAILURE_MARKERS = /AGY_ERROR|no output produced|print timeout|permission check failed|Matches user-configured deny rule/i;

/** Hapus jejak path lokal (mis. link file:/// ke folder brain) dari jawaban untuk tamu. */
export function sanitizeGuestOutput(text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\(file:\/\/[^)]*\)/gi, '$1')
    .replace(/file:\/\/\/?\S+/gi, '')
    .replace(/[A-Za-z]:\\Users\\[^\s)]+/g, '')
    .replace(/\/home\/[^\s)]+/g, '')
    .trim();
}

export class GuestAgentError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'GuestAgentError';
    this.detail = detail;
  }
}

/**
 * Jalankan prompt tamu. Melempar GuestAgentError bila tidak ada jawaban yang layak
 * (mis. tamu meminta aksi yang diblokir, atau batas waktu habis).
 */
export async function runGuestPrompt({ agyPath, prompt, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const jailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-guest-'));
  try {
    let stdout = '';
    let stderr = '';
    try {
      const res = await execFileAsync(agyPath, buildGuestAgyArgs(prompt, timeoutMs), {
        cwd: jailDir,
        env,
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true
      });
      stdout = res.stdout || '';
      stderr = res.stderr || '';
    } catch (err) {
      throw new GuestAgentError('Agen tamu gagal dijalankan.', err.message);
    }

    const out = stdout.trim();
    if (!out || FAILURE_MARKERS.test(out) || FAILURE_MARKERS.test(stderr)) {
      throw new GuestAgentError('Agen tamu tidak menghasilkan jawaban.', (stderr || out).slice(0, 300));
    }
    const clean = sanitizeGuestOutput(out);
    if (!clean) throw new GuestAgentError('Jawaban agen tamu kosong setelah dibersihkan.');
    return clean;
  } finally {
    try { fs.rmSync(jailDir, { recursive: true, force: true }); } catch {}
  }
}
