/**
 * Mesin dokumen Joko: spesifikasi JSON -> PDF / Excel / Word / PowerPoint / grafik PNG.
 * ------------------------------------------------------------
 * Murni Node.js + Chrome yang sudah terpasang (tidak butuh Python/LibreOffice).
 * Dipanggil lewat tool MCP "buat_file" (joko-tools.mjs). Semua file ditulis HANYA ke
 * folder outbox; nama file disanitasi sehingga tidak bisa keluar dari folder itu.
 *
 * Desain: tema warna dipilih sesuai topik (palet diadaptasi dari skill pptx Anthropic,
 * Apache-2.0 — lihat .agents/skills/SUMBER.md), tanpa ornamen khas "buatan AI"
 * (garis/batang aksen dekoratif). Angka turunan (total, porsi) dihitung mesin, bukan model.
 * Halaman PDF dirender tanpa JavaScript dan tanpa akses jaringan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, LevelFormat, Packer,
  PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType
} from 'docx';
import PptxGenJS from 'pptxgenjs';
import { getChromePath } from './browser-utils.mjs';
import { MEDIA_OUTBOX_DIR } from './file-outbox.mjs';

const require = createRequire(import.meta.url);

export class DocumentSpecError extends Error {
  name = 'DocumentSpecError';
}

// ---------- Tema ----------
const BASE = { text: '1F2937', muted: '6B7280', border: 'D9DEE5', zebra: 'F7F8FA', good: '15803D', bad: 'B91C1C' };
const SANS = 'Calibri';
const SERIF = 'Cambria';

/** Satu warna dominan (primary), satu aksen tajam, satu tint lembut untuk latar. */
export const THEMES = Object.freeze({
  profesional: { nama: 'Profesional (navy)', primary: '1E2761', accent: 'D98E04', tint: 'EEF1F8', head: SANS, palette: ['1E2761', 'D98E04', '5B7DB1', 'A3B8D9', '8C6D1F', '2A9D8F', 'C05746', '9CA3AF'] },
  keuangan: { nama: 'Keuangan (hijau hutan)', primary: '1F5136', accent: '97BC62', tint: 'EEF5EC', head: SANS, palette: ['1F5136', '97BC62', 'C9A227', '4F7F5B', 'A7C4A0', '2F6690', 'B5651D', '9CA3AF'] },
  hangat: { nama: 'Hangat (terakota)', primary: 'B85042', accent: '6E8B74', tint: 'F7EFEC', head: SERIF, palette: ['B85042', '6E8B74', 'E3A587', 'D9B44A', 'A7BEAE', '5C4B51', '8FA9C4', '9CA3AF'] },
  energik: { nama: 'Energik (koral & navy)', primary: '2F3C7E', accent: 'F96167', tint: 'F1F2FA', head: SANS, palette: ['2F3C7E', 'F96167', 'F4C542', '6A7BD1', 'FFA8AB', '2A9D8F', '8D6A9F', '9CA3AF'] },
  teknologi: { nama: 'Teknologi (biru laut & mint)', primary: '065A82', accent: '02C39A', tint: 'E8F3F7', head: SANS, palette: ['065A82', '02C39A', '1C7293', 'F2A541', '7FD1C7', 'E76F51', '6C5B7B', '9CA3AF'] },
  elegan: { nama: 'Elegan (beri)', primary: '6D2E46', accent: 'A26769', tint: 'F6EEF1', head: SERIF, palette: ['6D2E46', 'A26769', 'C9A227', '8E7DBE', 'D5B9B2', '3D5A80', '7A9E7E', '9CA3AF'] },
  minimal: { nama: 'Minimal (arang)', primary: '36454F', accent: 'C0843D', tint: 'F2F4F5', head: SANS, palette: ['36454F', 'C0843D', '8A9BA8', '5E6F7A', 'C2CCD3', '7A9E7E', 'A05C5C', 'D4A373'] },
  berani: { nama: 'Berani (merah ceri)', primary: '990011', accent: '2F3C7E', tint: 'FCF3F3', head: SERIF, palette: ['990011', '2F3C7E', 'E07A5F', '81B29A', 'F2CC8F', '5E548E', '3D405B', '9CA3AF'] }
});
export const DEFAULT_THEME = 'profesional';

export function resolveTheme(name, gaya = 'laporan') {
  const t = THEMES[name] || THEMES[DEFAULT_THEME];
  const body = gaya === 'surat' ? 'Times New Roman' : SANS;
  return { ...BASE, ...t, head: gaya === 'surat' ? 'Times New Roman' : t.head, body };
}

const LIMITS = Object.freeze({ blocks: 300, rows: 5000, cols: 30, slides: 40, sheets: 20, points: 200, text: 20000, kpi: 6, previews: 8 });
const FORMATS = { pdf: 'pdf', xlsx: 'xlsx', excel: 'xlsx', docx: 'docx', word: 'docx', pptx: 'pptx', powerpoint: 'pptx', png: 'png', grafik: 'png' };
const COLUMN_FORMATS = new Set(['teks', 'rupiah', 'angka', 'persen', 'tanggal']);
const CHART_TYPES = { batang: 'bar', batang_horizontal: 'bar', garis: 'line', pai: 'pie', donat: 'doughnut' };

// ---------- Format Indonesia ----------
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

export function todayWib(now = Date.now()) {
  const d = new Date(now + 7 * 3600 * 1000);
  return `${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Rp 1.250.000", "Rp 12,5" (desimal hanya bila ada), negatif "-Rp 5.000". */
export function formatRupiah(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  const abs = Math.abs(v).toLocaleString('id-ID', { maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}Rp ${abs}`;
}

export function formatNumberId(n, maxDigits = 2) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('id-ID', { maximumFractionDigits: maxDigits }) : String(n ?? '');
}

/** Angka dari number atau string ("Rp 35.000", "1.250.000", "12,5%"). Format Indonesia: titik = ribuan, koma = desimal. */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  let s = String(value).trim().replace(/rp\.?/i, '').replace(/[%\s]/g, '');
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** "2026-11-16" -> Date (UTC tengah hari, aman dari geser zona waktu). */
export function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateId(value) {
  const d = parseDate(value);
  return d ? `${d.getUTCDate()} ${BULAN[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}` : String(value ?? '');
}

/** "2026-11-21" -> "21 November 2026"; teks lain dibiarkan. */
export function longDateId(value) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim()) ? parseDate(value) : null;
  return d ? `${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}` : String(value ?? '');
}

export function formatCell(value, format) {
  if (value === null || value === undefined || value === '') return '';
  if (format === 'rupiah') { const n = parseNumber(value); return n === null ? String(value) : formatRupiah(n); }
  if (format === 'angka') { const n = parseNumber(value); return n === null ? String(value) : formatNumberId(n); }
  if (format === 'persen') { const n = parseNumber(value); return n === null ? String(value) : `${n.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`; }
  if (format === 'tanggal') return formatDateId(value);
  return String(value);
}

const isNumericFormat = (f) => f === 'rupiah' || f === 'angka' || f === 'persen';

// ---------- Validasi & normalisasi ----------
const str = (v, max = LIMITS.text) => String(v ?? '').slice(0, max);

export function sanitizeFileName(name, ext) {
  // Ambil bagian terakhir untuk "/" maupun "\" (di Linux path.basename tidak memecah "\").
  let base = String(name || '').trim().split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,5}$/i, '');
  base = base.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${base || 'dokumen-joko'}.${ext}`;
}

function normColumns(cols, where) {
  if (!Array.isArray(cols) || cols.length === 0) throw new DocumentSpecError(`${where}: "kolom" wajib berupa daftar kolom.`);
  if (cols.length > LIMITS.cols) throw new DocumentSpecError(`${where}: maksimal ${LIMITS.cols} kolom.`);
  return cols.map((c) => {
    const col = typeof c === 'string' ? { judul: c } : (c || {});
    const hitung = col.hitung === 'porsi' ? 'porsi' : null;
    const format = hitung ? 'persen' : (COLUMN_FORMATS.has(col.format) ? col.format : 'teks');
    return {
      judul: str(col.judul ?? col.nama ?? '', 200), format, hitung,
      dari: col.dari === undefined || col.dari === null ? null : col.dari,
      lebar: Number(col.lebar) > 0 ? Math.min(80, Number(col.lebar)) : null
    };
  });
}

function normRows(rows, ncol, where) {
  if (!Array.isArray(rows)) throw new DocumentSpecError(`${where}: "baris" wajib berupa daftar baris.`);
  if (rows.length > LIMITS.rows) throw new DocumentSpecError(`${where}: maksimal ${LIMITS.rows} baris.`);
  return rows.map((r) => {
    const arr = Array.isArray(r) ? r : [r];
    return Array.from({ length: ncol }, (_, i) => (arr[i] === undefined || arr[i] === null ? '' : arr[i]));
  });
}

/**
 * Kolom porsi ({hitung:"porsi", dari:"Jumlah"}) diisi mesin: nilai baris / total kolom sumber x 100.
 * Model tidak perlu (dan tidak boleh) menghitung persentase sendiri.
 */
function applyComputedColumns(t, where) {
  t.kolom.forEach((c, i) => {
    if (c.hitung !== 'porsi') return;
    let src = typeof c.dari === 'number' ? c.dari : t.kolom.findIndex(k => k.judul.toLowerCase() === String(c.dari ?? '').toLowerCase());
    if (src < 0 || src >= t.kolom.length) src = t.kolom.findIndex((k, j) => j !== i && (k.format === 'rupiah' || k.format === 'angka'));
    if (src < 0 || src === i) throw new DocumentSpecError(`${where}: kolom porsi "${c.judul}" butuh "dari" = judul kolom angka/rupiah.`);
    c.dari = src;
    const total = t.baris.reduce((s, r) => s + (parseNumber(r[src]) ?? 0), 0);
    t.baris.forEach((r) => {
      const v = parseNumber(r[src]);
      r[i] = total && v !== null ? Math.round((v / total) * 1000) / 10 : '';
    });
  });
  return t;
}

export function normTable(t, where = 'tabel') {
  const kolom = normColumns(t?.kolom, where);
  const table = { kolom, baris: normRows(t?.baris, kolom.length, where), total: !!t?.total, label_total: str(t?.label_total || 'Total', 60) };
  return applyComputedColumns(table, where);
}

export function normChart(g, where = 'grafik') {
  if (!g || typeof g !== 'object') throw new DocumentSpecError(`${where}: wajib berupa objek.`);
  const jenis = Object.prototype.hasOwnProperty.call(CHART_TYPES, g.jenis) ? g.jenis : 'batang';
  const label = Array.isArray(g.label) ? g.label.slice(0, LIMITS.points).map(x => str(x, 80)) : [];
  const seriRaw = Array.isArray(g.seri) ? g.seri : [];
  if (!label.length || !seriRaw.length) throw new DocumentSpecError(`${where}: "label" dan "seri" wajib diisi.`);
  const seri = seriRaw.slice(0, 10).map((s, i) => ({
    nama: str(s?.nama || `Seri ${i + 1}`, 80),
    data: label.map((_, j) => parseNumber(Array.isArray(s?.data) ? s.data[j] : null) ?? 0)
  }));
  const format = isNumericFormat(g.format) ? g.format : 'angka';
  // Pai/donat: maks. 6 irisan — sisanya (terkecil) digabung menjadi "Lain-lain" agar terbaca.
  if ((jenis === 'pai' || jenis === 'donat') && label.length > 6 && seri.length === 1) {
    const pairs = label.map((l, i) => [l, seri[0].data[i]]).sort((a, b) => b[1] - a[1]);
    const head = pairs.slice(0, 5);
    const rest = pairs.slice(5).reduce((s, p) => s + p[1], 0);
    const existing = head.findIndex(p => /^lain/i.test(p[0]));
    if (existing >= 0) head[existing][1] += rest; else head.push(['Lain-lain', rest]);
    return { jenis, judul: str(g.judul, 200), label: head.map(p => p[0]), seri: [{ nama: seri[0].nama, data: head.map(p => p[1]) }], format };
  }
  return { jenis, judul: str(g.judul, 200), label, seri, format };
}

function normKpi(items, where) {
  if (!Array.isArray(items) || !items.length) throw new DocumentSpecError(`${where}: "item" wajib berisi daftar angka kunci.`);
  return items.slice(0, LIMITS.kpi).map((k) => ({
    label: str(k?.label, 80),
    nilai: k?.nilai ?? '',
    format: isNumericFormat(k?.format) ? k.format : (typeof k?.nilai === 'number' ? 'angka' : 'teks'),
    perubahan: parseNumber(k?.perubahan),
    baik_jika: k?.baik_jika === 'turun' ? 'turun' : 'naik',
    keterangan: str(k?.keterangan, 120)
  }));
}

function normBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new DocumentSpecError('"isi" wajib berupa daftar blok (judul, paragraf, daftar, tabel, grafik, angka_kunci, catatan, info, kop, tanda_tangan, pemisah_halaman).');
  if (blocks.length > LIMITS.blocks) throw new DocumentSpecError(`maksimal ${LIMITS.blocks} blok isi.`);
  return blocks.map((b, i) => {
    const where = `isi[${i}]`;
    switch (b?.jenis) {
      case 'judul': return { jenis: 'judul', teks: str(b.teks, 300), level: Math.min(3, Math.max(1, Number(b.level) || 1)) };
      case 'paragraf': return { jenis: 'paragraf', teks: str(b.teks), rata: ['kanan', 'tengah', 'rata'].includes(b.rata) ? b.rata : 'kiri' };
      case 'catatan': return { jenis: 'catatan', teks: str(b.teks), label: str(b.label, 60) };
      case 'daftar': return { jenis: 'daftar', butir: (Array.isArray(b.butir) ? b.butir : []).slice(0, 200).map(x => str(x, 2000)), bernomor: !!b.bernomor };
      case 'tabel': return { jenis: 'tabel', ...normTable(b, where) };
      case 'grafik': return { jenis: 'grafik', grafik: normChart(b.grafik || b, where) };
      case 'angka_kunci': return { jenis: 'angka_kunci', item: normKpi(b.item, where) };
      case 'kop': return { jenis: 'kop', nama: str(b.nama, 200), baris: (Array.isArray(b.baris) ? b.baris : []).slice(0, 4).map(x => str(x, 200)) };
      case 'info': return { jenis: 'info', baris: (Array.isArray(b.baris) ? b.baris : []).slice(0, 30).map(r => [str(Array.isArray(r) ? r[0] : r, 120), str(Array.isArray(r) ? r[1] : '', 1000)]) };
      case 'tanda_tangan': return { jenis: 'tanda_tangan', tempat_tanggal: str(b.tempat_tanggal, 120), jabatan: str(b.jabatan, 120), nama: str(b.nama, 120), keterangan: str(b.keterangan, 120) };
      case 'pemisah_halaman': return { jenis: 'pemisah_halaman' };
      default: throw new DocumentSpecError(`${where}: jenis blok tidak dikenal "${b?.jenis}".`);
    }
  });
}

export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new DocumentSpecError('spesifikasi harus berupa objek JSON.');
  const format = FORMATS[String(spec.format || '').toLowerCase()];
  if (!format) throw new DocumentSpecError('format wajib salah satu dari: pdf, xlsx, docx, pptx, png.');
  const gaya = spec.gaya === 'surat' ? 'surat' : 'laporan';
  const tema = Object.prototype.hasOwnProperty.call(THEMES, spec.tema) ? spec.tema : DEFAULT_THEME;
  const base = {
    format, gaya, tema,
    nama_file: sanitizeFileName(spec.nama_file || spec.judul, format),
    judul: str(spec.judul, 300),
    subjudul: str(spec.subjudul, 500),
    // Surat menulis tanggal sendiri (blok tanda_tangan / paragraf), jadi tidak otomatis.
    tanggal: spec.tanggal === false || (gaya === 'surat' && !spec.tanggal) ? '' : longDateId(str(spec.tanggal || todayWib(), 100)),
    lanskap: spec.orientasi === 'lanskap'
  };
  if (format === 'pdf' || format === 'docx') return { ...base, isi: normBlocks(spec.isi) };
  if (format === 'xlsx') {
    const sheets = Array.isArray(spec.lembar) && spec.lembar.length ? spec.lembar : (spec.kolom ? [spec] : null);
    if (!sheets) throw new DocumentSpecError('"lembar" wajib berupa daftar sheet ({nama, kolom, baris, total}).');
    if (sheets.length > LIMITS.sheets) throw new DocumentSpecError(`maksimal ${LIMITS.sheets} sheet.`);
    const used = new Set();
    return {
      ...base,
      lembar: sheets.map((s, i) => {
        let nama = str(s.nama || `Sheet ${i + 1}`, 31).replace(/[\\/?*[\]:]/g, '-') || `Sheet ${i + 1}`;
        while (used.has(nama.toLowerCase())) nama = `${nama.slice(0, 28)} ${i + 1}`;
        used.add(nama.toLowerCase());
        const catatan = (Array.isArray(s.catatan) ? s.catatan : (s.catatan ? [s.catatan] : [])).slice(0, 10).map(x => str(x, 500));
        return { nama, judul: str(s.judul ?? (i === 0 ? spec.judul : ''), 300), ...normTable(s, `lembar[${i}]`), grafik: s.grafik ? normChart(s.grafik, `lembar[${i}].grafik`) : null, catatan };
      })
    };
  }
  if (format === 'pptx') {
    if (!Array.isArray(spec.slide) || !spec.slide.length) throw new DocumentSpecError('"slide" wajib berupa daftar slide ({judul, butir, angka_kunci, tabel, grafik, catatan}).');
    if (spec.slide.length > LIMITS.slides) throw new DocumentSpecError(`maksimal ${LIMITS.slides} slide.`);
    return {
      ...base,
      slide: spec.slide.map((s, i) => ({
        judul: str(s?.judul, 200),
        butir: Array.isArray(s?.butir) ? s.butir.slice(0, 12).map(x => str(x, 500)) : [],
        angka_kunci: s?.angka_kunci ? normKpi(s.angka_kunci, `slide[${i}].angka_kunci`).slice(0, 4) : [],
        tabel: s?.tabel ? normTable(s.tabel, `slide[${i}].tabel`) : null,
        grafik: s?.grafik ? normChart(s.grafik, `slide[${i}].grafik`) : null,
        catatan: str(s?.catatan, 3000)
      })),
      penutup: spec.penutup ? { judul: str(spec.penutup.judul || 'Terima kasih', 200), butir: Array.isArray(spec.penutup.butir) ? spec.penutup.butir.slice(0, 6).map(x => str(x, 300)) : [] } : null
    };
  }
  return { ...base, grafik: normChart(spec.grafik || spec, 'grafik') };
}

/** Jumlah per kolom angka (untuk baris total). Kolom porsi bertotal 100. */
export function columnTotals(table) {
  return table.kolom.map((c, i) => {
    if (c.hitung === 'porsi') return table.baris.length ? 100 : null;
    if (c.format === 'rupiah' || c.format === 'angka') return table.baris.reduce((sum, r) => sum + (parseNumber(r[i]) ?? 0), 0);
    return null;
  });
}

const kpiValue = (k) => formatCell(k.nilai, k.format) || String(k.nilai ?? '');
const kpiChange = (k) => {
  if (k.perubahan === null) return null;
  const up = k.perubahan > 0;
  const flat = k.perubahan === 0;
  const good = flat ? null : (up === (k.baik_jika === 'naik'));
  return { text: `${flat ? '■' : (up ? '▲' : '▼')} ${formatNumberId(Math.abs(k.perubahan), 1)}%`, good };
};

// ---------- Chrome ----------
let chromeQueue = Promise.resolve();
async function withBrowser(fn) {
  const run = chromeQueue.then(async () => {
    const executablePath = getChromePath();
    if (!executablePath || !fs.existsSync(executablePath)) throw new Error('Chrome/Edge tidak ditemukan; PDF & grafik membutuhkan Chrome.');
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] });
    try { return await fn(browser); } finally { await browser.close().catch(() => {}); }
  });
  chromeQueue = run.catch(() => {});
  return run;
}

/** Halaman tanpa akses jaringan (hanya data:/about:). */
async function isolatedPage(browser, { js }) {
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(js);
  await page.setRequestInterception(true);
  page.on('request', (r) => (/^(data|about|blob):/.test(r.url()) ? r.continue() : r.abort()));
  return page;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
/** Teks aman + **tebal** + *miring* + baris baru. */
const richHtml = (s) => escapeHtml(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>')
  .replace(/\n/g, '<br>');

let chartJsCache = null;
function chartJsSource() {
  // Subpath dist/ tidak diekspor paket chart.js; require.resolve('chart.js') -> <paket>/dist/chart.cjs.
  if (!chartJsCache) chartJsCache = fs.readFileSync(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js'), 'utf8');
  return chartJsCache;
}

/** Render grafik ke PNG (Buffer) dengan Chart.js di Chrome. */
export async function renderChartPng(chart, { width = 1000, height = 600, browser = null, theme = resolveTheme(DEFAULT_THEME) } = {}) {
  const render = async (b) => {
    const page = await isolatedPage(b, { js: true });
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    const cfg = JSON.stringify({ ...chart, palette: theme.palette.map(c => `#${c}`), font: theme.body, text: `#${theme.text}` });
    const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}#c{width:${width}px;height:${height}px}</style>
<canvas id="c" width="${width}" height="${height}"></canvas><script>${chartJsSource().replace(/<\/script/gi, '<\\/script')}</script><script>
const S=${cfg.replace(/</g, '\\u003c')};
const fmt=(v)=>S.format==='rupiah'?'Rp '+Math.round(v).toLocaleString('id-ID'):S.format==='persen'?v.toLocaleString('id-ID',{maximumFractionDigits:1})+'%':v.toLocaleString('id-ID',{maximumFractionDigits:2});
const short=(v)=>{const a=Math.abs(v);const n=a>=1e9?(v/1e9).toLocaleString('id-ID',{maximumFractionDigits:1})+' M':a>=1e6?(v/1e6).toLocaleString('id-ID',{maximumFractionDigits:1})+' jt':a>=1e3&&S.format==='rupiah'?(v/1e3).toLocaleString('id-ID',{maximumFractionDigits:0})+' rb':v.toLocaleString('id-ID',{maximumFractionDigits:1});return (S.format==='rupiah'?'Rp ':'')+n+(S.format==='persen'?'%':'');};
const type={batang:'bar',batang_horizontal:'bar',garis:'line',pai:'pie',donat:'doughnut'}[S.jenis]||'bar';
const round=type==='pie'||type==='doughnut';
Chart.defaults.font.family=S.font+', Arial, sans-serif';Chart.defaults.font.size=15;Chart.defaults.color=S.text;
const labelsPlugin={id:'nilai',afterDatasetsDraw(ch){const {ctx}=ch;ctx.save();ctx.font=(round?'700 18px ':'600 13px ')+Chart.defaults.font.family;
 ch.data.datasets.forEach((ds,i)=>{const meta=ch.getDatasetMeta(i);if(meta.hidden)return;if(type==='line'&&ds.data.length>12)return;
  const total=ds.data.reduce((a,b)=>a+b,0);
  meta.data.forEach((el,j)=>{const v=ds.data[j];if(!v)return;const p=el.tooltipPosition();
   let txt=short(v);if(round){const pct=total?Math.round(v/total*1000)/10:0;if(pct<4)return;txt=pct.toLocaleString('id-ID')+'%';ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(txt,p.x,p.y);return;}
   ctx.fillStyle=S.text;if(S.jenis==='batang_horizontal'){ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(txt,p.x+6,p.y);}else{ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(txt,p.x,p.y-4);}});});ctx.restore();}};
new Chart(document.getElementById('c'),{type,plugins:[labelsPlugin],
 data:{labels:S.label,datasets:S.seri.map((s,i)=>({label:s.nama,data:s.data,
  backgroundColor:round?S.label.map((_,j)=>S.palette[j%S.palette.length]):(type==='line'?S.palette[i%S.palette.length]+'22':S.palette[i%S.palette.length]),
  borderColor:round?'#fff':S.palette[i%S.palette.length],borderWidth:round?2:(type==='line'?3:0),fill:type==='line'&&S.seri.length===1,tension:0.25,pointRadius:type==='line'?4:0,borderRadius:type==='bar'?4:0}))},
 options:{animation:false,responsive:false,maintainAspectRatio:false,devicePixelRatio:2,indexAxis:S.jenis==='batang_horizontal'?'y':'x',
  layout:{padding:{top:round?10:28,right:S.jenis==='batang_horizontal'?70:24,left:12,bottom:8}},
  plugins:{title:{display:!!S.judul,text:S.judul,font:{size:22,weight:'600'},padding:{bottom:18}},
   legend:{display:round||S.seri.length>1,position:round?'right':'bottom',labels:{boxWidth:16,padding:16,
    generateLabels:round?(ch)=>{const ds=ch.data.datasets[0];return ch.data.labels.map((l,j)=>({text:l+' — '+fmt(ds.data[j]),fillStyle:ds.backgroundColor[j],strokeStyle:'#fff',index:j}));}:undefined}}},
  scales:round?{}:{[S.jenis==='batang_horizontal'?'x':'y']:{beginAtZero:true,grid:{color:'#e5e7eb'},border:{display:false},ticks:{callback:(v)=>short(v)}},[S.jenis==='batang_horizontal'?'y':'x']:{grid:{display:false}}}}});
document.body.dataset.ready='1';
</script>`;
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
    const el = await page.$('#c');
    const buf = await el.screenshot({ type: 'png', omitBackground: false });
    await page.close();
    return Buffer.from(buf);
  };
  return browser ? render(browser) : withBrowser(render);
}

// ---------- PDF (juga dipakai sebagai pratinjau Word) ----------
function tableHtml(t) {
  const totals = t.total ? columnTotals(t) : null;
  const align = (c) => (isNumericFormat(c.format) ? ' class="num"' : '');
  const head = `<thead><tr>${t.kolom.map(c => `<th${align(c)}>${escapeHtml(c.judul)}</th>`).join('')}</tr></thead>`;
  const body = t.baris.map(r => `<tr>${r.map((v, i) => `<td${align(t.kolom[i])}>${escapeHtml(formatCell(v, t.kolom[i].format))}</td>`).join('')}</tr>`).join('');
  const foot = totals ? `<tfoot><tr>${t.kolom.map((c, i) => `<td${align(c)}>${i === 0 && totals[0] === null ? escapeHtml(t.label_total) : (totals[i] === null ? '' : escapeHtml(formatCell(totals[i], c.format)))}</td>`).join('')}</tr></tfoot>` : '';
  return `<table>${head}<tbody>${body}</tbody>${foot}</table>`;
}

function kpiHtml(items) {
  const cols = items.length === 4 ? 4 : Math.min(3, items.length);
  return `<div class="kpis" style="grid-template-columns:repeat(${cols},1fr)">${items.map((k) => {
    const ch = kpiChange(k);
    return `<div class="kpi"><div class="kpi-l">${escapeHtml(k.label)}</div><div class="kpi-v">${escapeHtml(kpiValue(k))}</div>${ch ? `<div class="kpi-c ${ch.good === null ? '' : (ch.good ? 'good' : 'bad')}">${escapeHtml(ch.text)}${k.keterangan ? ` <span>${escapeHtml(k.keterangan)}</span>` : ''}</div>` : (k.keterangan ? `<div class="kpi-c"><span>${escapeHtml(k.keterangan)}</span></div>` : '')}</div>`;
  }).join('')}</div>`;
}

export function buildPdfHtml(spec, chartImages = []) {
  const t = resolveTheme(spec.tema, spec.gaya);
  const surat = spec.gaya === 'surat';
  let chartIdx = 0;
  const blocks = spec.isi.map((b) => {
    switch (b.jenis) {
      case 'judul': return `<h${b.level + 1}>${escapeHtml(b.teks)}</h${b.level + 1}>`;
      case 'paragraf': return `<p class="al-${b.rata}">${richHtml(b.teks)}</p>`;
      case 'catatan': return `<div class="note">${b.label ? `<strong>${escapeHtml(b.label)}</strong> ` : ''}${richHtml(b.teks)}</div>`;
      case 'daftar': return `<${b.bernomor ? 'ol' : 'ul'}>${b.butir.map(x => `<li>${richHtml(x)}</li>`).join('')}</${b.bernomor ? 'ol' : 'ul'}>`;
      case 'tabel': return tableHtml(b);
      case 'grafik': { const img = chartImages[chartIdx++]; return img ? `<figure><img src="data:image/png;base64,${img.toString('base64')}" alt=""></figure>` : ''; }
      case 'angka_kunci': return kpiHtml(b.item);
      case 'info': return `<table class="info">${b.baris.map(([k, v]) => `<tr><td class="info-k">${escapeHtml(k)}</td><td class="info-s">:</td><td>${richHtml(v)}</td></tr>`).join('')}</table>`;
      case 'kop': return `<div class="kop"><div class="kop-n">${escapeHtml(b.nama)}</div>${b.baris.map(x => `<div>${escapeHtml(x)}</div>`).join('')}</div>`;
      case 'tanda_tangan': return `<div class="ttd">${b.tempat_tanggal ? `<div>${escapeHtml(b.tempat_tanggal)}</div>` : ''}${b.jabatan ? `<div>${escapeHtml(b.jabatan)}</div>` : ''}<div class="ttd-s"></div><div class="ttd-n">${escapeHtml(b.nama)}</div>${b.keterangan ? `<div>${escapeHtml(b.keterangan)}</div>` : ''}</div>`;
      case 'pemisah_halaman': return '<div class="pb"></div>';
      default: return '';
    }
  }).join('\n');
  const c = (k) => `#${t[k]}`;
  const header = surat ? '' : `<header><h1>${escapeHtml(spec.judul || 'Dokumen')}</h1>${spec.subjudul ? `<div class="sub">${escapeHtml(spec.subjudul)}</div>` : ''}${spec.tanggal ? `<div class="date">${escapeHtml(spec.tanggal)}</div>` : ''}</header>`;
  const font = (f) => `"${f}",${f === 'Times New Roman' ? '"Liberation Serif",serif' : (f === SERIF ? '"Caladea",Georgia,serif' : '"Carlito",Arial,"DejaVu Sans",sans-serif')}`;
  return `<!doctype html><html lang="id"><meta charset="utf-8"><title>${escapeHtml(spec.judul)}</title><style>
@page{size:A4 ${spec.lanskap ? 'landscape' : 'portrait'};margin:${surat ? '22mm 22mm 22mm 25mm' : '18mm 17mm 20mm'}}
*{box-sizing:border-box}body{font-family:${font(t.body)};color:${surat ? '#000' : c('text')};font-size:${surat ? '12pt' : '10.5pt'};line-height:${surat ? 1.6 : 1.55};margin:0}
header{margin:0 0 22px}header h1{font-family:${font(t.head)};font-size:24pt;line-height:1.15;margin:0;color:${c('primary')};font-weight:700}
header .sub{font-size:12pt;color:${c('muted')};margin-top:6px}header .date{font-size:9.5pt;color:${c('muted')};margin-top:2px}
h2,h3,h4{font-family:${font(t.head)};break-after:avoid;line-height:1.25}
h2{font-size:${surat ? '12pt' : '15pt'};color:${surat ? '#000' : c('primary')};margin:${surat ? '14px 0 6px' : '24px 0 8px'}}
h3{font-size:12pt;color:${surat ? '#000' : c('primary')};margin:16px 0 6px}h4{font-size:11pt;margin:12px 0 4px}
p{margin:0 0 9px}.al-kanan{text-align:right}.al-tengah{text-align:center}.al-rata{text-align:justify}ul,ol{margin:0 0 10px;padding-left:22px}li{margin:3px 0}
table{width:100%;border-collapse:collapse;margin:6px 0 16px;font-size:${surat ? '11pt' : '9.5pt'}}thead{display:table-header-group}tr{break-inside:avoid}
th{background:${surat ? '#eee' : c('primary')};color:${surat ? '#000' : '#fff'};font-weight:600;text-align:left;padding:7px 9px}td{padding:6px 9px;border-bottom:1px solid ${c('border')}}
tbody tr:nth-child(even) td{background:${surat ? '#fff' : c('zebra')}}tfoot td{font-weight:700;background:${surat ? '#f3f3f3' : c('tint')};border-top:1.5px solid ${surat ? '#000' : c('primary')};border-bottom:none}
.num{text-align:right;white-space:nowrap}figure{margin:10px 0 16px;text-align:center;break-inside:avoid}figure img{max-width:100%;max-height:115mm}
.note{background:${c('tint')};border-radius:6px;padding:10px 14px;margin:10px 0 14px;break-inside:avoid}
.kpis{display:grid;gap:10px;margin:8px 0 18px;break-inside:avoid}.kpi{background:${c('tint')};border-radius:8px;padding:12px 14px}
.kpi-l{font-size:9pt;color:${c('muted')}}.kpi-v{font-family:${font(t.head)};font-size:19pt;font-weight:700;color:${c('primary')};line-height:1.2;margin-top:2px;white-space:nowrap}
.kpi-c{font-size:9pt;font-weight:600;margin-top:2px;color:${c('muted')}}.kpi-c.good{color:${c('good')}}.kpi-c.bad{color:${c('bad')}}.kpi-c span{font-weight:400;color:${c('muted')}}
.kop{text-align:center;padding-bottom:8px;margin-bottom:18px;border-bottom:3px double #000;font-size:10.5pt;line-height:1.35}.kop-n{font-size:15pt;font-weight:700;text-transform:uppercase}
table.info{width:auto;margin:0 0 12px;font-size:inherit}table.info td{border:none;background:none!important;padding:1px 0;vertical-align:top}.info-k{padding-right:10px!important;white-space:nowrap}.info-s{padding-right:8px!important}
.ttd{width:45%;margin:28px 0 0 auto;break-inside:avoid}.ttd-s{height:64px}.ttd-n{font-weight:700;text-decoration:underline}
.pb{break-after:page}
</style><body>${header}
${blocks}</body></html>`;
}

let pdfJsCache = null;
function pdfJsSources() {
  if (!pdfJsCache) {
    const dir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build');
    pdfJsCache = { lib: fs.readFileSync(path.join(dir, 'pdf.min.mjs'), 'utf8'), worker: fs.readFileSync(path.join(dir, 'pdf.worker.min.mjs'), 'utf8') };
  }
  return pdfJsCache;
}

/**
 * Pratinjau = halaman PDF yang SEBENARNYA (dirender pdf.js di Chrome, tanpa jaringan), agar
 * agen menilai pemenggalan halaman, halaman kosong, dan grafik persis seperti yang diterima.
 */
async function renderPdfPages(browser, pdfBuffer, { max = LIMITS.previews, scale = 1.35 } = {}) {
  const page = await isolatedPage(browser, { js: true });
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>', { waitUntil: 'load' });
  const { lib, worker } = pdfJsSources();
  const urls = await page.evaluate(async (libSrc, workerSrc, b64, maxPages, sc) => {
    const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const pdfjs = await import(blobUrl(libSrc));
    pdfjs.GlobalWorkerOptions.workerSrc = blobUrl(workerSrc);
    const data = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const out = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: sc });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push(canvas.toDataURL('image/png'));
    }
    return out;
  }, lib, worker, pdfBuffer.toString('base64'), max, scale);
  await page.close();
  return urls.map(u => Buffer.from(u.split(',')[1], 'base64'));
}

async function renderHtmlDocument(spec) {
  const theme = resolveTheme(spec.tema, spec.gaya);
  return withBrowser(async (browser) => {
    const charts = [];
    for (const b of spec.isi) if (b.jenis === 'grafik') charts.push(await renderChartPng(b.grafik, { browser, width: 900, height: 500, theme }));
    const html = buildPdfHtml(spec, charts);
    const page = await isolatedPage(browser, { js: false });
    await page.setContent(html, { waitUntil: 'load' });
    const footer = spec.gaya === 'surat' ? '<div></div>' : `<div style="font-family:Arial,sans-serif;font-size:8px;color:#${theme.muted};width:100%;padding:0 17mm;display:flex;justify-content:space-between">
<span>${escapeHtml(spec.judul).slice(0, 90)}</span><span>Halaman <span class="pageNumber"></span> dari <span class="totalPages"></span></span></div>`;
    const buffer = Buffer.from(await page.pdf({
      format: 'A4', landscape: spec.lanskap, printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: spec.gaya !== 'surat', headerTemplate: '<div></div>', footerTemplate: footer
    }));
    await page.close();
    const previews = await renderPdfPages(browser, buffer);
    return { buffer, previews, charts };
  });
}

async function buildPdf(spec) {
  const { buffer, previews } = await renderHtmlDocument(spec);
  const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { buffer, previews, info: `${pages} halaman, tema ${resolveTheme(spec.tema).nama}` };
}

// ---------- Excel ----------
const XLSX_NUMFMT = {
  rupiah: '"Rp" #,##0;[Red]-"Rp" #,##0;"-"',
  angka: '#,##0.##;-#,##0.##;"-"',
  persen: '0.0%;-0.0%;"-"',
  tanggal: 'dd mmm yyyy'
};

function xlsxValue(v, format) {
  if (v === '' || v === null || v === undefined) return null;
  if (format === 'rupiah' || format === 'angka') return parseNumber(v) ?? String(v);
  if (format === 'persen') { const n = parseNumber(v); return n === null ? String(v) : n / 100; }
  if (format === 'tanggal') return parseDate(v) ?? String(v);
  return typeof v === 'number' ? v : String(v);
}

const colLetter = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

async function buildXlsx(spec) {
  const t = resolveTheme(spec.tema);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Joko';
  wb.created = new Date();
  const thin = { style: 'thin', color: { argb: `FF${t.border}` } };
  const fill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } });
  const summary = [];
  const needsChart = spec.lembar.some(s => s.grafik);
  const charts = needsChart ? await withBrowser(async (b) => Promise.all(spec.lembar.map(s => (s.grafik ? renderChartPng(s.grafik, { browser: b, width: 900, height: 500, theme: t }) : null)))) : [];

  spec.lembar.forEach((sh, si) => {
    const ws = wb.addWorksheet(sh.nama, { properties: { defaultRowHeight: 18 } });
    const ncol = sh.kolom.length;
    let r = 1;
    if (sh.judul) {
      ws.mergeCells(1, 1, 1, Math.max(1, ncol));
      ws.getCell(1, 1).value = sh.judul;
      ws.getCell(1, 1).font = { name: SANS, size: 15, bold: true, color: { argb: `FF${t.primary}` } };
      ws.getRow(1).height = 26;
      const sub = [spec.subjudul, spec.tanggal].filter(Boolean).join(' • ');
      if (sub) {
        ws.mergeCells(2, 1, 2, Math.max(1, ncol));
        ws.getCell(2, 1).value = sub;
        ws.getCell(2, 1).font = { name: SANS, size: 10, italic: true, color: { argb: `FF${t.muted}` } };
      }
      r = 4;
    }
    const headerRow = r;
    sh.kolom.forEach((c, i) => {
      const cell = ws.getCell(headerRow, i + 1);
      cell.value = c.judul;
      cell.font = { name: SANS, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = fill(t.primary);
      cell.alignment = { vertical: 'middle', horizontal: isNumericFormat(c.format) ? 'right' : 'left', wrapText: true };
      cell.border = { top: thin, bottom: thin, left: thin, right: thin };
    });
    ws.getRow(headerRow).height = 22;
    const first = headerRow + 1;
    const last = headerRow + sh.baris.length;
    sh.baris.forEach((row, ri) => {
      const rr = first + ri;
      row.forEach((v, i) => {
        const c = sh.kolom[i];
        const cell = ws.getCell(rr, i + 1);
        if (c.hitung === 'porsi') {
          // Rumus asli: tetap benar bila angka sumber diubah di Excel.
          const S = colLetter(c.dari);
          cell.value = { formula: `IFERROR(${S}${rr}/SUM(${S}$${first}:${S}$${last}),0)`, result: v === '' ? 0 : v / 100 };
        } else {
          cell.value = xlsxValue(v, c.format);
        }
        if (XLSX_NUMFMT[c.format]) cell.numFmt = XLSX_NUMFMT[c.format];
        cell.font = { name: SANS, size: 10.5 };
        cell.border = { bottom: thin };
        cell.alignment = { vertical: 'top', horizontal: isNumericFormat(c.format) ? 'right' : (c.format === 'tanggal' ? 'center' : 'left'), wrapText: c.format === 'teks' };
        if (ri % 2 === 1) cell.fill = fill(t.zebra);
      });
    });
    let endRow = last;
    if (sh.total && sh.baris.length) {
      const tr = last + 1;
      endRow = tr;
      const totals = columnTotals(sh);
      sh.kolom.forEach((c, i) => {
        const cell = ws.getCell(tr, i + 1);
        if (totals[i] !== null) {
          const L = colLetter(i);
          cell.value = { formula: `SUM(${L}${first}:${L}${last})`, result: c.hitung === 'porsi' ? 1 : totals[i] };
          cell.numFmt = XLSX_NUMFMT[c.format];
          cell.alignment = { horizontal: 'right' };
        } else if (i === 0) cell.value = sh.label_total;
        cell.font = { name: SANS, bold: true };
        cell.fill = fill(t.tint);
        cell.border = { top: { style: 'medium', color: { argb: `FF${t.primary}` } } };
      });
    }
    // Asumsi/sumber data ditulis di bawah tabel agar terlihat pembaca.
    sh.catatan.forEach((note, ni) => {
      const rr = endRow + 2 + ni;
      ws.mergeCells(rr, 1, rr, Math.max(1, ncol));
      ws.getCell(rr, 1).value = note;
      ws.getCell(rr, 1).font = { name: SANS, size: 9.5, italic: true, color: { argb: `FF${t.muted}` } };
      ws.getCell(rr, 1).alignment = { wrapText: true, vertical: 'top' };
    });
    sh.kolom.forEach((c, i) => {
      const lens = [c.judul.length, ...sh.baris.slice(0, 500).map(row => formatCell(row[i], c.format).length)];
      ws.getColumn(i + 1).width = c.lebar || Math.min(50, Math.max(10, Math.max(...lens) + 3));
    });
    ws.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }];
    if (sh.baris.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: last, column: ncol } };
    ws.pageSetup = { orientation: spec.lanskap ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    if (charts[si]) {
      const id = wb.addImage({ buffer: charts[si], extension: 'png' });
      ws.addImage(id, { tl: { col: ncol + 1, row: headerRow - 1 }, ext: { width: 640, height: 356 } });
    }
    const porsi = sh.kolom.filter(c => c.hitung === 'porsi').length;
    summary.push(`${sh.nama}: ${sh.baris.length} baris × ${ncol} kolom${sh.total ? ', baris total (rumus SUM)' : ''}${porsi ? `, ${porsi} kolom porsi (rumus)` : ''}${charts[si] ? ', grafik' : ''}${sh.catatan.length ? ', catatan' : ''}`);
  });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), previews: [], info: summary.join('; ') };
}

// ---------- Word ----------
function docxRuns(text, opts = {}) {
  return String(text).split(/(\*\*.+?\*\*|(?<![*\w])\*(?!\s)[^*\n]+?\*(?![*\w]))/g).filter(Boolean).flatMap((part) => {
    const bold = /^\*\*.+\*\*$/.test(part);
    const italics = !bold && /^\*[^*].*\*$/.test(part);
    const tx = bold ? part.slice(2, -2) : (italics ? part.slice(1, -1) : part);
    return tx.split('\n').map((line, i) => new TextRun({ text: line, bold: bold || opts.bold, italics, color: opts.color, break: i > 0 ? 1 : 0, font: opts.font, size: opts.size }));
  });
}

function docxTable(tb, t, surat) {
  const totals = tb.total ? columnTotals(tb) : null;
  const border = { style: BorderStyle.SINGLE, size: 4, color: t.border };
  const shade = (hex) => ({ type: ShadingType.CLEAR, fill: hex, color: 'auto' });
  const cell = (text, c, { header = false, total = false, zebra = false } = {}) => new TableCell({
    shading: header ? shade(surat ? 'EEEEEE' : t.primary) : (total ? shade(surat ? 'F3F3F3' : t.tint) : (zebra && !surat ? shade(t.zebra) : undefined)),
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    borders: { top: border, bottom: border, left: border, right: border },
    children: [new Paragraph({
      alignment: isNumericFormat(c.format) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text, bold: header || total, color: header && !surat ? 'FFFFFF' : (surat ? '000000' : t.text), font: t.body, size: surat ? 22 : 19 })]
    })]
  });
  const rows = [new TableRow({ tableHeader: true, children: tb.kolom.map(c => cell(c.judul, c, { header: true })) })];
  tb.baris.forEach((r, ri) => rows.push(new TableRow({ cantSplit: true, children: r.map((v, i) => cell(formatCell(v, tb.kolom[i].format), tb.kolom[i], { zebra: ri % 2 === 1 })) })));
  if (totals) rows.push(new TableRow({ children: tb.kolom.map((c, i) => cell(i === 0 && totals[0] === null ? tb.label_total : (totals[i] === null ? '' : formatCell(totals[i], c.format)), c, { total: true })) }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function docxKpi(items, t) {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const white = { style: BorderStyle.SINGLE, size: 24, color: 'FFFFFF' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: white },
    rows: [new TableRow({
      children: items.map((k) => {
        const ch = kpiChange(k);
        const lines = [
          new Paragraph({ children: [new TextRun({ text: k.label, color: t.muted, size: 17, font: t.body })] }),
          new Paragraph({ children: [new TextRun({ text: kpiValue(k), bold: true, color: t.primary, size: 34, font: t.head })] })
        ];
        if (ch || k.keterangan) {
          lines.push(new Paragraph({
            children: [
              ...(ch ? [new TextRun({ text: ch.text, bold: true, size: 17, font: t.body, color: ch.good === null ? t.muted : (ch.good ? t.good : t.bad) })] : []),
              ...(k.keterangan ? [new TextRun({ text: `${ch ? ' ' : ''}${k.keterangan}`, size: 17, font: t.body, color: t.muted })] : [])
            ]
          }));
        }
        return new TableCell({ shading: { type: ShadingType.CLEAR, fill: t.tint, color: 'auto' }, margins: { top: 140, bottom: 140, left: 180, right: 180 }, children: lines });
      })
    })]
  });
}

async function buildDocx(spec) {
  const t = resolveTheme(spec.tema, spec.gaya);
  const surat = spec.gaya === 'surat';
  // Grafik + pratinjau dari render HTML yang sama (tata letak Word mendekati versi PDF).
  const { previews, charts } = await renderHtmlDocument(spec);
  let ci = 0;
  let listInstance = 0;
  const bodySize = surat ? 24 : 21;
  const children = [];
  if (!surat) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 80 }, children: [new TextRun({ text: spec.judul || 'Dokumen', bold: true, color: t.primary, font: t.head, size: 44 })] }));
    if (spec.subjudul) children.push(new Paragraph({ children: [new TextRun({ text: spec.subjudul, color: t.muted, font: t.body, size: 24 })] }));
    if (spec.tanggal) children.push(new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: spec.tanggal, color: t.muted, font: t.body, size: 19 })] }));
  }
  const align = { kanan: AlignmentType.RIGHT, tengah: AlignmentType.CENTER, rata: AlignmentType.JUSTIFIED, kiri: AlignmentType.LEFT };
  for (const b of spec.isi) {
    if (b.jenis === 'judul') {
      children.push(new Paragraph({
        heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][b.level - 1], keepNext: true,
        spacing: { before: surat ? 160 : 300, after: 120 },
        children: [new TextRun({ text: b.teks, bold: true, color: surat ? '000000' : t.primary, font: t.head, size: surat ? 24 : [30, 26, 23][b.level - 1] })]
      }));
    } else if (b.jenis === 'paragraf') {
      children.push(new Paragraph({ alignment: align[b.rata], spacing: { after: 140, line: surat ? 360 : 300 }, children: docxRuns(b.teks, { size: bodySize, font: t.body }) }));
    } else if (b.jenis === 'catatan') {
      children.push(new Paragraph({ spacing: { before: 120, after: 160 }, shading: { type: ShadingType.CLEAR, fill: t.tint, color: 'auto' }, children: [...(b.label ? [new TextRun({ text: `${b.label} `, bold: true, font: t.body, size: bodySize })] : []), ...docxRuns(b.teks, { size: bodySize, font: t.body })] }));
    } else if (b.jenis === 'daftar') {
      const instance = listInstance++;
      b.butir.forEach(x => children.push(new Paragraph({ numbering: { reference: b.bernomor ? 'angka' : 'poin', level: 0, instance }, spacing: { after: 60 }, children: docxRuns(x, { size: bodySize, font: t.body }) })));
    } else if (b.jenis === 'tabel') {
      children.push(docxTable(b, t, surat));
      children.push(new Paragraph({ text: '' }));
    } else if (b.jenis === 'grafik') {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: charts[ci++], transformation: { width: 600, height: 333 } })] }));
    } else if (b.jenis === 'angka_kunci') {
      children.push(docxKpi(b.item, t));
      children.push(new Paragraph({ text: '' }));
    } else if (b.jenis === 'info') {
      const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
      const c = (runs, w) => new TableCell({ width: { size: w, type: WidthType.DXA }, borders: { top: none, bottom: none, left: none, right: none }, children: [new Paragraph({ children: runs })] });
      children.push(new Table({
        borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
        rows: b.baris.map(([k, v]) => new TableRow({ children: [c([new TextRun({ text: k, size: bodySize, font: t.body })], 1700), c([new TextRun({ text: ':', size: bodySize, font: t.body })], 250), c(docxRuns(v, { size: bodySize, font: t.body }), 6500)] }))
      }));
      children.push(new Paragraph({ text: '' }));
    } else if (b.jenis === 'kop') {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: b.nama.toUpperCase(), bold: true, size: 30, font: t.head })] }));
      b.baris.forEach((x, i) => children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        border: i === b.baris.length - 1 ? { bottom: { style: BorderStyle.DOUBLE, size: 6, color: '000000', space: 6 } } : undefined,
        children: [new TextRun({ text: x, size: 20, font: t.body })]
      })));
      children.push(new Paragraph({ text: '' }));
    } else if (b.jenis === 'tanda_tangan') {
      const ind = { left: 5200 };
      [b.tempat_tanggal, b.jabatan].filter(Boolean).forEach(x => children.push(new Paragraph({ indent: ind, children: [new TextRun({ text: x, size: bodySize, font: t.body })] })));
      children.push(new Paragraph({ indent: ind, spacing: { before: 900 }, children: [new TextRun({ text: b.nama, bold: true, underline: {}, size: bodySize, font: t.body })] }));
      if (b.keterangan) children.push(new Paragraph({ indent: ind, children: [new TextRun({ text: b.keterangan, size: bodySize, font: t.body })] }));
    } else if (b.jenis === 'pemisah_halaman') {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }
  const doc = new Document({
    creator: 'Joko', title: spec.judul,
    styles: { default: { document: { run: { font: t.body, size: bodySize, color: surat ? '000000' : t.text } } } },
    numbering: {
      config: [
        { reference: 'angka', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 500, hanging: 300 } } } }] },
        { reference: 'poin', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 500, hanging: 300 } } } }] }
      ]
    },
    sections: [{
      properties: { page: { size: { orientation: spec.lanskap ? 'landscape' : 'portrait' }, margin: surat ? { top: 1250, bottom: 1250, left: 1420, right: 1250 } : { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      footers: surat ? undefined : { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ['Halaman ', PageNumber.CURRENT, ' dari ', PageNumber.TOTAL_PAGES], color: t.muted, size: 16, font: t.body })] })] }) },
      children
    }]
  });
  return { buffer: await Packer.toBuffer(doc), previews, info: `${spec.isi.length} blok isi${charts.length ? `, ${charts.length} grafik` : ''}, tema ${surat ? 'surat resmi' : t.nama} (pratinjau = perkiraan tampilan)` };
}

// ---------- PowerPoint ----------
async function buildPptx(spec) {
  const t = resolveTheme(spec.tema);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.author = 'Joko';
  pptx.title = spec.judul;
  const W = 13.33;
  const M = 0.6;
  const text = (s, str2, opts) => s.addText(str2, { isTextBox: true, fontFace: t.body, color: t.text, ...opts });

  // Sampul gelap (struktur "sandwich": sampul & penutup gelap, isi terang).
  const cover = pptx.addSlide();
  cover.background = { color: t.primary };
  text(cover, spec.judul || 'Presentasi', { x: 0.9, y: 2.2, w: W - 1.8, h: 1.6, fontFace: t.head, fontSize: 42, bold: true, color: 'FFFFFF', fit: 'shrink', valign: 'bottom' });
  if (spec.subjudul) text(cover, spec.subjudul, { x: 0.9, y: 3.9, w: W - 1.8, h: 0.7, fontSize: 20, color: t.tint });
  if (spec.tanggal) text(cover, spec.tanggal, { x: 0.9, y: 6.3, w: 6, h: 0.4, fontSize: 13, color: t.tint });

  const chartType = { batang: pptx.ChartType.bar, batang_horizontal: pptx.ChartType.bar, garis: pptx.ChartType.line, pai: pptx.ChartType.pie, donat: pptx.ChartType.doughnut };
  const numFmt = { rupiah: '"Rp" #,##0', angka: '#,##0', persen: '0.0"%"' };
  const outline = [];

  spec.slide.forEach((sd, i) => {
    const s = pptx.addSlide();
    s.background = { color: 'FFFFFF' };
    text(s, sd.judul, { x: M, y: 0.35, w: W - 2 * M, h: 1.0, fontFace: t.head, fontSize: 32, bold: true, color: t.primary, fit: 'shrink', valign: 'middle', margin: 0 });
    let y = 1.55;
    if (sd.angka_kunci.length) {
      const n = sd.angka_kunci.length;
      const gap = 0.3;
      const cw = (W - 2 * M - gap * (n - 1)) / n;
      sd.angka_kunci.forEach((k, j) => {
        const x = M + j * (cw + gap);
        s.addShape(pptx.ShapeType.roundRect, { x, y, w: cw, h: 1.55, fill: { color: t.tint }, line: { color: t.tint }, rectRadius: 0.08 });
        text(s, k.label, { x: x + 0.2, y: y + 0.12, w: cw - 0.4, h: 0.35, fontSize: 13, color: t.muted, margin: 0 });
        text(s, kpiValue(k), { x: x + 0.2, y: y + 0.45, w: cw - 0.4, h: 0.65, fontFace: t.head, fontSize: 30, bold: true, color: t.primary, fit: 'shrink', margin: 0 });
        const ch = kpiChange(k);
        if (ch || k.keterangan) text(s, `${ch ? ch.text : ''}${k.keterangan ? `${ch ? '  ' : ''}${k.keterangan}` : ''}`, { x: x + 0.2, y: y + 1.1, w: cw - 0.4, h: 0.32, fontSize: 12, bold: !!ch, color: ch && ch.good !== null ? (ch.good ? t.good : t.bad) : t.muted, margin: 0 });
      });
      y += 1.85;
    }
    const hasVisual = sd.tabel || sd.grafik;
    const avail = 7.0 - y;
    const textW = hasVisual && sd.butir.length ? 5.2 : W - 2 * M;
    if (sd.butir.length) {
      text(s, sd.butir.map((b, j) => ({ text: b.replace(/\*\*/g, ''), options: { bullet: true, paraSpaceAfter: 8, breakLine: j < sd.butir.length - 1 } })),
        { x: M, y, w: textW, h: avail, fontSize: sd.butir.length > 5 ? 16 : 18, valign: 'top', fit: 'shrink' });
    }
    const vx = sd.butir.length ? M + 5.5 : M;
    const vw = sd.butir.length ? W - M - vx : W - 2 * M;
    if (sd.grafik) {
      const g = sd.grafik;
      const round = g.jenis === 'pai' || g.jenis === 'donat';
      s.addChart(chartType[g.jenis], g.seri.map(x => ({ name: x.nama, labels: g.label, values: x.data })), {
        x: vx, y, w: vw, h: sd.tabel ? avail * 0.48 : avail, barDir: g.jenis === 'batang_horizontal' ? 'bar' : 'col',
        chartColors: t.palette, showLegend: round || g.seri.length > 1, legendPos: round ? 'r' : 'b', legendFontFace: t.body, legendFontSize: 12,
        // Pai/donat menampilkan porsi: format persen (format Rupiah di sini membuat semua label "Rp 0").
        showValue: !round, showPercent: round, dataLabelFormatCode: round ? '0.0%' : numFmt[g.format], valAxisLabelFormatCode: numFmt[g.format],
        dataLabelFontSize: round ? 12 : 11, dataLabelColor: round ? 'FFFFFF' : t.text, dataLabelFontBold: round, dataLabelFontFace: t.body, catAxisLabelFontFace: t.body, valAxisLabelFontFace: t.body,
        catAxisLabelColor: t.muted, valAxisLabelColor: t.muted, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11,
        showTitle: !!g.judul, title: g.judul, titleFontFace: t.head, titleFontSize: 14, titleColor: t.text,
        valGridLine: { color: 'E5E7EB', size: 1 }, catGridLine: { style: 'none' }
      });
    }
    if (sd.tabel) {
      const tb = sd.tabel;
      const totals = tb.total ? columnTotals(tb) : null;
      const al = (c) => (isNumericFormat(c.format) ? 'right' : 'left');
      const rows = [tb.kolom.map(c => ({ text: c.judul, options: { bold: true, color: 'FFFFFF', fill: { color: t.primary }, align: al(c) } }))];
      tb.baris.slice(0, 12).forEach((r, ri) => rows.push(r.map((v, ci) => ({ text: formatCell(v, tb.kolom[ci].format), options: { align: al(tb.kolom[ci]), fill: { color: ri % 2 ? t.zebra : 'FFFFFF' } } }))));
      if (totals) rows.push(tb.kolom.map((c, ci) => ({ text: ci === 0 && totals[0] === null ? tb.label_total : (totals[ci] === null ? '' : formatCell(totals[ci], c.format)), options: { bold: true, fill: { color: t.tint }, align: al(c) } })));
      s.addTable(rows, { x: vx, y: sd.grafik ? y + avail * 0.52 : y, w: vw, fontFace: t.body, fontSize: rows.length > 9 ? 12 : 14, color: t.text, border: { type: 'solid', pt: 0.5, color: t.border }, autoPage: false });
    }
    if (sd.catatan) s.addNotes(sd.catatan);
    text(s, `${i + 2}`, { x: W - M - 1, y: 7.0, w: 1, h: 0.3, fontSize: 10, color: t.muted, align: 'right', margin: 0 });
    outline.push(`${i + 2}. ${sd.judul}${sd.angka_kunci.length ? ' [angka kunci]' : ''}${sd.grafik ? ` [grafik ${sd.grafik.jenis}]` : ''}${sd.tabel ? ` [tabel ${sd.tabel.baris.length} baris${sd.tabel.baris.length > 12 ? ' — HANYA 12 ditampilkan, pecah ke slide lain' : ''}]` : ''}${sd.butir.length ? ` [${sd.butir.length} poin]` : ''}`);
  });

  if (spec.penutup) {
    const s = pptx.addSlide();
    s.background = { color: t.primary };
    text(s, spec.penutup.judul, { x: 0.9, y: 1.4, w: W - 1.8, h: 1.2, fontFace: t.head, fontSize: 36, bold: true, color: 'FFFFFF', fit: 'shrink' });
    if (spec.penutup.butir.length) text(s, spec.penutup.butir.map((b, j) => ({ text: b, options: { bullet: true, paraSpaceAfter: 10, breakLine: j < spec.penutup.butir.length - 1 } })), { x: 0.9, y: 2.8, w: W - 1.8, h: 3.8, fontSize: 20, color: 'FFFFFF', valign: 'top', fit: 'shrink' });
    outline.push(`${spec.slide.length + 2}. ${spec.penutup.judul} [penutup]`);
  }
  const buffer = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
  return { buffer, previews: [], info: `${spec.slide.length + 1 + (spec.penutup ? 1 : 0)} slide (termasuk sampul), tema ${t.nama}. Kerangka: 1. Sampul; ${outline.join('; ')}` };
}

/**
 * Pratinjau slide dengan PowerPoint asli (Windows, via COM) — render paling akurat.
 * Path dikirim lewat variabel lingkungan (bukan disisipkan ke skrip). PowerPoint hanya
 * ditutup bila tidak ada presentasi lain yang sedang dibuka pengguna.
 * Mengembalikan [] bila PowerPoint tidak tersedia atau gagal.
 */
const POWERPOINT_EXE = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE';
export async function renderPptxPreviews(pptxPath, outDir, stem, { max = LIMITS.previews } = {}) {
  if (process.platform !== 'win32' || process.env.JOKO_PPTX_PREVIEW === 'off' || !fs.existsSync(POWERPOINT_EXE)) return [];
  const { execFile } = await import('node:child_process');
  const script = `$ErrorActionPreference='Stop'
$app = New-Object -ComObject PowerPoint.Application
$pres = $app.Presentations.Open($env:JOKO_PPTX, $true, $false, $false)
try {
  $n = [Math]::Min($pres.Slides.Count, [int]$env:JOKO_MAX)
  for ($i = 1; $i -le $n; $i++) { $pres.Slides.Item($i).Export((Join-Path $env:JOKO_OUT ($env:JOKO_STEM + '-slide' + $i + '.png')), 'PNG', 1333, 750) }
} finally { $pres.Close(); if ($app.Presentations.Count -eq 0) { $app.Quit() } }`;
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, JOKO_PPTX: path.resolve(pptxPath), JOKO_OUT: path.resolve(outDir), JOKO_STEM: stem, JOKO_MAX: String(max) },
      timeout: 120000, windowsHide: true
    }, (err) => (err ? reject(err) : resolve())));
  } catch {
    return [];
  }
  return Array.from({ length: max }, (_, i) => path.join(outDir, `${stem}-slide${i + 1}.png`)).filter(p => fs.existsSync(p));
}

// ---------- Grafik PNG ----------
async function buildPng(spec) {
  const buffer = await renderChartPng({ ...spec.grafik, judul: spec.grafik.judul || spec.judul }, { width: 1200, height: 700, theme: resolveTheme(spec.tema) });
  return { buffer, previews: [], info: `grafik ${spec.grafik.jenis}, ${spec.grafik.label.length} kategori` };
}

const BUILDERS = { pdf: buildPdf, xlsx: buildXlsx, docx: buildDocx, pptx: buildPptx, png: buildPng };

/**
 * Bangun file dari spesifikasi dan simpan di outDir.
 * @returns {Promise<{fileName:string, filePath:string, bytes:number, format:string, info:string, previewPaths:string[], previewPath:string|null}>}
 */
export async function buildDocument(rawSpec, { outDir = MEDIA_OUTBOX_DIR } = {}) {
  const spec = normalizeSpec(rawSpec);
  const { buffer, previews, info } = await BUILDERS[spec.format](spec);
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, spec.nama_file);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(outDir)) throw new DocumentSpecError('nama file tidak valid.');
  fs.writeFileSync(filePath, buffer);

  const previewPaths = [];
  const stem = spec.nama_file.replace(/\.[^.]+$/, '');
  const dir = path.join(outDir, '.pratinjau');
  // Buang pratinjau lama milik file yang sama (mis. versi sebelumnya punya lebih banyak halaman).
  try { for (const f of fs.readdirSync(dir)) if ((f.startsWith(`${stem}-hal`) || f.startsWith(`${stem}-slide`)) && f.endsWith('.png')) fs.unlinkSync(path.join(dir, f)); } catch {}
  if (spec.format === 'pptx') {
    previewPaths.push(...await renderPptxPreviews(filePath, dir, stem));
  } else if (previews.length) {
    fs.mkdirSync(dir, { recursive: true });
    previews.forEach((buf, i) => {
      const p = path.join(dir, `${stem}-hal${i + 1}.png`);
      fs.writeFileSync(p, buf);
      previewPaths.push(p);
    });
  } else if (spec.format === 'png') {
    previewPaths.push(filePath);
  }
  return { fileName: spec.nama_file, filePath, bytes: buffer.length, format: spec.format, info, previewPaths, previewPath: previewPaths[0] || null };
}
