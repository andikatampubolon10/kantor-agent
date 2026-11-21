/**
 * Mesin dokumen Joko: spesifikasi JSON -> PDF / Excel / Word / PowerPoint / grafik PNG.
 * ------------------------------------------------------------
 * Murni Node.js + Chrome yang sudah terpasang (tidak butuh Python/LibreOffice).
 * Dipanggil lewat tool MCP "buat_file" (joko-tools.mjs). Semua file ditulis HANYA ke
 * folder outbox; nama file disanitasi sehingga tidak bisa keluar dari folder itu.
 *
 * Gaya seragam: warna, huruf, format Rupiah & tanggal Indonesia sama di semua format.
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
export const THEME = Object.freeze({
  accent: '1F4E79',
  accent2: '2E75B6',
  light: 'EAF1F8',
  zebra: 'F6F9FC',
  text: '1F2937',
  muted: '6B7280',
  border: 'D0D7E2',
  font: 'Segoe UI',
  palette: ['2E75B6', 'F28E2B', '59A14F', 'E15759', '76B7B2', 'EDC948', 'B07AA1', 'FF9DA7', '9C755F', 'BAB0AC']
});

const LIMITS = Object.freeze({ blocks: 300, rows: 5000, cols: 30, slides: 40, sheets: 20, points: 200, text: 20000 });
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

export function formatNumberId(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('id-ID', { maximumFractionDigits: 2 }) : String(n ?? '');
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

export function formatCell(value, format) {
  if (value === null || value === undefined || value === '') return '';
  if (format === 'rupiah') { const n = parseNumber(value); return n === null ? String(value) : formatRupiah(n); }
  if (format === 'angka') { const n = parseNumber(value); return n === null ? String(value) : formatNumberId(n); }
  if (format === 'persen') { const n = parseNumber(value); return n === null ? String(value) : `${formatNumberId(n)}%`; }
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
    const format = COLUMN_FORMATS.has(col.format) ? col.format : 'teks';
    return { judul: str(col.judul ?? col.nama ?? '', 200), format, lebar: Number(col.lebar) > 0 ? Math.min(80, Number(col.lebar)) : null };
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

export function normTable(t, where = 'tabel') {
  const kolom = normColumns(t?.kolom, where);
  return { kolom, baris: normRows(t?.baris, kolom.length, where), total: !!t?.total, label_total: str(t?.label_total || 'Total', 60) };
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
  return { jenis, judul: str(g.judul, 200), label, seri, format };
}

function normBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new DocumentSpecError('"isi" wajib berupa daftar blok (judul, paragraf, daftar, tabel, grafik, catatan, pemisah_halaman).');
  if (blocks.length > LIMITS.blocks) throw new DocumentSpecError(`maksimal ${LIMITS.blocks} blok isi.`);
  return blocks.map((b, i) => {
    const where = `isi[${i}]`;
    switch (b?.jenis) {
      case 'judul': return { jenis: 'judul', teks: str(b.teks, 300), level: Math.min(3, Math.max(1, Number(b.level) || 1)) };
      case 'paragraf': return { jenis: 'paragraf', teks: str(b.teks) };
      case 'catatan': return { jenis: 'catatan', teks: str(b.teks) };
      case 'daftar': return { jenis: 'daftar', butir: (Array.isArray(b.butir) ? b.butir : []).slice(0, 200).map(x => str(x, 2000)), bernomor: !!b.bernomor };
      case 'tabel': return { jenis: 'tabel', ...normTable(b, where) };
      case 'grafik': return { jenis: 'grafik', grafik: normChart(b.grafik || b, where) };
      case 'pemisah_halaman': return { jenis: 'pemisah_halaman' };
      default: throw new DocumentSpecError(`${where}: jenis blok tidak dikenal "${b?.jenis}".`);
    }
  });
}

export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new DocumentSpecError('spesifikasi harus berupa objek JSON.');
  const format = FORMATS[String(spec.format || '').toLowerCase()];
  if (!format) throw new DocumentSpecError('format wajib salah satu dari: pdf, xlsx, docx, pptx, png.');
  const base = {
    format,
    nama_file: sanitizeFileName(spec.nama_file || spec.judul, format),
    judul: str(spec.judul, 300),
    subjudul: str(spec.subjudul, 500),
    tanggal: spec.tanggal === false ? '' : str(spec.tanggal || todayWib(), 100),
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
        return { nama, judul: str(s.judul ?? (i === 0 ? spec.judul : ''), 300), ...normTable(s, `lembar[${i}]`), grafik: s.grafik ? normChart(s.grafik, `lembar[${i}].grafik`) : null };
      })
    };
  }
  if (format === 'pptx') {
    if (!Array.isArray(spec.slide) || !spec.slide.length) throw new DocumentSpecError('"slide" wajib berupa daftar slide ({judul, butir, tabel, grafik, catatan}).');
    if (spec.slide.length > LIMITS.slides) throw new DocumentSpecError(`maksimal ${LIMITS.slides} slide.`);
    return {
      ...base,
      slide: spec.slide.map((s, i) => ({
        judul: str(s?.judul, 200),
        butir: Array.isArray(s?.butir) ? s.butir.slice(0, 12).map(x => str(x, 500)) : [],
        tabel: s?.tabel ? normTable(s.tabel, `slide[${i}].tabel`) : null,
        grafik: s?.grafik ? normChart(s.grafik, `slide[${i}].grafik`) : null,
        catatan: str(s?.catatan, 3000)
      }))
    };
  }
  return { ...base, grafik: normChart(spec.grafik || spec, 'grafik') };
}

/** Jumlah per kolom angka (untuk baris total). */
export function columnTotals(table) {
  return table.kolom.map((c, i) => (isNumericFormat(c.format) && c.format !== 'persen'
    ? table.baris.reduce((sum, r) => sum + (parseNumber(r[i]) ?? 0), 0)
    : null));
}

// ---------- Chrome ----------
let chromeQueue = Promise.resolve();
async function withBrowser(fn) {
  const run = chromeQueue.then(async () => {
    const executablePath = getChromePath();
    if (!executablePath) throw new Error('Chrome/Edge tidak ditemukan; PDF & grafik membutuhkan Chrome.');
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
/** Teks aman + **tebal** + baris baru. */
const richHtml = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

let chartJsCache = null;
function chartJsSource() {
  // Subpath dist/ tidak diekspor paket chart.js; cari lewat lokasi package.json-nya.
  if (!chartJsCache) {
    // require.resolve('chart.js') -> <paket>/dist/chart.cjs; file UMD ada di folder yang sama.
    const distDir = path.dirname(require.resolve('chart.js'));
    chartJsCache = fs.readFileSync(path.join(distDir, 'chart.umd.min.js'), 'utf8');
  }
  return chartJsCache;
}

/** Render grafik ke PNG (Buffer) dengan Chart.js di Chrome. */
export async function renderChartPng(chart, { width = 1000, height = 600, browser = null } = {}) {
  const render = async (b) => {
    const page = await isolatedPage(b, { js: true });
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    const cfg = JSON.stringify({ ...chart, palette: THEME.palette.map(c => `#${c}`), font: THEME.font, text: `#${THEME.text}` });
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
   let txt=short(v);if(round){const pct=total?Math.round(v/total*100):0;if(pct<4)return;txt=pct+'%';ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(txt,p.x,p.y);return;}
   ctx.fillStyle=S.text;if(S.jenis==='batang_horizontal'){ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(txt,p.x+6,p.y);}else{ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(txt,p.x,p.y-4);}});});ctx.restore();}};
new Chart(document.getElementById('c'),{type,plugins:[labelsPlugin],
 data:{labels:S.label,datasets:S.seri.map((s,i)=>({label:s.nama,data:s.data,
  backgroundColor:round?S.label.map((_,j)=>S.palette[j%S.palette.length]):(type==='line'?S.palette[i%S.palette.length]+'33':S.palette[i%S.palette.length]),
  borderColor:round?'#fff':S.palette[i%S.palette.length],borderWidth:round?2:(type==='line'?3:0),fill:type==='line'&&S.seri.length===1,tension:0.25,pointRadius:type==='line'?4:0,borderRadius:type==='bar'?4:0}))},
 options:{animation:false,responsive:false,maintainAspectRatio:false,devicePixelRatio:2,indexAxis:S.jenis==='batang_horizontal'?'y':'x',
  layout:{padding:{top:round?10:28,right:S.jenis==='batang_horizontal'?70:24,left:12,bottom:8}},
  plugins:{title:{display:!!S.judul,text:S.judul,font:{size:22,weight:'600'},padding:{bottom:18}},
   legend:{display:round||S.seri.length>1,position:round?'right':'bottom',labels:{boxWidth:16,padding:16,
    generateLabels:round?(ch)=>{const ds=ch.data.datasets[0];return ch.data.labels.map((l,j)=>({text:l+' — '+fmt(ds.data[j]),fillStyle:ds.backgroundColor[j],strokeStyle:'#fff',index:j}));}:undefined}}},
  scales:round?{}:{[S.jenis==='batang_horizontal'?'x':'y']:{beginAtZero:true,grid:{color:'#e5e7eb'},ticks:{callback:(v)=>short(v)}},[S.jenis==='batang_horizontal'?'y':'x']:{grid:{display:false}}}}});
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

// ---------- PDF ----------
function tableHtml(t) {
  const totals = t.total ? columnTotals(t) : null;
  const align = (c) => (isNumericFormat(c.format) ? ' class="num"' : '');
  const head = `<thead><tr>${t.kolom.map(c => `<th${align(c)}>${escapeHtml(c.judul)}</th>`).join('')}</tr></thead>`;
  const body = t.baris.map(r => `<tr>${r.map((v, i) => `<td${align(t.kolom[i])}>${escapeHtml(formatCell(v, t.kolom[i].format))}</td>`).join('')}</tr>`).join('');
  const foot = totals ? `<tfoot><tr>${t.kolom.map((c, i) => `<td${align(c)}>${i === 0 && totals[0] === null ? escapeHtml(t.label_total) : (totals[i] === null ? '' : escapeHtml(formatCell(totals[i], c.format)))}</td>`).join('')}</tr></tfoot>` : '';
  return `<table>${head}<tbody>${body}</tbody>${foot}</table>`;
}

export function buildPdfHtml(spec, chartImages = []) {
  let chartIdx = 0;
  let ol = false;
  const blocks = spec.isi.map((b) => {
    switch (b.jenis) {
      case 'judul': return `<h${b.level + 1}>${escapeHtml(b.teks)}</h${b.level + 1}>`;
      case 'paragraf': return `<p>${richHtml(b.teks)}</p>`;
      case 'catatan': return `<div class="note">${richHtml(b.teks)}</div>`;
      case 'daftar': ol = b.bernomor; return `<${ol ? 'ol' : 'ul'}>${b.butir.map(x => `<li>${richHtml(x)}</li>`).join('')}</${ol ? 'ol' : 'ul'}>`;
      case 'tabel': return tableHtml(b);
      case 'grafik': { const img = chartImages[chartIdx++]; return img ? `<figure><img src="data:image/png;base64,${img.toString('base64')}" alt=""></figure>` : ''; }
      case 'pemisah_halaman': return '<div class="pb"></div>';
      default: return '';
    }
  }).join('\n');
  const c = (k) => `#${THEME[k]}`;
  return `<!doctype html><html lang="id"><meta charset="utf-8"><title>${escapeHtml(spec.judul)}</title><style>
@page{size:A4 ${spec.lanskap ? 'landscape' : 'portrait'};margin:18mm 16mm 20mm}
*{box-sizing:border-box}body{font-family:"${THEME.font}",Arial,"DejaVu Sans",sans-serif;color:${c('text')};font-size:10.5pt;line-height:1.5;margin:0}
header{border-left:6px solid ${c('accent')};padding:2px 0 2px 14px;margin-bottom:18px}
header h1{font-size:20pt;line-height:1.2;margin:0;color:${c('accent')}}header .sub{font-size:11.5pt;color:${c('muted')};margin-top:4px}header .date{font-size:9.5pt;color:${c('muted')};margin-top:2px}
h2{font-size:14pt;color:${c('accent')};margin:20px 0 8px;padding-bottom:4px;border-bottom:1.5px solid ${c('light')}}h3{font-size:12pt;color:${c('accent2')};margin:14px 0 6px}h4{font-size:11pt;margin:12px 0 4px}
h2,h3,h4{break-after:avoid}p{margin:0 0 8px}ul,ol{margin:0 0 10px;padding-left:22px}li{margin:2px 0}
table{width:100%;border-collapse:collapse;margin:6px 0 14px;font-size:9.5pt}thead{display:table-header-group}tr{break-inside:avoid}
th{background:${c('accent')};color:#fff;font-weight:600;text-align:left;padding:6px 8px}td{padding:5px 8px;border-bottom:1px solid ${c('border')}}
tbody tr:nth-child(even) td{background:${c('zebra')}}tfoot td{font-weight:700;background:${c('light')};border-top:2px solid ${c('accent')}}
.num{text-align:right;white-space:nowrap}figure{margin:8px 0 14px;text-align:center;break-inside:avoid}figure img{max-width:100%;max-height:120mm}
.note{background:${c('light')};border-left:4px solid ${c('accent2')};padding:8px 12px;margin:8px 0 12px;break-inside:avoid}.pb{break-after:page}
</style><body><header><h1>${escapeHtml(spec.judul || 'Dokumen')}</h1>${spec.subjudul ? `<div class="sub">${escapeHtml(spec.subjudul)}</div>` : ''}${spec.tanggal ? `<div class="date">${escapeHtml(spec.tanggal)}</div>` : ''}</header>
${blocks}</body></html>`;
}

async function buildPdf(spec) {
  return withBrowser(async (browser) => {
    const charts = [];
    for (const b of spec.isi) if (b.jenis === 'grafik') charts.push(await renderChartPng(b.grafik, { browser, width: 900, height: 500 }));
    const html = buildPdfHtml(spec, charts);
    const page = await isolatedPage(browser, { js: false });
    await page.setContent(html, { waitUntil: 'load' });
    const footer = `<div style="font-family:Arial,sans-serif;font-size:8px;color:#${THEME.muted};width:100%;padding:0 16mm;display:flex;justify-content:space-between">
<span>${escapeHtml(spec.judul).slice(0, 90)}</span><span>Halaman <span class="pageNumber"></span> dari <span class="totalPages"></span></span></div>`;
    const pdf = Buffer.from(await page.pdf({
      format: 'A4', landscape: spec.lanskap, printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer
    }));
    // Pratinjau halaman pertama untuk diperiksa agen secara visual.
    const w = spec.lanskap ? 1123 : 794;
    const h = spec.lanskap ? 794 : 1123;
    await page.emulateMediaType('print');
    await page.addStyleTag({ content: `body{padding:${Math.round(18 * 3.78)}px ${Math.round(16 * 3.78)}px}` }).catch(() => {});
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    const preview = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } }));
    await page.close();
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    return { buffer: pdf, preview, info: `${pages} halaman` };
  });
}

// ---------- Excel ----------
const XLSX_NUMFMT = { rupiah: '"Rp" #,##0;[Red]-"Rp" #,##0', angka: '#,##0.##', persen: '0.0%', tanggal: 'dd mmm yyyy' };

function xlsxValue(v, format) {
  if (v === '' || v === null || v === undefined) return null;
  if (format === 'rupiah' || format === 'angka') return parseNumber(v) ?? String(v);
  if (format === 'persen') { const n = parseNumber(v); return n === null ? String(v) : n / 100; }
  if (format === 'tanggal') return parseDate(v) ?? String(v);
  return typeof v === 'number' ? v : String(v);
}

const colLetter = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

async function buildXlsx(spec) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Joko';
  wb.created = new Date();
  const thin = { style: 'thin', color: { argb: `FF${THEME.border}` } };
  const summary = [];
  const needsChart = spec.lembar.some(s => s.grafik);
  const charts = needsChart ? await withBrowser(async (b) => Promise.all(spec.lembar.map(s => (s.grafik ? renderChartPng(s.grafik, { browser: b, width: 900, height: 500 }) : null)))) : [];

  spec.lembar.forEach((sh, si) => {
    const ws = wb.addWorksheet(sh.nama, { properties: { defaultRowHeight: 18 } });
    const ncol = sh.kolom.length;
    let r = 1;
    if (sh.judul) {
      ws.mergeCells(1, 1, 1, Math.max(1, ncol));
      Object.assign(ws.getCell(1, 1), { value: sh.judul });
      ws.getCell(1, 1).font = { name: THEME.font, size: 14, bold: true, color: { argb: `FF${THEME.accent}` } };
      ws.getRow(1).height = 24;
      const sub = [spec.subjudul, spec.tanggal].filter(Boolean).join(' • ');
      if (sub) {
        ws.mergeCells(2, 1, 2, Math.max(1, ncol));
        ws.getCell(2, 1).value = sub;
        ws.getCell(2, 1).font = { name: THEME.font, size: 10, italic: true, color: { argb: `FF${THEME.muted}` } };
      }
      r = 4;
    }
    const headerRow = r;
    sh.kolom.forEach((c, i) => {
      const cell = ws.getCell(headerRow, i + 1);
      cell.value = c.judul;
      cell.font = { name: THEME.font, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${THEME.accent}` } };
      cell.alignment = { vertical: 'middle', horizontal: isNumericFormat(c.format) ? 'right' : 'left', wrapText: true };
      cell.border = { top: thin, bottom: thin, left: thin, right: thin };
    });
    ws.getRow(headerRow).height = 22;
    sh.baris.forEach((row, ri) => {
      const rr = headerRow + 1 + ri;
      row.forEach((v, i) => {
        const c = sh.kolom[i];
        const cell = ws.getCell(rr, i + 1);
        cell.value = xlsxValue(v, c.format);
        if (XLSX_NUMFMT[c.format]) cell.numFmt = XLSX_NUMFMT[c.format];
        cell.font = { name: THEME.font, size: 10 };
        cell.border = { bottom: thin };
        cell.alignment = { vertical: 'top', horizontal: isNumericFormat(c.format) ? 'right' : (c.format === 'tanggal' ? 'center' : 'left'), wrapText: c.format === 'teks' };
        if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${THEME.zebra}` } };
      });
    });
    const first = headerRow + 1;
    const last = headerRow + sh.baris.length;
    if (sh.total && sh.baris.length) {
      const tr = last + 1;
      const totals = columnTotals(sh);
      sh.kolom.forEach((c, i) => {
        const cell = ws.getCell(tr, i + 1);
        if (totals[i] !== null) {
          const L = colLetter(i);
          cell.value = { formula: `SUM(${L}${first}:${L}${last})`, result: totals[i] };
          cell.numFmt = XLSX_NUMFMT[c.format];
          cell.alignment = { horizontal: 'right' };
        } else if (i === 0) cell.value = sh.label_total;
        cell.font = { name: THEME.font, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${THEME.light}` } };
        cell.border = { top: { style: 'medium', color: { argb: `FF${THEME.accent}` } } };
      });
    }
    // Lebar kolom: dari isi terformat (dibatasi), atau lebar eksplisit.
    sh.kolom.forEach((c, i) => {
      const lens = [c.judul.length, ...sh.baris.slice(0, 500).map(r => formatCell(r[i], c.format).length)];
      ws.getColumn(i + 1).width = c.lebar || Math.min(50, Math.max(10, Math.max(...lens) + 3));
    });
    ws.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }];
    if (sh.baris.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: last, column: ncol } };
    ws.pageSetup = { orientation: spec.lanskap ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    if (charts[si]) {
      const id = wb.addImage({ buffer: charts[si], extension: 'png' });
      ws.addImage(id, { tl: { col: ncol + 1, row: headerRow - 1 }, ext: { width: 640, height: 356 } });
    }
    summary.push(`${sh.nama}: ${sh.baris.length} baris × ${ncol} kolom${sh.total ? ', baris total (rumus SUM)' : ''}${charts[si] ? ', grafik' : ''}`);
  });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), preview: null, info: summary.join('; ') };
}

// ---------- Word ----------
function docxRuns(text, opts = {}) {
  return String(text).split(/(\*\*.+?\*\*)/g).filter(Boolean).flatMap((part) => {
    const bold = /^\*\*.+\*\*$/.test(part);
    const t = bold ? part.slice(2, -2) : part;
    return t.split('\n').map((line, i) => new TextRun({ text: line, bold: bold || opts.bold, color: opts.color, break: i > 0 ? 1 : 0, font: THEME.font, size: opts.size }));
  });
}

function docxTable(t) {
  const totals = t.total ? columnTotals(t) : null;
  const border = { style: BorderStyle.SINGLE, size: 4, color: THEME.border };
  const cell = (text, c, { header = false, total = false, zebra = false } = {}) => new TableCell({
    shading: header ? { type: ShadingType.CLEAR, fill: THEME.accent, color: 'auto' } : (total ? { type: ShadingType.CLEAR, fill: THEME.light, color: 'auto' } : (zebra ? { type: ShadingType.CLEAR, fill: THEME.zebra, color: 'auto' } : undefined)),
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    borders: { top: border, bottom: border, left: border, right: border },
    children: [new Paragraph({
      alignment: isNumericFormat(c.format) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text, bold: header || total, color: header ? 'FFFFFF' : THEME.text, font: THEME.font, size: 19 })]
    })]
  });
  const rows = [new TableRow({ tableHeader: true, children: t.kolom.map(c => cell(c.judul, c, { header: true })) })];
  t.baris.forEach((r, ri) => rows.push(new TableRow({ cantSplit: true, children: r.map((v, i) => cell(formatCell(v, t.kolom[i].format), t.kolom[i], { zebra: ri % 2 === 1 })) })));
  if (totals) rows.push(new TableRow({ children: t.kolom.map((c, i) => cell(i === 0 && totals[0] === null ? t.label_total : (totals[i] === null ? '' : formatCell(totals[i], c.format)), c, { total: true })) }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

async function buildDocx(spec) {
  const chartBlocks = spec.isi.filter(b => b.jenis === 'grafik');
  const charts = chartBlocks.length ? await withBrowser(async (b) => { const out = []; for (const cb of chartBlocks) out.push(await renderChartPng(cb.grafik, { browser: b, width: 900, height: 500 })); return out; }) : [];
  let ci = 0;
  let listInstance = 0;
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: spec.judul || 'Dokumen', bold: true, color: THEME.accent, font: THEME.font, size: 40 })] })
  ];
  if (spec.subjudul) children.push(new Paragraph({ children: [new TextRun({ text: spec.subjudul, color: THEME.muted, font: THEME.font, size: 24 })] }));
  if (spec.tanggal) children.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: spec.tanggal, color: THEME.muted, font: THEME.font, size: 19 })] }));
  for (const b of spec.isi) {
    if (b.jenis === 'judul') children.push(new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][b.level - 1], spacing: { before: 240, after: 120 }, children: [new TextRun({ text: b.teks, bold: true, color: b.level === 1 ? THEME.accent : THEME.accent2, font: THEME.font, size: [30, 26, 23][b.level - 1] })] }));
    else if (b.jenis === 'paragraf') children.push(new Paragraph({ spacing: { after: 120 }, children: docxRuns(b.teks, { size: 21 }) }));
    else if (b.jenis === 'catatan') children.push(new Paragraph({ spacing: { before: 120, after: 160 }, shading: { type: ShadingType.CLEAR, fill: THEME.light, color: 'auto' }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: THEME.accent2, space: 8 } }, children: docxRuns(b.teks, { size: 21 }) }));
    else if (b.jenis === 'daftar') {
      const instance = listInstance++;
      b.butir.forEach(x => children.push(new Paragraph({ ...(b.bernomor ? { numbering: { reference: 'angka', level: 0, instance } } : { bullet: { level: 0 } }), children: docxRuns(x, { size: 21 }) })));
    } else if (b.jenis === 'tabel') { children.push(docxTable(b)); children.push(new Paragraph({ text: '' })); }
    else if (b.jenis === 'grafik') children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: charts[ci++], transformation: { width: 600, height: 333 } })] }));
    else if (b.jenis === 'pemisah_halaman') children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  const doc = new Document({
    creator: 'Joko', title: spec.judul,
    styles: { default: { document: { run: { font: THEME.font, size: 21, color: THEME.text } } } },
    numbering: { config: [{ reference: 'angka', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 500, hanging: 300 } } } }] }] },
    sections: [{
      properties: { page: { size: { orientation: spec.lanskap ? 'landscape' : 'portrait' }, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ['Halaman ', PageNumber.CURRENT, ' dari ', PageNumber.TOTAL_PAGES], color: THEME.muted, size: 16, font: THEME.font })] })] }) },
      children
    }]
  });
  return { buffer: await Packer.toBuffer(doc), preview: null, info: `${spec.isi.length} blok isi${charts.length ? `, ${charts.length} grafik` : ''}` };
}

// ---------- PowerPoint ----------
async function buildPptx(spec) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.author = 'Joko';
  pptx.title = spec.judul;
  const font = THEME.font;
  const footer = (s, n) => {
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 7.2, w: 13.33, h: 0.3, fill: { color: THEME.light }, line: { color: THEME.light } });
    s.addText(`${spec.judul}  •  ${n}`, { x: 0.5, y: 7.2, w: 12.3, h: 0.3, fontFace: font, fontSize: 10, color: THEME.muted, align: 'right' });
  };

  const cover = pptx.addSlide();
  cover.background = { color: THEME.accent };
  cover.addShape(pptx.ShapeType.rect, { x: 0.8, y: 2.55, w: 0.12, h: 1.9, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' } });
  cover.addText(spec.judul || 'Presentasi', { x: 1.15, y: 2.4, w: 11.3, h: 1.3, fontFace: font, fontSize: 40, bold: true, color: 'FFFFFF', fit: 'shrink' });
  cover.addText([spec.subjudul, spec.tanggal].filter(Boolean).join('\n'), { x: 1.15, y: 3.7, w: 11.3, h: 0.9, fontFace: font, fontSize: 18, color: 'DCE6F2' });

  const chartType = { batang: pptx.ChartType.bar, batang_horizontal: pptx.ChartType.bar, garis: pptx.ChartType.line, pai: pptx.ChartType.pie, donat: pptx.ChartType.doughnut };
  const numFmt = { rupiah: '"Rp" #,##0', angka: '#,##0', persen: '0.0"%"' };

  spec.slide.forEach((sd, i) => {
    const s = pptx.addSlide();
    s.background = { color: 'FFFFFF' };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: THEME.accent }, line: { color: THEME.accent } });
    s.addText(sd.judul, { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontFace: font, fontSize: 28, bold: true, color: THEME.accent, fit: 'shrink' });
    const hasVisual = sd.tabel || sd.grafik;
    const textW = hasVisual && sd.butir.length ? 5.4 : 12.1;
    if (sd.butir.length) {
      s.addText(sd.butir.map(t => ({ text: t.replace(/\*\*/g, ''), options: { bullet: { indent: 18 }, paraSpaceAfter: 10 } })),
        { x: 0.6, y: 1.45, w: textW, h: 5.5, fontFace: font, fontSize: sd.butir.length > 6 ? 16 : 20, color: THEME.text, valign: 'top', fit: 'shrink' });
    }
    const vx = sd.butir.length ? 6.3 : 0.6;
    const vw = sd.butir.length ? 6.4 : 12.1;
    if (sd.grafik) {
      const g = sd.grafik;
      const round = g.jenis === 'pai' || g.jenis === 'donat';
      s.addChart(chartType[g.jenis], g.seri.map(x => ({ name: x.nama, labels: g.label, values: x.data })), {
        x: vx, y: 1.45, w: vw, h: sd.tabel ? 2.7 : 5.5, barDir: g.jenis === 'batang_horizontal' ? 'bar' : 'col',
        chartColors: THEME.palette, showLegend: round || g.seri.length > 1, legendPos: round ? 'r' : 'b', legendFontFace: font,
        showValue: !round, showPercent: round, dataLabelFormatCode: numFmt[g.format], valAxisLabelFormatCode: numFmt[g.format],
        dataLabelFontSize: 11, catAxisLabelFontFace: font, valAxisLabelFontFace: font, showTitle: !!g.judul, title: g.judul, titleFontFace: font, titleFontSize: 14,
        valGridLine: { color: 'E5E7EB', size: 1 }
      });
    }
    if (sd.tabel) {
      const t = sd.tabel;
      const totals = t.total ? columnTotals(t) : null;
      const al = (c) => (isNumericFormat(c.format) ? 'right' : 'left');
      const rows = [t.kolom.map(c => ({ text: c.judul, options: { bold: true, color: 'FFFFFF', fill: { color: THEME.accent }, align: al(c) } }))];
      t.baris.slice(0, 14).forEach((r, ri) => rows.push(r.map((v, ci) => ({ text: formatCell(v, t.kolom[ci].format), options: { align: al(t.kolom[ci]), fill: { color: ri % 2 ? THEME.zebra : 'FFFFFF' } } }))));
      if (totals) rows.push(t.kolom.map((c, ci) => ({ text: ci === 0 && totals[0] === null ? t.label_total : (totals[ci] === null ? '' : formatCell(totals[ci], c.format)), options: { bold: true, fill: { color: THEME.light }, align: al(c) } })));
      s.addTable(rows, { x: vx, y: sd.grafik ? 4.3 : 1.45, w: vw, fontFace: font, fontSize: rows.length > 10 ? 11 : 13, color: THEME.text, border: { type: 'solid', pt: 0.5, color: THEME.border }, autoPage: false });
    }
    if (sd.catatan) s.addNotes(sd.catatan);
    footer(s, i + 2);
  });
  const buffer = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
  return { buffer, preview: null, info: `${spec.slide.length + 1} slide (termasuk sampul)` };
}

// ---------- Grafik PNG ----------
async function buildPng(spec) {
  const buffer = await renderChartPng({ ...spec.grafik, judul: spec.grafik.judul || spec.judul }, { width: 1200, height: 700 });
  return { buffer, preview: null, info: `grafik ${spec.grafik.jenis}, ${spec.grafik.label.length} kategori` };
}

const BUILDERS = { pdf: buildPdf, xlsx: buildXlsx, docx: buildDocx, pptx: buildPptx, png: buildPng };

/**
 * Bangun file dari spesifikasi dan simpan di outDir.
 * @returns {Promise<{fileName:string, filePath:string, bytes:number, format:string, info:string, previewPath:string|null}>}
 */
export async function buildDocument(rawSpec, { outDir = MEDIA_OUTBOX_DIR } = {}) {
  const spec = normalizeSpec(rawSpec);
  const { buffer, preview, info } = await BUILDERS[spec.format](spec);
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, spec.nama_file);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(outDir)) throw new DocumentSpecError('nama file tidak valid.');
  fs.writeFileSync(filePath, buffer);
  let previewPath = null;
  if (preview) {
    const dir = path.join(outDir, '.pratinjau');
    fs.mkdirSync(dir, { recursive: true });
    previewPath = path.join(dir, `${spec.nama_file.replace(/\.[^.]+$/, '')}-hal1.png`);
    fs.writeFileSync(previewPath, preview);
  } else if (spec.format === 'png') {
    previewPath = filePath;
  }
  return { fileName: spec.nama_file, filePath, bytes: buffer.length, format: spec.format, info, previewPath };
}
