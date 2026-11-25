/**
 * Pemilihan model Antigravity per permintaan.
 * ------------------------------------------------------------
 *  - Tugas BERAT (membuat file, laporan, analisis) -> model kuat (bawaan Claude Opus 4.6 Thinking).
 *  - Obrolan biasa & pertanyaan cepat -> model ringan (bawaan Gemini 3.8 Flash High):
 *    cepat dan hemat kuota.
 * Dapat diatur lewat env: JOKO_MODEL_HEAVY, JOKO_MODEL_LIGHT, JOKO_MODEL_ROUTING=off
 * (off = selalu model ringan), atau lewat panel admin (/admin) yang menyimpan pengaturan
 * ke .joko-settings.json — pengaturan panel menang atas env.
 */

export const DEFAULT_HEAVY_MODEL = 'claude-opus-4-6-thinking';
export const DEFAULT_LIGHT_MODEL = 'gemini-3.8-flash-high';

/** Model yang dikenal Antigravity CLI (pilihan di panel admin). */
export const KNOWN_MODELS = [
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking', note: 'paling kuat, lebih lambat' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', note: 'kuat & lebih cepat' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High', note: 'cepat, hemat kuota' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash Medium', note: 'lebih cepat' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash Low', note: 'tercepat' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B Medium', note: 'alternatif' }
];

export const MODEL_NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Keluaran `agy models` ("<id>\t<label>" per baris) -> [{ id, label }] */
export function parseAgyModels(text) {
  return String(text || '').split(/\r?\n/)
    .map(l => l.match(/^\s*([A-Za-z0-9._-]{1,80})\s*\t\s*(.+?)\s*$/))
    .filter(Boolean)
    .map(m => ({ id: m[1], label: m[2] }));
}

/** Daftar model live dari Antigravity (urutan aslinya), diberi catatan bila dikenal; kosong -> daftar bawaan. */
export function mergeModelCatalog(live, known = KNOWN_MODELS) {
  if (!live?.length) return known.map(k => ({ ...k, live: false }));
  const note = (id) => known.find(k => k.id === id)?.note
    || (/xhigh/.test(id) ? 'penalaran terdalam, paling lambat' : /-high$/.test(id) ? 'penalaran tinggi' : /-medium$/.test(id) ? 'seimbang' : /-low$/.test(id) ? 'tercepat' : 'model baru');
  return live.map(m => ({ id: m.id, label: m.label, note: note(m.id), live: true }));
}

const tokens = (s) => String(s || '').toLowerCase().replace(/[()]/g, ' ').split(/[\s._-]+/).filter(Boolean);

/**
 * Cari model dari ketikan bebas ("hydrogen medium", "opus", "gemini-4-hydrogen-high").
 * -> { model } | { ambiguous: [...] } | { notFound: true }
 */
export function findModel(query, models) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { notFound: true };
  const exact = models.find(m => m.id.toLowerCase() === q);
  if (exact) return { model: exact };
  const qt = tokens(q);
  const hits = models.filter(m => { const t = new Set([...tokens(m.id), ...tokens(m.label)]); return qt.every(x => t.has(x) || [...t].some(y => y.startsWith(x) && x.length >= 3)); });
  if (hits.length === 1) return { model: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return { notFound: true };
}

/**
 * Perintah WhatsApp owner:
 *   "Joko model" / "model apa" / "daftar model"           -> { kind: 'show' }
 *   "Joko ganti model ringan ke hydrogen medium"          -> { kind: 'set', slot: 'light', query }
 *   slot: berat | ringan | cadangan | semua (tanpa slot = ringan)
 *   "Joko reset model" / "model bawaan"                    -> { kind: 'reset' }
 */
export function parseModelCommand(text) {
  const t = String(text || '').trim().replace(/^[!/]?joko[,:\s]+/i, '').replace(/[.!?]+$/, '').trim();
  if (/^((status|daftar|cek|lihat)\s+)?model(\s+(apa|sekarang|yang\s+dipakai))?$/i.test(t) || /^model\s+apa\s+(yang\s+)?(dipakai|sekarang)/i.test(t)) return { kind: 'show' };
  if (/^(reset|kembalikan)\s+model(\s+ke)?(\s+bawaan)?$|^model\s+bawaan$/i.test(t)) return { kind: 'reset' };
  const m = t.match(/^(?:ganti|pakai|ubah|set|gunakan)\s+model\s+(?:(berat|ringan|cadangan|semua)\s+)?(?:ke\s+|jadi\s+|=\s*)?(.+)$/i);
  if (!m) return null;
  const slot = { berat: 'heavy', ringan: 'light', cadangan: 'fallback', semua: 'all' }[String(m[1] || 'ringan').toLowerCase()];
  return { kind: 'set', slot, query: m[2].trim() };
}
export const ROUTING_MODES = ['otomatis', 'ringan', 'berat'];

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

/** Kata pemicu bawaan per kelompok, untuk ditampilkan di panel admin. */
export function builtinTriggers() {
  const groups = {};
  for (const [reason, re] of HEAVY_PATTERNS) {
    const words = re.source.replace(/^\\b\(|\)\\b$/g, '').split('|')
      .map(w => w.replace(/\(([^)]*)\)\?/g, '($1)').replace(/(\w)\?/g, '($1)'));
    (groups[reason] ||= []).push(...words);
  }
  return groups;
}

// Pengaturan dari panel admin (null = pakai env/bawaan). Diisi wa-assistant saat start & saat disimpan.
let activeSettings = null;
export function setModelSettings(settings) { activeSettings = settings ? normalizeModelSettings(settings) : null; }
export function getModelSettings() { return activeSettings; }

/**
 * Validasi & rapikan pengaturan model dari panel. Melempar Error berbahasa Indonesia bila tidak valid.
 * @returns {{ heavy?: string, light?: string, fallback?: string, routing?: string, fallbackEnabled?: boolean, extraHeavy?: string[] }}
 */
export function normalizeModelSettings(input = {}) {
  const out = {};
  for (const k of ['heavy', 'light', 'fallback']) {
    const v = input[k] == null ? '' : String(input[k]).trim();
    if (!v) continue;
    if (!MODEL_NAME_RE.test(v)) throw new Error(`Nama model "${v.slice(0, 40)}" tidak valid.`);
    out[k] = v;
  }
  if (input.routing != null && input.routing !== '') {
    if (!ROUTING_MODES.includes(input.routing)) throw new Error('Mode routing harus otomatis, ringan, atau berat.');
    out.routing = input.routing;
  }
  if (input.fallbackEnabled != null) out.fallbackEnabled = input.fallbackEnabled !== false;
  if (input.extraHeavy != null) {
    const list = Array.isArray(input.extraHeavy) ? input.extraHeavy : String(input.extraHeavy).split(/[,\n]/);
    out.extraHeavy = [...new Set(list.map(w => String(w).trim().toLowerCase()).filter(Boolean))];
    if (out.extraHeavy.length > 50) throw new Error('Kata pemicu maksimal 50.');
    for (const w of out.extraHeavy) {
      if (w.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u.test(w)) throw new Error(`Kata pemicu "${w.slice(0, 40)}" tidak valid (pakai huruf/angka).`);
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Model berat, ringan, cadangan & mode yang berlaku sekarang (panel > env > bawaan). */
export function effectiveModelConfig({ env = process.env, settings = activeSettings } = {}) {
  const s = settings || {};
  const light = s.light || String(env.JOKO_MODEL_LIGHT || DEFAULT_LIGHT_MODEL).trim();
  return {
    heavy: s.heavy || String(env.JOKO_MODEL_HEAVY || DEFAULT_HEAVY_MODEL).trim(),
    light,
    routing: s.routing || (String(env.JOKO_MODEL_ROUTING || '').toLowerCase() === 'off' ? 'ringan' : 'otomatis'),
    fallback: s.fallback || light,
    fallbackEnabled: s.fallbackEnabled !== false,
    extraHeavy: s.extraHeavy || [],
    source: settings ? 'panel' : 'env/bawaan'
  };
}

/**
 * @param {string} text permintaan pengguna (tanpa konteks tambahan)
 * @param {{ env?: object, settings?: object }} [opts]
 * @returns {{ model: string, tier: 'berat'|'ringan', reason: string }}
 */
export function pickModel(text, { env = process.env, settings = activeSettings } = {}) {
  const cfg = effectiveModelConfig({ env, settings });
  if (cfg.routing === 'ringan') return { model: cfg.light, tier: 'ringan', reason: 'routing dimatikan (selalu ringan)' };
  if (cfg.routing === 'berat') return { model: cfg.heavy, tier: 'berat', reason: 'selalu model berat' };
  const t = String(text || '').toLowerCase();
  for (const [reason, re] of HEAVY_PATTERNS) {
    const m = t.match(re);
    if (m) return { model: cfg.heavy, tier: 'berat', reason: `${reason}: "${m[0]}"` };
  }
  for (const w of cfg.extraHeavy) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, 'u').test(t)) {
      return { model: cfg.heavy, tier: 'berat', reason: `kata pemicu: "${w}"` };
    }
  }
  return { model: cfg.light, tier: 'ringan', reason: 'obrolan/pertanyaan cepat' };
}

/** Model cadangan bila model berat gagal (mis. kuota habis); null bila cadangan dimatikan. */
export function fallbackModel(env = process.env, settings = activeSettings) {
  const cfg = effectiveModelConfig({ env, settings });
  return cfg.fallbackEnabled ? cfg.fallback : null;
}
