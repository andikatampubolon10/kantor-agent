import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickModel, fallbackModel, DEFAULT_HEAVY_MODEL, DEFAULT_LIGHT_MODEL,
  normalizeModelSettings, effectiveModelConfig, builtinTriggers
} from '../model-router.mjs';
import { buildAgyCliArgs } from '../agy-cli.mjs';

const env = {};

test('tugas file, laporan, analisis -> model berat', () => {
  for (const t of [
    'buatkan file CSV contoh pengeluaran mingguan',
    'tolong export ke Excel ya',
    'bikin PDF laporan bulan ini',
    'buat presentasi 5 slide tentang AI',
    'buatkan grafik penjualan',
    'tolong analisis data ini',
    'analisa kelebihan dan kekurangan dua HP ini',
    'bandingkan paket internet Telkomsel dan XL',
    'susun proposal kegiatan 17an',
    'rekap pengeluaran minggu ini',
    'buatkan surat izin tidak masuk kerja'
  ]) {
    const r = pickModel(t, { env });
    assert.equal(r.model, DEFAULT_HEAVY_MODEL, t);
    assert.equal(r.tier, 'berat', t);
  }
});

test('obrolan & pertanyaan cepat -> model ringan', () => {
  for (const t of [
    'halo', 'apa kabar', 'makasih kak', 'bus 10H kapan datang?', 'jam berapa sekarang',
    'ingatkan saya minum air tiap 2 jam', 'siapa presiden pertama Indonesia?', 'bagaimana hasilnya ?', ''
  ]) {
    const r = pickModel(t, { env });
    assert.equal(r.model, DEFAULT_LIGHT_MODEL, t);
    assert.equal(r.tier, 'ringan', t);
  }
});

test('kata kunci hanya cocok sebagai kata utuh', () => {
  assert.equal(pickModel('profilenya bagus', { env }).tier, 'ringan');
  assert.equal(pickModel('wordpress error', { env }).tier, 'ringan');
  assert.equal(pickModel('kirim filenya', { env }).tier, 'ringan'); // "filenya" bukan "file"
});

test('model bisa diatur lewat env & routing bisa dimatikan', () => {
  const custom = { JOKO_MODEL_HEAVY: 'claude-sonnet-4-6', JOKO_MODEL_LIGHT: 'gemini-3.8-flash-low' };
  assert.equal(pickModel('buat laporan', { env: custom }).model, 'claude-sonnet-4-6');
  assert.equal(pickModel('halo', { env: custom }).model, 'gemini-3.8-flash-low');
  assert.equal(pickModel('buat laporan PDF', { env: { JOKO_MODEL_ROUTING: 'off' } }).model, DEFAULT_LIGHT_MODEL);
  assert.equal(fallbackModel({}), DEFAULT_LIGHT_MODEL);
});

test('pengaturan panel menang atas env, kata pemicu tambahan & mode', () => {
  const settings = normalizeModelSettings({ heavy: 'claude-sonnet-4-6', routing: 'otomatis', extraHeavy: 'Anggaran\nrencana kerja, anggaran', fallbackEnabled: false });
  assert.deepEqual(settings.extraHeavy, ['anggaran', 'rencana kerja']);
  assert.equal(pickModel('buat laporan', { env: { JOKO_MODEL_HEAVY: 'claude-opus-4-6-thinking' }, settings }).model, 'claude-sonnet-4-6');
  const r = pickModel('tolong susun Rencana Kerja minggu depan', { env, settings });
  assert.equal(r.tier, 'berat');
  assert.match(r.reason, /rencana kerja/);
  assert.equal(pickModel('anggarannya berapa', { env, settings }).tier, 'ringan'); // kata utuh
  assert.equal(pickModel('halo', { env, settings: { routing: 'berat' } }).tier, 'berat');
  assert.equal(pickModel('buat PDF', { env, settings: { routing: 'ringan' } }).tier, 'ringan');
  assert.equal(fallbackModel(env, settings), null);
  assert.equal(fallbackModel(env, { fallback: 'gemini-3.8-flash-low' }), 'gemini-3.8-flash-low');
  assert.equal(effectiveModelConfig({ env, settings: null }).source, 'env/bawaan');
  assert.throws(() => normalizeModelSettings({ heavy: 'x; rm -rf /' }), /tidak valid/);
  assert.throws(() => normalizeModelSettings({ routing: 'acak' }), /routing/);
  assert.throws(() => normalizeModelSettings({ extraHeavy: ['a(b'] }), /pemicu/);
  assert.ok(builtinTriggers().laporan.includes('rekap(an)'));
});

test('argumen CLI --model hanya untuk nama model yang valid', () => {
  const a = buildAgyCliArgs({ prompt: 'x', timeoutMs: 60000, model: 'claude-opus-4-6-thinking' });
  assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'claude-opus-4-6-thinking']);
  assert.deepEqual(a.slice(-2), ['-p', 'x']);
  assert.equal(buildAgyCliArgs({ prompt: 'x', timeoutMs: 60000, model: 'x; rm -rf /' }).includes('--model'), false);
  assert.equal(buildAgyCliArgs({ prompt: 'x', timeoutMs: 60000 }).includes('--model'), false);
});

test('daftar model live: parse "agy models", gabung catatan, cari dari ketikan bebas', async () => {
  const { parseAgyModels, mergeModelCatalog, findModel, KNOWN_MODELS } = await import('../model-router.mjs');
  const out = 'Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
  const live = parseAgyModels(out);
  assert.deepEqual(live.map(m => m.id), ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6']);
  const cat = mergeModelCatalog(live);
  assert.equal(cat[0].note, 'penalaran tinggi');
  assert.equal(cat[2].note, KNOWN_MODELS.find(k => k.id === 'claude-opus-4-6-thinking').note);
  assert.equal(mergeModelCatalog([]).length, KNOWN_MODELS.length, 'agy tidak bisa dihubungi -> daftar bawaan');
  assert.equal(findModel('hydrogen medium', cat).model.id, 'gemini-4-hydrogen-medium');
  assert.equal(findModel('opus', cat).model.id, 'claude-opus-4-6-thinking');
  assert.equal(findModel('gemini-4-hydrogen-high', cat).model.id, 'gemini-4-hydrogen-high');
  assert.deepEqual(findModel('hydrogen', cat).ambiguous.map(m => m.id), ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium']);
  assert.ok(findModel('gpt-5', cat).notFound);
});

test('perintah model WhatsApp', async () => {
  const { parseModelCommand } = await import('../model-router.mjs');
  assert.deepEqual(parseModelCommand('Joko model'), { kind: 'show' });
  assert.deepEqual(parseModelCommand('joko, model apa yang dipakai sekarang?'), { kind: 'show' });
  assert.deepEqual(parseModelCommand('Joko reset model'), { kind: 'reset' });
  assert.deepEqual(parseModelCommand('Joko ganti model ringan ke hydrogen medium'), { kind: 'set', slot: 'light', query: 'hydrogen medium' });
  assert.deepEqual(parseModelCommand('Joko pakai model berat gemini-4-hydrogen-high'), { kind: 'set', slot: 'heavy', query: 'gemini-4-hydrogen-high' });
  assert.deepEqual(parseModelCommand('Joko ganti model semua jadi opus'), { kind: 'set', slot: 'all', query: 'opus' });
  assert.deepEqual(parseModelCommand('Joko ganti model ke sonnet'), { kind: 'set', slot: 'light', query: 'sonnet' });
  assert.equal(parseModelCommand('Joko jelaskan model bisnis startup'), null);
  assert.equal(parseModelCommand('Joko buat model 3D rumah'), null);
});
