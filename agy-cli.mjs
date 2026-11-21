/**
 * Pemanggil Antigravity CLI (`agy`) untuk percakapan OWNER & tugas cron.
 * Sesi dikunci ke ID percakapan sendiri lewat `--conversation <id>` (bukan `-c`,
 * yang melanjutkan percakapan "terakhir" di mesin — bisa milik tamu atau cron).
 * Output dibaca dalam format JSON: { conversation_id, status, response, ... }.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CLI_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

/**
 * Pesan akhir model dari transkrip (langkah PLANNER_RESPONSE terakhir tanpa tool call).
 * `response` dari agy menggabungkan SEMUA teks model selama tugas, termasuk catatan kerja
 * di antara pemanggilan tool ("Sekarang saya panggil buat_file…") yang tidak untuk pengguna.
 */
export function extractFinalMessage(transcriptText) {
  const steps = String(transcriptText || '').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.source !== 'MODEL' || s.type !== 'PLANNER_RESPONSE') continue;
    if (Array.isArray(s.tool_calls) && s.tool_calls.length) return null; // tugas berakhir pada tool call
    const text = typeof s.content === 'string' ? s.content.trim() : '';
    return text || null;
  }
  return null;
}

function finalMessageFor(conversationId, combined, brainDir) {
  if (!conversationId || !/^[A-Za-z0-9-]+$/.test(conversationId)) return null;
  try {
    const file = path.join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    const final = extractFinalMessage(fs.readFileSync(file, 'utf8'));
    // Hanya dipakai bila memang bagian dari jawaban gabungan (transkrip sesi yang benar).
    return final && combined.includes(final.slice(0, 200)) ? final : null;
  } catch {
    return null;
  }
}

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
 * Argumen CLI. Semua flag sebelum -p (karena -p memakan argumen berikutnya).
 * allowMcpServers: server MCP yang tool-nya diizinkan TANPA dialog persetujuan.
 * Di mode print, panggilan MCP tanpa izin ditolak otomatis (denied_actions: mcp).
 * Izin dibatasi per server: "mcp(<server>/*)" — diuji; "mcp(<server>:*)" tidak berlaku.
 * denyMcpTools: aturan "mcp(<server>/<tool>)" yang selalu ditolak walau servernya diizinkan (diuji, agy 1.5).
 */
export function buildAgyCliArgs({ prompt, resumeId = null, timeoutMs, allowMcpServers = [], denyMcpTools = [], model = null }) {
  const args = ['--output-format', 'json', '--print-timeout', `${Math.floor(timeoutMs / 1000)}s`];
  // Model per panggilan (sesi yang sama boleh berganti model; konteks tetap terbawa).
  if (model && /^[A-Za-z0-9._-]+$/.test(model)) args.push('--model', model);
  const servers = allowMcpServers.filter(s => /^[A-Za-z0-9_-]+$/.test(s));
  const deny = denyMcpTools.filter(r => /^mcp\([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\)$/.test(r));
  if (servers.length > 0) {
    const permissions = { allow: servers.map(s => `mcp(${s}/*)`) };
    if (deny.length) permissions.deny = deny;
    args.push('--settings', JSON.stringify({ permissions }));
  }
  if (resumeId) args.push('--conversation', resumeId);
  args.push('-p', prompt);
  return args;
}

/**
 * @returns {Promise<{ response: string, conversationId: string|null, resumed: boolean }>}
 */
export async function runAgyCli({ agyPath, prompt, resumeId = null, timeoutMs = 10 * 60 * 1000, env = process.env, cwd = process.cwd(), allowMcpServers = [], denyMcpTools = [], model = null, brainDir = CLI_BRAIN_DIR }) {
  const args = buildAgyCliArgs({ prompt, resumeId, timeoutMs, allowMcpServers, denyMcpTools, model });

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
  const finalOnly = finalMessageFor(conversationId, response, brainDir);
  return { response: finalOnly || response, conversationId, resumed: !!resumeId && conversationId === resumeId };
}

/** Mode teks lama tanpa sesi (untuk agy versi lama). */
export async function runAgyCliLegacy({ agyPath, prompt, timeoutMs = 10 * 60 * 1000, env = process.env, cwd = process.cwd() }) {
  const res = await execFileAsync(agyPath, ['-p', prompt], { cwd, env, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs, windowsHide: true });
  const text = String(res.stdout || '').trim();
  if (!text) throw new Error('Tidak ada output teks dari Antigravity CLI.');
  return text;
}
