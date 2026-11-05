#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.PORT || '8795', 10);
const FONNTE_TOKEN = process.env.FONNTE_TOKEN?.trim() || 'HUw3Ny3R4EaW1jHua4ki';
const DEVICE_NUMBER = process.env.FONNTE_DEVICE?.trim() || '6282163850914';
const DEVICE_NAME = 'Andika';
const AGY_PATH = 'C:\\Users\\andik\\.gemini\\bin\\agy.exe';
const BRAIN_DIR = 'C:\\Users\\andik\\.gemini\\antigravity\\brain';
const CLOUDFLARED_PATH = path.join(process.cwd(), 'cloudflared.exe');
const SESSION_FILE = path.join(process.cwd(), '.wa-assistant-session.json');

// Nomor WhatsApp yang diizinkan mengontrol Antigravity
const AUTHORIZED_TARGETS = new Set([
  '6282163850914',
  '082163850914',
  ...(process.env.AUTHORIZED_TARGETS ? process.env.AUTHORIZED_TARGETS.split(',').map(s => s.trim()) : [])
]);

// Anti loop hash tracker
const sentMessageHashes = new Set();
function markSent(msg) {
  if (!msg) return;
  const snippet = msg.slice(0, 60);
  sentMessageHashes.add(snippet);
  setTimeout(() => sentMessageHashes.delete(snippet), 120000);
}

function isOurOwnMessage(msg) {
  if (!msg) return false;
  const prefixes = ['🤖', '⏳', '🚀', '🔔', '🔄', '📋', '🟢', '⚠️'];
  if (prefixes.some(p => msg.startsWith(p))) return true;
  return sentMessageHashes.has(msg.slice(0, 60));
}

// Format teks markdown agar rapi di WhatsApp
function formatForWhatsApp(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '*$1*') // Bold
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*') // Headers to bold
    .trim();
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

// Kirim pesan ke WhatsApp via Fonnte
async function sendWhatsApp(target, message) {
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
      console.log(`[WA] ✅ Pesan terkirim ke ${target}`);
      return true;
    } else {
      console.error(`[WA] ⚠️ Gagal kirim ke ${target}:`, data.reason || JSON.stringify(data));
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
      quick: 'true'
    });

    const res = await fetch('https://api.fonnte.com/update-device', {
      method: 'POST',
      headers: { 'Authorization': FONNTE_TOKEN },
      body: params
    });

    const data = await res.json();
    if (data.status) {
      console.log(`[Fonnte API] ✅ Webhook berhasil diperbarui di Fonnte: ${webhookUrl}`);
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

// Tunggu hingga Antigravity selesai mengeksekusi dan memberikan balasan akhir
async function waitForAgentResponse(conversationId, startStepIndex = 0, maxWaitMs = 180000) {
  const pollInterval = 1500;
  const startTime = Date.now();
  let candidateStepIndex = -1;
  let candidateContent = null;

  console.log(`[Agent] Menunggu eksekusi untuk percakapan ${conversationId} (mulai index ${startStepIndex})...`);

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const steps = readTranscript(conversationId);
    if (!steps || steps.length === 0) continue;

    const newSteps = steps.filter(s => typeof s.step_index === 'number' && s.step_index >= startStepIndex);
    if (newSteps.length === 0) continue;

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
        return latest.content.trim();
      } else {
        candidateStepIndex = latest.step_index;
        candidateContent = latest.content.trim();
        continue;
      }
    }
  }

  if (candidateContent) return candidateContent;
  throw new Error('Timeout 3 menit: Agen Antigravity masih sibuk atau belum selesai.');
}

// Eksekusi prompt dengan Antigravity CLI
let isProcessing = false;

async function executeWithAntigravity(userPrompt, sender) {
  if (isProcessing) {
    await sendWhatsApp(sender, '⏳ *Antigravity sedang menyelesaikan tugas sebelumnya, mohon tunggu sebentar...*');
    return;
  }

  isProcessing = true;
  let activeConversationId = getSavedSession();

  try {
    let startStepIndex = 0;

    if (!activeConversationId) {
      console.log(`[Agent] Membuka percakapan baru dengan prompt: "${userPrompt}"`);
      const { stdout } = await execFileAsync(AGY_PATH, [
        'agentapi',
        'new-conversation',
        '--model=flash',
        userPrompt
      ]);

      const res = JSON.parse(stdout);
      activeConversationId = res?.response?.newConversation?.conversationId;
      if (!activeConversationId) {
        throw new Error(`Gagal mendapatkan conversationId dari agy: ${stdout}`);
      }
      saveSession(activeConversationId);
      startStepIndex = 1;
    } else {
      console.log(`[Agent] Mengirim pesan ke sesi ${activeConversationId}: "${userPrompt}"`);
      const currentSteps = readTranscript(activeConversationId);
      startStepIndex = currentSteps.length > 0 ? (currentSteps[currentSteps.length - 1].step_index + 1) : 0;

      await execFileAsync(AGY_PATH, [
        'agentapi',
        'send-message',
        activeConversationId,
        userPrompt
      ]);
    }

    const responseText = await waitForAgentResponse(activeConversationId, startStepIndex);
    console.log(`[Agent] ✅ Respon diterima (${responseText.length} karakter).`);

    const formatted = formatForWhatsApp(responseText);
    const replyMessage = `🤖 *Antigravity Agent:*\n\n${formatted}`;
    await sendWhatsApp(sender, replyMessage);

  } catch (err) {
    console.error('[Agent] ❌ Error:', err.message);
    await sendWhatsApp(sender, `⚠️ *Terjadi kendala saat memproses instruksi:*\n${err.message}`);
  } finally {
    isProcessing = false;
  }
}

// Setup HTTP Server Webhook
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'active',
      service: 'Antigravity WhatsApp Assistant',
      conversationId: getSavedSession(),
      port: PORT,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // Balas HTTP 200 segera ke Fonnte
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

        const sender = (payload.sender || payload.phone || '').replace(/[^0-9]/g, '');
        const senderName = payload.name || 'Pengguna';
        const rawMessage = (payload.message || payload.text || '').trim();

        if (!rawMessage || !sender) return;

        // Abaikan jika pesan berasal dari bot sendiri
        if (isOurOwnMessage(rawMessage)) {
          return;
        }

        console.log(`[Webhook] Pesan masuk dari ${senderName} (${sender}): "${rawMessage}"`);

        // Validasi keamanan nomor pengirim
        if (!AUTHORIZED_TARGETS.has(sender)) {
          console.log(`[Security] ⛔ Pengirim ${sender} tidak ada dalam daftar yang diizinkan.`);
          return;
        }

        const lowerMsg = rawMessage.toLowerCase();

        if (lowerMsg === '/bantuan' || lowerMsg === '/help') {
          await sendWhatsApp(sender, `📋 *BANTUAN ASISTEN ANTIGRAVITY*

Kirim pesan apapun untuk meminta asisten melakukan tugas di PC Anda, misalnya:
• _"Buatkan script python untuk kalkulator"_
• _"Periksa status git di proyek saat ini"_
• _"Cek kesehatan sistem kantor agent"_
• _"Buatkan file halo.txt di folder repo"_

*Perintah Khusus:*
• */status* : Cek status server & sesi aktif
• */baru* atau */reset* : Mulai percakapan sesi baru
• */bantuan* : Menampilkan menu ini`);
          return;
        }

        if (lowerMsg === '/status') {
          const curId = getSavedSession() || 'Belum ada sesi aktif';
          await sendWhatsApp(sender, `🟢 *Status Asisten Antigravity*
• Server: Online (Port ${PORT})
• Sesi Aktif: \`${curId}\`
• Status Eksekusi: ${isProcessing ? '⏳ Sedang Bekerja' : '✅ Siaga'}`);
          return;
        }

        if (lowerMsg === '/baru' || lowerMsg === '/reset') {
          if (fs.existsSync(SESSION_FILE)) {
            fs.unlinkSync(SESSION_FILE);
          }
          await sendWhatsApp(sender, `🔄 *Sesi Antigravity telah di-reset.*\nPesan berikutnya akan membuka percakapan sesi baru.`);
          return;
        }

        // Beri tanda terima ke pengguna
        await sendWhatsApp(sender, `⏳ *Menerima perintah:* "${rawMessage.slice(0, 60)}${rawMessage.length > 60 ? '...' : ''}"\n_Antigravity sedang mengeksekusi..._`);

        // Jalankan instruksi ke Antigravity
        executeWithAntigravity(rawMessage, sender).catch(err => {
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

// Jalankan HTTP Server & Cloudflare Tunnel
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`====================================================`);
  console.log(`🚀 Antigravity WhatsApp Assistant Server aktif di port ${PORT}`);
  console.log(`📱 Mengizinkan pengirim: ${Array.from(AUTHORIZED_TARGETS).join(', ')}`);
  console.log(`🤖 Model: Flash via Antigravity CLI (agy.exe)`);
  console.log(`====================================================`);

  // Mulai Cloudflare Tunnel
  if (fs.existsSync(CLOUDFLARED_PATH)) {
    console.log('[Tunnel] Memulai Cloudflare Tunnel...');
    const tunnel = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', `http://127.0.0.1:${PORT}`]);

    let tunnelRegistered = false;

    tunnel.stderr.on('data', async data => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !tunnelRegistered) {
        tunnelRegistered = true;
        const tunnelUrl = match[0];
        console.log(`\n🎉 TUNNEL URL BERHASIL DIBUAT: ${tunnelUrl}\n`);

        // Update Webhook Fonnte secara otomatis!
        const success = await updateFonnteWebhook(tunnelUrl);
        if (success) {
          // Kirim notifikasi sambutan ke WhatsApp Andika
          const welcomeMsg = `🚀 *Antigravity WhatsApp Assistant Siap!*

Halo Pak Andika! Asisten pribadi Antigravity Anda telah aktif dan terhubung ke komputer Anda.

Silakan kirimkan perintah atau pertanyaan langsung di chat ini untuk dieksekusi oleh Antigravity.

*Contoh Perintah:*
1. _"Periksa git status repo ini"_
2. _"Buatkan file teks bernama info.txt dengan isi Halo Dunia"_
3. _"Jelaskan fungsi proyek kantor-agent"_

Ketik */bantuan* untuk bantuan lebih lanjut.`;
          await sendWhatsApp(DEVICE_NUMBER, welcomeMsg);
        }
      }
    });

    tunnel.on('close', code => {
      console.log(`[Tunnel] Cloudflare tunnel berhenti dengan kode ${code}`);
    });

    const cleanup = () => {
      try { tunnel.kill(); } catch {}
      process.exit();
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);

  } else {
    console.warn(`[Tunnel] ⚠️ cloudflared.exe tidak ditemukan di ${CLOUDFLARED_PATH}. Jalankan tunnel secara manual.`);
  }
});
