/**
 * Penjalan paper trading Joko: data pasar Indodax + jadwal + penyimpanan + notifikasi.
 * ------------------------------------------------------------
 *  - Harga: API publik Indodax (tanpa API key; TIDAK ADA order sungguhan ke exchange).
 *  - Setiap 15 menit: catat nilai portofolio, tegakkan batas rugi harian.
 *  - Setiap `decisionEveryHours`: AI mengusulkan order -> diperiksa & dieksekusi paper-trading.mjs.
 *  - Laporan harian ke WhatsApp owner pukul 21.00 WIB; notifikasi setiap transaksi & penghentian.
 */
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import {
  createState, markToMarket, computeStats, buildDecisionPrompt, parseDecision, applyDecision,
  recordFailedDecision, positionValue, PAIR_LABEL, wibDay, DEFAULT_RULES
} from './paper-trading.mjs';

const UA = 'kantor-agent-paper-trading/1.0';
const rp = (n) => `Rp${Math.round(n).toLocaleString('id-ID')}`;
const pct = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`);

export function createIndodaxMarket({ fetchImpl = globalThis.fetch, timeoutMs = 15000, retries = 1, now = () => Date.now() } = {}) {
  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`Indodax HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        if (attempt >= retries) throw new Error(`data Indodax gagal diambil (${err.message})`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  const symbol = (pair) => pair.replace('_', '');
  return {
    async snapshot(pairs) {
      const out = {};
      await Promise.all(pairs.map(async (p) => {
        const d = (await getJson(`https://indodax.com/api/ticker/${symbol(p)}`))?.ticker;
        const bid = Number(d?.buy), ask = Number(d?.sell), last = Number(d?.last);
        if (!(bid > 0 && ask > 0 && last > 0)) throw new Error(`data harga ${p} tidak valid`);
        out[p] = { bid, ask, last, high: Number(d.high), low: Number(d.low), volIdr: Number(d.vol_idr), t: now() };
      }));
      return out;
    },
    async closes(pair, hours = 72) {
      const to = Math.floor(now() / 1000), from = to - hours * 3600;
      const rows = await getJson(`https://indodax.com/tradingview/history_v2?symbol=${symbol(pair).toUpperCase()}&tf=60&from=${from}&to=${to}`);
      if (!Array.isArray(rows)) return [];
      return rows.sort((a, b) => a.Time - b.Time).map(r => Number(r.Close)).filter(v => v > 0);
    }
  };
}

export function formatTradeNotice(trade) {
  const label = PAIR_LABEL[trade.pair] || trade.pair;
  const head = trade.side === 'beli' ? `🟢 BELI ${label} ${rp(trade.valueIdr)}` : `🔴 JUAL ${label} ${rp(trade.valueIdr)}`;
  const pnl = trade.realizedPnl != null ? ` · laba/rugi ${rp(trade.realizedPnl)}` : '';
  return `${head} @ ${rp(trade.price)}${pnl}\n   _${trade.reason || 'tanpa alasan'}_`;
}

export function formatReport(state, market, { title = '📊 *Laporan Paper Trading Joko*' } = {}) {
  const s = computeStats(state, market);
  const lines = [title, '_(uang simulasi, harga asli Indodax)_', ''];
  lines.push(`Ekuitas: *${rp(s.equity)}* (${pct(s.returnPct)})`);
  lines.push(`Beli-lalu-diam: ${rp(s.benchmarkEquity)} (${pct(s.benchmarkReturnPct)})`);
  lines.push(`Hari ini: ${s.dayPnl >= 0 ? '+' : ''}${rp(s.dayPnl)} · ${s.tradesToday} transaksi`);
  lines.push(`Total: ${s.trades} transaksi · biaya ${rp(s.feesPaid)} · drawdown maks ${(s.maxDrawdownPct * 100).toFixed(2)}%`);
  if (s.winRate != null) lines.push(`Win rate: ${(s.winRate * 100).toFixed(0)}% dari ${s.closedTrades} penjualan`);
  const pos = Object.entries(state.positions);
  lines.push('', `Kas: ${rp(s.cash)}`);
  for (const [p, v] of pos) {
    const val = positionValue(state, market, p);
    lines.push(`${PAIR_LABEL[p] || p}: ${rp(val)} (${pct((val - v.cost) / v.cost)})`);
  }
  if (state.halted) lines.push('', `⛔ Dihentikan: ${state.halted.reason}`);
  else if (state.paused) lines.push('', '⏸️ Sedang dijeda.');
  return lines.join('\n');
}

/**
 * decide(prompt) -> Promise<{ text, model }>  (pemanggil memakai antrean agen Joko)
 * notify(text)   -> Promise                  (WhatsApp owner)
 */
export function createTradingRunner({
  file, market, decide, notify = async () => {}, log = console, now = () => Date.now(),
  rules = DEFAULT_RULES, markEveryMs = 15 * 60 * 1000, reportHourWib = 21, tickMs = 60 * 1000,
  retryAfterMs = 15 * 60 * 1000
}) {
  let state = readJsonFile(file, null, { validate: d => d && typeof d === 'object' && d.version === 1 });
  let lastMarket = null;
  let deciding = false;
  let lastError = null;
  let timer = null;
  const save = () => { if (state) writeJsonAtomic(file, state); };
  const safeNotify = (text) => Promise.resolve().then(() => notify(text)).catch(err => log.warn?.(`[Trading] Notifikasi gagal: ${err.message}`));
  const pairs = () => state?.rules.pairs || rules.pairs;

  async function refreshMarket() {
    lastMarket = await market.snapshot(pairs());
    return lastMarket;
  }

  async function mark() {
    const m = await refreshMarket();
    const t = now();
    if (!state) {
      state = createState({ rules, now: t, market: m });
      // Mulai setelah jam laporan -> laporan pertama besok (bukan langsung saat mulai).
      state.meta = new Date(t + 7 * 3600 * 1000).getUTCHours() >= reportHourWib ? { lastReportDay: wibDay(t) } : {};
      log.log?.(`[Trading] 🧪 Paper trading dimulai dengan modal simulasi ${rp(state.rules.startingCash)}.`);
      await safeNotify(`🧪 *Paper trading Joko dimulai*\nModal simulasi ${rp(state.rules.startingCash)} · pair ${state.rules.pairs.map(p => PAIR_LABEL[p] || p).join(' & ')} · analisis tiap ${state.rules.decisionEveryHours} jam.\nTidak ada uang sungguhan. Perintah: "Joko status trading", "Joko stop trading".`);
    }
    state.meta ||= {};
    const halted = markToMarket(state, m, t);
    state.meta.lastMarkAt = t;
    save();
    if (halted) await safeNotify(`⛔ *Paper trading dihentikan*: ${halted.reason}.\n\n${formatReport(state, m, { title: '📊 Posisi saat ini' })}`);
    const hour = new Date(t + 7 * 3600 * 1000).getUTCHours();
    if (hour >= reportHourWib && state.meta.lastReportDay !== wibDay(t)) {
      state.meta.lastReportDay = wibDay(t);
      save();
      await safeNotify(formatReport(state, m));
    }
    return m;
  }

  async function runDecision(trigger = 'jadwal') {
    if (deciding) throw new Error('Analisis sebelumnya masih berjalan.');
    if (!state) await mark();
    if (state.paused) throw new Error('Trading sedang dijeda.');
    if (state.halted) throw new Error(`Trading dihentikan: ${state.halted.reason}`);
    deciding = true;
    try {
      const m = await mark();
      const closes = {};
      for (const p of pairs()) {
        try { closes[p] = await market.closes(p, 72); } catch (err) { closes[p] = []; log.warn?.(`[Trading] Candle ${p} gagal: ${err.message}`); }
      }
      const prompt = buildDecisionPrompt({ state, market: m, closes, now: now() });
      state.meta.lastAttemptAt = now();
      save();
      let out;
      try {
        out = await decide(prompt);
      } catch (err) {
        recordFailedDecision(state, { now: now(), trigger, error: `agen gagal: ${err.message}` });
        save();
        throw err;
      }
      let decision;
      try {
        decision = parseDecision(out.text);
      } catch (err) {
        recordFailedDecision(state, { now: now(), trigger, model: out.model, error: err.message });
        save();
        throw err;
      }
      // Harga bisa bergeser selama AI berpikir: eksekusi memakai harga terbaru. Bila gagal diambil,
      // pakai harga saat analisis (aturan "harga maks. 5 menit" tetap menolak harga yang basi).
      let fresh;
      try { fresh = await refreshMarket(); } catch (err) {
        log.warn?.(`[Trading] Harga terbaru gagal (${err.message}); memakai harga saat analisis.`);
        fresh = m;
      }
      const { record, results } = applyDecision(state, fresh, decision, { now: now(), model: out.model, trigger });
      state.meta.lastDecisionAt = now();
      save();
      const done = results.filter(r => r.ok);
      const rejected = results.filter(r => !r.ok);
      log.log?.(`[Trading] 🤖 Keputusan ${record.id}: ${done.length} dieksekusi, ${rejected.length} ditolak, ${results.length ? '' : 'tahan'}`.trim());
      if (done.length || rejected.length) {
        const parts = ['🤖 *Paper trading — keputusan Joko*', ...done.map(r => formatTradeNotice(r.trade))];
        for (const r of rejected) parts.push(`⚪ Ditolak sistem (${r.action.side} ${PAIR_LABEL[r.action.pair] || r.action.pair}): ${r.error}`);
        parts.push('', `Ekuitas: ${rp(computeStats(state, fresh).equity)}`);
        await safeNotify(parts.join('\n'));
      }
      lastError = null;
      return record;
    } catch (err) {
      lastError = { at: now(), message: err.message };
      throw err;
    } finally {
      deciding = false;
    }
  }

  async function tick() {
    try {
      const t = now();
      if (!state || !state.meta?.lastMarkAt || t - state.meta.lastMarkAt >= markEveryMs) await mark();
      const every = state.rules.decisionEveryHours * 3600 * 1000;
      const last = state.meta.lastDecisionAt || 0;
      const attempt = state.meta.lastAttemptAt || 0;
      // Jadwal normal tiap `every`; percobaan yang gagal diulang setelah retryAfterMs.
      if (!state.paused && !state.halted && !deciding && t - last >= every && t - attempt >= retryAfterMs) {
        await runDecision('jadwal').catch(err => log.warn?.(`[Trading] ⚠️ Analisis gagal: ${err.message}`));
      }
    } catch (err) {
      lastError = { at: now(), message: err.message };
      log.warn?.(`[Trading] ⚠️ ${err.message}`);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
      setTimeout(tick, 5000).unref?.();
    },
    stopTimers() { clearInterval(timer); timer = null; },
    tick,
    mark,
    runDecision,
    status() {
      const m = lastMarket;
      const every = (state?.rules.decisionEveryHours || rules.decisionEveryHours) * 3600 * 1000;
      return {
        started: !!state,
        state,
        market: m,
        stats: state && m ? computeStats(state, m) : null,
        deciding,
        lastError,
        nextDecisionAt: state && !state.paused && !state.halted
          ? Math.max((state.meta?.lastDecisionAt || 0) + every, (state.meta?.lastAttemptAt || 0) + retryAfterMs, now())
          : null
      };
    },
    report() { return state && lastMarket ? formatReport(state, lastMarket) : 'Paper trading belum dimulai.'; },
    pause(paused) {
      if (!state) throw new Error('Paper trading belum dimulai.');
      state.paused = !!paused; save();
      return state.paused;
    },
    stop(reason = 'dihentikan Mas Andika') {
      if (!state) throw new Error('Paper trading belum dimulai.');
      state.halted = { kind: 'manual', at: now(), reason }; save();
      return state.halted;
    },
    resume() {
      if (!state) throw new Error('Paper trading belum dimulai.');
      state.halted = null; state.paused = false; save();
    },
    async reset(startingCash) {
      const cash = Number(startingCash) || rules.startingCash;
      if (cash < 1_000_000 || cash > 1_000_000_000) throw new Error('Modal simulasi harus Rp1 juta – Rp1 miliar.');
      const m = await refreshMarket();
      state = createState({ rules: { ...rules, startingCash: cash }, now: now(), market: m });
      state.meta = { lastMarkAt: now() };
      markToMarket(state, m, now());
      save();
      return state;
    }
  };
}
