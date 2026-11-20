/**
 * Tool Joko untuk agen (diekspos lewat MCP — lihat joko-mcp-server.mjs).
 * ------------------------------------------------------------
 * Handler berjalan DI DALAM proses Joko (wa-assistant.mjs) karena data live
 * (radar GPS Transjakarta via MQTT, cache rute, jadwal) hanya ada di proses itu.
 * Server MCP hanya meneruskan panggilan lewat HTTP lokal bertoken.
 *
 * Semua tool bersifat baca/ambil data. Aksi berdampak publik (posting Threads,
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
  }
]);

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
    }
  };

  return async function runTool(name, args = {}) {
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
    if (!handler) throw new ToolInputError(`tool tidak dikenal: ${name}`);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('arguments harus berupa objek');
    return clip(await handler(args));
  };
}
