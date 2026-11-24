import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createState, executeOrder, validateOrder, markToMarket, computeStats, equityOf, benchmarkEquity,
  parseDecision, applyDecision, buildDecisionPrompt, rsi, sma, indicators, maxDrawdown, TradeRuleError, DecisionParseError,
  checkExits, evaluateDecisions, evaluationSummary, marketSnapshot
} from '../paper-trading.mjs';
import { createTradingRunner, formatReport } from '../trading-runner.mjs';

const T0 = Date.parse('2026-11-21T03:00:00Z'); // 10.00 WIB
const mkt = (btc = 1_000_000_000, eth = 30_000_000, t = T0) => ({
  btc_idr: { bid: btc, ask: btc + btc / 1000, last: btc, high: btc, low: btc, t },
  eth_idr: { bid: eth, ask: eth + eth / 1000, last: eth, high: eth, low: eth, t }
});
const LV = { btc_idr: { stop: 950_000_000, target: 1_100_000_000 }, eth_idr: { stop: 28_500_000, target: 33_000_000 } };
const fresh = () => createState({ now: T0, market: mkt() });

test('beli di harga ask dengan biaya; jual di bid; laba/rugi terealisasi benar', () => {
  const s = fresh();
  const buy = executeOrder(s, mkt(), { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_000_000 }, { now: T0, reason: 'uji' });
  assert.equal(buy.price, 1_001_000_000);
  assert.equal(s.cash, 9_000_000);
  assert.ok(Math.abs(s.positions.btc_idr.qty - (1_000_000 * 0.997) / 1_001_000_000) < 1e-15);
  assert.equal(buy.feeIdr, 3000);
  // Harga naik 10%, jual semua
  const up = mkt(1_100_000_000);
  const sell = executeOrder(s, up, { pair: 'btc_idr', side: 'jual', portion: 1 }, { now: T0 + 1000 });
  const gross = buy.qty * 1_100_000_000;
  assert.equal(sell.valueIdr, Math.round(gross));
  assert.equal(sell.realizedPnl, Math.round(gross * 0.997 - 1_000_000));
  assert.equal(s.positions.btc_idr, undefined);
  assert.ok(Math.abs(s.cash - (9_000_000 + gross * 0.997)) < 1e-6);
});

test('aturan risiko ditegakkan kode', () => {
  const s = fresh();
  const m = mkt();
  const bad = (order, re) => assert.throws(() => validateOrder(s, m, order, T0), (e) => e instanceof TradeRuleError && re.test(e.message));
  bad({ pair: 'doge_idr', side: 'beli', amountIdr: 100_000 }, /tidak diizinkan/);
  bad({ pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 2_500_000 }, /20% ekuitas/);
  bad({ pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 10_000 }, /minimal/);
  bad({ pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: -5 }, /tidak valid/);
  bad({ pair: 'btc_idr', side: 'jual', portion: 1 }, /tidak memiliki/);
  bad({ pair: 'btc_idr', side: 'short', amountIdr: 100_000 }, /beli.*jual/);
  assert.throws(() => validateOrder(s, mkt(1e9, 3e7, T0 - 10 * 60 * 1000), { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 100_000 }, T0), /basi/);
  // Batas posisi 50%: 2 order 20% boleh, order ketiga melewati 50%
  executeOrder(s, m, { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_900_000 }, { now: T0 });
  executeOrder(s, m, { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_900_000 }, { now: T0 });
  bad({ pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_500_000 }, /50% ekuitas/);
  s.paused = true;
  bad({ pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 100_000 }, /dijeda/);
});

test('batas transaksi harian & kas tidak cukup', () => {
  const s = fresh();
  s.rules = { ...s.rules, maxTradesPerDay: 2, maxOrderPct: 1, maxPositionPct: 1 };
  const m = mkt();
  executeOrder(s, m, { pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 100_000 }, { now: T0 });
  executeOrder(s, m, { pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 100_000 }, { now: T0 });
  assert.throws(() => validateOrder(s, m, { pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 100_000 }, T0), /2 transaksi per hari/);
  const s2 = fresh();
  s2.rules = { ...s2.rules, maxOrderPct: 1, maxPositionPct: 1 };
  assert.throws(() => validateOrder(s2, m, { pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 10_000_001 }, T0), /kas tidak cukup/);
});

test('batas rugi harian menghentikan trading lalu lepas otomatis besok', () => {
  const s = fresh();
  executeOrder(s, mkt(), { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_900_000 }, { now: T0 });
  executeOrder(s, mkt(), { pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 1_900_000 }, { now: T0 });
  assert.equal(markToMarket(s, mkt(), T0 + 1000), null);
  const crash = mkt(700_000_000, 21_000_000, T0 + 2000); // -30% -> rugi ~1,2 jt (>3%)
  const h = markToMarket(s, crash, T0 + 2000);
  assert.equal(h.kind, 'harian');
  assert.throws(() => validateOrder(s, crash, { pair: 'btc_idr', side: 'jual', portion: 1 }, T0 + 2000), /dihentikan/);
  const tomorrow = T0 + 86400000;
  markToMarket(s, mkt(700_000_000, 21_000_000, tomorrow), tomorrow);
  assert.equal(s.halted, null, 'lepas otomatis di hari baru');
  assert.equal(s.dayStart.day, '2026-11-22');
});

test('statistik: ekuitas, benchmark beli-lalu-diam, drawdown, win rate', () => {
  const s = fresh();
  assert.equal(equityOf(s, mkt()), 10_000_000);
  assert.equal(benchmarkEquity(s, mkt(1_100_000_000, 33_000_000)), 11_000_000);
  executeOrder(s, mkt(), { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_000_000 }, { now: T0 });
  executeOrder(s, mkt(1_200_000_000), { pair: 'btc_idr', side: 'jual', portion: 1 }, { now: T0 });
  const st = computeStats(s, mkt());
  assert.equal(st.closedTrades, 1);
  assert.equal(st.winRate, 1);
  assert.equal(st.trades, 2);
  assert.ok(st.feesPaid > 0);
  assert.equal(maxDrawdown([{ equity: 100 }, { equity: 120 }, { equity: 90 }, { equity: 130 }]), 0.25);
});

test('indikator: SMA & RSI', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1], 2), null);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => i)), 100);
  const flat = rsi([10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10]);
  assert.ok(flat > 40 && flat < 60);
  const ind = indicators(Array.from({ length: 50 }, (_, i) => 100 + i));
  assert.equal(ind.last, 149);
  assert.ok(ind.change24h > 0 && ind.sma12 > ind.sma48);
});

test('parseDecision: blok resmi, JSON longgar, dan format salah', () => {
  const d = parseDecision('Analisa...\n```keputusan-trading\n{"analisis":"tren naik","aksi":[{"pair":"BTC_IDR","sisi":"beli","jumlah_idr":500000,"batal":950000000,"target":1100000000,"alasan":"SMA12>SMA48"},{"pair":"eth_idr","sisi":"jual","porsi":0.5}]}\n```');
  assert.equal(d.analysis, 'tren naik');
  assert.deepEqual(d.actions[0], { pair: 'btc_idr', side: 'beli', amountIdr: 500000, portion: undefined, stop: 950000000, target: 1100000000, reason: 'SMA12>SMA48' });
  assert.equal(d.actions[1].portion, 0.5);
  assert.deepEqual(parseDecision('{"analisis":"tahan","aksi":[]}').actions, []);
  assert.throws(() => parseDecision('tidak ada json'), DecisionParseError);
  assert.throws(() => parseDecision('```keputusan-trading\n{"aksi": "beli"}\n```'), DecisionParseError);
  const many = parseDecision(JSON.stringify({ aksi: Array.from({ length: 9 }, () => ({ pair: 'btc_idr', sisi: 'beli', jumlah_idr: 60000 })) }));
  assert.equal(many.actions.length, 4, 'maksimal 4 aksi');
});

test('applyDecision: aksi valid dieksekusi, pelanggaran ditolak dengan alasan', () => {
  const s = fresh();
  const { record, results } = applyDecision(s, mkt(), { analysis: 'a', actions: [
    { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_000_000, reason: 'ok' },
    { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 9_000_000, reason: 'kebesaran' },
    { pair: 'xrp_idr', side: 'beli', amountIdr: 100_000, reason: 'asing' }
  ] }, { now: T0, model: 'm' });
  assert.deepEqual(results.map(r => r.ok), [true, false, false]);
  assert.equal(record.actions[1].error, 'order melebihi 20% ekuitas');
  assert.equal(s.decisions.length, 1);
  assert.equal(s.trades[0].decisionId, record.id);
});

test('prompt memuat portofolio, pasar, aturan & larangan memakai tool', () => {
  const s = fresh();
  const p = buildDecisionPrompt({ state: s, market: mkt(), closes: { btc_idr: Array.from({ length: 50 }, (_, i) => 1e9 + i * 1e6) }, now: T0 });
  assert.match(p, /keputusan-trading/);
  assert.match(p, /JANGAN memakai tool/);
  assert.match(p, /btc_idr/);
  assert.match(p, /RSI14/);
});

test('prompt anti-FOMO: tanpa pembanding/hasil total, dengan larangan mengejar kenaikan', () => {
  const s = fresh();
  const p = buildDecisionPrompt({ state: s, market: mkt(), now: T0 });
  assert.doesNotMatch(p, /beli-lalu-diam|benchmark|mengalahkan|Modal awal/i, 'AI tidak diberi angka ketertinggalan');
  assert.match(p, /anti-FOMO/);
  assert.match(p, /JANGAN membeli karena harga sudah naik/);
  assert.match(p, /RSI14 > 70/);
  assert.match(p, /BATAL/);
  assert.match(p, /revenge trading/);
});

test('runner: mulai, analisis terjadwal, notifikasi, jeda/stop, data tersimpan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  const file = path.join(dir, 'trading.json');
  let t = T0;
  const notes = [];
  const prompts = [];
  const market = { snapshot: async () => mkt(1e9, 3e7, t), closes: async () => Array.from({ length: 72 }, (_, i) => 1e9 + i) };
  const decide = async (prompt) => { prompts.push(prompt); return { text: '```keputusan-trading\n{"analisis":"uji","aksi":[{"pair":"btc_idr","sisi":"beli","jumlah_idr":1000000,"batal":950000000,"target":1100000000,"alasan":"uji beli"}]}\n```', model: 'model-uji' }; };
  const r = createTradingRunner({ file, market, decide, notify: async (x) => notes.push(x), now: () => t, log: { log() {}, warn() {} } });
  await r.tick();
  assert.equal(prompts.length, 1, 'analisis pertama langsung jalan');
  assert.match(notes[0], /dimulai/);
  assert.match(notes.at(-1), /BELI BTC Rp1\.000\.000/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.trades.length, 1);
  assert.equal(saved.decisions[0].model, 'model-uji');
  t += 60 * 60 * 1000; await r.tick();
  assert.equal(prompts.length, 1, 'belum 4 jam');
  t += 3 * 60 * 60 * 1000 + 1; await r.tick();
  assert.equal(prompts.length, 2, 'analisis berikutnya setelah 4 jam');
  r.pause(true);
  await assert.rejects(r.runDecision('manual'), /dijeda/);
  r.resume();
  r.stop('uji stop');
  await assert.rejects(r.runDecision('manual'), /uji stop/);
  // Laporan harian pukul 21.00 WIB (14.00 UTC)
  r.resume();
  t = Date.parse('2026-11-21T14:05:00Z');
  const before = notes.length;
  await r.mark();
  assert.ok(notes.slice(before).some(n => /Laporan Paper Trading/.test(n)));
  await r.mark();
  assert.equal(notes.filter(n => /Laporan Paper Trading/.test(n)).length, 1, 'sekali sehari');
  // Data dimuat ulang oleh runner baru
  const r2 = createTradingRunner({ file, market, decide, now: () => t, log: { log() {}, warn() {} } });
  assert.equal(r2.status().state.trades.length, 2);
  assert.match(formatReport(r2.status().state, mkt()), /Ekuitas/);
});

test('runner: jawaban AI rusak dicatat sebagai keputusan gagal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  const r = createTradingRunner({
    file: path.join(dir, 't.json'),
    market: { snapshot: async () => mkt(), closes: async () => [] },
    decide: async () => ({ text: 'maaf saya tidak bisa', model: 'm' }),
    now: () => T0, log: { log() {}, warn() {} }
  });
  await assert.rejects(r.runDecision('manual'), DecisionParseError);
  const st = r.status().state;
  assert.equal(st.decisions.at(-1).ok, false);
  assert.equal(st.trades.length, 0);
});

test('runner: gagal -> diulang 15 menit kemudian; harga gagal setelah AI -> pakai harga analisis', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  let t = T0;
  let calls = 0;
  let failSnapshotAfterDecide = false;
  let snapshots = 0;
  const market = {
    snapshot: async () => { snapshots++; if (failSnapshotAfterDecide && snapshots > 2) throw new Error('timeout'); return mkt(1e9, 3e7, t); },
    closes: async () => []
  };
  const decide = async () => {
    calls++;
    if (calls === 1) throw new Error('agen sibuk');
    failSnapshotAfterDecide = true;
    return { text: '{"analisis":"x","aksi":[{"pair":"eth_idr","sisi":"beli","jumlah_idr":200000,"batal":28500000,"target":33000000,"alasan":"uji"}]}', model: 'm' };
  };
  const r = createTradingRunner({ file: path.join(dir, 't.json'), market, decide, now: () => t, log: { log() {}, warn() {} } });
  await r.tick();
  assert.equal(calls, 1);
  t += 5 * 60 * 1000; await r.tick();
  assert.equal(calls, 1, 'belum 15 menit');
  t += 11 * 60 * 1000; snapshots = 0; await r.tick();
  assert.equal(calls, 2, 'diulang setelah 15 menit');
  const st = r.status().state;
  assert.equal(st.trades.length, 1, 'order tetap dieksekusi dengan harga saat analisis');
  assert.equal(st.trades[0].pair, 'eth_idr');
});

test('runner: mulai setelah jam 21 WIB tidak langsung mengirim laporan harian', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  const notes = [];
  const t = Date.parse('2026-11-21T15:00:00Z'); // 22.00 WIB
  const r = createTradingRunner({ file: path.join(dir, 't.json'), market: { snapshot: async () => mkt(1e9, 3e7, t), closes: async () => [] }, decide: async () => ({ text: '{"aksi":[]}' }), notify: async (x) => notes.push(x), now: () => t, log: { log() {}, warn() {} } });
  await r.mark();
  assert.equal(notes.filter(n => /Laporan Paper Trading/.test(n)).length, 0);
});

test('runner: setelah restart harga langsung diambil walau belum jadwal catat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  const file = path.join(dir, 't.json');
  let t = T0;
  const market = { snapshot: async () => mkt(1e9, 3e7, t), closes: async () => [] };
  const quiet = { log() {}, warn() {} };
  const decide = async () => ({ text: '{"aksi":[]}', model: 'm' });
  const r1 = createTradingRunner({ file, market, decide, now: () => t, log: quiet });
  await r1.tick();
  const marks = JSON.parse(fs.readFileSync(file, 'utf8')).equity.length;
  t += 60 * 1000; // "restart" 1 menit kemudian
  const r2 = createTradingRunner({ file, market, decide, now: () => t, log: quiet });
  assert.equal(r2.status().stats, null);
  await r2.tick();
  assert.ok(r2.status().stats, 'statistik tersedia setelah tick pertama');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).equity.length, marks, 'tidak menambah titik catat di luar jadwal');
});

test('runner: candle yang macet dibatasi waktu, analisis tetap jalan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  const t = T0;
  const market = { snapshot: async () => mkt(1e9, 3e7, t), closes: () => new Promise(() => {}) }; // tidak pernah selesai
  let prompts = 0;
  const r = createTradingRunner({ file: path.join(dir, 't.json'), market, decide: async () => { prompts++; return { text: '{"aksi":[]}', model: 'm' }; }, now: () => t, log: { log() {}, warn() {} }, stepTimeoutMs: 20 });
  const rec = await r.runDecision('manual');
  assert.equal(prompts, 1);
  assert.ok(rec.id);
  assert.equal(r.status().deciding, false);
});

test('runner: watchdog melepas analisis macet; hasil terlambat diabaikan; jadwal lanjut', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  let t = T0;
  const market = { snapshot: async () => mkt(1e9, 3e7, t), closes: async () => [] };
  let release;
  let calls = 0;
  const decide = () => {
    calls++;
    if (calls === 1) return new Promise(res => { release = () => res({ text: '{"aksi":[]}', model: 'm' }); });
    return Promise.resolve({ text: '{"aksi":[]}', model: 'm' });
  };
  const warns = [];
  const r = createTradingRunner({ file: path.join(dir, 't.json'), market, decide, now: () => t, log: { log() {}, warn: (x) => warns.push(x) }, maxDecisionMs: 20 * 60 * 1000 });
  const stuck = r.runDecision('jadwal').catch(e => e);
  await new Promise(res => setImmediate(res));
  await new Promise(res => setImmediate(res));
  assert.equal(r.status().deciding, true);
  t += 21 * 60 * 1000;
  await r.tick(); // watchdog melepas, lalu analisis baru dijadwalkan (sudah lewat retryAfterMs)
  assert.ok(warns.some(w => /dilepas watchdog/.test(w)));
  assert.equal(calls, 2, 'analisis terjadwal berikutnya berjalan');
  assert.equal(r.status().state.decisions.length, 1);
  release();
  const err = await stuck;
  assert.match(err.message, /dibatalkan watchdog/);
  assert.equal(r.status().state.decisions.length, 1, 'hasil terlambat tidak dicatat');
  assert.equal(r.status().deciding, false);
});

test('runner: refreshIfStale mengambil harga live hanya bila sudah basi', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  let t = T0, calls = 0, btc = 1e9;
  const market = { snapshot: async () => { calls++; return mkt(btc, 3e7, t); }, closes: async () => [] };
  const r = createTradingRunner({ file: path.join(dir, 't.json'), market, decide: async () => ({ text: '{"aksi":[]}' }), now: () => t, log: { log() {}, warn() {} } });
  await r.mark();
  const n = calls;
  t += 5000; await r.refreshIfStale(20000);
  assert.equal(calls, n, 'masih segar');
  t += 30000; btc = 1.1e9; await r.refreshIfStale(20000);
  assert.equal(calls, n + 1);
  assert.equal(r.status().market.btc_idr.bid, 1.1e9, 'statistik memakai harga terbaru');
  assert.equal(r.status().state.equity.length, 1, 'tidak menambah titik kurva');
});

test('beli wajib level batal & target yang masuk akal', () => {
  const s = fresh();
  const m = mkt();
  const bad = (extra, re) => assert.throws(() => validateOrder(s, m, { pair: 'btc_idr', side: 'beli', amountIdr: 500_000, ...extra }, T0), (e) => e instanceof TradeRuleError && re.test(e.message));
  bad({}, /level batal .*wajib/);
  bad({ stop: 950_000_000 }, /target .*wajib/);
  bad({ stop: 999_000_000, target: 1.1e9 }, /terlalu dekat/);
  bad({ stop: 800_000_000, target: 1.1e9 }, /terlalu jauh/);
  bad({ stop: 950_000_000, target: 1_005_000_000 }, /target .*terlalu dekat/);
  bad({ stop: 950_000_000, target: 2e9 }, /tidak realistis/);
  const ok = validateOrder(s, m, { pair: 'btc_idr', side: 'beli', amountIdr: 500_000, ...LV.btc_idr }, T0);
  assert.equal(ok.stop, 950_000_000);
});

test('jual otomatis: stop-loss & take-profit, tetap jalan saat dihentikan, tidak makan kuota harian', () => {
  const s = fresh();
  s.rules = { ...s.rules, maxTradesPerDay: 2 };
  executeOrder(s, mkt(), { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_000_000 }, { now: T0 });
  executeOrder(s, mkt(), { pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 1_000_000 }, { now: T0 });
  assert.equal(s.positions.btc_idr.stop, 950_000_000);
  assert.deepEqual(checkExits(s, mkt(), T0 + 1000), [], 'harga di antara level: tidak ada aksi');
  s.halted = { kind: 'manual', reason: 'uji' };
  const t1 = T0 + 60_000;
  const exits = checkExits(s, mkt(940_000_000, 34_000_000, t1), t1);
  assert.deepEqual(exits.map(t => [t.pair, t.auto]).sort(), [['btc_idr', 'stop'], ['eth_idr', 'target']]);
  assert.ok(exits.find(t => t.auto === 'stop').realizedPnl < 0);
  assert.ok(exits.find(t => t.auto === 'target').realizedPnl > 0);
  assert.deepEqual(s.positions, {});
  assert.match(exits[0].reason, /otomatis/);
  s.halted = null;
  // 2 beli + 2 jual otomatis hari ini: batas 2 transaksi hanya menghitung yang bukan otomatis
  assert.throws(() => validateOrder(s, mkt(1e9, 3e7, t1), { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 100_000 }, t1), /2 transaksi per hari/);
  // harga basi -> tidak dieksekusi
  const s2 = fresh();
  executeOrder(s2, mkt(), { pair: 'btc_idr', side: 'beli', ...LV.btc_idr, amountIdr: 1_000_000 }, { now: T0 });
  assert.deepEqual(checkExits(s2, mkt(900_000_000, 3e7, T0), T0 + 10 * 60_000), []);
});

test('aksi "ubah" menggeser level posisi; posisi tanpa level tidak dijual otomatis', () => {
  const s = fresh();
  executeOrder(s, mkt(), { pair: 'eth_idr', side: 'beli', ...LV.eth_idr, amountIdr: 1_000_000 }, { now: T0 });
  const m2 = mkt(1e9, 32_000_000);
  const { results } = applyDecision(s, m2, { analysis: 'kunci laba', actions: [{ pair: 'eth_idr', side: 'ubah', stop: 31_000_000, target: 34_000_000, reason: 'naikkan batal' }] }, { now: T0 });
  assert.equal(results[0].ok, true);
  assert.equal(s.positions.eth_idr.stop, 31_000_000);
  assert.equal(s.trades.length, 1, 'ubah level bukan transaksi');
  assert.throws(() => validateOrder(s, m2, { pair: 'eth_idr', side: 'ubah', stop: 32_500_000, target: 34_000_000 }, T0), /terlalu dekat|di atas/);
  assert.throws(() => validateOrder(s, m2, { pair: 'btc_idr', side: 'ubah', stop: 9e8, target: 1.1e9 }, T0), /tidak memiliki/);
  delete s.positions.eth_idr.stop; delete s.positions.eth_idr.target;
  assert.deepEqual(checkExits(s, mkt(1e9, 1e7), T0), []);
});

test('evaluasi diri: hasil 4 & 24 jam setelah keputusan, ditandai tidak terukur bila Joko mati', () => {
  const s = fresh();
  const closes = { btc_idr: Array.from({ length: 50 }, () => 1e9), eth_idr: Array.from({ length: 50 }, () => 3e7) };
  const snap = marketSnapshot(mkt(), closes);
  assert.equal(snap.btc_idr.last, 1e9);
  assert.equal(snap.btc_idr.vsSma12, 0);
  applyDecision(s, mkt(), { analysis: 'beli', actions: [{ pair: 'btc_idr', side: 'beli', amountIdr: 1_000_000, ...LV.btc_idr, reason: 'x' }] }, { now: T0, snapshot: snap });
  applyDecision(s, mkt(), { analysis: 'tahan', actions: [] }, { now: T0 + 1000, snapshot: snap });
  const H = 3600_000;
  for (let t = T0; t <= T0 + 5 * H; t += 15 * 60_000) markToMarket(s, mkt(1e9 * (1 + (t - T0) / H / 100), 3e7, t), t);
  assert.ok(Math.abs(s.decisions[0].eval.h4.btc_idr - 0.04) < 1e-6, 'BTC +4% setelah 4 jam');
  assert.equal(s.decisions[0].eval.h4.eth_idr, 0);
  assert.equal('h24' in s.decisions[0].eval, false, 'belum 24 jam');
  // Joko mati sampai jam ke-30: 24 jam tidak terukur
  markToMarket(s, mkt(), T0 + 30 * H);
  evaluateDecisions(s, T0 + 30 * H);
  assert.equal(s.decisions[0].eval.h24, null);
  const sum = evaluationSummary(s);
  assert.equal(sum.lines.length, 2);
  assert.match(sum.lines[0], /BELI BTC .*4j: BTC \+4\.00%.*24j: tidak terukur/);
  assert.match(sum.lines[1], /TAHAN/);
  assert.match(sum.summary.join(' '), /Beli: 1x, tepat arah 100%/);
  const p = buildDecisionPrompt({ state: s, market: mkt(), now: T0 + 30 * H });
  assert.match(p, /Evaluasi keputusanmu sebelumnya/);
  assert.match(p, /KALIBRASI/);
  assert.match(p, /level batal/);
});

test('runner: stop-loss dijalankan di antara analisis & dinotifikasi', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-trade-'));
  let t = T0, btc = 1e9;
  const notes = [];
  const market = { snapshot: async () => mkt(btc, 3e7, t), closes: async () => [] };
  const decide = async () => ({ text: '{"analisis":"x","aksi":[{"pair":"btc_idr","sisi":"beli","jumlah_idr":1000000,"batal":950000000,"target":1100000000,"alasan":"uji"}]}', model: 'm' });
  const r = createTradingRunner({ file: path.join(dir, 't.json'), market, decide, notify: async (x) => notes.push(x), now: () => t, log: { log() {}, warn() {} } });
  await r.tick();
  assert.equal(r.status().state.positions.btc_idr.stop, 950_000_000);
  t += 60_000; btc = 940_000_000; await r.tick();
  assert.deepEqual(r.status().state.positions, {});
  assert.match(notes.at(-1), /jual otomatis[\s\S]*STOP-LOSS BTC/);
  assert.equal(r.status().state.decisions[0].snapshot.btc_idr.last, 1e9, 'snapshot keputusan tersimpan');
});
