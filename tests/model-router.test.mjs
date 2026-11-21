import test from 'node:test';
import assert from 'node:assert/strict';
import { pickModel, fallbackModel, DEFAULT_HEAVY_MODEL, DEFAULT_LIGHT_MODEL } from '../model-router.mjs';
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

test('argumen CLI --model hanya untuk nama model yang valid', () => {
  const a = buildAgyCliArgs({ prompt: 'x', timeoutMs: 60000, model: 'claude-opus-4-6-thinking' });
  assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'claude-opus-4-6-thinking']);
  assert.deepEqual(a.slice(-2), ['-p', 'x']);
  assert.equal(buildAgyCliArgs({ prompt: 'x', timeoutMs: 60000, model: 'x; rm -rf /' }).includes('--model'), false);
  assert.equal(buildAgyCliArgs({ prompt: 'x', timeoutMs: 60000 }).includes('--model'), false);
});
