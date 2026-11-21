import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  buildDocument, normalizeSpec, sanitizeFileName, parseNumber, formatRupiah, formatCell,
  columnTotals, buildPdfHtml, DocumentSpecError
} from '../document-builder.mjs';
import { getChromePath } from '../browser-utils.mjs';
import { createToolRunner, ToolInputError } from '../joko-tools.mjs';

// Tes tidak perlu membuka PowerPoint untuk pratinjau slide.
process.env.JOKO_PPTX_PREVIEW = 'off';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'joko-doc-'));
const hasChrome = fs.existsSync(getChromePath());

const kolom = [{ judul: 'Tanggal', format: 'tanggal' }, 'Kategori', { judul: 'Jumlah', format: 'rupiah' }];
const baris = [['2026-11-16', 'Makan', 45000], ['2026-11-17', 'Transport', 'Rp 15.000'], ['2026-11-18', 'Belanja', 230500]];

test('format angka & Rupiah Indonesia', () => {
  assert.equal(formatRupiah(1250000), 'Rp 1.250.000');
  assert.equal(formatRupiah(-5000), '-Rp 5.000');
  assert.equal(parseNumber('Rp 1.250.000'), 1250000);
  assert.equal(parseNumber('12,5%'), 12.5);
  assert.equal(parseNumber('1,250,000'), 1250000);
  assert.equal(parseNumber(42), 42);
  assert.equal(parseNumber('abc'), null);
  assert.equal(formatCell('2026-11-16', 'tanggal'), '16 Nov 2026');
  assert.equal(formatCell(12.5, 'persen'), '12,5%');
});

test('nama file disanitasi & tidak bisa keluar dari folder outbox', () => {
  assert.equal(sanitizeFileName('Rekap Pengeluaran Mingguan', 'pdf'), 'rekap-pengeluaran-mingguan.pdf');
  assert.equal(sanitizeFileName('../../.env', 'xlsx'), 'dokumen-joko.xlsx');
  assert.equal(sanitizeFileName('../../laporan', 'xlsx'), 'laporan.xlsx');
  assert.equal(sanitizeFileName('C:\\Windows\\evil.exe', 'pdf'), 'evil.pdf');
  assert.equal(sanitizeFileName('', 'docx'), 'dokumen-joko.docx');
  assert.equal(normalizeSpec({ format: 'png', nama_file: 'a/../../b.png', grafik: { label: ['x'], seri: [{ data: [1] }] } }).nama_file, 'b.png');
});

test('spesifikasi tidak valid ditolak dengan pesan jelas', () => {
  assert.throws(() => normalizeSpec({ format: 'exe' }), DocumentSpecError);
  assert.throws(() => normalizeSpec({ format: 'pdf' }), /isi/);
  assert.throws(() => normalizeSpec({ format: 'pdf', isi: [{ jenis: 'video' }] }), /jenis blok/);
  assert.throws(() => normalizeSpec({ format: 'xlsx', lembar: [{ nama: 'a', kolom: [], baris: [] }] }), /kolom/);
  assert.throws(() => normalizeSpec({ format: 'pptx', slide: [] }), /slide/);
});

test('total kolom angka & HTML PDF di-escape', () => {
  const t = normalizeSpec({ format: 'pdf', isi: [{ jenis: 'tabel', kolom, baris, total: true }] }).isi[0];
  assert.deepEqual(columnTotals(t), [null, null, 290500]);
  const html = buildPdfHtml(normalizeSpec({ format: 'pdf', judul: '<script>x</script>', isi: [{ jenis: 'paragraf', teks: 'a **b** <img src=x onerror=1>' }] }));
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('<strong>b</strong>'));
  assert.ok(!html.includes('<img src=x'));
});

test('Excel: format Rupiah/tanggal asli, rumus total, header dibekukan', async () => {
  const dir = tmp();
  const r = await buildDocument({ format: 'xlsx', nama_file: 'Tes Excel', judul: 'Tes', lembar: [{ nama: 'Data', kolom, baris, total: true }] }, { outDir: dir });
  assert.equal(r.fileName, 'tes-excel.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(r.filePath);
  const ws = wb.getWorksheet('Data');
  assert.equal(ws.getCell('A1').value, 'Tes');
  assert.equal(ws.getCell('C4').value, 'Jumlah');
  assert.equal(ws.getCell('C6').value, 15000); // "Rp 15.000" jadi angka
  assert.match(ws.getCell('C5').numFmt, /Rp/);
  assert.ok(ws.getCell('A5').value instanceof Date);
  assert.deepEqual(ws.getCell('C8').value, { formula: 'SUM(C5:C7)', result: 290500 });
  assert.equal(ws.views[0].state, 'frozen');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Word & PowerPoint: file valid (zip OOXML)', async () => {
  const dir = tmp();
  const d = await buildDocument({ format: 'docx', judul: 'Surat', isi: [{ jenis: 'judul', teks: 'Isi' }, { jenis: 'paragraf', teks: 'Halo **Mas**' }, { jenis: 'daftar', butir: ['a', 'b'], bernomor: true }, { jenis: 'tabel', kolom, baris, total: true }] }, { outDir: dir });
  const p = await buildDocument({ format: 'pptx', judul: 'Deck', slide: [{ judul: 'S1', butir: ['x'] }, { judul: 'S2', tabel: { kolom, baris, total: true }, grafik: { jenis: 'pai', label: ['a', 'b'], seri: [{ data: [1, 2] }] } }] }, { outDir: dir });
  for (const r of [d, p]) {
    const buf = fs.readFileSync(r.filePath);
    assert.equal(buf.subarray(0, 2).toString(), 'PK', r.fileName);
  }
  assert.match(d.fileName, /^surat\.docx$/);
  assert.match(p.info, /3 slide/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PDF & grafik PNG lewat Chrome (dengan pratinjau)', { skip: !hasChrome && 'Chrome tidak ada' }, async () => {
  const dir = tmp();
  const pdf = await buildDocument({ format: 'pdf', judul: 'Laporan', isi: [{ jenis: 'paragraf', teks: 'Halo' }, { jenis: 'grafik', grafik: { jenis: 'batang', label: ['a', 'b'], seri: [{ data: [1, 2] }] } }, { jenis: 'tabel', kolom, baris, total: true }] }, { outDir: dir });
  assert.equal(fs.readFileSync(pdf.filePath).subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.previewPath && fs.existsSync(pdf.previewPath));
  const png = await buildDocument({ format: 'png', nama_file: 'grafik', grafik: { jenis: 'garis', label: ['Jan', 'Feb'], seri: [{ nama: 'A', data: [1, 3] }] } }, { outDir: dir });
  const buf = fs.readFileSync(png.filePath);
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  assert.equal(buf.readUInt32BE(16), 2400); // 1200 px x2
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kolom porsi dihitung mesin (bukan model) & total porsi 100', () => {
  const t = normalizeSpec({ format: 'pdf', isi: [{ jenis: 'tabel', kolom: ['Kategori', { judul: 'Jumlah', format: 'rupiah' }, { judul: 'Porsi', hitung: 'porsi', dari: 'Jumlah' }], baris: [['Makan', 646000, 35.1], ['Rumah', 553000], ['Lain', 586000]], total: true }] }).isi[0];
  assert.deepEqual(t.baris.map(r => r[2]), [36.2, 31, 32.8]); // 35.1 dari model ditimpa
  assert.deepEqual(columnTotals(t), [null, 1785000, 100]);
  assert.equal(formatCell(31, 'persen'), '31,0%');
  assert.throws(() => normalizeSpec({ format: 'pdf', isi: [{ jenis: 'tabel', kolom: ['A', { judul: 'P', hitung: 'porsi' }], baris: [['x', 1]] }] }), /porsi/);
});

test('tema, gaya surat, blok info/kop/tanda tangan/angka kunci', () => {
  const s = normalizeSpec({ format: 'pdf', gaya: 'surat', tema: 'tidak-ada', isi: [
    { jenis: 'kop', nama: 'PT A', baris: ['Jl. B'] },
    { jenis: 'info', baris: [['Nomor', '1/X'], ['Perihal', '**Izin**']] },
    { jenis: 'angka_kunci', item: [{ label: 'Total', nilai: 5000, format: 'rupiah', perubahan: 8, baik_jika: 'turun' }] },
    { jenis: 'tanda_tangan', tempat_tanggal: 'Jakarta, 1 Des 2026', nama: 'Andika' }
  ] });
  assert.equal(s.tema, 'profesional');
  assert.equal(s.tanggal, ''); // surat tidak memberi tanggal otomatis
  const html = buildPdfHtml(s);
  assert.match(html, /class="kop"/);
  assert.match(html, /class="info"/);
  assert.match(html, /<strong>Izin<\/strong>/);
  assert.match(html, /kpi-c bad/); // biaya naik = merah
  assert.match(html, /class="ttd"/);
  assert.ok(!/<header>/.test(html)); // surat tanpa header judul berwarna
  const lap = buildPdfHtml(normalizeSpec({ format: 'pdf', tema: 'keuangan', judul: 'L', isi: [{ jenis: 'paragraf', teks: 'x' }] }));
  assert.match(lap, /#1F5136/);
  assert.ok(!/border-left:\s*\d+px solid/.test(lap)); // tanpa batang aksen dekoratif
});

test('tanggal ISO jadi format Indonesia, *miring*, pai > 6 irisan digabung', () => {
  assert.equal(normalizeSpec({ format: 'pdf', tanggal: '2026-11-21', isi: [{ jenis: 'paragraf', teks: 'x' }] }).tanggal, '21 November 2026');
  assert.equal(normalizeSpec({ format: 'pdf', tanggal: 'Minggu ke-3 November', isi: [{ jenis: 'paragraf', teks: 'x' }] }).tanggal, 'Minggu ke-3 November');
  const html = buildPdfHtml(normalizeSpec({ format: 'pdf', isi: [{ jenis: 'paragraf', teks: 'a *b* c 3*4' }] }));
  assert.match(html, /a <em>b<\/em> c 3\*4/);
  const g = normalizeSpec({ format: 'png', grafik: { jenis: 'pai', label: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], seri: [{ data: [8, 7, 6, 5, 4, 3, 2, 1] }] } }).grafik;
  assert.deepEqual(g.label, ['A', 'B', 'C', 'D', 'E', 'Lain-lain']);
  assert.deepEqual(g.seri[0].data, [8, 7, 6, 5, 4, 6]);
});

test('tool buat_file: spesifikasi salah -> ToolInputError, sukses -> instruksi kirim', async () => {
  const run = createToolRunner({
    buildDocument: async (spec) => {
      if (!spec.isi) { const e = new Error('"isi" wajib'); e.name = 'DocumentSpecError'; throw e; }
      return { fileName: 'a.pdf', filePath: '/x/a.pdf', bytes: 2048, format: 'pdf', info: '1 halaman', previewPath: '/x/.pratinjau/a-hal1.png' };
    }
  });
  await assert.rejects(run('buat_file', { format: 'pdf' }), ToolInputError);
  const out = await run('buat_file', { format: 'pdf', isi: [] });
  assert.match(out, /a\.pdf/);
  assert.match(out, /read_file/);
  assert.match(out, /kirim-file/);
});
