import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityLog, summarizeUsage, summarizeTools, listConversations, conversationMessages, wibDay } from '../activity-log.mjs';

const NOW = Date.parse('2026-11-21T03:00:00Z'); // 10.00 WIB
const H = 3600000;

test('catatan harian (WIB), dibaca lintas hari, file lama dihapus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-act-'));
  let t = NOW;
  const log = createActivityLog({ dir, now: () => t, retentionDays: 30 });
  fs.writeFileSync(path.join(dir, 'activity-2026-10-01.jsonl'), '{"t":1}\n'); // > 30 hari
  log.append({ type: 'msg', dir: 'in', chat: 'a', text: 'x'.repeat(5000), t: NOW - 24 * H });
  log.append({ type: 'msg', dir: 'out', chat: 'a', text: 'halo' });
  assert.equal(wibDay(Date.parse('2026-11-20T18:30:00Z')), '2026-11-21'); // 01.30 WIB
  assert.ok(fs.existsSync(path.join(dir, 'activity-2026-11-20.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'activity-2026-10-01.jsonl')));
  const all = log.read(7);
  assert.equal(all.length, 2);
  assert.ok(all[0].text.length <= 4001);
  assert.equal(log.read(1).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ringkasan pemakaian per hari & per model', () => {
  const ev = [
    { type: 'agent', t: NOW - H, model: 'claude-opus-4-6-thinking', ok: true, ms: 40000 },
    { type: 'agent', t: NOW - 2 * H, model: 'gemini-3.8-flash-high', ok: true, ms: 8000 },
    { type: 'agent', t: NOW - 3 * H, model: 'gemini-3.8-flash-high', ok: true, ms: 6000, fallbackFrom: 'claude-opus-4-6-thinking' },
    { type: 'agent', t: NOW - 26 * H, model: 'claude-opus-4-6-thinking', ok: false, error: 'timeout', ms: 600000 },
    { type: 'agent', t: NOW - 40 * 24 * H, model: 'x', ok: true }, // di luar periode
    { type: 'msg', t: NOW - H, dir: 'in', chat: 'a@s', name: 'Andika' },
    { type: 'msg', t: NOW - H, dir: 'out', chat: 'a@s', file: { name: 'a.pdf' } }
  ];
  const u = summarizeUsage(ev, { days: 7, now: NOW });
  assert.equal(u.perDay.length, 7);
  assert.equal(u.perDay.at(-1).day, '2026-11-21');
  assert.deepEqual(u.totals, { calls: 4, ok: 3, failed: 0, timeouts: 1, fallbacks: 1, msgIn: 1, msgOut: 1, files: 1, medianMs: 8000 });
  assert.equal(u.perDay.at(-1).byModel['gemini-3.8-flash-high'], 2);
  const opus = u.models.find(m => m.model === 'claude-opus-4-6-thinking');
  assert.equal(opus.calls, 2);
  assert.equal(opus.timeouts, 1);
  assert.equal(opus.medianMs, 40000);
  assert.equal(u.models[0].calls, 2);
  assert.deepEqual(u.topContacts, [{ chat: 'a@s', name: 'Andika', group: false, count: 1 }]);
});

test('daftar percakapan & linimasa urut waktu', () => {
  const ev = [
    { type: 'msg', t: 10, dir: 'in', chat: 'a', name: 'Budi', text: 'Joko halo' },
    { type: 'msg', t: 30, dir: 'out', chat: 'a', text: 'Halo Budi' },
    { type: 'agent', t: 20, chat: 'a', model: 'm', ok: true },
    { type: 'msg', t: 50, dir: 'in', chat: 'g@g.us', name: 'Sari', group: true, text: 'Joko rekap' },
    { type: 'msg', t: 60, dir: 'out', chat: 'g@g.us', file: { name: 'rekap.pdf' } }
  ];
  const list = listConversations(ev);
  assert.deepEqual(list.map(c => c.chat), ['g@g.us', 'a']);
  assert.equal(list[0].lastText, '📎 rekap.pdf');
  assert.equal(list[0].group, true);
  assert.equal(list[1].name, 'Budi');
  assert.deepEqual(conversationMessages(ev, 'a').map(e => e.t), [10, 20, 30]);
});

test('summarizeTools: statistik per tool & panggilan terakhir', () => {
  const ev = [
    { type: 'tool', t: NOW - 5000, name: 'cari_berita', ok: true, ms: 1200, source: 'agen', hint: 'AI' },
    { type: 'tool', t: NOW - 4000, name: 'cari_berita', ok: false, ms: 300, error: 'topik wajib diisi', source: 'panel' },
    { type: 'tool', t: NOW - 3000, name: 'buat_file', ok: true, ms: 4000 },
    { type: 'agent', t: NOW - 2000, model: 'x', ok: true, ms: 9000 },
    { type: 'msg', t: NOW - 1000, dir: 'in', chat: 'a', text: 'hai' }
  ];
  const s = summarizeTools(ev);
  assert.equal(s.total, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.stats.cari_berita.calls, 2);
  assert.equal(s.stats.cari_berita.failed, 1);
  assert.equal(s.stats.cari_berita.lastError, 'topik wajib diisi');
  assert.equal(s.stats.cari_berita.avgMs, 750);
  assert.equal(s.stats.cari_berita.lastAt, NOW - 4000);
  assert.equal(s.stats.buat_file.medianMs, 4000);
  assert.equal(s.recent[0].name, 'buat_file');
  assert.equal(s.recent[0].source, 'agen');
  assert.equal(s.recent[1].error, 'topik wajib diisi');
  assert.equal(summarizeTools(ev, { recent: 1 }).recent.length, 1);
  // kejadian tool tidak mengganggu ringkasan lain
  assert.equal(summarizeUsage(ev, { days: 1, now: NOW }).totals.calls, 1);
  assert.equal(listConversations(ev).length, 1);
});
