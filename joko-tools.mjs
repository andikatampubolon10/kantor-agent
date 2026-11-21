/**
 * Tool Joko untuk agen (diekspos lewat MCP — lihat joko-mcp-server.mjs).
 * ------------------------------------------------------------
 * Handler berjalan DI DALAM proses Joko (wa-assistant.mjs) karena data live
 * (radar GPS Transjakarta via MQTT, cache rute, jadwal) hanya ada di proses itu.
 * Server MCP hanya meneruskan panggilan lewat HTTP lokal bertoken.
 *
 * Semua tool bersifat baca/ambil data, kecuali buat_file yang hanya menulis ke folder
 * outbox (pengiriman tetap lewat blok kirim-file yang diperiksa). Aksi berdampak publik (posting Threads,
 * mengirim pesan, memberi akses) sengaja TIDAK dijadikan tool: aksi itu tetap
 * lewat jalur yang diawasi router (ownerRequestedThreadsPost, dsb.).
 * Hasil dari sumber luar dibungkus sebagai DATA TIDAK TERPERCAYA.
 */
import { wrapUntrusted } from './message-guard.mjs';

export const MAX_TOOL_OUTPUT = 8000;

const clip = (s, n = MAX_TOOL_OUTPUT) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n…(dipotong)` : t;
};

/** Teks data live Transjakarta (dipakai router & tool). */
export function formatTransitInfo(liveTJ) {
  const buses = liveTJ.buses || [];
  return `• Koridor: ${liveTJ.corridor} (${liveTJ.routeName})
• Halte Asal / Keberangkatan Pengguna: ${liveTJ.originStop}
• Halte Tujuan Pengguna: ${liveTJ.destStop || 'Sesuai rute'}
• Jumlah Armada Aktif di Koridor Saat Ini: ${liveTJ.activeBusCount} bus
• Bus Terdekat & Estimasi Waktu Tiba (ETA):
${buses.length > 0 ? buses.slice(0, 3).map((b, i) => `  ${i + 1}. Armada ${b.bodyNo} (Papan Jurusan: "${b.headsign}") -> Posisi Terakhir: ${b.currStop || b.nextStop}, Kecepatan: ${b.speed} km/jam, Estimasi Tiba di Halte ${liveTJ.originStop}: ${b.etaOriginMinutes !== null ? b.etaOriginMinutes + ' menit lagi' : 'Sedang menuju halte'}, Estimasi Sampai di Halte ${liveTJ.destStop || 'Tujuan'}: ${b.etaDestMinutes !== null ? b.etaDestMinutes + ' menit lagi' : '-'}`).join('\n') : '  (Armada bus sedang memutar rute/terminus)'}
• Tarif Tiket: Rp ${liveTJ.price}
• Jam Operasional: ${liveTJ.operatingHours}`;
}

/** Teks isi halaman web (dipakai router & tool). */
export function formatScrapedPage(scraped, maxContent = 3500) {
  return `• URL: ${scraped.url}
• Judul: ${scraped.title}
• Deskripsi: ${scraped.description}
• Penulis: ${scraped.author}
• Jumlah Kata: ${scraped.wordCount}
• Isi Artikel/Konten:
${String(scraped.content || '').slice(0, maxContent)}`;
}

export function formatNewsArticles(articles) {
  return articles.map((a, i) => `${i + 1}. "${a.title}" (${a.pubDate}${a.source ? `, ${a.source}` : ''})
   Link: ${a.url}
   Snippet: ${a.snippet}`).join('\n\n');
}

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'transjakarta_live',
    description: 'Radar GPS live Transjakarta: posisi armada, ETA bus ke halte, rute, tarif, jam operasional. Pakai untuk pertanyaan bus/halte/koridor Transjakarta.',
    inputSchema: {
      type: 'object',
      properties: {
        pertanyaan: { type: 'string', description: 'Pertanyaan pengguna apa adanya, mis. "bus 10H dari Tanah Abang ke Blok M kapan datang?"' },
        koridor: { type: 'string', description: 'Opsional: kode koridor, mis. "10H", "1", "9".' },
        halte_asal: { type: 'string', description: 'Opsional: nama halte asal.' },
        halte_tujuan: { type: 'string', description: 'Opsional: nama halte tujuan.' }
      },
      required: ['pertanyaan']
    }
  },
  {
    name: 'baca_halaman_web',
    description: 'Membuka satu URL publik (http/https) dan mengambil judul serta isi teksnya. Alamat internal/lokal ditolak.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'cari_berita',
    description: 'Mencari berita terkini tentang suatu topik (Google News) dan mengambil ringkasan artikelnya.',
    inputSchema: {
      type: 'object',
      properties: { topik: { type: 'string' }, jumlah: { type: 'integer', minimum: 1, maximum: 5, description: 'Jumlah artikel (default 3).' } },
      required: ['topik']
    }
  },
  {
    name: 'briefing_eksekutif',
    description: 'Menyusun Morning Executive Briefing Mas Andika (cuaca Jakarta, status komuter, tren AI/tech, draft Threads).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'daftar_jadwal',
    description: 'Daftar jadwal & pengingat yang aktif di Joko (judul, waktu, tujuan, ID). Hanya baca.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'status_joko',
    description: 'Status sistem Joko: koneksi WhatsApp, antrean tugas agen, radar Transjakarta, jumlah memori.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'buat_file',
    description: 'Membuat file rapi siap kirim ke WhatsApp dari spesifikasi JSON: PDF, Excel (xlsx), Word (docx), PowerPoint (pptx), atau grafik PNG. Gaya seragam, format Rupiah & tanggal Indonesia, total otomatis. File disimpan di folder outbox; PDF disertai gambar pratinjau halaman 1 untuk diperiksa. Lihat skill joko-dokumen untuk contoh spesifikasi.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['pdf', 'xlsx', 'docx', 'pptx', 'png'] },
        nama_file: { type: 'string', description: 'Nama file deskriptif, mis. "rekap-pengeluaran-nov-2026" (ekstensi otomatis).' },
        judul: { type: 'string' },
        subjudul: { type: 'string' },
        tanggal: { type: 'string', description: 'Opsional; default tanggal hari ini (WIB).' },
        orientasi: { type: 'string', enum: ['potret', 'lanskap'] },
        tema: { type: 'string', enum: ['profesional', 'keuangan', 'hangat', 'energik', 'teknologi', 'elegan', 'minimal', 'berani'], description: 'Tema warna sesuai topik (default profesional).' },
        gaya: { type: 'string', enum: ['laporan', 'surat'], description: 'surat = surat/dokumen resmi hitam-putih (pakai blok kop & tanda_tangan).' },
        isi: { type: 'array', description: 'pdf/docx: daftar blok {jenis: judul|paragraf|daftar|tabel|grafik|angka_kunci|catatan|kop|tanda_tangan|pemisah_halaman, ...}.', items: { type: 'object' } },
        lembar: { type: 'array', description: 'xlsx: daftar sheet {nama, judul?, kolom, baris, total?, grafik?, catatan?}.', items: { type: 'object' } },
        slide: { type: 'array', description: 'pptx: daftar slide {judul, butir?, angka_kunci?, tabel?, grafik?, catatan?}.', items: { type: 'object' } },
        penutup: { type: 'object', description: 'pptx (opsional): slide penutup gelap {judul, butir?}.' },
        grafik: { type: 'object', description: 'png: {jenis: batang|batang_horizontal|garis|pai|donat, judul, label, seri:[{nama, data}], format: rupiah|angka|persen}.' }
      },
      required: ['format']
    }
  }
]);

/**
 * Info tool untuk halaman "Tools & MCP" di panel admin.
 *  label  : nama ramah
 *  sifat  : baca (hanya mengambil data) | tulis (membuat file di outbox) | berat (proses panjang)
 *  uji    : boleh diuji dari panel (hanya tool baca yang aman & cepat)
 */
export const TOOL_PANEL_INFO = Object.freeze({
  transjakarta_live: { label: 'Radar Transjakarta', sifat: 'baca', uji: true },
  baca_halaman_web: { label: 'Baca halaman web', sifat: 'baca', uji: true },
  cari_berita: { label: 'Cari berita', sifat: 'baca', uji: true },
  briefing_eksekutif: { label: 'Briefing eksekutif', sifat: 'berat', uji: false },
  daftar_jadwal: { label: 'Daftar jadwal', sifat: 'baca', uji: true },
  status_joko: { label: 'Status Joko', sifat: 'baca', uji: true },
  buat_file: { label: 'Buat file', sifat: 'tulis', uji: false }
});

/** Ringkasan argumen untuk catatan aktivitas (tanpa isi dokumen penuh). */
export function toolArgsHint(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const s = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  let hint = '';
  if (name === 'buat_file') hint = [s(a.format), s(a.nama_file)].filter(Boolean).join(' · ');
  else hint = s(a.pertanyaan || a.url || a.topik || '');
  return hint.length > 140 ? `${hint.slice(0, 140)}…` : hint;
}

/**
 * Hasil `agy mcp list` -> [{ name, type, status, command }].
 * Format: "NAME  TYPE  STATUS  COMMAND/URL" (perintah boleh berisi spasi).
 */
export function parseMcpList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^NAME\s+TYPE\s+STATUS/i.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s+(stdio|https?|sse|streamable[-_]?http|ws)\s+(enabled|disabled|error|connected|failed)\s+(.+)$/i);
    if (m) out.push({ name: m[1], type: m[2], status: m[3].toLowerCase(), command: m[4].trim() });
  }
  return out;
}

export class ToolInputError extends Error {}

/**
 * @param {object} deps fungsi nyata dari modul Joko (disuntik agar bisa diuji)
 * @returns {(name:string, args:object) => Promise<string>}
 */
export function createToolRunner(deps) {
  const handlers = {
    async transjakarta_live(args) {
      const q = String(args.pertanyaan || '').trim();
      if (!q) throw new ToolInputError('pertanyaan wajib diisi');
      const params = { ...deps.extractTransitParams(q) };
      if (args.koridor) params.corridor = String(args.koridor);
      if (args.halte_asal) params.origin = String(args.halte_asal);
      if (args.halte_tujuan) params.destination = String(args.halte_tujuan);
      const live = await deps.getLiveTransitInfo(params);
      if (!live?.success) return `Data Transjakarta tidak tersedia: ${live?.message || 'rute/halte tidak ditemukan'}`;
      return wrapUntrusted('DATA LIVE GPS TRANSJAKARTA', formatTransitInfo(live));
    },

    async baca_halaman_web(args) {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new ToolInputError('url harus diawali http:// atau https://');
      try {
        const scraped = await deps.scrapeUrl(url);
        if (!scraped?.success || !String(scraped.content || '').trim()) {
          return `Halaman ${url} terbuka tetapi tidak berisi teks yang bisa dibaca. Jangan mengarang isinya.`;
        }
        return wrapUntrusted('ISI HALAMAN WEB', formatScrapedPage(scraped, 6000));
      } catch (err) {
        return `Halaman tidak dapat dibaca (${err?.name === 'UnsafeUrlError' ? `alamat tidak diizinkan: ${err.message}` : 'gagal dibuka'}). Jangan mengarang isinya.`;
      }
    },

    async cari_berita(args) {
      const topic = String(args.topik || '').trim();
      if (!topic) throw new ToolInputError('topik wajib diisi');
      const n = Math.min(5, Math.max(1, Number.parseInt(args.jumlah, 10) || 3));
      const res = await deps.searchAndScrapeTopic(topic, n);
      if (!res?.success || !res.articles?.length) return `Tidak ada berita yang ditemukan untuk "${topic}".`;
      return wrapUntrusted('HASIL RISET BERITA', formatNewsArticles(res.articles));
    },

    async briefing_eksekutif() {
      const b = await deps.generateExecutiveBriefing();
      return String(b?.text || 'Briefing kosong.');
    },

    async daftar_jadwal() {
      const jobs = deps.loadJobs();
      if (!jobs.length) return 'Belum ada jadwal atau pengingat aktif.';
      return jobs.map((j, i) => `${i + 1}. ${j.title} | ${j.config?.readableTime || j.type} | ${String(j.target || '').includes('@g.us') ? 'Grup' : 'Pribadi'} | ID ${j.id}`).join('\n');
    },

    async status_joko() {
      const s = deps.getStatus();
      return Object.entries(s).map(([k, v]) => `• ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    },

    async buat_file(args) {
      let r;
      try {
        r = await deps.buildDocument(args);
      } catch (err) {
        if (err?.name === 'DocumentSpecError') throw new ToolInputError(`spesifikasi tidak valid: ${err.message}`);
        throw err;
      }
      const kb = Math.max(1, Math.round(r.bytes / 1024));
      const previews = Array.isArray(r.previewPaths) ? r.previewPaths : (r.previewPath ? [r.previewPath] : []);
      const lines = [`File dibuat: ${r.fileName} (${r.info}, ${kb} KB).`];
      if (previews.length) {
        lines.push(`Pratinjau (${previews.length} gambar) — buka SEMUA dengan read_file dan nilai dengan rubrik skill sebelum mengirim:`);
        previews.forEach(p => lines.push(`- ${p}`));
      } else {
        lines.push('Tidak ada pratinjau gambar untuk format ini: periksa kerangka/ringkasan di atas terhadap rubrik skill.');
      }
      lines.push('Bila ada yang kurang (teks terpotong, tabel meluber, angka salah, struktur lemah), perbaiki spesifikasi lalu panggil buat_file lagi dengan nama_file yang sama.');
      lines.push('PENTING: hasil pemeriksaan ini catatan internal — JANGAN ditulis di jawaban. Jawaban akhir hanya pesan untuk Mas Andika (isi file 1–3 kalimat).');
      lines.push(`Kirim dengan blok di baris paling akhir jawaban: \`\`\`kirim-file\n{ "path": "${r.fileName}", "caption": "..." }\n\`\`\``);
      return lines.join('\n');
    }
  };

  return async function runTool(name, args = {}) {
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
    if (!handler) throw new ToolInputError(`tool tidak dikenal: ${name}`);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('arguments harus berupa objek');
    return clip(await handler(args));
  };
}
