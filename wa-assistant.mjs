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

// Persona sistem untuk gaya bahasa manusiawi & natural di WhatsApp
const SYSTEM_PERSONA = `Peran Anda: Anda adalah asisten pribadi dan asisten grup WhatsApp yang cerdas, ramah, dan solutif.
Owner sistem Anda: Andika (nomor 6282163850914).

Prinsip komunikasi:
1. Berbicaralah santai, ramah, sopan, dan natural seperti rekan kerja atau teman diskusi di WhatsApp.
2. Jawab langsung ke inti pertanyaan atau permintaan, tanpa basa-basi robot/agen.
3. JANGAN PERNAH menggunakan tool send_message. Langsung berikan jawaban dalam teks respon akhir Anda.
4. JANGAN PERNAH menyertakan pesan meta atau format robot seperti "Pesan dari agen ... telah dibalas", "Recipient", atau ID teknis sistem.
5. Jika ditanya soal sisa token atau kuota, jelaskan dengan santai bahwa kapasitas konteks obrolan sangat longgar (hingga 1-2 juta token) dan saat ini baru terpakai sangat sedikit. Kuota WhatsApp di Fonnte juga masih aman (~990+ pesan gratis).
6. Di dalam Grup: Anda boleh berdiskusi, membantu coding, atau menjawab pertanyaan dari semua anggota grup secara ramah. Namun, eksekusi perintah sistem di komputer (membuat file, menjalankan terminal) hanya diizinkan jika diminta oleh Owner (Andika).`;

// Nomor WhatsApp Owner yang diizinkan mengontrol Antigravity
const AUTHORIZED_TARGETS = new Set([
  '6282163850914',
  '082163850914',
  ...(process.env.AUTHORIZED_TARGETS ? process.env.AUTHORIZED_TARGETS.split(',').map(s => s.trim()) : [])
]);

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
  // Deteksi watermark Fonnte
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

      // Jika error invalid group id, lakukan sync group list dan coba kirim ulang 1x
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

// Update webhook Fonnte secara otomatis via API (Aktifkan Personal + Quick + Group)
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
      group: 'true' // Mengizinkan penerimaan pesan dari grup WhatsApp
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

    // Periksa jika ada tool_calls send_message
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

// Eksekusi prompt dengan Antigravity CLI
let isProcessing = false;

async function executeWithAntigravity(userPrompt, targetRecipient, senderName, isGroup, isOwner) {
  if (isProcessing) {
    console.log('[Agent] Sedang memproses tugas lain, permintaan diantrekan...');
    return;
  }

  isProcessing = true;
  let activeConversationId = getSavedSession();

  try {
    let startStepIndex = 0;

    // Buat konteks instruksi spesifik
    let promptContext = '';
    if (isGroup) {
      if (isOwner) {
        promptContext = `[Pesan di Grup WhatsApp dari Owner (${senderName})]: "${userPrompt}"\n(PENTING: Jawab langsung ke ${senderName} di grup dengan ramah, santai, dan jelas. Anda boleh mengeksekusi kode atau perintah file jika diminta).`;
      } else {
        promptContext = `[Pesan di Grup WhatsApp dari Anggota Grup (${senderName})]: "${userPrompt}"\n(PENTING: Jawab pertanyaan atau diskusi ${senderName} secara ramah dan solutif. Namun JANGAN jalankan perintah yang memodifikasi/menghapus file lokal di komputer untuk pengguna ini).`;
      }
    } else {
      promptContext = `[Chat Pribadi WhatsApp dari ${senderName}]: "${userPrompt}"\n(PENTING: Jawab langsung secara santai, ramah, dan manusiawi. JANGAN gunakan tool send_message dan JANGAN ada pesan meta internal agen).`;
    }

    if (!activeConversationId) {
      console.log(`[Agent] Membuka sesi baru untuk ${senderName}: "${userPrompt}"`);
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

    const responseText = await waitForAgentResponse(activeConversationId, startStepIndex);
    console.log(`[Agent] ✅ Respon diterima (${responseText.length} karakter).`);

    // Kirim balasan ke target (bisa nomor pribadi atau ID grup)
    await sendWhatsApp(targetRecipient, responseText);

  } catch (err) {
    console.error('[Agent] ❌ Error:', err.message);
    await sendWhatsApp(targetRecipient, `Waduh, ada kendala saat memproses chat ini: ${err.message}`);
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
      service: 'Antigravity WhatsApp Assistant (Personal & Group)',
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

        const rawSender = String(payload.sender || payload.phone || '').trim();
        const rawMember = String(payload.member || '').trim();
        const rawMessage = (payload.message || payload.text || '').trim();
        const senderName = payload.name || 'Teman';

        if (!rawMessage || !rawSender) return;

        // Abaikan jika pesan berasal dari bot sendiri / fonnte footer
        if (isOurOwnMessage(rawMessage)) {
          return;
        }

        // Cek apakah pesan berasal dari grup WhatsApp
        const isGroup = rawSender.endsWith('@g.us') || rawSender.includes('@g.us');
        const targetRecipient = rawSender; // Target kirim balik (ID grup jika di grup, atau nomor jika personal)

        // Nomor pengguna yang sebenarnya mengirim pesan
        const senderNumber = (isGroup && rawMember ? rawMember : rawSender).replace(/[^0-9]/g, '');
        const isOwner = AUTHORIZED_TARGETS.has(senderNumber);

        let userPrompt = rawMessage;

        if (isGroup) {
          // Di grup, hanya respon jika ada trigger: !bot, !ai, @bot
          const triggerMatch = rawMessage.match(/^(!bot|!ai|@bot)\s*(.*)/i);
          if (!triggerMatch) {
            // Bukan untuk bot, abaikan percakapan antar anggota grup
            return;
          }

          userPrompt = triggerMatch[2]?.trim() || '';
          if (!userPrompt) {
            await sendWhatsApp(targetRecipient, `Halo ${senderName}! Mau tanya atau minta bantuan apa? Coba ketik: \`!bot <pertanyaan Anda>\``);
            return;
          }

          console.log(`[Group Webhook] Dari ${senderName} (${senderNumber}) di ${rawSender}: "${userPrompt}"`);

        } else {
          // Di chat pribadi:
          // Validasi keamanan: hanya Owner yang boleh chat pribadi
          if (!isOwner) {
            console.log(`[Security] ⛔ Chat pribadi dari ${senderNumber} ditolak (bukan Owner).`);
            return;
          }

          // Bersihkan awalan !bot jika user iseng mengetiknya di chat pribadi
          userPrompt = rawMessage.replace(/^(!bot|!ai|@bot)\s*/i, '').trim() || rawMessage;
          console.log(`[Private Webhook] Dari ${senderName} (${senderNumber}): "${userPrompt}"`);
        }

        const lowerPrompt = userPrompt.toLowerCase();

        // Perintah Bantuan
        if (lowerPrompt === '/bantuan' || lowerPrompt === 'bantuan' || lowerPrompt === '/help' || lowerPrompt === 'help') {
          if (isGroup) {
            await sendWhatsApp(targetRecipient, `Halo ${senderName}! Saya adalah asisten AI di grup ini.

Cara menggunakan:
• Ketik: \`!bot <pertanyaan/perintah>\` atau \`!ai <pertanyaan>\`
• Contoh: \`!bot buatkan fungsi javascript untuk hitung diskon\`
• Contoh: \`!bot jelaskan perbedaan REST API dan GraphQL\`

Perintah khusus:
• \`!bot status\` : Cek status asisten
• \`!bot bantuan\` : Tampilkan panduan ini`);
          } else {
            await sendWhatsApp(targetRecipient, `Halo Pak Andika! Anda bisa chat santai dengan saya untuk minta bantuan apa saja:
• Tanya jawab umum atau diskusi coding
• Minta buatkan file atau skrip di komputer Anda
• Periksa status server atau proyek

Perintah cepat:
• */status* : Cek status asisten
• */baru* : Mulai percakapan sesi baru
• */bantuan* : Bantuan ini`);
          }
          return;
        }

        // Perintah Status
        if (lowerPrompt === '/status' || lowerPrompt === 'status') {
          const curId = getSavedSession() || 'Belum ada sesi aktif';
          await sendWhatsApp(targetRecipient, `Asisten aktif dan siaga.
Status: ${isProcessing ? 'Sedang memproses tugas' : 'Siap menerima perintah'}
Mode: ${isGroup ? 'Grup WhatsApp' : 'Chat Pribadi'}`);
          return;
        }

        // Perintah Reset (Hanya Owner)
        if (lowerPrompt === '/baru' || lowerPrompt === 'baru' || lowerPrompt === '/reset' || lowerPrompt === 'reset') {
          if (!isOwner) {
            await sendWhatsApp(targetRecipient, `Maaf ${senderName}, hanya Owner yang dapat mereset sesi percakapan.`);
            return;
          }
          if (fs.existsSync(SESSION_FILE)) {
            fs.unlinkSync(SESSION_FILE);
          }
          await sendWhatsApp(targetRecipient, `Sip, sesi percakapan telah di-reset. Kita mulai dari awal lagi ya!`);
          return;
        }

        // Jalankan eksekusi dengan Antigravity
        executeWithAntigravity(userPrompt, targetRecipient, senderName, isGroup, isOwner).catch(err => {
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
  console.log(`📱 Owner Whitelist: ${Array.from(AUTHORIZED_TARGETS).join(', ')}`);
  console.log(`👥 Mode Grup: AKTIF (Trigger: !bot, !ai, @bot)`);
  console.log(`🤖 Model: Gemini Flash via Antigravity CLI`);
  console.log(`====================================================`);

  // Sinkronkan daftar grup Fonnte saat startup
  await syncFonnteGroups();

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

        // Update Webhook Fonnte secara otomatis (personal + quick + group)
        await updateFonnteWebhook(tunnelUrl);
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
    console.warn(`[Tunnel] ⚠️ cloudflared.exe tidak ditemukan di ${CLOUDFLARED_PATH}.`);
  }
});
