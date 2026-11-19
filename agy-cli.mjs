/**
 * Pemanggil Antigravity CLI (`agy`) untuk percakapan OWNER & tugas cron.
 * Sesi dikunci ke ID percakapan sendiri lewat `--conversation <id>` (bukan `-c`,
 * yang melanjutkan percakapan "terakhir" di mesin — bisa milik tamu atau cron).
 * Output dibaca dalam format JSON: { conversation_id, status, response, ... }.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class AgentTimeoutError extends Error {
  constructor(message, { partial = '', stillRunning = false } = {}) {
    super(message);
    this.name = 'AgentTimeoutError';
    this.partial = partial;
    this.stillRunning = stillRunning;
  }
}

/** Ambil objek JSON hasil `agy --output-format json` (atau baris `AGY_ERROR: {...}`). */
export function parseAgyJson(text) {
  const lines = String(text || '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const t = line.trim().replace(/^AGY_ERROR:\s*/, '');
    if (t.startsWith('{') && t.endsWith('}')) {
      try { return JSON.parse(t); } catch {}
    }
  }
  return null;
}

const TIMEOUT_MSG = (ms) => ms >= 60000
  ? `Waktu tunggu habis: tugas melebihi batas ${Math.round(ms / 60000)} menit dan dihentikan.`
  : `Waktu tunggu habis: tugas melebihi batas ${Math.round(ms / 1000)} detik dan dihentikan.`;

/**
 * @returns {Promise<{ response: string, conversationId: string|null, resumed: boolean }>}
 */
export async function runAgyCli({ agyPath, prompt, resumeId = null, timeoutMs = 10 * 60 * 1000, env = process.env, cwd = process.cwd() }) {
  const args = ['--output-format', 'json', '--print-timeout', `${Math.floor(timeoutMs / 1000)}s`];
  if (resumeId) args.push('--conversation', resumeId);
  args.push('-p', prompt);

  let stdout = '';
  let stderr = '';
  try {
    const res = await execFileAsync(agyPath, args, {
      cwd, env, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs + 30000, windowsHide: true
    });
    stdout = res.stdout || '';
    stderr = res.stderr || '';
  } catch (err) {
    if (err.killed) throw new AgentTimeoutError(TIMEOUT_MSG(timeoutMs));
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    if (/flag provided but not defined|unknown flag/i.test(stderr)) {
      const e = new Error('Antigravity CLI versi lama (tidak mendukung --output-format/--conversation). Jalankan "agy update".');
      e.code = 'AGY_LEGACY';
      throw e;
    }
    if (!parseAgyJson(stdout) && !parseAgyJson(stderr)) {
      throw new Error((stderr || err.message || 'Antigravity CLI gagal dijalankan.').trim().slice(0, 300));
    }
  }

  const result = parseAgyJson(stdout) || parseAgyJson(stderr);
  if (!result) {
    throw new Error((stderr || stdout || 'Tidak ada output dari Antigravity CLI. Pastikan akun sudah login.').trim().slice(0, 300));
  }

  const response = String(result.response || '').trim();
  // Contoh timeout nyata: {"status":"ERROR","error":"print timeout after ...","finished_reason":"print_timeout"}
  const statusText = `${result.status || ''} ${result.reason || ''} ${result.finished_reason || ''} ${result.short_error || ''} ${result.error || ''}`;
  if (result.status && result.status !== 'SUCCESS') {
    if (/DEADLINE|timeout/i.test(statusText)) {
      throw new AgentTimeoutError(TIMEOUT_MSG(timeoutMs), { partial: response });
    }
    throw new Error(result.short_error || result.error || `Status Antigravity: ${result.status}`);
  }
  if (!response) throw new Error('Antigravity tidak menghasilkan jawaban.');

  const conversationId = result.conversation_id ? String(result.conversation_id) : null;
  return { response, conversationId, resumed: !!resumeId && conversationId === resumeId };
}

/** Mode teks lama tanpa sesi (untuk agy versi lama). */
export async function runAgyCliLegacy({ agyPath, prompt, timeoutMs = 10 * 60 * 1000, env = process.env, cwd = process.cwd() }) {
  const res = await execFileAsync(agyPath, ['-p', prompt], { cwd, env, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs, windowsHide: true });
  const text = String(res.stdout || '').trim();
  if (!text) throw new Error('Tidak ada output teks dari Antigravity CLI.');
  return text;
}
