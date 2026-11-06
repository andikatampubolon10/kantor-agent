#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  addJob,
  removeJob,
  loadJobs,
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

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.PORT || '8795', 10);
const FONNTE_TOKEN = process.env.FONNTE_TOKEN?.trim() || 'HUw3Ny3R4EaW1jHua4ki';
const DEVICE_NUMBER = process.env.FONNTE_DEVICE?.trim() || '6282163850914';
const DEVICE_NAME = 'Andika';
const AGY_PATH = 'C:\\Users\\andik\\.gemini\\bin\\agy.exe';
const BRAIN_DIR = 'C:\\Users\\andik\\.gemini\\antigravity\\brain';
const CLOUDFLARED_PATH = path.join(process.cwd(), 'cloudflared.exe');
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
    /(?:teman[- ]*teman|semua|anggota|member)\s+(?:di\s+grup\s+ini\s+)?(?:juga\s+)?(?:kasih|dikasih|diberi|beri|bisa)\s+akses/i.test(t) ||
    /(?:kasih|buka|izinkan|bolehkan|beri|share|aktifkan)\s+(?:akses\s+)?(?:buat\s+|untuk\s+)?(?:teman|semua|anggota|member|grup)/i.test(t) ||
    /(?:izinkan|bolehkan)\s+(?:teman|semua|anggota|member)/i.test(t) ||
    /akses\s+(?:buat\s+|untuk\s+)?(?:teman|semua|anggota|member)\s+(?:dibuka|diaktifkan|aktif)/i.test(t)
  );
}

function isRevokeAccessCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /(?:kunci|cabut|tutup|batasi|matikan|hapus)\s+akses\s+(?:buat\s+|untuk\s+)?(?:teman|semua|anggota|member|grup)/i.test(t) ||
    /(?:akses\s+)?(?:hanya|cuma)\s+(?:buat|untuk)\s+(?:saya|mas andika|owner)/i.test(t)
  );
}

// Persona sistem untuk Joko: Asisten Pribadi Mas Andika
const SYSTEM_PERSONA = `Peran Anda: Anda adalah Joko, asisten pribadi cerdas, ramah, dan solutif untuk Mas Andika (Owner sistem Anda: nomor 6282163850914).
Prinsip komunikasi:
1. Nama Anda adalah Joko. Sapa dan bicaralah secara santai, ramah, sopan, dan bersahabat seperti rekan kerja atau partner diskusi di WhatsApp.
2. Panggil Andika dengan 'Mas Andika'.
3. Jawab langsung ke inti pertanyaan atau permintaan, tanpa basa-basi robot/agen.
4. JANGAN PERNAH menggunakan tool send_message. Langsung berikan jawaban dalam teks respon akhir Anda.
5. JANGAN PERNAH menyertakan pesan meta atau format robot seperti "Pesan dari agen ... telah dibalas", "Recipient", atau ID teknis sistem.
6. Jika ditanya soal sisa token atau kuota, jelaskan dengan santai bahwa kapasitas konteks obrolan sangat longgar (hingga 1-2 juta token) dan saat ini baru terpakai sangat sedikit. Kuota WhatsApp di Fonnte juga masih aman.
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
13. Live Radar Transjakarta: Anda memiliki akses ke radar GPS live seluruh armada Transjakarta (BRT, Feeder, Mikrotrans). Jika pengguna bertanya seputar posisi bus, estimasi waktu kedatangan (ETA), rute, atau halte Transjakarta, data live GPS resmi akan disediakan di konteks obrolan. Gunakan data tersebut untuk memberikan jawaban yang akurat, real-time, dan solutif layaknya warga lokal Jakarta yang ramah dan paham seluk-beluk transportasi umum.`;

// Nomor WhatsApp Owner yang diizinkan mengontrol Joko
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
    /^(?:!joko\s+|joko\s+|!bot\s+)?(?:bangun|bantu\s+dong|aktif|on|kerja|wake\s*up)/i.test(t) ||
    /^(?:joko,?\s+)?bantu\s+dong/i.test(t) ||
    /^(?:joko,?\s+)?bisa\s+bantu/i.test(t)
  );
}

// Deteksi perintah tidur (Sleep Triggers)
function isSleepCommand(text) {
  const t = text.toLowerCase().trim();
  return (
    /^(?:!joko\s+|joko\s+|!bot\s+)?(?:lu\s+bisa\s+tidur|kamu\s+bisa\s+tidur|bisa\s+tidur|tidur|istirahat(?:\s+dulu)?|off|sleep|turu)/i.test(t)
  );
}

// Anti loop tracker
const sentMessageHashes = new Set();
function markSent(msg) {
  if (!msg) return;
  const clean = msg.replace(/\s*>*\s*_?Sent via fonnte\.com_?/gi, '').trim();
  const snippet = clean.slice(0, 50);
  sentMessageHashes.add(snippet);
  setTimeout(() => sentMessageHashes.delete(snippet), 180000);
}

function isOurOwnMessage(msg) {
  if (!msg) return false;
  if (/fonnte\.com/i.test(msg) || /sent via/i.test(msg)) {
    return true;
  }
  const clean = msg.replace(/\s*>*\s*_?Sent via fonnte\.com_?/gi, '').trim();
  const snippet = clean.slice(0, 50);
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

// Sync daftar grup WhatsApp di server Fonnte
async function syncFonnteGroups() {
  if (!FONNTE_TOKEN) return false;
  try {
    console.log('[Fonnte API] Menyinkronkan daftar grup WhatsApp...');
    const res = await fetch('https://api.fonnte.com/fetch-group', {
      method: 'POST',
      headers: { 'Authorization': FONNTE_TOKEN }
    });
    const data = await res.json();
    if (data.status) {
      console.log('[Fonnte API] ✅ Sinkronisasi grup WhatsApp selesai.');
      return true;
    }
  } catch (err) {
    console.error('[Fonnte API] Gagal sync grup:', err.message);
  }
  return false;
}

// Kirim pesan ke WhatsApp via Fonnte (Mendukung nomor pribadi & ID grup dengan auto-retry)
async function sendWhatsApp(target, message, isRetry = false) {
  if (!FONNTE_TOKEN) {
    console.log('[WA] Token tidak tersedia. Pesan tidak dikirim:', message);
    return false;
  }
  try {
    markSent(message);
    const formData = new URLSearchParams();
    formData.append('target', target);
    formData.append('message', message);
    formData.append('countryCode', '62');

    const res = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': FONNTE_TOKEN },
      body: formData
    });

    const data = await res.json();
    if (data.status) {
      console.log(`[WA] ✅ Pesan terkirim ke target: ${target}`);
      return true;
    } else {
      console.error(`[WA] ⚠️ Gagal kirim ke target ${target}:`, data.reason || JSON.stringify(data));

      if (!isRetry && data.reason?.toLowerCase().includes('invalid group id')) {
        console.log(`[WA] 🔄 Terdeteksi 'invalid group id'. Menyinkronkan daftar grup Fonnte lalu mencoba kirim ulang...`);
        await syncFonnteGroups();
        await new Promise(r => setTimeout(r, 2000));
        return await sendWhatsApp(target, message, true);
      }

      return false;
    }
  } catch (err) {
    console.error(`[WA] ❌ Error kirim pesan:`, err.message);
    return false;
  }
}

// Update webhook Fonnte secara otomatis via API
async function updateFonnteWebhook(webhookUrl) {
  try {
    console.log(`[Fonnte API] Mendaftarkan webhook URL: ${webhookUrl}...`);
    const params = new URLSearchParams({
      name: DEVICE_NAME,
      device: DEVICE_NUMBER,
      webhook: webhookUrl,
      autoread: 'true',
      personal: 'true',
      quick: 'true',
      group: 'true'
    });

    const res = await fetch('https://api.fonnte.com/update-device', {
      method: 'POST',
      headers: { 'Authorization': FONNTE_TOKEN },
      body: params
    });

    const data = await res.json();
    if (data.status) {
      console.log(`[Fonnte API] ✅ Webhook & Fitur Grup berhasil diperbarui di Fonnte: ${webhookUrl}`);
      return true;
    } else {
      console.warn(`[Fonnte API] ⚠️ Gagal update webhook:`, data.reason || JSON.stringify(data));
      return false;
    }
  } catch (err) {
    console.error(`[Fonnte API] ❌ Error update device:`, err.message);
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
async function waitForAgentResponse(conversationId, startStepIndex = 0, maxWaitMs = 180000) {
  const pollInterval = 1200;
  const startTime = Date.now();
  let candidateStepIndex = -1;
  let candidateContent = null;
  let capturedSendMessage = null;

  console.log(`[Agent] Menunggu respons untuk percakapan ${conversationId} (mulai index ${startStepIndex})...`);

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const steps = readTranscript(conversationId);
    if (!steps || steps.length === 0) continue;

    const newSteps = steps.filter(s => typeof s.step_index === 'number' && s.step_index >= startStepIndex);
    if (newSteps.length === 0) continue;

    for (const s of newSteps) {
      if (s.tool_calls && Array.isArray(s.tool_calls)) {
        const smCall = s.tool_calls.find(t => t.name === 'send_message');
        if (smCall?.args?.Message) {
          capturedSendMessage = smCall.args.Message;
        }
      }
    }

    const latest = newSteps[newSteps.length - 1];

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
  }

  if (candidateContent) {
    if (isAgentMetaMessage(candidateContent) && capturedSendMessage) {
      return cleanHumanResponse(capturedSendMessage);
    }
    return cleanHumanResponse(candidateContent);
  }
  if (capturedSendMessage) return cleanHumanResponse(capturedSendMessage);

  throw new Error('Waktu tunggu habis (timeout).');
}

// Eksekusi prompt standalone untuk Cron Job Antigravity
async function executeCronWithAntigravity(taskPrompt) {
  console.log(`[Cron Agent] Membuka sesi eksekusi baru untuk tugas terjadwal...`);
  const fullPrompt = `${SYSTEM_PERSONA}\n\n${taskPrompt}`;

  const { stdout } = await execFileAsync(AGY_PATH, [
    'agentapi',
    'new-conversation',
    '--model=flash',
    fullPrompt
  ]);

  const res = JSON.parse(stdout);
  const convId = res?.response?.newConversation?.conversationId;
  if (!convId) throw new Error('Gagal inisialisasi percakapan Antigravity');

  const responseText = await waitForAgentResponse(convId, 1);
  return responseText;
}

// Eksekusi prompt percakapan dengan Antigravity CLI
let isProcessing = false;
let lastSeenStepIndex = 0;
let lastTargetRecipient = null;

async function executeWithAntigravity(userPrompt, targetRecipient, senderName, senderNumber, isGroup, isOwner) {
  if (isProcessing) {
    console.log('[Agent] Joko sedang memproses tugas lain, permintaan diantrekan...');
    return;
  }

  isProcessing = true;
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

    let promptContext = '';
    if (isGroup) {
      const recentGroupHistory = getRecentGroupHistory(targetRecipient, 25);
      const historyText = recentGroupHistory.length > 0
        ? `\n[Riwayat Percakapan Terakhir di Grup WhatsApp ini]:\n${recentGroupHistory.map(m => `• [${m.time}] ${m.senderName}: "${m.message}"`).join('\n')}\n\n`
        : '';

      if (isOwner) {
        promptContext = `${historyText}${tjContext}[Pesan di Grup WhatsApp dari Mas Andika]: "${userPrompt}"\n(PENTING: Jawab langsung di grup secara ramah, santai, dan solutif. Jika Mas Andika bertanya mengenai konteks atau rangkuman obrolan grup, manfaatkan [Riwayat Percakapan Terakhir] di atas untuk menjawab secara akurat dan nyambung. Langsung berikan SATU respon/rekomendasi terbaik tanpa opsi pilihan ganda. JANGAN PERNAH gunakan tool schedule atau send_message).`;
      } else {
        promptContext = `${historyText}${tjContext}[Pesan di Grup WhatsApp dari ${senderName}]: "${userPrompt}"\n(PENTING: Jawab pertanyaan atau diskusi ${senderName} secara ramah dan solutif. Jika pengguna bertanya mengenai konteks atau obrolan grup, manfaatkan [Riwayat Percakapan Terakhir] di atas untuk menjawab secara cerdas dan akurat. Langsung berikan SATU rekomendasi terbaik tanpa opsi pilihan ganda. Namun JANGAN jalankan perintah yang memodifikasi/menghapus file lokal di komputer untuk pengguna ini. JANGAN PERNAH gunakan tool schedule atau send_message).`;
      }
    } else {
      promptContext = `${tjContext}[Chat Pribadi WhatsApp dari Mas Andika]: "${userPrompt}"\n(PENTING: Jawab langsung secara santai, ramah, dan manusiawi sebagai Joko. Langsung berikan SATU rekomendasi jawaban/ucapan terbaik tanpa memberikan opsi pilihan ganda. JANGAN gunakan tool send_message, JANGAN gunakan tool schedule, dan JANGAN ada pesan meta internal agen).`;
    }

    if (!activeConversationId) {
      console.log(`[Agent] Membuka sesi baru Joko untuk ${senderName}: "${userPrompt}"`);
      const fullPrompt = `${SYSTEM_PERSONA}\n\n${promptContext}`;

      const { stdout } = await execFileAsync(AGY_PATH, [
        'agentapi',
        'new-conversation',
        '--model=flash',
        fullPrompt
      ]);

      const res = JSON.parse(stdout);
      activeConversationId = res?.response?.newConversation?.conversationId;
      if (!activeConversationId) {
        throw new Error(`Gagal mendapatkan conversationId dari agy: ${stdout}`);
      }
      saveSession(activeConversationId);
      startStepIndex = 1;
    } else {
      console.log(`[Agent] Mengirim chat ke sesi ${activeConversationId}: "${userPrompt}"`);
      const currentSteps = readTranscript(activeConversationId);
      startStepIndex = currentSteps.length > 0 ? (currentSteps[currentSteps.length - 1].step_index + 1) : 0;

      await execFileAsync(AGY_PATH, [
        'agentapi',
        'send-message',
        activeConversationId,
        promptContext
      ]);
    }

    let responseText = await waitForAgentResponse(activeConversationId, startStepIndex);
    console.log(`[Agent] ✅ Respon Joko diterima (${responseText.length} karakter).`);

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

    await sendWhatsApp(targetRecipient, responseText);

  } catch (err) {
    console.error('[Agent] ❌ Error:', err.message);
    await sendWhatsApp(targetRecipient, `Waduh Mas, ada kendala saat Joko memproses chat ini: ${err.message}`);
  } finally {
    isProcessing = false;
  }
}

// Setup HTTP Server Webhook
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    const jokoState = getJokoState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'active',
      name: 'Joko (Personal AI Assistant)',
      mode: jokoState.isAsleep ? 'SLEEP (Tidur)' : 'AWAKE (Aktif)',
      port: PORT,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: true }));

      try {
        let payload = {};
        if (req.headers['content-type']?.includes('application/json')) {
          payload = JSON.parse(body || '{}');
        } else {
          const params = new URLSearchParams(body);
          payload = Object.fromEntries(params.entries());
        }

        const rawSender = String(payload.sender || payload.phone || '').trim();
        const rawMember = String(payload.member || '').trim();
        const rawMessage = (payload.message || payload.text || '').trim();
        const senderName = payload.name || 'Teman';

        if (!rawMessage || !rawSender) return;

        if (isOurOwnMessage(rawMessage)) {
          return;
        }

        const isGroup = rawSender.endsWith('@g.us') || rawSender.includes('@g.us');
        const targetRecipient = rawSender;

        const senderNumber = (isGroup && rawMember ? rawMember : rawSender).replace(/[^0-9]/g, '');
        const isOwner = AUTHORIZED_TARGETS.has(senderNumber);

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
          if (!isOwner) {
            console.log(`[Security] ⛔ Chat pribadi dari ${senderNumber} ditolak (bukan Owner).`);
            return;
          }

          // Bersihkan awalan nama "Joko" jika pengguna mengetiknya di chat pribadi
          userPrompt = rawMessage.replace(/^(!joko|joko|!bot|!ai|@bot)\b\s*[:,-]?\s*/i, '').trim() || rawMessage;
          console.log(`[Private Webhook] Dari ${senderName} (${senderNumber}): "${userPrompt}"`);
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

*Tanya Jawab & Coding:*
• Chat langsung untuk tanya-jawab, diskusi, atau minta buatkan skrip di laptop.

*Kontrol Tidur / Bangun:*
• *"Joko lu bisa tidur"* : Joko istirahat / off
• *"Joko bantu dong"* : Joko bangun / on

*Pengingat & Cron Job:*
• \`ingatkan saya 10 menit lagi untuk cek server\`
• \`jadwalkan setiap hari jam 08:00 selamat pagi\`
• \`/jadwal\` : Melihat daftar jadwal aktif
• \`/baru\` : Reset sesi obrolan Joko`);
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
        console.error('[Webhook] Error payload:', err.message);
      }
    });
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

// Jalankan HTTP Server, Cron Engine, dan Cloudflare Tunnel
server.listen(PORT, '0.0.0.0', async () => {
  loadGroupHistory();
  startTJTracker();
  const curState = getJokoState();
  console.log(`====================================================`);
  console.log(`🚀 Asisten WhatsApp "JOKO" aktif di port ${PORT}`);
  console.log(`📱 Owner Whitelist: ${Array.from(AUTHORIZED_TARGETS).join(', ')}`);
  console.log(`💤 Status Awal: ${curState.isAsleep ? 'TIDUR (Sleep Mode)' : 'BANGUN (Awake Mode)'}`);
  console.log(`🗣️ Panggilan Nama: "Joko", "!joko", "Joko bantu dong", "Joko lu bisa tidur"`);
  console.log(`====================================================`);

  // Sinkronkan daftar grup Fonnte saat startup
  await syncFonnteGroups();

  // Mulai Engine Cron Scheduler
  startCronScheduler(async (job) => {
    console.log(`[Cron Trigger] ⏰ Menjalankan jadwal "${job.title}" (${job.id}) ke ${job.target}`);

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
        text = `⏰ *Colekan dari Joko!*\n\nHalo ${displayName}! Pengingat untuk:\n👉 *${job.payload}*\n\nYuk siap-siap meeting-nya! 💼✨`;
      } else {
        text = `⏰ *Colekan dari Joko!*\n\nHalo ${displayName}! Udah waktunya untuk:\n👉 *${job.payload}*\n\n_Semoga urusannya lancar ya!_ ✨`;
      }

      await sendWhatsApp(job.target, text);
    }
  });

  // Background Transcript Safety Net
  // Memantau jika ada pesan MODEL yang muncul di transcript di luar webhook aktif
  function startTranscriptWatcher() {
    const session = getSavedSession();
    if (session) {
      const steps = readTranscript(session);
      if (steps.length > 0) {
        lastSeenStepIndex = steps[steps.length - 1].step_index;
      }
    }

    setInterval(async () => {
      if (isProcessing) return;
      const session = getSavedSession();
      if (!session) return;

      try {
        const steps = readTranscript(session);
        if (!steps || steps.length === 0) return;

        const unseen = steps.filter(s => typeof s.step_index === 'number' && s.step_index > lastSeenStepIndex);
        if (unseen.length === 0) return;

        for (const step of unseen) {
          if (typeof step.step_index === 'number' && step.step_index > lastSeenStepIndex) {
            lastSeenStepIndex = step.step_index;
          }

          if (
            step.source === 'MODEL' &&
            step.type === 'PLANNER_RESPONSE' &&
            step.status === 'DONE' &&
            step.content &&
            typeof step.content === 'string' &&
            step.content.trim().length > 0 &&
            (!step.tool_calls || step.tool_calls.length === 0)
          ) {
            const content = cleanHumanResponse(step.content);
            if (content && !isOurOwnMessage(content)) {
              const target = lastTargetRecipient || Array.from(AUTHORIZED_TARGETS)[0];
              console.log(`[Transcript Watcher] 🔔 Menangkap pesan asinkron tak terduga (step ${step.step_index}), meneruskan ke ${target}...`);
              await sendWhatsApp(target, content);
            }
          }
        }
      } catch (err) {
        // Abaikan error pembacaan transcript
      }
    }, 5000);
  }

  startTranscriptWatcher();

  // Mulai Cloudflare Tunnel dengan fitur Auto-Reconnect
  let activeTunnel = null;
  let isShuttingDown = false;

  function startTunnel() {
    if (isShuttingDown || !fs.existsSync(CLOUDFLARED_PATH)) {
      if (!fs.existsSync(CLOUDFLARED_PATH)) {
        console.warn(`[Tunnel] ⚠️ cloudflared.exe tidak ditemukan di ${CLOUDFLARED_PATH}.`);
      }
      return;
    }

    console.log('[Tunnel] Memulai Cloudflare Tunnel...');
    activeTunnel = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', `http://127.0.0.1:${PORT}`]);
    let tunnelRegistered = false;

    activeTunnel.stderr.on('data', async data => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !tunnelRegistered) {
        tunnelRegistered = true;
        const tunnelUrl = match[0];
        console.log(`\n🎉 TUNNEL URL BERHASIL DIBUAT: ${tunnelUrl}\n`);
        await updateFonnteWebhook(tunnelUrl);
      }
    });

    activeTunnel.on('close', code => {
      console.log(`[Tunnel] Cloudflare tunnel berhenti dengan kode ${code}.`);
      if (!isShuttingDown) {
        console.log('[Tunnel] Memulai ulang tunnel dalam 3 detik...');
        setTimeout(startTunnel, 3000);
      }
    });
  }

  startTunnel();

  const cleanup = () => {
    isShuttingDown = true;
    try { if (activeTunnel) activeTunnel.kill(); } catch {}
  };

  process.on('SIGINT', () => { cleanup(); process.exit(); });
  process.on('SIGTERM', () => { cleanup(); process.exit(); });
});
