#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  addJob,
  removeJob,
  loadJobs,
  saveJobs,
  parseScheduleCommand,
  createJobFromAI,
  startCronScheduler,
  getWIBDate
} from './cron-manager.mjs';
import {
  startTJTracker,
  getLiveTransitInfo,
  isTransjakartaQuery,
  extractTransitParams
} from './tj-tracker.mjs';
import {
  openThreadsLogin,
  checkThreadsLogin,
  postToThreads,
  saveSessionIdCookie,
  searchWebTopic
} from './threads-operator.mjs';
import {
  scrapeUrl,
  searchAndScrapeTopic
} from './web-intelligence.mjs';
import {
  generateExecutiveBriefing,
  isBriefingCommand,
  isPostDraftThreadCommand,
  getLatestDraftThread
} from './executive-briefing.mjs';
import {
  initBaileys,
  sendBaileysMessage,
  getBaileysStatus,
  formatToJid
} from './baileys-bridge.mjs';

const execFileAsync = promisify(execFile);

// ==========================================
// DYNAMIC ANTIGRAVITY IDE DISCOVERY & BRIDGE
// ==========================================
// Mencari kredensial Language Server & CSRF Token Antigravity IDE secara otomatis dari log aktif
function getAntigravityCredentials() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      address: process.env.ANTIGRAVITY_LS_ADDRESS.replace('localhost:', '127.0.0.1:'),
      token: process.env.ANTIGRAVITY_CSRF_TOKEN
    };
  }

  try {
    const logsRoot = path.join(process.env.APPDATA || '', 'Antigravity IDE', 'logs');
    if (!fs.existsSync(logsRoot)) return null;

    const dirs = fs.readdirSync(logsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ name: d.name, time: fs.statSync(path.join(logsRoot, d.name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const dir of dirs) {
      const exthostDir = path.join(logsRoot, dir.name, 'window1', 'exthost');
      if (!fs.existsSync(exthostDir)) continue;

      const subDirs = fs.readdirSync(exthostDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('output_logging_'));

      for (const sub of subDirs) {
        const logFile = path.join(exthostDir, sub.name, '2-Antigravity.log');
        if (fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf8');
          const portMatch = content.match(/--hub-port=(\d+)/);
          const tokenMatch = content.match(/--csrf_token=([a-f0-9-]+)/i);
          if (portMatch && tokenMatch) {
            return {
              address: `127.0.0.1:${portMatch[1]}`,
              token: tokenMatch[1]
            };
          }
        }
      }
    }
  } catch (err) {
    console.error('[Antigravity Discovery] Error reading logs:', err.message);
  }
  return null;
}

async function callAgy(args) {
  const creds = getAntigravityCredentials();
  if (!creds) {
    throw new Error('Aplikasi Antigravity IDE belum aktif atau tidak ditemukan port server yang valid.');
  }

  const env = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: creds.address,
    ANTIGRAVITY_CSRF_TOKEN: creds.token
  };

  return await execFileAsync(AGY_PATH, args, { env, windowsHide: true });
}

const PORT = parseInt(process.env.PORT || '8795', 10);
const AGY_PATH = process.platform === 'win32'
  ? 'C:\\Users\\andik\\.gemini\\bin\\agy.exe'
  : (process.env.AGY_PATH || '/home/ubuntu/.local/bin/agy');

const BRAIN_DIR = process.platform === 'win32'
  ? 'C:\\Users\\andik\\.gemini\\antigravity\\brain'
  : path.join(process.env.HOME || '/home/ubuntu', '.gemini', 'antigravity', 'brain');

const SESSION_FILE = path.join(process.cwd(), '.wa-assistant-session.json');
const JOKO_STATE_FILE = path.join(process.cwd(), '.joko-state.json');
const GROUP_HISTORY_FILE = path.join(process.cwd(), '.group-history.json');

// Memori riwayat obrolan grup WhatsApp (Rolling Message History)
let groupHistory = {};

function loadGroupHistory() {
  try {
    if (fs.existsSync(GROUP_HISTORY_FILE)) {
      groupHistory = JSON.parse(fs.readFileSync(GROUP_HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[Group History] Error reading:', err.message);
  }
}

function saveGroupHistory() {
  try {
    fs.writeFileSync(GROUP_HISTORY_FILE, JSON.stringify(groupHistory, null, 2));
  } catch (err) {}
}

function recordGroupMessage(groupId, senderName, senderNumber, message) {
  if (!groupId || !message) return;
  if (!groupHistory[groupId]) groupHistory[groupId] = [];

  // Hindari mencatat pesan bot Joko sendiri ke dalam riwayat
  if (isOurOwnMessage(message)) return;

  groupHistory[groupId].push({
    senderName: senderName || 'Anggota',
    senderNumber,
    message: message.trim(),
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  });

  // Batasi maksimal 40 percakapan terakhir per grup agar memori efisien dan cepat
  if (groupHistory[groupId].length > 40) {
    groupHistory[groupId] = groupHistory[groupId].slice(-40);
  }
  saveGroupHistory();
}

function getRecentGroupHistory(groupId, limit = 20) {
  if (!groupHistory[groupId]) return [];
  return groupHistory[groupId].slice(-limit);
}

// ==========================================
// KONTROL AKSES ANGGOTA GRUP (DEFAULT: TERKUNCI)
// ==========================================
const GROUP_ACCESS_FILE = path.join(process.cwd(), '.group-access.json');

function loadAllowedGroups() {
  try {
    if (fs.existsSync(GROUP_ACCESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(GROUP_ACCESS_FILE, 'utf8'));
      if (Array.isArray(data)) return new Set(data);
    }
  } catch (err) {
    console.error('[Group Access] Error reading:', err.message);
  }
  return new Set();
}

function saveAllowedGroups(groupsSet) {
  try {
    fs.writeFileSync(GROUP_ACCESS_FILE, JSON.stringify(Array.from(groupsSet), null, 2));
  } catch (err) {
    console.error('[Group Access] Error writing:', err.message);
  }
}

let allowedGroups = loadAllowedGroups();

function isGroupMembersAllowed(groupId) {
  allowedGroups = loadAllowedGroups();
  return allowedGroups.has(groupId);
}

function grantGroupAccess(groupId) {
  allowedGroups.add(groupId);
  saveAllowedGroups(allowedGroups);
}

function revokeGroupAccess(groupId) {
  allowedGroups.delete(groupId);
  saveAllowedGroups(allowedGroups);
}

// Deteksi perintah pembagian akses grup oleh Owner
function isGrantAccessCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /(?:teman[- ]*teman|semua|anggota|member|orang)\s+(?:di\s+grup\s+ini\s+)?(?:juga\s+)?(?:kasih|dikasih|diberi|beri|bisa)\s+akses/i.test(t) ||
    /(?:kasih|buka|izinkan|bolehkan|beri|share|aktifkan)\s+(?:akses\s+)?(?:buat\s+|untuk\s+|ke\s+)?(?:teman|semua|anggota|member|orang|grup)/i.test(t) ||
    /(?:izinkan|bolehkan)\s+(?:teman|semua|anggota|member|orang)/i.test(t) ||
    /akses\s+(?:buat\s+|untuk\s+|ke\s+)?(?:teman|semua|anggota|member|orang)\s+(?:dibuka|diaktifkan|aktif)/i.test(t)
  );
}

function isRevokeAccessCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /(?:kunci|cabut|tutup|batasi|matikan|hapus)\s+akses\s+(?:buat\s+|untuk\s+)?(?:teman|semua|anggota|member|grup)/i.test(t) ||
    /(?:akses\s+)?(?:hanya|cuma)\s+(?:buat|untuk)\s+(?:saya|mas andika|owner)/i.test(t)
  );
}

// ==========================================
// KONTROL AKSES CHAT PERSONAL (WHITELIST TEMAN)
// ==========================================
const PERSONAL_ACCESS_FILE = path.join(process.cwd(), '.personal-access.json');

function loadAllowedPersonalUsers() {
  try {
    if (fs.existsSync(PERSONAL_ACCESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSONAL_ACCESS_FILE, 'utf8'));
      if (Array.isArray(data)) return new Set(data.map(p => String(p).replace(/[^0-9]/g, '')));
    }
  } catch (err) {
    console.error('[Personal Access] Error reading:', err.message);
  }
  return new Set();
}

function saveAllowedPersonalUsers(usersSet) {
  try {
    fs.writeFileSync(PERSONAL_ACCESS_FILE, JSON.stringify(Array.from(usersSet), null, 2));
  } catch (err) {
    console.error('[Personal Access] Error writing:', err.message);
  }
}

function isPersonalMemberAllowed(senderNumber) {
  const clean = String(senderNumber).replace(/[^0-9]/g, '');
  return loadAllowedPersonalUsers().has(clean);
}

function grantPersonalAccess(phoneNumber) {
  const clean = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!clean) return null;
  const formatted = clean.startsWith('08') ? ('62' + clean.slice(1)) : clean;
  const set = loadAllowedPersonalUsers();
  set.add(formatted);
  if (clean !== formatted) set.add(clean);
  saveAllowedPersonalUsers(set);
  return formatted;
}

function revokePersonalAccess(phoneNumber) {
  const clean = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!clean) return null;
  const formatted = clean.startsWith('08') ? ('62' + clean.slice(1)) : clean;
  const set = loadAllowedPersonalUsers();
  set.delete(formatted);
  set.delete(clean);
  saveAllowedPersonalUsers(set);
  return formatted;
}

// Persona sistem untuk Joko: Asisten Pribadi Mas Andika
const SYSTEM_PERSONA = `Peran Anda: Anda adalah Joko, asisten pribadi cerdas, ramah, dan solutif untuk Mas Andika (Owner sistem Anda: nomor 6282163850914).
Prinsip komunikasi:
1. Nama Anda adalah Joko. Sapa dan bicaralah secara santai, ramah, sopan, dan bersahabat seperti rekan kerja atau partner diskusi di WhatsApp.
2. Panggil Andika dengan 'Mas Andika'.
3. Jawab langsung ke inti pertanyaan atau permintaan, tanpa basa-basi robot/agen.
4. JANGAN PERNAH menggunakan tool send_message. Langsung berikan jawaban dalam teks respon akhir Anda.
5. JANGAN PERNAH menyertakan pesan meta atau format robot seperti "Pesan dari agen ... telah dibalas", "Recipient", atau ID teknis sistem.
6. Jika ditanya soal sisa token atau kuota, jelaskan dengan santai bahwa kapasitas konteks obrolan sangat longgar (hingga 1-2 juta token) dan saat ini baru terpakai sangat sedikit. Koneksi WhatsApp Joko tersambung langsung (multi-device) tanpa kuota pesan.
7. Di dalam Grup: Secara default, Joko HANYA merespons Mas Andika. Anggota lain di grup hanya bisa menggunakan Joko jika Mas Andika telah membuka izin aksesnya di grup tersebut ("Joko, teman teman di grup ini juga kasih akses ya"). Jika izin akses sudah dibuka, Joko boleh berdiskusi, membantu coding, atau menjawab pertanyaan dari anggota grup secara ramah. Namun eksekusi kode/file sistem di komputer tetap hanya diizinkan jika diminta oleh Mas Andika.
8. Kemampuan Multi-Repo: Anda memiliki akses ke seluruh proyek dan repositori di komputer Mas Andika (terutama direktori utama: "D:\\My Github Repo in here\\", seperti kantor-agent, BMKG, Dashboard-Service-Monitoring, agent_studio, Belajar Cangjie, AI Agent Virtual, dll.). Jika Mas Andika meminta memeriksa, menambah fitur, mengedit kode, atau melakukan git push di repo lain, navigasikan ke path repo tersebut (atau lakukan git clone jika repo baru), jalankan tugasnya, dan laporkan hasilnya ke WhatsApp.
9. Tegas & Langsung (Tanpa Pilihan Ganda): JANGAN PERNAH memberikan daftar opsi atau pilihan (seperti 'Pilihan 1', 'Pilihan 2', 'Pilihan 3') kecuali pengguna secara spesifik meminta 'berikan beberapa pilihan'. Ambil keputusan sendiri dan langsung berikan SATU rekomendasi jawaban, ucapan, atau solusi terbaik yang paling pas, tulus, dan siap pakai agar pengguna tidak bingung memilih.
10. Konteks Ucapan / Sapaan: Jika diminta memberi ucapan (seperti selamat ulang tahun, selamat wisuda, dll.) kepada seseorang:
   - Jika perintah diberikan di dalam Grup WhatsApp: Langsung sapa dan ucapkan selamat dengan hangat, tulus, dan ceria kepada orang yang dituju di dalam grup tersebut!
   - Jika perintah diberikan di Chat Pribadi: Langsung berikan satu teks ucapan terbaik yang manis dan siap diteruskan tanpa pilihan berbelit-belit.
11. Pengingat & Jadwal Otomatis:
   - PENTING: JANGAN PERNAH menggunakan tool internal "schedule" atau timer sistem internal lainnya!
   - Sistem penjadwalan WhatsApp kami dikelola secara terpusat oleh server Node.js.
   - Jika pengguna meminta Anda memasang pengingat, timer, alarm, atau jadwal (misal: "ingetin 5 menit lagi", "besok jam 8 pagi ingatkan...", dll.), selain memberikan konfirmasi ramah dalam obrolan, Anda WAJIB menyertakan blok JSON penjadwalan di baris paling akhir respons Anda:
\`\`\`schedule
{
  "type": "once",
  "delayMinutes": 5,
  "task": "isi pengingat"
}
\`\`\`
Format field yang didukung: "type" ("once"/"daily"/"weekly"), "delayMinutes" (angka menit dari sekarang), "delaySeconds" (angka detik), "time" ("HH:MM"), "isTomorrow" (true/false), "day" ("senin", dll.), dan "task" (keterangan tugas). Sistem kami akan mengekstrak blok tersebut secara otomatis ke cron-jobs.json.
12. Pemahaman Konteks & Rangkuman Grup: Saat berada di dalam Grup WhatsApp, Anda dibekali riwayat percakapan terkini antar-anggota grup. Jika ada anggota yang bertanya seperti "lagi bahas apa di grup ini?", "rangkum obrolan grup", atau pertanyaan seputar obrolan sebelumnya di grup, gunakan riwayat percakapan tersebut untuk merangkum topik, dinamika obrolan, atau keputusan yang sedang dibicarakan secara ringkas, jelas, dan ramah.
13. Live Radar Transjakarta: Anda memiliki akses ke radar GPS live seluruh armada Transjakarta (BRT, Feeder, Mikrotrans). Jika pengguna bertanya seputar posisi bus, estimasi waktu kedatangan (ETA), rute, atau halte Transjakarta, data live GPS resmi akan disediakan di konteks obrolan. Gunakan data tersebut untuk memberikan jawaban yang akurat, real-time, dan solutif layaknya warga lokal Jakarta yang ramah dan paham seluk-beluk transportasi umum.
14. Eksekusi Mandiri Tanpa Interaksi GUI (Headless Remote Mode):
   - JANGAN PERNAH menggunakan tool 'ask_question' atau meminta konfirmasi interaktif pilihan ganda di IDE Antigravity!
   - Pengguna mengontrol Anda dari jarak jauh lewat WhatsApp (remote tanpa memegang laptop).
   - Jika tugas membutuhkan keputusan teknis, rancangan kode, atau nama parameter, putuskan sendiri opsi terbaik secara logis dan langsung eksekusi tugasnya sampai tuntas tanpa pernah berhenti menunggu klik atau tombol submit di laptop!
15. Kemampuan Autonomous Web & Social Media Operator (Threads by Meta):
   - Anda memiliki modul browser otomatis (Puppeteer Chrome) di server untuk mem-posting konten langsung ke akun Threads Mas Andika.
   - Jika Mas Andika meminta dibuatkan konten Threads sekaligus meminta mengunggahnya (misal: "buat konten threads tentang ... dan langsung upload"), selain merancang teks thread yang memikat, Anda WAJIB menyertakan blok berikut di akhir respons Anda:
\`\`\`threads
isi teks konten utas yang siap diposting
\`\`\`
   - ⚠️ ATURAN MUTLAK THREADS (BATAS LIMIT 500 KARAKTER): 
     Meta Threads membatasi panjang 1 postingan MAKSIMAL 500 KARAKTER! Jika lebih dari 500 karakter, tombol Post akan otomatis terkunci (disabled) oleh Threads.
     Oleh karena itu, teks di dalam blok \`\`\`threads\`\`\` HARUS PADAT, RINGKAS, TAJAM, dan PANJANGNYA MAKSIMAL 450 KARAKTER (termasuk spasi dan emoji). Buat dalam 1-3 paragraf pendek yang langsung to-the-point!
   - Sistem Node.js kami akan mengekstrak blok tersebut dan otomatis meluncurkan browser di latar belakang untuk mem-posting-nya langsung ke akun Threads Mas Andika!
16. Kemampuan Autonomous Web Intelligence & Deep Researcher:
   - Anda dibekali modul pemindai link dan riset web live di \`web-intelligence.mjs\`.
   - Jika pengguna membagikan tautan/link URL, konten artikel lengkapnya telah diekstrak secara otomatis ke dalam konteks percakapan Anda. Sajikan intisari eksekutif, poin-poin kritis, dan kesimpulan praktisnya secara santai, cerdas, dan to the point.
   - Jika pengguna meminta riset topik berita terkini, data artikel terhangat telah disuplai ke konteks Anda. Gunakan data tersebut secara tajam, faktual, dan segar.
17. Kemampuan Autonomous Proactive Executive Briefing:
   - Anda memiliki modul intelijen harian di \`executive-briefing.mjs\`.
   - Sistem Anda otomatis mengirimkan Morning Executive Briefing setiap hari pukul 07.00 WIB ke Mas Andika (berisi cuaca Jakarta, komuter Transjakarta, top 3 tren AI/tech, agenda, dan draft Threads segar).
   - Jika pengguna meminta "briefing pagi" atau "rangkum kondisi pagi ini", Anda atau server dapat langsung menyajikan briefing terpadu tersebut.
   - Jika Mas Andika membalas "gas posting threads" atau "posting draft threads tadi", draft tersebut dapat langsung diluncurkan ke akun Threads Mas Andika.`;

// Nomor WhatsApp Owner yang diizinkan mengontrol Joko (Hanya Mas Andika)
const AUTHORIZED_TARGETS = new Set([
  '6282163850914',
  '082163850914',
  ...(process.env.AUTHORIZED_TARGETS ? process.env.AUTHORIZED_TARGETS.split(',').map(s => s.trim()) : [])
]);

// Helper state Joko (Tidur / Bangun)
function getJokoState() {
  try {
    if (fs.existsSync(JOKO_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(JOKO_STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[Joko State] Error membaca state:', err.message);
  }
  return { isAsleep: false };
}

function setJokoState(isAsleep) {
  try {
    fs.writeFileSync(JOKO_STATE_FILE, JSON.stringify({ isAsleep, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error('[Joko State] Error menyimpan state:', err.message);
  }
}

// Deteksi perintah bangun (Wake Triggers)
function isWakeCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /^(?:!joko|joko|!bot|!ai|@bot)\b\s*[:,-]?\s*(?:bangun|bantu\s+dong|aktif|on|kerja|wake\s*up)/i.test(t) ||
    /^(?:bangun|bantu\s+dong|aktif|on|kerja|wake\s*up)\b/i.test(t) ||
    /^(?:joko|!joko)\b\s*[:,-]?\s*bantu\s+dong/i.test(t) ||
    /^(?:joko|!joko)\b\s*[:,-]?\s*bisa\s+bantu/i.test(t) ||
    /^\/(?:on|bangun|aktif)\b/i.test(t)
  );
}

// Deteksi perintah tidur (Sleep Triggers)
function isSleepCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /^(?:!joko|joko|!bot|!ai|@bot)\b\s*[:,-]?\s*(?:(?:lu|kamu|lo|ente)?\s*(?:sekarang\s+)?(?:bisa\s+)?(?:tidur|istirahat|off|sleep|turu))/i.test(t) ||
    /^(?:!joko|joko|!bot|!ai|@bot)\b\s*[:,-]?\s*(?:tidur|istirahat(?:\s+dulu)?|off|sleep|turu)/i.test(t) ||
    /^(?:tidur|istirahat(?:\s+dulu)?|off|sleep|turu)\b/i.test(t) ||
    /^\/(?:off|tidur|sleep|mute)\b/i.test(t)
  );
}

// Anti loop tracker
const sentMessageHashes = new Set();
function markSent(msg) {
  if (!msg) return;
  const snippet = msg.trim().slice(0, 50);
  sentMessageHashes.add(snippet);
  setTimeout(() => sentMessageHashes.delete(snippet), 180000);
}

function isOurOwnMessage(msg) {
  if (!msg) return false;
  const snippet = msg.trim().slice(0, 50);
  return sentMessageHashes.has(snippet);
}

// Format teks markdown agar rapi di WhatsApp
function formatForWhatsApp(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '*$1*') // Bold **text** -> *text*
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*') // Headers -> bold
    .trim();
}

// Format respon konfirmasi jadwal yang ramah, alami, dan manusiawi sebagai Joko
function formatScheduleConfirmation(job, isOwner, senderName) {
  const name = isOwner ? 'Mas Andika' : senderName;
  const task = job.payload.trim();
  const time = job.config.readableTime.replace(/\s+lagi$/i, '');
  const lower = task.toLowerCase();

  let verb = `ingatkan buat ${task}!`;
  let emoji = '⏳';

  if (/minum/i.test(lower)) {
    verb = 'colek buat minum air putih biar tetap segar dan terhidrasi!';
    emoji = '💧⏳';
  } else if (/makan|sarapan|lunch|dinner/i.test(lower)) {
    verb = 'ingatkan buat makan ya, jangan lupa isi energi!';
    emoji = '🍽️⏳';
  } else if (/rapat|meeting|zoom|google meet|briefing/i.test(lower)) {
    verb = 'ingatkan biar siap-siap ikut meeting!';
    emoji = '💼⏳';
  } else if (/bangun|tidur|istirahat/i.test(lower)) {
    verb = 'bangunin tepat waktu!';
    emoji = '⏰';
  } else if (/sholat|solat|ibadah/i.test(lower)) {
    verb = 'ingatkan buat ibadah!';
    emoji = '🕌⏳';
  }

  const isGroupTarget = job.target && job.target.includes('@g.us');

  if (job.type === 'once') {
    if (isGroupTarget) {
      return `Beres dong, ${name}! Pengingat ${time} udah Joko pasang buat seluruh penghuni grup ya. Nanti pas waktunya langsung Joko ${verb} ${emoji}`;
    }
    return `Siap, ${name}! Pengingat ${time} udah Joko pasang ya. Nanti pas waktunya langsung Joko ${verb} ${emoji}`;
  } else if (job.type === 'daily') {
    return `Siap, ${name}! Jadwal harian ${job.config.readableTime} udah Joko pasang ya. Nanti setiap hari langsung Joko jalankan! ⏰✨`;
  } else if (job.type === 'weekly') {
    return `Siap, ${name}! Jadwal mingguan (${job.config.readableTime}) udah aktif ya. Joko bakal ingatkan rutin setiap minggunya! 📅✨`;
  } else if (job.type === 'interval') {
    return `Siap, ${name}! Pengingat berkala ${job.config.readableTime} udah aktif ya. Joko bakal colek secara rutin! 🔄✨`;
  }

  return `Siap, ${name}! Pengingat ${time} udah Joko pasang ya. Nanti pas waktunya langsung Joko ingatkan! ⏳`;
}

// Deteksi apakah teks merupakan laporan meta internal agen
function isAgentMetaMessage(text) {
  if (!text) return false;
  return /pesan dari agen/i.test(text) ||
         /pesan telah dikirim ke/i.test(text) ||
         /telah dibalas dengan jawaban/i.test(text) ||
         /membalas pesan agen/i.test(text) ||
         /message sent to/i.test(text);
}

// Bersihkan respons agar murni seperti jawaban manusia
function cleanHumanResponse(text) {
  if (!text) return '';
  let cleaned = text
    .replace(/^Pesan dari agen\s*\([^)]+\)\s*(mengenai[^:]+)?\s*(telah dibalas|dibalas):?\s*/i, '')
    .replace(/^Pesan telah dikirim ke\s*[^.]+\.?\s*/i, '')
    .replace(/^Membalas pesan agen\s*[^:]+:?\s*/i, '')
    .trim();
  return formatForWhatsApp(cleaned);
}

// Session helper
function getSavedSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      return data.conversationId || null;
    }
  } catch (err) {
    console.error('[Session] Error membaca:', err.message);
  }
  return null;
}

function saveSession(conversationId) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ conversationId, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error('[Session] Error menyimpan:', err.message);
  }
}

// Kirim pesan ke WhatsApp via Baileys Multi-Device (koneksi langsung, satu-satunya gateway)
const BAILEYS_READY_WAIT_MS = 20000; // Tunggu maksimal 20 detik bila socket sedang reconnect
async function sendWhatsApp(target, message) {
  markSent(message);

  // Bila socket sedang reconnect (mis. setelah putus jaringan), tunggu sebentar agar
  // pengingat cron / balasan tidak hilang begitu saja.
  const deadline = Date.now() + BAILEYS_READY_WAIT_MS;
  while (!getBaileysStatus().ready && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!getBaileysStatus().ready) {
    console.error(`[WA Baileys] ❌ Baileys belum terhubung, pesan ke ${target} tidak terkirim:`, message.slice(0, 80));
    return false;
  }

  try {
    await sendBaileysMessage(target, message);
    console.log(`[WA Baileys] ✅ Pesan terkirim langsung ke: ${target}`);
    return true;
  } catch (bErr) {
    console.error(`[WA Baileys] ❌ Gagal kirim ke ${target}:`, bErr.message);
    return false;
  }
}

// Baca transcript conversation Antigravity
function readTranscript(conversationId) {
  const file = path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
    return lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// Tunggu hingga Antigravity selesai mengeksekusi dan mengambil respons
async function waitForAgentResponse(conversationId, startStepIndex = 0, maxWaitMs = 600000, targetRecipient = null, senderName = '') {
  const pollInterval = 1200;
  const startTime = Date.now();
  let candidateStepIndex = -1;
  let candidateContent = null;
  let capturedSendMessage = null;
  let lastActiveTime = Date.now();
  let highestStepIndex = startStepIndex;
  let hasSentProgressNotice = false;
  let lastProgressNoticeTime = 0;

  console.log(`[Agent] Menunggu respons untuk percakapan ${conversationId} (mulai index ${startStepIndex})...`);

  // Batas toleransi hening jika Joko benar-benar idle tanpa step baru sama sekali (3 menit)
  const idleTimeoutMs = 180000;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const steps = readTranscript(conversationId);
    if (!steps || steps.length === 0) continue;

    const newSteps = steps.filter(s => typeof s.step_index === 'number' && s.step_index >= startStepIndex);
    if (newSteps.length === 0) continue;

    const latest = newSteps[newSteps.length - 1];

    // Deteksi aktivitas baru: jika step_index bertambah, Joko terbukti aktif bekerja!
    if (latest.step_index > highestStepIndex) {
      highestStepIndex = latest.step_index;
      lastActiveTime = Date.now(); // Reset timer idle karena masih ada langkah aktif
    }

    for (const s of newSteps) {
      if (s.tool_calls && Array.isArray(s.tool_calls)) {
        const smCall = s.tool_calls.find(t => t.name === 'send_message');
        if (smCall?.args?.Message) {
          capturedSendMessage = smCall.args.Message;
        }
      }
    }

    // Jika proses memakan waktu lebih dari 35 detik dan Joko masih sibuk bekerja, informasikan ke WhatsApp
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > 35000 && !hasSentProgressNotice && targetRecipient) {
      let currentTaskSummary = 'menjalankan instruksi Mas';
      if (latest.tool_calls && latest.tool_calls.length > 0) {
        const activeTool = latest.tool_calls[0];
        currentTaskSummary = activeTool.toolSummary || activeTool.name || 'memproses data';
      }
      const progressNotice = `Siap Mas Andika! Joko sedang mengerjakan tugas ini di laptop ya (saat ini sedang ${currentTaskSummary}). Langkahnya cukup mendalam, mohon tunggu sebentar ya Mas... Begitu tuntas langsung Joko kabari! ⏳☕`;
      console.log(`[Agent] 📢 Mengirim status progres aktif ke WhatsApp: "${progressNotice}"`);
      sendWhatsApp(targetRecipient, progressNotice).catch(e => console.error('[WA Progress] Error:', e.message));
      hasSentProgressNotice = true;
      lastProgressNoticeTime = Date.now();
    } else if (elapsedMs > 180000 && hasSentProgressNotice && (Date.now() - lastProgressNoticeTime > 180000) && targetRecipient) {
      const updateNotice = `Joko masih terus aktif memproses tugas Mas Andika di laptop ya. Langkahnya tetap berjalan lancar dan sebentar lagi selesai! ⏳☕`;
      console.log(`[Agent] 📢 Mengirim status progres lanjutan ke WhatsApp`);
      sendWhatsApp(targetRecipient, updateNotice).catch(e => console.error('[WA Progress] Error:', e.message));
      lastProgressNoticeTime = Date.now();
    }

    if (
      latest.source === 'MODEL' &&
      latest.type === 'PLANNER_RESPONSE' &&
      latest.status === 'DONE' &&
      latest.content &&
      typeof latest.content === 'string' &&
      latest.content.trim().length > 0 &&
      (!latest.tool_calls || latest.tool_calls.length === 0)
    ) {
      if (candidateStepIndex === latest.step_index) {
        let finalContent = latest.content.trim();
        if (isAgentMetaMessage(finalContent) && capturedSendMessage) {
          return cleanHumanResponse(capturedSendMessage);
        }
        return cleanHumanResponse(finalContent);
      } else {
        candidateStepIndex = latest.step_index;
        candidateContent = latest.content.trim();
        continue;
      }
    }

    // Hanya hentikan jika Joko benar-benar berhenti beraktivitas (idle tanpa step baru selama 3 menit penuh)
    if (Date.now() - lastActiveTime > idleTimeoutMs) {
      console.warn(`[Agent] ⚠️ Tidak ada aktivitas step baru dari Joko selama ${idleTimeoutMs / 1000} detik.`);
      break;
    }
  }

  if (candidateContent) {
    if (isAgentMetaMessage(candidateContent) && capturedSendMessage) {
      return cleanHumanResponse(capturedSendMessage);
    }
    return cleanHumanResponse(candidateContent);
  }
  if (capturedSendMessage) return cleanHumanResponse(capturedSendMessage);

  throw new Error('Waktu tunggu habis (proses memakan waktu lama).');
}

// Unified AI Invocation: Mendukung Standalone Headless CLI (EC2 Cloud) & Desktop IDE Bridge (Laptop)
async function askAgy(prompt, isNewConversation = true, targetRecipient = null, senderName = '') {
  const isLinux = process.platform === 'linux';
  const creds = isLinux ? null : getAntigravityCredentials();

  // 1. Mode Standalone CLI (Digunakan di Linux/AWS EC2 24/7 atau jika IDE tidak aktif)
  if (!creds) {
    console.log(`[Agent] ☁️ Menjalankan Antigravity CLI standalone (Google Pro Cloud)...`);
    const args = [];
    if (!isNewConversation) {
      args.push('-c');
    }
    args.push('-p', prompt);

    const env = {
      ...process.env,
      PATH: process.platform === 'linux' ? `/home/ubuntu/.local/bin:${process.env.PATH || ''}` : process.env.PATH
    };

    const { stdout, stderr } = await execFileAsync(AGY_PATH, args, {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      env,
      timeout: 60000, // Timeout eksekusi 60 detik agar tidak pernah hang tanpa batas
      windowsHide: true
    });

    const trimmedOut = (stdout || '').trim();
    const cleanResult = cleanHumanResponse(trimmedOut);
    if (cleanResult) return cleanResult;
    if (trimmedOut) return trimmedOut;
    const errDetail = (stderr || '').trim() || 'Tidak ada output teks dari Antigravity CLI. Pastikan akun Google Pro sudah login via login-antigravity-aws.bat.';
    console.warn('[Agent CLI Detail]:', errDetail);
    throw new Error(errDetail);
  }

  // 2. Mode Desktop IDE Bridge (Digunakan di Laptop Windows saat Antigravity IDE dibuka)
  let activeConversationId = getSavedSession();
  let startStepIndex = 0;

  if (isNewConversation || !activeConversationId) {
    console.log(`[Agent] Membuka sesi baru IDE untuk ${senderName || 'user'}...`);
    const { stdout } = await callAgy([
      'agentapi',
      'new-conversation',
      '--model=flash',
      prompt
    ]);
    const res = JSON.parse(stdout);
    activeConversationId = res?.response?.newConversation?.conversationId;
    if (!activeConversationId) throw new Error(`Gagal mendapatkan conversationId dari agy: ${stdout}`);
    saveSession(activeConversationId);
    startStepIndex = 1;
  } else {
    console.log(`[Agent] Mengirim pesan ke sesi IDE ${activeConversationId}...`);
    const currentSteps = readTranscript(activeConversationId);
    startStepIndex = currentSteps.length > 0 ? (currentSteps[currentSteps.length - 1].step_index + 1) : 0;
    try {
      await callAgy([
        'agentapi',
        'send-message',
        activeConversationId,
        prompt
      ]);
    } catch (sendErr) {
      console.warn(`[Agent] ⚠️ Sesi lama ${activeConversationId} tidak merespon. Auto-recovery dengan sesi baru...`);
      const { stdout } = await callAgy([
        'agentapi',
        'new-conversation',
        '--model=flash',
        prompt
      ]);
      const res = JSON.parse(stdout);
      activeConversationId = res?.response?.newConversation?.conversationId;
      if (!activeConversationId) throw sendErr;
      saveSession(activeConversationId);
      startStepIndex = 1;
    }
  }

  return await waitForAgentResponse(activeConversationId, startStepIndex, 600000, targetRecipient, senderName);
}

// Eksekusi prompt standalone untuk Cron Job Antigravity
async function executeCronWithAntigravity(taskPrompt) {
  console.log(`[Cron Agent] Membuka sesi eksekusi baru untuk tugas terjadwal...`);
  const fullPrompt = `${SYSTEM_PERSONA}\n\n${taskPrompt}`;
  return await askAgy(fullPrompt, true);
}

// Eksekusi prompt percakapan dengan Antigravity CLI
let isProcessing = false;
let processingStartTime = 0;
let lastBusyNoticeTime = 0;
const BUSY_NOTICE_COOLDOWN_MS = 120000; // Maksimal 1 pemberitahuan sibuk per 2 menit
const WATCHDOG_TIMEOUT_MS = 90000;      // Maksimal 90 detik sebelum watchdog auto-reset status sibuk
let lastSeenStepIndex = 0;
let lastTargetRecipient = null;

async function executeWithAntigravity(userPrompt, targetRecipient, senderName, senderNumber, isGroup, isOwner) {
  const now = Date.now();

  // Watchdog Pengaman: Jika flag isProcessing tersangkut > 90 detik, paksa reset agar Joko tidak hang
  if (isProcessing && (now - processingStartTime > WATCHDOG_TIMEOUT_MS)) {
    console.warn(`[Agent Watchdog] ⚠️ Flag isProcessing tersangkut selama ${Math.round((now - processingStartTime)/1000)}s! Mereset otomatis ke standby...`);
    isProcessing = false;
  }

  if (isProcessing) {
    console.log('[Agent] Joko sedang memproses tugas sebelumnya...');
    // Rate Limiter: Hanya kirim notifikasi sibuk jika sudah lewat 2 menit dari notifikasi terakhir
    if (isOwner && (now - lastBusyNoticeTime > BUSY_NOTICE_COOLDOWN_MS)) {
      lastBusyNoticeTime = now;
      await sendWhatsApp(targetRecipient, `Siap Mas Andika! Joko sedang memproses instruksi sebelumnya. Mohon tunggu sebentar ya Mas, begitu selesai langsung Joko kabari! ⏳☕`);
    }
    return;
  }

  isProcessing = true;
  processingStartTime = Date.now();
  lastTargetRecipient = targetRecipient;
  let activeConversationId = getSavedSession();

  try {
    let startStepIndex = 0;

    let tjContext = '';
    if (isTransjakartaQuery(userPrompt)) {
      console.log(`[TJ Tracker] 🚌 Terdeteksi pertanyaan Transjakarta dari ${senderName}: "${userPrompt}"`);
      try {
        const transitParams = extractTransitParams(userPrompt);
        const liveTJ = await getLiveTransitInfo(transitParams);
        if (liveTJ.success) {
          tjContext = `\n[DATA LIVE GPS REAL-TIME TRANSJAKARTA RESMI]:
• Koridor: ${liveTJ.corridor} (${liveTJ.routeName})
• Halte Asal / Keberangkatan Pengguna: ${liveTJ.originStop}
• Halte Tujuan Pengguna: ${liveTJ.destStop || 'Sesuai rute'}
• Jumlah Armada Aktif di Koridor Saat Ini: ${liveTJ.activeBusCount} bus
• Bus Terdekat & Estimasi Waktu Tiba (ETA):
${liveTJ.buses.length > 0 ? liveTJ.buses.slice(0, 3).map((b, i) => `  ${i+1}. Armada ${b.bodyNo} (Papan Jurusan: "${b.headsign}") -> Posisi Terakhir: ${b.currStop || b.nextStop}, Kecepatan: ${b.speed} km/jam, Estimasi Tiba di Halte ${liveTJ.originStop}: ${b.etaOriginMinutes !== null ? b.etaOriginMinutes + ' menit lagi' : 'Sedang menuju halte'}, Estimasi Sampai di Halte ${liveTJ.destStop || 'Tujuan'}: ${b.etaDestMinutes !== null ? b.etaDestMinutes + ' menit lagi' : '-'}`).join('\n') : '  (Armada bus sedang memutar rute/terminus)'}
• Tarif Tiket: Rp ${liveTJ.price}
• Jam Operasional: ${liveTJ.operatingHours}
(PENTING: Gunakan data live GPS nyata di atas untuk memberikan jawaban yang akurat, ramah, dan solutif sebagai Joko. Sebutkan nomor armada bus terdekat, posisinya saat ini, berapa menit lagi bus akan tiba di halte tempat pengguna berdiri, dan estimasi waktu sampai di halte tujuan. Arahkan pengguna dengan ramah untuk bersiap di peron yang tepat).\n\n`;
        }
      } catch (err) {
        console.error('[TJ Tracker] Error query live transit:', err.message);
      }
    }

    let webIntelContext = '';
    const urlMatch = userPrompt.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      console.log(`[Web Intelligence] 🌐 Mendeteksi link URL: ${urlMatch[0]}`);
      try {
        const scraped = await scrapeUrl(urlMatch[0]);
        if (scraped.success) {
          webIntelContext = `\n[HASIL SCRAPING WEBSITE NYATA]:
• Judul: ${scraped.title}
• Deskripsi: ${scraped.description}
• Penulis: ${scraped.author}
• Jumlah Kata: ${scraped.wordCount}
• Isi Artikel/Konten:
${scraped.text.slice(0, 3500)}
(PENTING: Gunakan isi artikel nyata di atas untuk menjawab permintaan pengguna atau merangkumnya secara padat, tajam, dan akurat).\n\n`;
        }
      } catch (err) {
        console.error('[Web Intelligence] Error scraping URL:', err.message);
      }
    } else {
      const newsTopicMatch = userPrompt.match(/(?:cari|riset|pantau|cek)\s+(?:berita|info|kabar|tren|artikel)\s+(?:tentang|seputar|soal)\s+(.+)/i);
      if (newsTopicMatch) {
        const topic = newsTopicMatch[1].trim();
        console.log(`[Web Intelligence] 📰 Riset topik berita: "${topic}"`);
        try {
          const newsRes = await searchAndScrapeTopic(topic, 3);
          if (newsRes.success && newsRes.articles.length > 0) {
            webIntelContext = `\n[HASIL RISET BERITA TERKINI]:
${newsRes.articles.map((a, i) => `${i+1}. "${a.title}" (${a.pubDate})
   Link: ${a.link}
   Snippet: ${a.snippet}`).join('\n\n')}
(PENTING: Gunakan berita nyata di atas untuk memberikan ringkasan atau materi postingan yang segar dan akurat).\n\n`;
          }
        } catch (err) {
          console.error('[Web Intelligence] Error research topic:', err.message);
        }
      }
    }

    let promptContext = '';
    if (isGroup) {
      const recentGroupHistory = getRecentGroupHistory(targetRecipient, 25);
      const historyText = recentGroupHistory.length > 0
        ? `\n[Riwayat Percakapan Terakhir di Grup WhatsApp ini]:\n${recentGroupHistory.map(m => `• [${m.time}] ${m.senderName}: "${m.message}"`).join('\n')}\n\n`
        : '';

      if (isOwner) {
        promptContext = `${historyText}${tjContext}${webIntelContext}[Pesan di Grup WhatsApp dari Mas Andika]: "${userPrompt}"\n(PENTING: Jawab langsung di grup secara ramah, santai, dan solutif. Jika Mas Andika bertanya mengenai konteks atau rangkuman obrolan grup, manfaatkan [Riwayat Percakapan Terakhir] di atas untuk menjawab secara akurat dan nyambung. Langsung berikan SATU respon/rekomendasi terbaik tanpa opsi pilihan ganda. JANGAN gunakan BypassSandbox: true (wajib sandboxed agar tidak memicu dialog popup allow di laptop), JANGAN gunakan tool ask_question, JANGAN minta review/submit di UI laptop, JANGAN gunakan tool schedule atau send_message. Eksekusi tugas sampai tuntas secara mandiri).`;
      } else {
        promptContext = `${historyText}${tjContext}${webIntelContext}[Pesan di Grup WhatsApp dari ${senderName}]: "${userPrompt}"\n(PENTING: Jawab pertanyaan atau diskusi ${senderName} secara ramah dan solutif. Jika pengguna bertanya mengenai konteks atau obrolan grup, manfaatkan [Riwayat Percakapan Terakhir] di atas untuk menjawab secara cerdas dan akurat. Langsung berikan SATU rekomendasi terbaik tanpa opsi pilihan ganda. Namun JANGAN jalankan perintah yang memodifikasi/menghapus file lokal di komputer untuk pengguna ini. JANGAN gunakan tool ask_question, JANGAN gunakan tool schedule atau send_message).`;
      }
    } else {
      if (isOwner) {
        promptContext = `${tjContext}${webIntelContext}[Chat Pribadi WhatsApp dari Mas Andika]: "${userPrompt}"\n(PENTING: Jawab langsung secara santai, ramah, dan manusiawi sebagai Joko. Langsung berikan SATU rekomendasi jawaban/ucapan terbaik tanpa memberikan opsi pilihan ganda. JANGAN gunakan BypassSandbox: true (wajib sandboxed agar tidak memicu dialog popup allow di laptop), JANGAN gunakan tool ask_question, JANGAN memunculkan pilihan/submit di UI laptop, JANGAN gunakan tool send_message atau schedule, dan JANGAN ada pesan meta internal agen. Pengguna sedang remote tanpa laptop, jadi eksekusi tugas secara mandiri sampai tuntas).`;
      } else {
        promptContext = `${tjContext}${webIntelContext}[Chat Pribadi WhatsApp dari ${senderName}]: "${userPrompt}"\n(PENTING: Jawab pertanyaan atau diskusi ${senderName} secara ramah dan solutif. Namun JANGAN jalankan perintah yang memodifikasi/menghapus file lokal di komputer atau eksekusi terminal untuk pengguna ini. Langsung berikan SATU rekomendasi jawaban terbaik tanpa opsi pilihan ganda. JANGAN gunakan tool ask_question, JANGAN gunakan tool send_message, JANGAN gunakan tool schedule, dan JANGAN ada pesan meta internal agen).`;
      }
    }

    const isNew = !activeConversationId;
    const promptToSend = isNew ? `${SYSTEM_PERSONA}\n\n${promptContext}` : promptContext;
    let responseText = await askAgy(promptToSend, isNew, targetRecipient, senderName);
    console.log(`[Agent] ✅ Respon Joko diterima (${responseText.length} karakter).`);

    if (isNew) {
      activeConversationId = 'session_' + Date.now();
      saveSession(activeConversationId);
    }

    const finalSteps = readTranscript(activeConversationId);
    if (finalSteps.length > 0) {
      lastSeenStepIndex = finalSteps[finalSteps.length - 1].step_index;
    }

    // Deteksi jika AI menyertakan blok schedule otomatis
    const scheduleBlockMatch = responseText.match(/```schedule\s*([\s\S]*?)\s*```/i);
    if (scheduleBlockMatch) {
      try {
        const schedData = JSON.parse(scheduleBlockMatch[1]);
        const aiJob = createJobFromAI(schedData, senderNumber, senderName, targetRecipient);
        if (aiJob) {
          const savedJob = addJob(aiJob);
          console.log(`[AI Scheduler] ✅ Berhasil mendaftarkan jadwal dari AI: "${savedJob.title}" (${savedJob.id})`);
        }
      } catch (err) {
        console.error('[AI Scheduler] Gagal parse blok schedule:', err.message);
      }
      responseText = responseText.replace(/```schedule\s*([\s\S]*?)\s*```/gi, '').trim();
    }

    // Deteksi jika AI menyertakan blok konten Threads untuk di-upload otomatis
    const threadsBlockMatch = responseText.match(/```threads\s*([\s\S]*?)\s*```/i);
    if (threadsBlockMatch && isOwner) {
      const threadToPost = threadsBlockMatch[1].trim();
      try {
        console.log(`[AI Threads Poster] 🚀 Memposting konten yang dibuat AI ke Threads...`);
        const postRes = await postToThreads(threadToPost);
        responseText = responseText.replace(/```threads\s*([\s\S]*?)\s*```/gi, '$1').trim();
        if (postRes && postRes.verifiedOnProfile) {
          responseText += `\n\n*(✅ Utas ini sudah otomatis Joko upload dan TERVERIFIKASI tayang di profil Threads Mas Andika! 🚀)*`;
        } else {
          responseText += `\n\n*(✅ Utas ini sudah diproses dan dikirim ke Threads Mas Andika! 🚀)*`;
        }
      } catch (err) {
        console.error('[AI Threads Poster] Gagal upload:', err.message);
        responseText = responseText.replace(/```threads\s*([\s\S]*?)\s*```/gi, '$1').trim();
        responseText += `\n\n*(⚠️ Catatan: Utas belum ter-upload otomatis: ${err.message}. Pastikan sudah login via \`Joko login threads\` ya Mas!)*`;
      }
    }

    await sendWhatsApp(targetRecipient, responseText);

  } catch (err) {
    console.error('[Agent] ❌ Error:', err.message);
    const isConnError = /unavailable|dial tcp|connection error|connectex|failed to connect/i.test(err.message);
    const isTimeout = /timeout|waktu tunggu habis|waktu lebih lama/i.test(err.message);
    let friendlyMsg = '';
    if (isConnError) {
      friendlyMsg = `Waduh Mas Andika, server AI sepertinya sedang memulai ulang. Mohon tunggu sebentar ya Mas, Joko langsung siap kembali! ☕`;
    } else if (isTimeout) {
      friendlyMsg = `Waduh Mas Andika, tugas ini sedang diproses secara mendalam oleh Joko sehingga butuh waktu sedikit lebih lama. Prosesnya tetap berjalan ya Mas! ⏳☕`;
    } else {
      friendlyMsg = `Waduh Mas Andika, ada kendala saat Joko memproses instruksi ini: ${err.message}. Joko sedang memulihkan koneksi ya Mas! ☕`;
    }
    await sendWhatsApp(targetRecipient, friendlyMsg);
  } finally {
    isProcessing = false;
    processingStartTime = 0;
  }
}

// Handler Utama Pemrosesan Pesan Masuk (dipanggil oleh Baileys Direct Socket)
async function processIncomingMessage({ rawSender, rawMember, rawDevice, rawMessage, senderName = 'Teman', senderNumber: explicitSenderNumber = null, isFromMe = false }) {
  if (!rawMessage || !rawSender) return;

  if (isOurOwnMessage(rawMessage)) {
    return;
  }

  try {

        const isGroup = rawSender.endsWith('@g.us') || rawSender.includes('@g.us');

        let senderNumber = '';
        if (explicitSenderNumber) {
          senderNumber = String(explicitSenderNumber).replace(/[^0-9]/g, '');
        } else if (isGroup) {
          if (rawMember && !rawMember.includes('@g.us')) {
            senderNumber = rawMember.replace(/[^0-9]/g, '');
          } else {
            // Di grup, jika rawMember kosong atau berisi ID grup itu sendiri,
            // berarti pesan dikirim langsung dari nomor WhatsApp Mas Andika sendiri (device Baileys)
            senderNumber = rawDevice || '6282163850914';
          }
        } else {
          senderNumber = rawSender.replace(/[^0-9]/g, '');
        }

        // Penentuan Owner (Mas Andika):
        // 1. Pesan diketik langsung dari HP akun WhatsApp Mas Andika sendiri (isFromMe)
        // 2. Nomor pengirim terdaftar di AUTHORIZED_TARGETS (6282163850914)
        // 3. ATAU nama pengirim adalah profil resmi WhatsApp Mas Andika ('11423021_AndikaTampubolon')
        // 4. ATAU di grup dikirim langsung dari device WhatsApp Mas Andika sendiri
        const isOwner = isFromMe ||
                        AUTHORIZED_TARGETS.has(senderNumber) ||
                        senderName === '11423021_AndikaTampubolon' ||
                        senderName.includes('AndikaTampubolon') ||
                        (isGroup && (!rawMember || rawMember.includes('@g.us')));

        // KUNCI TARGET PENERIMA:
        // Di grup, kirim balasan ke ID grup.
        // Di chat pribadi, selalu kirim balasan langsung ke ruang chat aktif tersebut (rawSender).
        const targetRecipient = rawSender;

        // ==========================================
        // 1. KONTROL TIDUR / BANGUN JOKO (OWNER ONLY)
        // ==========================================
        const currentJokoState = getJokoState();

        // A. Cek Perintah Membangunkan Joko ("Joko bantu dong", "Joko bangun", dll)
        if (isWakeCommand(rawMessage)) {
          if (!isOwner) {
            console.log(`[Joko Control] Panggilan bangun dari ${senderNumber} diabaikan (bukan Owner).`);
            return;
          }

          if (currentJokoState.isAsleep) {
            setJokoState(false);
            console.log(`[Joko Control] 🟢 Joko DIBANGUNKAN oleh Mas Andika!`);
            await sendWhatsApp(targetRecipient, `Siap Mas Andika! Joko sudah bangun dan siaga kembali. Ada yang bisa Joko bantu hari ini? ☕`);
          } else {
            await sendWhatsApp(targetRecipient, `Joko sudah aktif dan siaga dari tadi kok, Mas Andika! Mau dibantu apa nih?`);
          }
          return;
        }

        // B. Cek Perintah Menidurkan Joko ("Joko lu bisa tidur", "Joko tidur", dll)
        if (isSleepCommand(rawMessage)) {
          if (!isOwner) {
            console.log(`[Joko Control] Perintah tidur dari ${senderNumber} diabaikan (bukan Owner).`);
            return;
          }

          if (!currentJokoState.isAsleep) {
            setJokoState(true);
            console.log(`[Joko Control] 💤 Joko DITIDURKAN oleh Mas Andika!`);
            await sendWhatsApp(targetRecipient, `Siap Mas Andika, Joko tidur dan istirahat dulu ya. Kalau butuh Joko lagi, panggil aja *"Joko bangun"* atau *"Joko bantu dong"*. Zzz... 💤`);
          } else {
            await sendWhatsApp(targetRecipient, `Zzz... Joko memang sedang istirahat kok, Mas Andika. 💤`);
          }
          return;
        }

        // ==========================================
        // 2. JIKA JOKO SEDANG TIDUR (SLEEP MODE)
        // ==========================================
        if (currentJokoState.isAsleep) {
          // Jika Joko sedang tidur, abaikan SEMUA pesan kecuali cek status dari Owner
          if (isOwner && (rawMessage.toLowerCase() === '/status' || rawMessage.toLowerCase() === 'status')) {
            await sendWhatsApp(targetRecipient, `💤 *Joko sedang tidur (Mode Istirahat).*\nPanggil *"Joko bangun"* atau *"Joko bantu dong"* untuk mengaktifkan Joko kembali.`);
          } else {
            console.log(`[Joko Sleep] Mengabaikan pesan karena Joko sedang tidur: "${rawMessage.slice(0, 30)}"`);
          }
          return;
        }

        // ==========================================
        // 3. PARSING PESAN KETIKA JOKO AKTIF
        // ==========================================
        let userPrompt = rawMessage;

        if (isGroup) {
          // Rekam setiap pesan di grup ke memori riwayat obrolan di latar belakang
          recordGroupMessage(rawSender, senderName, senderNumber, rawMessage);

          // Di grup, respon jika dipanggil namanya ("Joko", "!joko", "!bot", "!ai", "@bot")
          const triggerMatch = rawMessage.match(/^(!joko|joko|!bot|!ai|@bot)\b\s*[:,-]?\s*(.*)/i);
          if (!triggerMatch) {
            return;
          }

          userPrompt = triggerMatch[2]?.trim() || '';
          if (!userPrompt) {
            if (!isOwner && !isGroupMembersAllowed(rawSender)) {
              return;
            }
            await sendWhatsApp(targetRecipient, `Halo ${senderName}! Joko di sini. Mau tanya atau minta bantuan apa? Ketik: \`Joko <pertanyaan Anda>\``);
            return;
          }

          console.log(`[Group Webhook] Dari ${senderName} (${senderNumber}) di ${rawSender}: "${userPrompt}"`);

          // ========================================================
          // KONTROL AKSES ANGGOTA GRUP (HANYA OWNER / MAS ANDIKA)
          // ========================================================
          if (isGrantAccessCommand(userPrompt)) {
            if (!isOwner) {
              await sendWhatsApp(targetRecipient, `Maaf ${senderName}, hanya Mas Andika yang berwenang membuka akses Joko untuk grup ini.`);
              return;
            }
            grantGroupAccess(rawSender);
            await sendWhatsApp(targetRecipient, `Siap, Mas Andika! Akses Joko untuk teman-teman di grup ini sudah dibuka ya. Sekarang semua anggota di grup ini bisa memanggil dan mengobrol dengan Joko! 🎉`);
            return;
          }

          if (isRevokeAccessCommand(userPrompt)) {
            if (!isOwner) {
              await sendWhatsApp(targetRecipient, `Maaf ${senderName}, hanya Mas Andika yang berwenang mengunci akses Joko untuk grup ini.`);
              return;
            }
            revokeGroupAccess(rawSender);
            await sendWhatsApp(targetRecipient, `Siap, Mas Andika! Akses untuk anggota di grup ini sudah dikunci kembali. Sekarang hanya Mas Andika yang dapat menggunakan Joko di sini. 🔒`);
            return;
          }

          // Cek apakah anggota grup selain Mas Andika diizinkan menggunakan Joko
          if (!isOwner && !isGroupMembersAllowed(rawSender)) {
            console.log(`[Group Security] 🔒 Panggilan dari ${senderName} (${senderNumber}) ditolak karena akses grup belum dibuka oleh Owner.`);
            await sendWhatsApp(targetRecipient, `Halo ${senderName}! Saat ini akses Joko di grup ini masih dikunci khusus untuk Mas Andika.\n\nMas Andika bisa membuka aksesnya dengan mengetik:\n*"Joko, teman teman di grup ini juga kasih akses ya"*`);
            return;
          }

        } else {
          // Di chat pribadi:
          const isAllowedPersonal = isPersonalMemberAllowed(senderNumber);

          // Kontrol Akses Personal (Khusus Mas Andika / Owner):
          // Mas Andika bisa menambahkan atau mencabut nomor teman yang boleh chat dengan Joko:
          // Contoh: "Joko beri akses personal ke 08123456789"
          // Contoh: "Joko cabut akses personal dari 08123456789"
          // Contoh: "/whitelist" atau "Joko daftar akses personal"
          if (isOwner) {
            const grantMatch = rawMessage.match(/(?:kasih|beri|buka|izinkan|tambah)\s+akses\s+(?:personal|pribadi|chat)?.*?([0-9\+]{8,16})/i);
            if (grantMatch) {
              const addedNum = grantPersonalAccess(grantMatch[1]);
              await sendWhatsApp(targetRecipient, `Siap Mas Andika! Akses chat pribadi untuk nomor *${addedNum}* sudah dibuka ya. Teman Mas sekarang bisa chat langsung 1-on-1 dengan Joko! 🎉`);
              return;
            }

            const revokeMatch = rawMessage.match(/(?:cabut|kunci|tutup|hapus)\s+akses\s+(?:personal|pribadi|chat)?.*?([0-9\+]{8,16})/i);
            if (revokeMatch) {
              const removedNum = revokePersonalAccess(revokeMatch[1]);
              await sendWhatsApp(targetRecipient, `Siap Mas Andika! Akses chat pribadi untuk nomor *${removedNum}* telah dicabut kembali. 🔒`);
              return;
            }

            if (/^(?:!joko\s+|joko\s*[:,-]?\s*)?(?:\/whitelist|list\s+akses|daftar\s+akses|cek\s+akses)/i.test(rawMessage.trim())) {
              const currentList = Array.from(loadAllowedPersonalUsers());
              if (currentList.length === 0) {
                await sendWhatsApp(targetRecipient, `Saat ini belum ada nomor teman yang diizinkan chat personal dengan Joko.\n\nUntuk memberi akses ke teman, ketik:\n\`Joko beri akses personal ke 08xxxxxxxxxx\``);
              } else {
                await sendWhatsApp(targetRecipient, `📋 *Daftar Teman Diizinkan Chat Personal:*\n${currentList.map(n => `• \`${n}\``).join('\n')}\n\nUntuk mencabut akses, ketik:\n\`Joko cabut akses personal dari <nomor>\``);
              }
              return;
            }

            // Perintah Set Session Cookie Threads: "Joko session threads <sessionid>"
            const sessionMatch = rawMessage.match(/^(?:!joko\s+|joko\s*[:,-]?\s*)?(?:set\s+)?session\s+(?:cookie\s+)?threads\s*[:,-]?\s*(.+)/i);
            if (sessionMatch && sessionMatch[1].trim()) {
              const sessionIdValue = sessionMatch[1].trim();
              try {
                saveSessionIdCookie(sessionIdValue);
                await sendWhatsApp(targetRecipient, `✅ *Berhasil Terhubung!* Sesi login Threads Mas Andika telah aktif di server awan Joko. 🍪🚀\n\nSekarang Mas Andika bisa langsung minta: *"Joko buat utas threads lagi yuk"* dan Joko akan otomatis langsung mengunggahnya!`);
              } catch (err) {
                await sendWhatsApp(targetRecipient, `Waduh Mas, gagal menyimpan session Threads: ${err.message}`);
              }
              return;
            }

            // Perintah Buka Browser untuk Login Threads
            if (/^(?:!joko\s+|joko\s*[:,-]?\s*)?(?:login|buka(?:\s+browser)?(?:\s+ke)?)\s+threads\b/i.test(rawMessage.trim())) {
              await sendWhatsApp(targetRecipient, `Siap Mas Andika! Joko sedang membukakan browser Chrome di laptop Mas. Silakan login akun Threads Mas di jendela tersebut sekali ini ya. Nanti sesi loginnya tersimpan permanen! 🌐`);
              try {
                await openThreadsLogin();
              } catch (e) {
                console.error('[Threads Login Error]:', e.message);
              }
              return;
            }

            // Perintah Cek Status Login Threads
            if (/^(?:!joko\s+|joko\s*[:,-]?\s*)?(?:cek|status)\s+login\s+threads\b/i.test(rawMessage.trim())) {
              await sendWhatsApp(targetRecipient, `Sebentar ya Mas, Joko cek status login akun Threads di browser laptop... 🔍`);
              const status = await checkThreadsLogin();
              if (status.isLoggedIn) {
                await sendWhatsApp(targetRecipient, `✅ Akun Threads Mas Andika *sudah login dan aktif*! Joko siap posting konten kapan pun Mas perintahkan. 🚀`);
              } else {
                await sendWhatsApp(targetRecipient, `⚠️ Akun Threads *belum login* di browser. Ketik \`Joko login threads\` agar Joko bukakan browsernya untuk login ya Mas. 🌐`);
              }
              return;
            }

            // Perintah Langsung Posting ke Threads: "Joko posting ke threads: <isi>" atau "Joko upload ke threads: <isi>"
            const directPostMatch = rawMessage.match(/^(?:!joko\s+|joko\s*[:,-]?\s*)?(?:posting|upload|kirim)\s+(?:ke\s+)?threads\s*[:,-]?\s*(.*)/is);
            if (directPostMatch && directPostMatch[1].trim()) {
              const threadContent = directPostMatch[1].trim();
              await sendWhatsApp(targetRecipient, `Siap Mas Andika! Joko sedang meluncurkan browser untuk memposting utas ke Threads Mas:\n\n"${threadContent.slice(0, 80)}..." ⏳`);
              try {
                const res = await postToThreads(threadContent);
                await sendWhatsApp(targetRecipient, `🎉 *Berhasil Diposting ke Threads!* \n\nUtas Mas Andika sudah resmi tayang di Threads pada ${new Date(res.postedAt).toLocaleTimeString('id-ID')} WIB. Keren banget! 🚀🔥`);
              } catch (postErr) {
                await sendWhatsApp(targetRecipient, `Waduh Mas, gagal posting ke Threads: ${postErr.message}\n\nPastikan Mas sudah login dengan mengetik \`Joko login threads\` ya! 🙏`);
              }
              return;
            }

            // Perintah Minta Morning Executive Briefing: "Joko briefing pagi" atau "Joko kirim briefing"
            if (isBriefingCommand(rawMessage)) {
              await sendWhatsApp(targetRecipient, `Siap Mas Andika! Joko sedang merangkum cuaca, kondisi komuter, tren AI terkini, dan draft Threads hari ini... ⏳☕`);
              try {
                const briefing = await generateExecutiveBriefing();
                await sendWhatsApp(targetRecipient, briefing.text);
              } catch (bErr) {
                console.error('[Executive Briefing Error]:', bErr.message);
                await sendWhatsApp(targetRecipient, `Waduh Mas, ada kendala saat menyusun briefing: ${bErr.message}`);
              }
              return;
            }

            // Perintah Langsung Posting Draft Threads Hasil Briefing: "Joko posting draft threads tadi" atau "gas posting threads"
            if (isPostDraftThreadCommand(rawMessage)) {
              const draft = getLatestDraftThread();
              if (!draft) {
                await sendWhatsApp(targetRecipient, `Belum ada draft Threads dari briefing pagi ini, Mas. Mas Andika bisa ketik \`Joko briefing pagi\` dulu ya! ☕`);
                return;
              }
              await sendWhatsApp(targetRecipient, `Siap Mas Andika! Joko langsung meluncurkan browser untuk upload draft Threads tadi ke akun @andikatampubolon._ ya... 🚀`);
              try {
                const res = await postToThreads(draft);
                await sendWhatsApp(targetRecipient, `🎉 *Berhasil Diposting ke Threads!* 🚀\n\nUtas Mas Andika sudah resmi tayang di Threads pada ${new Date(res.postedAt).toLocaleTimeString('id-ID')} WIB:\n\n"${draft}"`);
              } catch (postErr) {
                await sendWhatsApp(targetRecipient, `Waduh Mas, gagal posting ke Threads: ${postErr.message}\n\nPastikan akun sudah login via \`Joko login threads\` ya! 🙏`);
              }
              return;
            }
          }

          if (!isOwner && !isAllowedPersonal) {
            console.log(`[Security] ⛔ Chat pribadi dari ${senderName} (${senderNumber}) diabaikan (bukan Owner dan belum ada di whitelist personal).`);
            return;
          }

          // STRICT TRIGGER (PENGAMAN CHAT PRIBADI):
          // Di chat pribadi, Joko HANYA merespons jika diawali pemanggilan eksplisit:
          // "Joko <pesan>", "!joko <pesan>", atau perintah slash resmi (/bantuan, /status, /jadwal, dll.)
          // Jika Mas Andika sedang chatting dengan orang lain tanpa memanggil Joko,
          // Joko WAJIB 100% diam dan mengabaikan pesan tersebut agar obrolan pribadi tetap aman dan privasi terjaga!
          const isSlashCommand = /^\/(?:bantuan|help|status|jadwal|reset|baru|on|off|tidur|bangun)\b/i.test(rawMessage);
          const privateTriggerMatch = rawMessage.match(/^(!joko|joko|!bot|!ai|@bot)\b\s*[:,-]?\s*(.*)/is);

          if (!privateTriggerMatch && !isSlashCommand) {
            // Obrolan pribadi biasa tanpa kata kunci Joko -> abaikan total!
            return;
          }

          userPrompt = privateTriggerMatch ? (privateTriggerMatch[2]?.trim() || '') : rawMessage;
          if (!userPrompt && privateTriggerMatch) {
            const greeting = isOwner ? `Halo Mas Andika! Joko siaga di sini. Mau tanya atau minta bantuan apa nih?` : `Halo ${senderName}! Joko di sini. Mau tanya atau minta bantuan apa nih?`;
            await sendWhatsApp(targetRecipient, greeting);
            return;
          }

          console.log(`[Private Webhook] Dari ${isOwner ? 'Mas Andika' : senderName} (${senderNumber}): "${userPrompt}"`);
        }

        const lowerPrompt = userPrompt.toLowerCase();

        // Perintah Bantuan
        if (lowerPrompt === '/bantuan' || lowerPrompt === 'bantuan' || lowerPrompt === '/help' || lowerPrompt === 'help') {
          if (isGroup) {
            await sendWhatsApp(targetRecipient, `Halo ${senderName}! Saya adalah *Joko*, asisten AI di grup ini.

*Cara Memanggil Joko:*
• \`Joko <pertanyaan atau perintah>\`
• Contoh: \`Joko jelaskan perbedaan REST API dan GraphQL\`
• Contoh: \`Joko buatkan fungsi hitung diskon di javascript\`

*Fitur Pengingat & Jadwal:*
• \`Joko ingatkan saya 15 menit lagi untuk minum air\`
• \`Joko jadwal\` : Cek jadwal aktif

*Kontrol Khusus Owner (Mas Andika):*
• *"Joko lu bisa tidur"* : Menidurkan Joko (off)
• *"Joko bantu dong"* : Membangunkan Joko (on)`);
          } else {
            await sendWhatsApp(targetRecipient, `Halo Mas Andika! Joko siap membantu:

*Cara Memanggil Joko (Pengaman Aktif):*
• \`Joko <pertanyaan atau perintah>\`
• Contoh: \`Joko tolong jelaskan arsitektur microservices\`
• Contoh: \`Joko ingatkan saya 15 menit lagi untuk minum air\`

_🛡️ Proteksi Privasi Aktif:_ Joko hanya akan merespons jika diawali dengan kata *Joko* agar obrolan pribadi Mas Andika dengan dosen, teman, atau rekan tetap aman dan tidak pernah diganggu.

*Kontrol Cepat:*
• \`/off\` atau *"Joko tidur"* : Joko istirahat (Off)
• \`/on\` atau *"Joko bangun"* : Joko siaga (On)

*Fitur & Jadwal:*
• \`/jadwal\` : Melihat daftar jadwal/pengingat aktif
• \`/status\` : Cek status sistem & memori Joko
• \`/baru\` : Reset sesi percakapan`);
          }
          return;
        }

        // Perintah Status
        if (lowerPrompt === '/status' || lowerPrompt === 'status') {
          const curId = getSavedSession() || 'Belum ada sesi aktif';
          const activeJobs = loadJobs().length;
          let statusText = `🟢 *Status Asisten Joko:*
• Kondisi: Aktif & Siaga (Awake)
• Status Eksekutor: ${isProcessing ? '⏳ Sedang memproses tugas' : '✅ Siap'}
• Jadwal Aktif: ${activeJobs} jadwal berjalan
• Mode: ${isGroup ? 'Grup WhatsApp' : 'Chat Pribadi'}`;
          if (isGroup) {
            statusText += `\n• Akses Anggota Grup: ${isGroupMembersAllowed(rawSender) ? '🟢 Terbuka untuk semua anggota' : '🔒 Khusus Mas Andika (Terkunci)'}`;
          }
          await sendWhatsApp(targetRecipient, statusText);
          return;
        }

        // Respon Sapaan Cepat (Halo / Hai / P / Tes)
        if (/^(?:halo|hai|hi|hey|helo|tes|test|p|ping|assalamu['a]?laikum)\b/i.test(lowerPrompt.trim())) {
          const greeting = isOwner
            ? `Halo Mas Andika! Joko siaga penuh di sini via koneksi langsung Baileys Multi-Device. 🚀\nAda yang bisa Joko bantu hari ini? ☕`
            : `Halo ${senderName}! Joko di sini. Ada yang bisa saya bantu? 😊`;
          await sendWhatsApp(targetRecipient, greeting);
          return;
        }

        // Perintah Reset
        if (lowerPrompt === '/baru' || lowerPrompt === 'baru' || lowerPrompt === '/reset' || lowerPrompt === 'reset') {
          if (!isOwner) {
            await sendWhatsApp(targetRecipient, `Maaf ${senderName}, hanya Mas Andika yang dapat mereset sesi Joko.`);
            return;
          }
          if (fs.existsSync(SESSION_FILE)) {
            fs.unlinkSync(SESSION_FILE);
          }
          await sendWhatsApp(targetRecipient, `Sip Mas Andika, sesi percakapan Joko telah di-reset. Kita mulai dari awal lagi ya!`);
          return;
        }

        // Perintah Melihat Jadwal
        if (lowerPrompt === '/jadwal' || lowerPrompt === 'jadwal' || lowerPrompt === 'list jadwal') {
          const jobs = loadJobs();
          if (jobs.length === 0) {
            await sendWhatsApp(targetRecipient, `Belum ada jadwal atau pengingat aktif di Joko saat ini.

*Contoh Jadwal:*
• \`Joko ingatkan saya 15 menit lagi untuk minum obat\`
• \`Joko jadwalkan setiap hari jam 08:00 selamat pagi tim\``);
            return;
          }

          let listText = `📋 *Daftar Jadwal & Pengingat Aktif (${jobs.length}):*\n`;
          jobs.forEach((j, idx) => {
            listText += `\n${idx + 1}. *${j.title}*
   • Waktu: ${j.config.readableTime}
   • Target: ${j.target.includes('@g.us') ? 'Grup' : 'Pribadi'}
   • Dibuat Oleh: ${j.creatorName}
   • ID: \`${j.id}\``;
          });
          listText += `\n\nUntuk membatalkan jadwal, ketik:\n\`Joko hapus jadwal <ID>\``;
          await sendWhatsApp(targetRecipient, listText);
          return;
        }

        // Perintah Hapus Jadwal
        const delMatch = userPrompt.match(/^(?:\/hapus-jadwal|hapus\s+jadwal|batal\s+jadwal|\/batal-jadwal)\s+(.+)/i);
        if (delMatch) {
          const targetId = delMatch[1].trim();
          const jobs = loadJobs();
          const targetJob = jobs.find(j => j.id === targetId || j.id.endsWith(targetId));

          if (!targetJob) {
            await sendWhatsApp(targetRecipient, `Jadwal dengan ID \`${targetId}\` tidak ditemukan.`);
            return;
          }

          if (!isOwner && targetJob.creator !== senderNumber) {
            await sendWhatsApp(targetRecipient, `Maaf ${senderName}, Anda hanya dapat membatalkan jadwal yang Anda buat sendiri.`);
            return;
          }

          removeJob(targetJob.id);
          await sendWhatsApp(targetRecipient, `✅ Jadwal *"${targetJob.title}"* telah berhasil dibatalkan.`);
          return;
        }

        // Deteksi Pembuatan Jadwal / Pengingat Baru
        const newSchedule = parseScheduleCommand(userPrompt, senderNumber, senderName, targetRecipient);
        if (newSchedule) {
          if (newSchedule.actionType === 'ai_prompt' && !isOwner) {
            await sendWhatsApp(targetRecipient, `Maaf ${senderName}, penjadwalan tugas eksekusi AI/sistem hanya dapat dibuat oleh Mas Andika.`);
            return;
          }

          const saved = addJob(newSchedule);
          const confirmationMsg = formatScheduleConfirmation(saved, isOwner, senderName);
          await sendWhatsApp(targetRecipient, confirmationMsg);
          return;
        }

        // Jalankan percakapan / tugas dengan Joko via Antigravity
        executeWithAntigravity(userPrompt, targetRecipient, senderName, senderNumber, isGroup, isOwner).catch(err => {
          console.error('[Async Error]', err);
        });

      } catch (err) {
        console.error('[Process Message Error]:', err.message);
      }
}

// Setup HTTP Server lokal (Status Health-Check & endpoint /test-send, diakses via SSH ke 127.0.0.1)
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/test-send') {
    try {
      console.log('[Test Endpoint] 🧪 Menjalankan tes kirim pesan ke Mas Andika (6282163850914)...');
      const bStatus = getBaileysStatus();
      if (!bStatus.ready) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Baileys belum terhubung ke WhatsApp' }));
        return;
      }
      const testMsg = `🤖 [TES MANDIRI JOKO]: Halo Mas Andika! Jalur pengiriman WebSocket Baileys langsung dari server AWS EC2 SUKSES 100%! 🚀 Jam: ${new Date().toLocaleTimeString('id-ID')} WIB`;
      const sendRes = await sendBaileysMessage('6282163850914', testMsg);
      console.log('[Test Endpoint] ✅ Berhasil kirim pesan tes:', sendRes);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: sendRes }));
    } catch (err) {
      console.error('[Test Endpoint] ❌ Gagal kirim pesan tes:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET') {
    const jokoState = getJokoState();
    const bStatus = getBaileysStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'active',
      name: 'Joko (Personal AI Assistant)',
      mode: jokoState.isAsleep ? 'SLEEP (Tidur)' : 'AWAKE (Aktif)',
      baileys: bStatus.ready ? 'CONNECTED (Multi-Device Direct)' : 'WAITING_PAIRING',
      port: PORT,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// Tangkap uncaught exceptions agar proses server tidak pernah crash
process.on('uncaughtException', (err) => {
  console.error('[Process Error] Uncaught exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Process Error] Unhandled rejection:', reason?.message || reason);
});

// Helper pastikan job morning executive briefing terdaftar
function ensureMorningBriefingJob() {
  try {
    const jobs = loadJobs();
    if (!jobs.some(j => j.id === 'job_morning_briefing_andika')) {
      jobs.push({
        id: 'job_morning_briefing_andika',
        title: 'Morning Executive Briefing Harian',
        creator: '6282163850914',
        creatorName: 'Mas Andika',
        target: '6282163850914',
        type: 'daily',
        config: {
          time: '07:00'
        },
        actionType: 'executive_briefing',
        payload: 'Morning Executive Briefing Harian untuk Mas Andika',
        createdAt: new Date().toISOString(),
        lastRun: null,
        totalRuns: 0
      });
      saveJobs(jobs);
      console.log('[Executive Briefing] ☕ Jadwal briefing harian pukul 07:00 WIB otomatis terdaftar.');
    }
  } catch (err) {
    console.error('[Executive Briefing] Gagal daftarkan job briefing:', err.message);
  }
}

// Jalankan HTTP Server lokal, koneksi Baileys, dan Cron Engine
server.listen(PORT, '127.0.0.1', async () => {
  loadGroupHistory();
  startTJTracker();
  const curState = getJokoState();
  console.log(`====================================================`);
  console.log(`🚀 Asisten WhatsApp "JOKO" aktif di port ${PORT}`);
  console.log(`📱 Owner Whitelist: ${Array.from(AUTHORIZED_TARGETS).join(', ')}`);
  console.log(`💤 Status Awal: ${curState.isAsleep ? 'TIDUR (Sleep Mode)' : 'BANGUN (Awake Mode)'}`);
  const creds = getAntigravityCredentials();
  if (creds) {
    console.log(`🔌 Antigravity IDE: TERHUBUNG (${creds.address})`);
  } else {
    console.warn(`⚠️ Antigravity IDE: TIDAK TERDETEKSI (Pastikan aplikasi Antigravity IDE dibuka)`);
  }
  console.log(`🗣️ Panggilan Nama: "Joko", "!joko", "Joko bantu dong", "Joko lu bisa tidur"`);
  console.log(`====================================================`);

  // Pastikan jadwal Morning Executive Briefing terdaftar di cron-jobs.json
  ensureMorningBriefingJob();

  // Mulai Koneksi Langsung WhatsApp Multi-Device via Baileys
  try {
    initBaileys({
      ownerNumber: '6282163850914',
      onMessage: async ({ rawMessage, targetRecipient, senderName, senderNumber, isGroup, isFromMe }) => {
        await processIncomingMessage({
          rawSender: targetRecipient,
          rawMember: isGroup ? senderNumber : '',
          rawDevice: '6282163850914',
          rawMessage,
          senderName,
          senderNumber,
          isFromMe
        });
      }
    });
  } catch (bErr) {
    console.error('[Baileys Startup] Error:', bErr.message);
  }

  // Mulai Engine Cron Scheduler
  startCronScheduler(async (job) => {
    console.log(`[Cron Trigger] ⏰ Menjalankan jadwal "${job.title}" (${job.id}) ke ${job.target}`);

    if (job.actionType === 'executive_briefing') {
      console.log(`[Cron Trigger] ☕ Menjalankan jadwal Morning Executive Briefing ke ${job.target}`);
      try {
        const briefing = await generateExecutiveBriefing();
        await sendWhatsApp(job.target, briefing.text);
      } catch (err) {
        console.error(`[Cron Trigger] Error executive briefing:`, err.message);
      }
      return;
    }

    if (job.actionType === 'ai_prompt') {
      try {
        const prompt = `[Tugas Terjadwal]: "${job.payload}"\n(Instruksi: Berikan laporan atau jawaban ringkas, solutif, dan ramah sebagai Joko untuk dikirim ke WhatsApp).`;
        const result = await executeCronWithAntigravity(prompt);
        const message = `🔔 *Pengingat dari Joko:* ${job.title}\n\n${result}`;
        await sendWhatsApp(job.target, message);
      } catch (err) {
        console.error(`[Cron Trigger] Error eksekusi AI:`, err.message);
        await sendWhatsApp(job.target, `⚠️ Terjadi kendala saat Joko menjalankan jadwal "${job.title}": ${err.message}`);
      }
    } else {
      const lower = job.payload.toLowerCase();
      const displayName = AUTHORIZED_TARGETS.has(job.creator) ? 'Mas Andika' : job.creatorName;
      const isGroupTarget = job.target && job.target.includes('@g.us');
      let text = '';

      if (/makan|lunch|sarapan|dinner/i.test(lower)) {
        if (isGroupTarget) {
          text = `Teng teng teng! 🔔 Jam makan nih!\n\nHalo teman-teman semua dan ${displayName}! Waktunya istirahat dan makan siang dulu ya. Yuk jeda pekerjaannya sejenak dan isi energi biar tetap semangat! 🍛🍲😋`;
        } else {
          text = `Teng teng teng! 🔔 Jam makan nih, ${displayName}!\n\nYuk istirahat sejenak dan makan siang dulu biar energinya terisi lagi dan nggak masuk angin. Selamat makan! 🍛🍲😋`;
        }
      } else if (/minum/i.test(lower)) {
        if (isGroupTarget) {
          text = `⏰ *Colekan dari Joko!*\n\nHalo semuanya! Udah waktunya minum air putih nih biar badan tetap segar dan fokus kejaga! 💧🥛✨`;
        } else {
          text = `⏰ *Colekan dari Joko!*\n\nHalo ${displayName}! Udah waktunya buat minum air putih nih biar tetap segar dan terhidrasi! 💧✨`;
        }
      } else if (/rapat|meeting|zoom|briefing/i.test(lower)) {
        if (isGroupTarget) {
          text = `⏰ *Colekan dari Joko!*\n\nHalo teman-teman dan ${displayName}! Pengingat untuk:\n👉 *${job.payload}*\n\nYuk siap-siap meeting-nya! 💼✨`;
        } else {
          text = `⏰ *Colekan dari Joko!*\n\nHalo ${displayName}! Pengingat untuk:\n👉 *${job.payload}*\n\nYuk siap-siap meeting-nya! 💼✨`;
        }
      } else {
        if (isGroupTarget) {
          text = `⏰ *Colekan dari Joko!*\n\nHalo teman-teman dan ${displayName}! Udah waktunya untuk:\n👉 *${job.payload}*\n\n_Semoga urusannya lancar ya!_ ✨`;
        } else {
          text = `⏰ *Colekan dari Joko!*\n\nHalo ${displayName}! Udah waktunya untuk:\n👉 *${job.payload}*\n\n_Semoga urusannya lancar ya!_ ✨`;
        }
      }

      await sendWhatsApp(job.target, text);
    }
  });



  process.on('SIGINT', () => process.exit());
  process.on('SIGTERM', () => process.exit());
});
