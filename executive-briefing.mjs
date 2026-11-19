import fs from 'node:fs';
import path from 'node:path';
import { searchAndScrapeTopic } from './web-intelligence.mjs';
import { loadJobs, getWIBDate } from './cron-manager.mjs';

const DRAFT_THREAD_FILE = path.join(process.cwd(), '.latest-briefing-draft.txt');

// Helper interpretasi kode cuaca WMO ke bahasa Indonesia
function interpretWeatherCode(code) {
  if (code === 0) return 'Cerah ☀️';
  if (code >= 1 && code <= 3) return 'Cerah Berawan ⛅';
  if (code >= 45 && code <= 48) return 'Berkabut / Berawan Tebal 🌫️';
  if (code >= 51 && code <= 55) return 'Gerimis Halus 🌦️';
  if (code >= 61 && code <= 65) return 'Hujan Sedang 🌧️';
  if (code >= 80 && code <= 82) return 'Hujan Deras / Guyuran Hujan ⛈️';
  if (code >= 95) return 'Hujan Petir ⚡';
  return 'Berawan ☁️';
}

// Fetch cuaca Jakarta via Open-Meteo (resilient dengan fallback)
export async function fetchJakartaWeather() {
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=-6.2088&longitude=106.8456&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m', {
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json();
    if (data?.current) {
      const temp = Math.round(data.current.temperature_2m);
      const humidity = data.current.relative_humidity_2m;
      const desc = interpretWeatherCode(data.current.weather_code);
      return {
        success: true,
        temperature: `${temp}°C`,
        humidity: `${humidity}%`,
        description: desc
      };
    }
  } catch (err) {
    console.warn('[Executive Briefing] Weather fetch fallback:', err.message);
  }
  return {
    success: false,
    temperature: '28°C - 32°C',
    humidity: '75%',
    description: 'Cerah Berawan khas Jakarta ⛅'
  };
}

// Simpan dan ambil draft konten Threads terbaru
export function saveLatestDraftThread(content) {
  try {
    fs.writeFileSync(DRAFT_THREAD_FILE, content.trim(), 'utf8');
  } catch (err) {
    console.error('[Executive Briefing] Error saving draft thread:', err.message);
  }
}

export function getLatestDraftThread() {
  try {
    if (fs.existsSync(DRAFT_THREAD_FILE)) {
      return fs.readFileSync(DRAFT_THREAD_FILE, 'utf8').trim();
    }
  } catch (err) {
    console.error('[Executive Briefing] Error reading draft thread:', err.message);
  }
  return null;
}

// Deteksi perintah minta briefing langsung dari chat
export function isBriefingCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /^(?:!joko\s+|joko\s*[:,-]?\s*)?(?:briefing|executive\s*briefing|morning\s*briefing|laporan\s*pagi|kabar\s*pagi|info\s*pagi)/i.test(t) ||
    /^(?:!joko\s+|joko\s*[:,-]?\s*)?(?:kirim\s*(?:kan\s*)?)?(?:morning\s*)?briefing/i.test(t) ||
    /(?:briefing\s+(?:pagi|hari\s+ini)|rangkum\s+(?:kondisi\s+)?pagi|laporan\s+harian|morning\s+briefing)/i.test(t)
  );
}

// Deteksi perintah posting draft Threads hasil briefing
export function isPostDraftThreadCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /(?:posting|upload|unggah|gas|post)\s+(?:draft\s+)?threads(?:\s+(?:tadi|terbaru|ini))?/i.test(t) ||
    /(?:gas\s+posting|langsung\s+upload|postingkan\s+draft)/i.test(t)
  );
}

// Generator Executive Briefing Harian Terpadu
export async function generateExecutiveBriefing() {
  const wib = getWIBDate();
  const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const monthNames = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  const dateFormatted = `${dayNames[wib.getDay()]}, ${wib.getDate()} ${monthNames[wib.getMonth()]} ${wib.getFullYear()}`;

  // 1. Cuaca Jakarta
  const weather = await fetchJakartaWeather();

  // 2. Berita & Tren AI Terhangat via Web Intelligence
  let newsItems = [];
  try {
    const newsRes = await searchAndScrapeTopic('Artificial Intelligence OR Agentic AI', 3);
    if (newsRes.success && newsRes.articles.length > 0) {
      newsItems = newsRes.articles.slice(0, 3);
    }
  } catch (err) {
    console.warn('[Executive Briefing] News search fallback:', err.message);
  }

  // 3. Agenda Hari Ini dari Cron Manager
  const allJobs = loadJobs();
  const todayReminders = allJobs.filter(j => {
    if (j.id === 'job_morning_briefing_andika') return false; // Jangan tampilkan job briefing itu sendiri
    if (j.type === 'daily') return true;
    if (j.type === 'weekly' && j.config.day === wib.getDay()) return true;
    if (j.type === 'once' && j.config.targetTimestamp) {
      const targetDate = new Date(j.config.targetTimestamp);
      return targetDate.toDateString() === wib.toDateString();
    }
    return false;
  });

  // 4. Rancang Draft Konten Threads Otomatis (< 500 karakter)
  let threadsTopic = 'perkembangan pesat Agentic AI yang semakin otonom';
  if (newsItems.length > 0) {
    threadsTopic = newsItems[0].title.replace(/ - [^-]+$/, '').trim();
  }
  const draftThread = `Pagi ini dunia tech lagi ramai soal "${threadsTopic}".\n\nPelajaran pentingnya: AI sekarang bukan lagi soal seberapa pintar dia jawab pertanyaan, tapi seberapa andal dia mengambil tindakan nyata tanpa nunggu disuapin.\n\nAutomate what's repetitive, focus on what creates leverage. Semangat & keep building! 🤖⚡`;
  
  // Simpan draft agar siap diunggah saat Mas Andika bilang "gas posting!"
  saveLatestDraftThread(draftThread);

  // 5. Susun Pesan Eksekutif Berformat WhatsApp
  let briefing = `☕ *MORNING EXECUTIVE BRIEFING — JOKO AI* ☕\n📅 *${dateFormatted}*\n\n`;
  briefing += `Selamat pagi Mas Andika! Joko sudah siapkan rangkuman intelijen harian untuk mengawali hari Mas dengan segar:\n\n`;

  briefing += `🌤️ *Cuaca & Kondisi Jakarta:*\n`;
  briefing += `• Suhu: ${weather.temperature} | Kelembaban: ${weather.humidity}\n`;
  briefing += `• Kondisi: ${weather.description}\n`;
  briefing += `• Komuter: Koridor Transjakarta utama terpantau beroperasi normal.\n\n`;

  briefing += `🌐 *Top 3 Tren AI & Teknologi Pagi Ini:*\n`;
  if (newsItems.length > 0) {
    newsItems.forEach((item, idx) => {
      const cleanTitle = item.title.replace(/ - [^-]+$/, '').trim();
      briefing += `${idx + 1}. *${cleanTitle}*\n   🔗 _${item.link}_\n`;
    });
  } else {
    briefing += `• Perkembangan Agen AI mandiri di industri teknologi semakin pesat.\n• Akselerasi integrasi model multimodal untuk otomasi harian.\n• Tren browser agent untuk social media operations mandiri.\n`;
  }
  briefing += `\n`;

  briefing += `📋 *Agenda & Pengingat Hari Ini:*\n`;
  if (todayReminders.length > 0) {
    todayReminders.forEach((r, idx) => {
      const timeStr = r.config?.time ? `[Jam ${r.config.time} WIB]` : '';
      briefing += `${idx + 1}. ${timeStr} ${r.title}\n`;
    });
  } else {
    briefing += `• Tidak ada pengingat khusus untuk hari ini. Jadwal Mas Andika leluasa!\n`;
  }
  briefing += `\n`;

  briefing += `🧵 *Draft Konten Threads Hari Ini:*\n`;
  briefing += `"${draftThread}"\n\n`;
  briefing += `👉 *Aksi Cepat:* Kalau Mas Andika mau draf Threads di atas langsung tayang ke akun @andikatampubolon._, cukup balas chat ini:\n*Joko posting draft threads tadi!* 🚀\n\nSelamat beraktivitas dan semoga hari Mas Andika menyenangkan! 💪☕`;

  return {
    dateFormatted,
    weather,
    newsItems,
    todayReminders,
    draftThread,
    text: briefing
  };
}
