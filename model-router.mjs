/**
 * Pemilihan model Antigravity per permintaan.
 * ------------------------------------------------------------
 *  - Tugas BERAT (membuat file, laporan, analisis) -> model kuat (bawaan Claude Opus 4.6 Thinking).
 *  - Obrolan biasa & pertanyaan cepat -> model ringan (bawaan Gemini 3.8 Flash High):
 *    cepat dan hemat kuota.
 * Dapat diatur lewat env: JOKO_MODEL_HEAVY, JOKO_MODEL_LIGHT, JOKO_MODEL_ROUTING=off
 * (off = selalu model ringan).
 */

export const DEFAULT_HEAVY_MODEL = 'claude-opus-4-6-thinking';
export const DEFAULT_LIGHT_MODEL = 'gemini-3.8-flash-high';

// Kata kunci dicocokkan sebagai kata utuh (huruf kecil). Urutan = prioritas alasan di log.
const HEAVY_PATTERNS = [
  // Format file / keluaran berkas
  ['file', /\b(pdf|excel|xlsx|xls|spreadsheet|word|docx|pptx?|powerpoint|csv|slides?|presentasi|infografis)\b/],
  ['file', /\b(grafik|chart|diagram|tabel)\b/],
  ['file', /\b(file|berkas|dokumen)\b/],
  // Jenis dokumen / laporan
  ['laporan', /\b(laporan|report|rekap(an)?|rekapitulasi|proposal|surat|notulen|notula|makalah|esai|essay|artikel|ringkasan eksekutif|memo|sop|cv)\b/],
  // Analisis & penalaran panjang
  ['analisis', /\b(analisis|analisa|menganalisis|menganalisa|analyze|analysis|evaluasi|kajian|mengkaji|riset|research|perbandingan|bandingkan|membandingkan|proyeksi|prediksi|forecast|strategi|swot|audit|insight)\b/]
];

/**
 * @param {string} text permintaan pengguna (tanpa konteks tambahan)
 * @param {{ env?: object }} [opts]
 * @returns {{ model: string, tier: 'berat'|'ringan', reason: string }}
 */
export function pickModel(text, { env = process.env } = {}) {
  const heavy = String(env.JOKO_MODEL_HEAVY || DEFAULT_HEAVY_MODEL).trim();
  const light = String(env.JOKO_MODEL_LIGHT || DEFAULT_LIGHT_MODEL).trim();
  if (String(env.JOKO_MODEL_ROUTING || '').toLowerCase() === 'off') {
    return { model: light, tier: 'ringan', reason: 'routing dimatikan' };
  }
  const t = String(text || '').toLowerCase();
  for (const [reason, re] of HEAVY_PATTERNS) {
    const m = t.match(re);
    if (m) return { model: heavy, tier: 'berat', reason: `${reason}: "${m[0]}"` };
  }
  return { model: light, tier: 'ringan', reason: 'obrolan/pertanyaan cepat' };
}

/** Model cadangan bila model berat gagal (mis. kuota habis). */
export function fallbackModel(env = process.env) {
  return String(env.JOKO_MODEL_LIGHT || DEFAULT_LIGHT_MODEL).trim();
}
