/**
 * Catatan aktivitas Joko untuk panel admin (Pemakaian & Percakapan).
 * ------------------------------------------------------------
 *  - File JSONL harian: logs/activity/activity-YYYY-MM-DD.jsonl (tanggal WIB), disimpan 30 hari.
 *  - Jenis kejadian:
 *      agent: satu panggilan model { model, tier, reason, ms, ok, error, fallbackFrom, label, chat }
 *      msg:   pesan yang melibatkan Joko { dir: 'in'|'out', chat, name, text, media, file }
 *      tool:  pemanggilan tool MCP Joko { name, ok, ms, error, source: agen|panel, hint }
 *    Hanya pesan yang MEMANGGIL Joko dan balasan Joko yang dicatat — obrolan biasa
 *    Mas Andika dengan orang lain tidak pernah masuk catatan ini.
 *  - Lokal saja (folder logs/ tidak masuk git) dan hanya dibaca panel admin.
 */
import fs from 'node:fs';
import path from 'node:path';

export const RETENTION_DAYS = 30;
const MAX_TEXT = 4000;
const WIB_MS = 7 * 3600 * 1000;

export const wibDay = (t = Date.now()) => new Date(t + WIB_MS).toISOString().slice(0, 10);

export function createActivityLog({ dir, retentionDays = RETENTION_DAYS, now = () => Date.now() } = {}) {
  let lastPrune = 0;
  const fileFor = (day) => path.join(dir, `activity-${day}.jsonl`);

  function prune() {
    const t = now();
    if (t - lastPrune < 3600 * 1000) return;
    lastPrune = t;
    const cutoff = wibDay(t - retentionDays * 86400000);
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^activity-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f));
      }
    } catch {}
  }

  function append(event) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const t = event.t ?? now();
      const e = { ...event, t };
      if (typeof e.text === 'string' && e.text.length > MAX_TEXT) e.text = e.text.slice(0, MAX_TEXT) + '…';
      fs.appendFileSync(fileFor(wibDay(t)), JSON.stringify(e) + '\n');
      prune();
    } catch (err) {
      console.warn('[Aktivitas] Gagal mencatat:', err.message);
    }
  }

  /** Kejadian dari `days` hari terakhir (termasuk hari ini), urut waktu. */
  function read(days = 7) {
    const out = [];
    const t = now();
    for (let i = days - 1; i >= 0; i--) {
      let raw;
      try { raw = fs.readFileSync(fileFor(wibDay(t - i * 86400000)), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch {}
      }
    }
    return out;
  }

  return { append, read, dir };
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Ringkasan pemakaian untuk halaman Pemakaian. */
export function summarizeUsage(events, { days = 7, now = Date.now() } = {}) {
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(wibDay(now - i * 86400000));
  const perDay = Object.fromEntries(dayKeys.map(d => [d, { day: d, calls: 0, ok: 0, failed: 0, timeouts: 0, fallbacks: 0, msgIn: 0, msgOut: 0, files: 0, byModel: {} }]));
  const models = {};
  const contacts = {};
  const durations = [];

  for (const e of events) {
    const d = perDay[wibDay(e.t)];
    if (!d) continue;
    if (e.type === 'agent') {
      d.calls++;
      if (e.ok) d.ok++; else if (e.error === 'timeout') d.timeouts++; else d.failed++;
      if (e.fallbackFrom) d.fallbacks++;
      const key = e.model || 'bawaan';
      d.byModel[key] = (d.byModel[key] || 0) + 1;
      const m = models[key] ||= { model: key, calls: 0, ok: 0, failed: 0, timeouts: 0, fallbackUsed: 0, ms: [] };
      m.calls++;
      if (e.ok) m.ok++; else if (e.error === 'timeout') m.timeouts++; else m.failed++;
      if (e.fallbackFrom) m.fallbackUsed++;
      if (e.ok && Number.isFinite(e.ms)) { m.ms.push(e.ms); durations.push(e.ms); }
    } else if (e.type === 'msg') {
      if (e.dir === 'in') {
        d.msgIn++;
        const c = contacts[e.chat] ||= { chat: e.chat, name: e.name || null, group: !!e.group, count: 0 };
        c.count++;
        if (e.name) c.name = e.name;
      } else {
        d.msgOut++;
        if (e.file) d.files++;
      }
    }
  }

  const modelList = Object.values(models).map(({ ms, ...m }) => ({
    ...m,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
    medianMs: median(ms),
    maxMs: ms.length ? Math.max(...ms) : 0,
    successRate: m.calls ? m.ok / m.calls : 0
  })).sort((a, b) => b.calls - a.calls);

  const totals = Object.values(perDay).reduce((acc, d) => {
    for (const k of ['calls', 'ok', 'failed', 'timeouts', 'fallbacks', 'msgIn', 'msgOut', 'files']) acc[k] += d[k];
    return acc;
  }, { calls: 0, ok: 0, failed: 0, timeouts: 0, fallbacks: 0, msgIn: 0, msgOut: 0, files: 0 });
  totals.medianMs = median(durations);

  return {
    days,
    totals,
    perDay: Object.values(perDay),
    models: modelList,
    topContacts: Object.values(contacts).sort((a, b) => b.count - a.count).slice(0, 8)
  };
}

/**
 * Ringkasan pemanggilan tool (kejadian type 'tool': { name, ok, ms, error, source, hint })
 * untuk halaman Tools & MCP.
 */
export function summarizeTools(events, { recent = 30 } = {}) {
  const byName = {};
  const calls = events.filter(e => e.type === 'tool' && e.name);
  for (const e of calls) {
    const s = byName[e.name] ||= { name: e.name, calls: 0, ok: 0, failed: 0, ms: [], lastAt: 0, lastError: null };
    s.calls++;
    if (e.ok) s.ok++; else { s.failed++; if (e.t >= s.lastAt) s.lastError = e.error || null; }
    if (Number.isFinite(e.ms)) s.ms.push(e.ms);
    if (e.t > s.lastAt) s.lastAt = e.t;
  }
  const stats = Object.fromEntries(Object.values(byName).map(({ ms, ...s }) => [s.name, {
    ...s,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
    medianMs: median(ms)
  }]));
  return {
    total: calls.length,
    failed: calls.filter(e => !e.ok).length,
    stats,
    recent: calls.sort((a, b) => b.t - a.t).slice(0, recent)
      .map(({ t, name, ok, ms, error, source, hint }) => ({ t, name, ok: !!ok, ms, error: error || null, source: source || 'agen', hint: hint || '' }))
  };
}

/** Daftar percakapan (per chat) untuk halaman Percakapan. */
export function listConversations(events) {
  const chats = {};
  for (const e of events) {
    if (e.type !== 'msg' || !e.chat) continue;
    const c = chats[e.chat] ||= { chat: e.chat, name: null, group: !!e.group, owner: false, count: 0, files: 0, lastAt: 0, lastText: '', lastDir: 'in' };
    c.count++;
    if (e.file) c.files++;
    if (e.dir === 'in' && e.name) c.name = e.name;
    if (e.owner) c.owner = true;
    if (e.group) c.group = true;
    if (e.t >= c.lastAt) {
      c.lastAt = e.t;
      c.lastDir = e.dir;
      c.lastText = e.file ? `📎 ${e.file.name}` : (e.media && !e.text ? `[${e.media}]` : String(e.text || '').slice(0, 140));
    }
  }
  return Object.values(chats).sort((a, b) => b.lastAt - a.lastAt);
}

/** Linimasa satu chat (maks. `limit` terakhir): pesan + panggilan agen (model & durasi). */
export function conversationMessages(events, chat, { limit = 300 } = {}) {
  // Panggilan agen dicatat saat selesai dengan waktu MULAI, jadi diurutkan ulang menurut waktu.
  return events.filter(e => (e.type === 'msg' || e.type === 'agent') && e.chat === chat)
    .sort((a, b) => a.t - b.t)
    .slice(-limit);
}
