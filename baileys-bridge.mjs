/**
 * Baileys WhatsApp Multi-Device Direct Bridge for Joko
 * Menggunakan @whiskeysockets/baileys untuk koneksi WebSocket langsung ke Meta WhatsApp.
 * Aman dari blokir gateway shared-IP, tanpa gateway pihak ketiga, dan bebas auto-read centang biru.
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

let baileysModule = null;
let makeWASocket = null;
let useMultiFileAuthState = null;
let DisconnectReason = null;
let fetchLatestBaileysVersion = null;
let Browsers = null;
let normalizeMessageContent = null;
let proto = null;

let sock = null;
let isConnecting = false;
// Status koneksi NYATA dari event connection.update. sock.user tetap terisi walau
// koneksi putus (diambil dari kredensial), jadi tidak bisa dipakai sebagai tanda "siap".
let isOpen = false;
let messageHandler = null;
const sentMessageIds = new Set();
const processedIncomingMessageIds = new Set();

// Cache pesan in-memory untuk menangani retry receipt E2EE WhatsApp (Signal Protocol)
// Menyelesaikan masalah "Menunggu pesan ini" pada perangkat mobile
const messageCache = new Map();
const MAX_MESSAGE_CACHE = 5000;

function storeMessage(keyId, message) {
  if (!keyId || !message) return;
  if (messageCache.size >= MAX_MESSAGE_CACHE) {
    const firstKey = messageCache.keys().next().value;
    messageCache.delete(firstKey);
  }
  messageCache.set(keyId, message);
}

const AUTH_FOLDER = path.join(process.cwd(), 'baileys_auth_info');
const PAIRING_FILE = path.join(process.cwd(), 'pairing-code.txt');
const DEFAULT_OWNER_NUMBER = '6282163850914';

/**
 * Format nomor telepon standar WhatsApp JID
 * Contoh: 082163850914 -> 6282163850914@s.whatsapp.net
 * Membersihkan device suffix seperti :12@s.whatsapp.net -> @s.whatsapp.net
 */
export function formatToJid(recipient) {
  if (!recipient) return '';
  let clean = String(recipient).replace(/:\d+@/, '@');
  if (clean.endsWith('@s.whatsapp.net') || clean.endsWith('@g.us') || clean.endsWith('@lid')) {
    return clean;
  }
  let digits = clean.replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }
  return `${digits}@s.whatsapp.net`;
}

/**
 * Inisialisasi koneksi Baileys
 */
export async function initBaileys({ onMessage, ownerNumber = DEFAULT_OWNER_NUMBER }) {
  messageHandler = onMessage;

  // Import dinamis agar tidak error jika package belum terinstall saat parsing
  try {
    baileysModule = await import('@whiskeysockets/baileys');
    makeWASocket = baileysModule.default || baileysModule.makeWASocket;
    useMultiFileAuthState = baileysModule.useMultiFileAuthState;
    DisconnectReason = baileysModule.DisconnectReason;
    fetchLatestBaileysVersion = baileysModule.fetchLatestBaileysVersion;
    Browsers = baileysModule.Browsers;
    normalizeMessageContent = baileysModule.normalizeMessageContent;
    proto = baileysModule.proto;
  } catch (err) {
    console.error('[Baileys] ❌ Gagal memuat @whiskeysockets/baileys:', err.message);
    console.warn('[Baileys] Pastikan sudah menjalankan "npm install" di server.');
    return false;
  }

  if (isConnecting) return false;
  isConnecting = true;

  try {
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    let version = [2, 3000, 1015901307];
    try {
      if (fetchLatestBaileysVersion) {
        const vInfo = await fetchLatestBaileysVersion();
        if (vInfo?.version) version = vInfo.version;
      }
    } catch {
      // fallback versi default
    }

    console.log(`[Baileys] 🌐 Memulai koneksi WhatsApp Multi-Device (v${version.join('.')})...`);

    const isPairMethodQR = process.env.WA_PAIR_METHOD === 'qr';
    // Gunakan canonical Ubuntu Chrome browser signature resmi Meta agar kode pairing dan handshake diterima
    const browserIdentity = (Browsers && typeof Browsers.ubuntu === 'function')
      ? Browsers.ubuntu('Chrome')
      : ['Ubuntu', 'Chrome', '22.04.4'];

    isOpen = false;
    const thisSock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }), // Heningkan log verbose internal pino
      printQRInTerminal: isPairMethodQR,
      browser: browserIdentity,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false, // Tidak memaksa status online konstan
      // Handler getMessage untuk menyelesaikan "Menunggu pesan ini" saat WhatsApp meminta dekripsi retry
      getMessage: async (key) => {
        if (key?.id && messageCache.has(key.id)) {
          return messageCache.get(key.id);
        }
        return proto?.Message?.fromObject({}) || undefined;
      }
    });
    sock = thisSock;

    sock.ev.on('creds.update', saveCreds);

    // Minta Pairing Code jika belum terdaftar dan tidak dalam mode QR
    if (!sock.authState.creds.registered) {
      if (isPairMethodQR) {
        console.log('[Baileys] 📷 Mode QR Code aktif. Silakan scan QR code di layar terminal...');
      } else {
        let cleanPhone = ownerNumber.replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
        if (cleanPhone.startsWith('8')) cleanPhone = '62' + cleanPhone;

        console.log(`[Baileys] ⏳ Belum terhubung ke akun WhatsApp. Menyiapkan Pairing Code untuk ${cleanPhone}...`);

        setTimeout(async () => {
          try {
            if (sock && !sock.authState.creds.registered) {
              const rawCode = await sock.requestPairingCode(cleanPhone);
              const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
              
              fs.writeFileSync(PAIRING_FILE, formattedCode, 'utf8');

              console.log('\n====================================================');
              console.log('🔑 KODE TAUTAN WHATSAPP MAS ANDIKA (PAIRING CODE):');
              console.log(`               👉  ${formattedCode}  👈`);
              console.log('----------------------------------------------------');
              console.log('Langkah Menghubungkan di HP Mas Andika:');
              console.log('1. Buka WhatsApp > Setelan (Settings) > Perangkat Tertaut.');
              console.log('2. Pilih "Tautkan Perangkat".');
              console.log('3. Ketuk "Tautkan dengan nomor telepon saja" di bagian bawah.');
              console.log(`4. Masukkan kode 8 karakter di atas: ${formattedCode}`);
              console.log('====================================================\n');
            }
          } catch (pairErr) {
            console.error('[Baileys] ❌ Gagal meminta pairing code:', pairErr.message);
          }
        }, 3000);
      }
    }

    // Tangani Lifecycle Koneksi
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Tangkap QR Code jika tersedia
      if (qr) {
        try {
          const qrcode = (await import('qrcode-terminal')).default || (await import('qrcode-terminal'));
          qrcode.generate(qr, { small: true }, (asciiQr) => {
            fs.writeFileSync(path.join(process.cwd(), 'wa-qr.txt'), asciiQr, 'utf8');
          });
        } catch {}
      }

      // Abaikan event dari socket lama yang sudah digantikan
      if (thisSock !== sock) return;

      if (connection === 'close') {
        isConnecting = false;
        isOpen = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;

        console.log(`[Baileys] ⚠️ Koneksi terputus (Status: ${statusCode || 'Unknown'}). Reconnect: ${shouldReconnect}`);

        if (statusCode === DisconnectReason?.loggedOut) {
          console.warn('[Baileys] 🛑 Sesi telah dikeluarkan dari HP. Menghapus sesi lama...');
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          } catch {}
          setTimeout(() => initBaileys({ onMessage: messageHandler, ownerNumber }), 3000);
        } else if (shouldReconnect) {
          console.log('[Baileys] 🔄 Menyambungkan ulang ke server WhatsApp Meta...');
          setTimeout(() => initBaileys({ onMessage: messageHandler, ownerNumber }), 3000);
        }
      } else if (connection === 'open') {
        isConnecting = false;
        isOpen = true;
        console.log('====================================================');
        console.log('🚀 Asisten WhatsApp JOKO AKTIF & TERHUBUNG VIA BAILEYS!');
        console.log(`📱 Nomor Tersambung: ${sock.user?.id?.split(':')[0] || 'Unknown'}`);
        console.log('🔒 Enkripsi: End-to-End Direct WebSocket (Tanpa Pihak Ketiga)');
        console.log('====================================================');
        try {
          if (fs.existsSync(PAIRING_FILE)) fs.unlinkSync(PAIRING_FILE);
          const qrFile = path.join(process.cwd(), 'wa-qr.txt');
          if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
        } catch {}
      }
    });

    // Tangani Pesan Masuk (messages.upsert)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Terima baik event notify maupun append (sync dari HP utama/companion)
      if (type !== 'notify' && type !== 'append') return;

      for (const m of messages) {
        if (!m.message) continue;

        // Simpan setiap payload pesan (masuk & keluar) ke cache agar dapat di-lookup saat WhatsApp meminta retry receipt (E2EE Signal Protocol)
        if (m.key?.id) {
          storeMessage(m.key.id, m.message);
        }

        // Cegah looping pesan: Jika pesan ini dikirim oleh bot Joko sendiri via sendMessage API, lewati
        if (m.key?.id && sentMessageIds.has(m.key.id)) continue;

        // Cegah pemrosesan duplikat: Jika ID pesan ini sudah pernah diproses (misal event notify + append), lewati
        if (m.key?.id) {
          if (processedIncomingMessageIds.has(m.key.id)) {
            continue;
          }
          processedIncomingMessageIds.add(m.key.id);
          setTimeout(() => processedIncomingMessageIds.delete(m.key.id), 300000);
        }

        // Cegah eksekusi pesan basi/historis dari sync WhatsApp (lebih dari 3 menit lalu)
        const msgTimeSec = typeof m.messageTimestamp === 'object' ? (m.messageTimestamp.low || 0) : Number(m.messageTimestamp || 0);
        if (msgTimeSec > 0 && ((Date.now() / 1000) - msgTimeSec > 180)) {
          // Tetap disimpan ke cache di atas untuk dekripsi, tapi jangan dieksekusi ulang sebagai perintah baru
          continue;
        }

        const rawRemoteJid = m.key.remoteJid;
        if (!rawRemoteJid || rawRemoteJid === 'status@broadcast') continue;

        // Tangani pemetaan LID WhatsApp jika remoteJid berformat @lid
        const remoteJid = (rawRemoteJid.endsWith('@lid') && m.key.remoteJidAlt) ? m.key.remoteJidAlt : rawRemoteJid;

        const isGroup = remoteJid.endsWith('@g.us');
        const myJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : '6282163850914@s.whatsapp.net';

        // Tentukan identitas pengirim:
        // PENTING: Jika m.key.fromMe bernilai true, berarti pesan diketik langsung oleh Mas Andika dari HP pribadinya!
        let senderJid = remoteJid;
        if (isGroup) {
          senderJid = m.key.participant || (m.key.fromMe ? myJid : remoteJid);
        } else if (m.key.fromMe) {
          senderJid = myJid;
        }

        // Jangan pernah jatuh ke nomor owner: pengirim tak dikenal harus tetap tak dikenal.
        const senderNumber = senderJid ? senderJid.replace(/[^0-9]/g, '') : '';
        const senderName = m.pushName || (m.key.fromMe ? 'Mas Andika' : (isGroup ? 'Anggota Grup' : 'Pengguna'));

        // Gunakan normalizeMessageContent resmi Baileys untuk unwrap seluruh layer pembungkus
        let msgContent = m.message;
        if (normalizeMessageContent && typeof normalizeMessageContent === 'function') {
          try {
            msgContent = normalizeMessageContent(m.message) || m.message;
          } catch {}
        }
        if (msgContent?.ephemeralMessage) msgContent = msgContent.ephemeralMessage.message;
        if (msgContent?.viewOnceMessage) msgContent = msgContent.viewOnceMessage.message;
        if (msgContent?.viewOnceMessageV2) msgContent = msgContent.viewOnceMessageV2.message;
        if (msgContent?.documentWithCaptionMessage) msgContent = msgContent.documentWithCaptionMessage.message;

        const rawText = 
          msgContent.conversation ||
          msgContent.extendedTextMessage?.text ||
          msgContent.imageMessage?.caption ||
          msgContent.videoMessage?.caption ||
          msgContent.documentMessage?.caption ||
          '';

        if (!rawText || !rawText.trim()) continue;

        console.log(`[Baileys Inbound] 📩 [${type}] Dari ${senderName} (${senderNumber}, fromMe: ${!!m.key?.fromMe}): "${rawText.slice(0, 70)}"`);

        // PENTING: Kami TIDAK memanggil sock.readMessages([m.key])
        // Ini menjamin WhatsApp Mas Andika TIDAK PERNAH auto-read (centang biru) secara sepihak!

        if (typeof messageHandler === 'function') {
          try {
            await messageHandler({
              rawMessage: rawText.trim(),
              targetRecipient: remoteJid,
              senderName,
              senderNumber,
              isGroup,
              isFromMe: !!m.key?.fromMe,
              msgKey: m.key
            });
          } catch (handlerErr) {
            console.error('[Baileys Dispatcher] Error processing message:', handlerErr.message);
          }
        }
      }
    });

    return true;

  } catch (err) {
    isConnecting = false;
    console.error('[Baileys] Error inisialisasi:', err.message);
    return false;
  }
}

/**
 * Kirim pesan WhatsApp langsung via Baileys
 * @param {string} recipient Nomor HP atau JID WhatsApp
 * @param {string} messageText Teks pesan
 */
export async function sendBaileysMessage(recipient, messageText) {
  if (!sock || !isOpen) {
    throw new Error('Koneksi WhatsApp Baileys belum siap.');
  }

  const jid = formatToJid(recipient);
  if (!jid) {
    throw new Error('JID penerima tidak valid.');
  }

  console.log(`[Baileys Outbox] 📤 Mengirim ke ${jid} (${messageText.length} karakter)...`);

  // Daftarkan ID pesan SEBELUM dikirim. Balasan Joko terkirim dari akun Mas Andika
  // (fromMe = owner), dan Baileys memancarkan event upsert untuk pesan keluar sebelum
  // sendMessage() selesai. Tanpa pra-registrasi, balasan Joko bisa terbaca sebagai
  // perintah owner baru. (sendMessage meneruskan options.messageId ke generateWAMessage.)
  let preId = null;
  try {
    preId = typeof baileysModule?.generateMessageIDV2 === 'function'
      ? baileysModule.generateMessageIDV2(sock.user?.id)
      : (typeof baileysModule?.generateMessageID === 'function' ? baileysModule.generateMessageID() : null);
  } catch {
    preId = null;
  }
  if (preId) {
    sentMessageIds.add(preId);
    setTimeout(() => sentMessageIds.delete(preId), 300000);
  }

  const sent = await sock.sendMessage(jid, { text: messageText }, preId ? { messageId: preId } : undefined);
  if (sent?.key?.id) {
    if (sent.message) {
      storeMessage(sent.key.id, sent.message);
    }
    sentMessageIds.add(sent.key.id);
    setTimeout(() => sentMessageIds.delete(sent.key.id), 300000);
  }
  return { success: true, messageId: sent?.key?.id };
}

/**
 * Status koneksi Baileys saat ini
 */
export function getBaileysStatus() {
  return {
    ready: !!(sock && isOpen && sock.user),
    user: sock?.user || null,
    isConnecting
  };
}

