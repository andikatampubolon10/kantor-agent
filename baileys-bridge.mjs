/**
 * Baileys WhatsApp Multi-Device Direct Bridge for Joko
 * Menggunakan @whiskeysockets/baileys untuk koneksi WebSocket langsung ke Meta WhatsApp.
 * Aman dari blokir gateway shared-IP, tanpa gateway pihak ketiga, dan bebas auto-read centang biru.
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { pipeline } from 'node:stream/promises';
import { extractMediaInfo } from './media-input.mjs';
import { extractQuotedInfo } from './reply-context.mjs';

let baileysModule = null;
let makeWASocket = null;
let useMultiFileAuthState = null;
let DisconnectReason = null;
let fetchLatestBaileysVersion = null;
let Browsers = null;
let normalizeMessageContent = null;
let downloadMediaMessage = null;
let proto = null;

let sock = null;
let isConnecting = false;
// Status koneksi NYATA dari event connection.update. sock.user tetap terisi walau
// koneksi putus (diambil dari kredensial), jadi tidak bisa dipakai sebagai tanda "siap".
let isOpen = false;
let messageHandler = null;
const sentMessageIds = new Set();
// ID pesan yang dikirim Joko, disimpan lebih lama (maks. 2000) agar reply ke jawaban
// Joko bisa dikenali sebagai "jawaban Joko sebelumnya" (Joko mengirim dari akun owner).
const jokoMessageIds = new Set();
function rememberJokoMessage(id) {
  if (!id) return;
  jokoMessageIds.add(id);
  if (jokoMessageIds.size > 2000) jokoMessageIds.delete(jokoMessageIds.values().next().value);
}
const processedIncomingMessageIds = new Set();

// Berhenti rapi: jangan reconnect lagi, dan tunggu penyimpanan kredensial terakhir selesai.
let shuttingDown = false;
let pendingCredsSave = Promise.resolve();

// Pemantau kesehatan sesi. Sesi enkripsi yang rusak tidak memutus koneksi: pesan tetap
// datang tapi gagal didekripsi (stub CIPHERTEXT). Catat agar terlihat di log & /status.
const HEALTH_WINDOW_MS = 10 * 60 * 1000;
const HEALTH_WARN_COUNT = 5;
const health = { lastInboundAt: 0, lastDecryptFailAt: 0, decryptFailures: [] };
let lastHealthWarnAt = 0;
function noteDecryptFailure() {
  const now = Date.now();
  health.lastDecryptFailAt = now;
  health.decryptFailures = health.decryptFailures.filter(t => now - t < HEALTH_WINDOW_MS);
  health.decryptFailures.push(now);
  const recent = health.decryptFailures.length;
  if (recent >= HEALTH_WARN_COUNT && health.lastInboundAt < now - HEALTH_WINDOW_MS && now - lastHealthWarnAt > HEALTH_WINDOW_MS) {
    lastHealthWarnAt = now;
    console.warn(`[Baileys] 🚨 ${recent} pesan gagal didekripsi dalam 10 menit tanpa satu pun pesan yang berhasil dibaca. Sesi enkripsi kemungkinan rusak; bila berlanjut, tautkan ulang lewat http://127.0.0.1:8795/tautkan.`);
  }
}
function sessionLooksBroken() {
  const now = Date.now();
  const recent = health.decryptFailures.filter(t => now - t < HEALTH_WINDOW_MS).length;
  return recent >= HEALTH_WARN_COUNT && health.lastInboundAt < now - HEALTH_WINDOW_MS;
}

/** Nomor HP (bukan LID) bila WhatsApp menyertakannya; LID tidak cocok dengan daftar nomor. */
function preferPn(jid, alt) {
  return (jid && jid.endsWith('@lid') && alt) ? alt : jid;
}

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

// Info penautan terkini (kode pairing + QR mentah) untuk halaman lokal /tautkan.
// Kode & QR hanya berlaku selama socket yang membuatnya masih hidup.
let pairingInfo = { code: null, codeAt: 0, qr: null, qrAt: 0 };
export function getPairingInfo() {
  return { ...pairingInfo };
}
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
    downloadMediaMessage = baileysModule.downloadMediaMessage;
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
      // Hanya galat Baileys yang dicatat (mis. "failed to decrypt message"); set
      // BAILEYS_LOG_LEVEL=warn/debug untuk diagnosis lebih rinci, atau silent untuk mematikan.
      logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' }),
      printQRInTerminal: isPairMethodQR,
      browser: browserIdentity,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false, // Tidak memaksa status online konstan
      // Perpanjang umur setiap ref QR (bawaan 60 detik lalu 20 detik). Kode pairing hanya
      // berlaku selama socket ini hidup; dengan bawaan, socket ditutup (408) sebelum
      // pengguna sempat memasukkan kode.
      qrTimeout: 120000,
      // Handler getMessage untuk menyelesaikan "Menunggu pesan ini" saat WhatsApp meminta dekripsi retry.
      // Pesan yang tidak ada di cache dikembalikan undefined: mengirim ulang pesan kosong
      // hanya mengganti "Menunggu pesan ini" dengan gelembung kosong.
      getMessage: async (key) => (key?.id ? messageCache.get(key.id) : undefined)
    });
    sock = thisSock;

    // Penyimpanan kredensial bisa bentrok dengan penghapusan folder sesi saat logout (ENOENT);
    // tangkap supaya tidak menjadi unhandled rejection.
    sock.ev.on('creds.update', () => {
      pendingCredsSave = pendingCredsSave
        .then(() => saveCreds())
        .catch(err => console.warn('[Baileys] Gagal menyimpan kredensial:', err.message));
    });
    pairingInfo = { code: null, codeAt: 0, qr: null, qrAt: 0 };

    // Minta Pairing Code HANYA bila sesi benar-benar belum tertaut. Baileys mengisi
    // creds.registered hanya pada penautan lewat KODE; penautan lewat scan QR hanya mengisi
    // creds.me. Meminta kode untuk sesi yang sudah tertaut (setelah restart 515) menimpa
    // creds.me dan membuat WhatsApp mengeluarkan perangkat (401).
    const isLinked = (creds) => !!(creds?.registered || creds?.me?.id);
    if (!isLinked(sock.authState.creds)) {
      if (isPairMethodQR) {
        console.log('[Baileys] 📷 Mode QR Code aktif. Silakan scan QR code di layar terminal...');
      } else {
        let cleanPhone = ownerNumber.replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
        if (cleanPhone.startsWith('8')) cleanPhone = '62' + cleanPhone;

        console.log(`[Baileys] ⏳ Belum terhubung ke akun WhatsApp. Menyiapkan Pairing Code untuk ${cleanPhone}...`);

        setTimeout(async () => {
          try {
            // Socket bisa sudah diganti / sudah tertaut lewat QR dalam 3 detik ini.
            if (sock && thisSock === sock && !isLinked(sock.authState.creds)) {
              const rawCode = await sock.requestPairingCode(cleanPhone);
              const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
              
              fs.writeFileSync(PAIRING_FILE, formattedCode, 'utf8');
              if (thisSock === sock) pairingInfo = { ...pairingInfo, code: formattedCode, codeAt: Date.now() };

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
      if (qr && thisSock === sock) pairingInfo = { ...pairingInfo, qr, qrAt: Date.now() };
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
        pairingInfo = { code: null, codeAt: 0, qr: null, qrAt: 0 }; // kode/QR socket ini tidak berlaku lagi
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;

        if (shuttingDown) {
          console.log('[Baileys] Koneksi ditutup (Joko berhenti).');
          return;
        }

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
        pairingInfo = { code: null, codeAt: 0, qr: null, qrAt: 0 };
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
        if (!m.message) {
          // messageStubType 2 = CIPHERTEXT: pesan gagal didekripsi. Baileys otomatis meminta
          // pengirim mengirim ulang (retry receipt); catat agar kegagalan tidak senyap.
          if (m.messageStubType === 2) {
            noteDecryptFailure();
            const params = (m.messageStubParameters || []).join(' | ').slice(0, 120);
            console.warn(`[Baileys] 🔐 Pesan gagal didekripsi dari ${m.key?.remoteJid}${m.key?.participant ? ` (peserta ${m.key.participant})` : ''}, fromMe=${!!m.key?.fromMe}, id=${m.key?.id}${params ? ` — ${params}` : ''}. Menunggu kiriman ulang dari WhatsApp.`);
          }
          continue;
        }

        // Simpan setiap payload pesan (masuk & keluar) ke cache agar dapat di-lookup saat WhatsApp meminta retry receipt (E2EE Signal Protocol)
        if (m.key?.id) {
          storeMessage(m.key.id, m.message);
        }

        // Cegah looping pesan: Jika pesan ini dikirim oleh bot Joko sendiri via sendMessage API, lewati
        if (m.key?.id && sentMessageIds.has(m.key.id)) continue;

        // Pesan dari pihak lain berhasil didekripsi: sesi enkripsi sehat.
        health.lastInboundAt = Date.now();

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
          if (type === 'notify') {
            console.log(`[Baileys] ⏭️ Pesan lama dilewati (${Math.round((Date.now() / 1000) - msgTimeSec)} detik) dari ${m.key?.remoteJid}, fromMe=${!!m.key?.fromMe}, id=${m.key?.id}.`);
          }
          // Tetap disimpan ke cache di atas untuk dekripsi, tapi jangan dieksekusi ulang sebagai perintah baru
          continue;
        }

        const rawRemoteJid = m.key.remoteJid;
        // Status, siaran, dan saluran WhatsApp (Channel/@newsletter) bukan percakapan untuk Joko.
        if (!rawRemoteJid || rawRemoteJid.endsWith('@broadcast') || rawRemoteJid.endsWith('@newsletter')) continue;

        // Tangani pemetaan LID WhatsApp jika remoteJid berformat @lid
        const remoteJid = preferPn(rawRemoteJid, m.key.remoteJidAlt);

        const isGroup = remoteJid.endsWith('@g.us');
        const myJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : '6282163850914@s.whatsapp.net';

        // Tentukan identitas pengirim:
        // PENTING: Jika m.key.fromMe bernilai true, berarti pesan diketik langsung oleh Mas Andika dari HP pribadinya!
        let senderJid = remoteJid;
        if (isGroup) {
          // Baileys 7: peserta grup bisa berupa LID; nomor HP-nya ada di participantAlt.
          senderJid = preferPn(m.key.participant, m.key.participantAlt) || (m.key.fromMe ? myJid : remoteJid);
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

        // Gambar / voice note. Belum diunduh di sini: unduhan hanya terjadi bila
        // router memutuskan pesan ini memang untuk Joko (lihat media.download()).
        const mediaInfo = extractMediaInfo(msgContent);
        if ((!rawText || !rawText.trim()) && !mediaInfo) continue;

        const media = mediaInfo ? {
          ...mediaInfo,
          download: () => downloadMediaMessage(m, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: thisSock.updateMediaMessage
          }),
          // Video/rekaman besar: alirkan langsung ke file (tidak ditampung utuh di RAM).
          downloadToFile: async (file, maxBytes) => {
            const stream = await downloadMediaMessage(m, 'stream', {}, {
              logger: pino({ level: 'silent' }),
              reuploadRequest: thisSock.updateMediaMessage
            });
            let total = 0;
            if (maxBytes) stream.on('data', (c) => { total += c.length; if (total > maxBytes) stream.destroy(new Error('Ukuran file melebihi batas.')); });
            await pipeline(stream, fs.createWriteStream(file));
            return total;
          }
        } : null;

        // Chat dengan diri sendiri ("Message yourself"): pesan dari HP Mas Andika ke nomornya sendiri.
        const ownLid = sock.user?.lid ? (sock.user.lid.split(':')[0] + '@lid') : null;
        const isSelfChat = !isGroup && !!m.key?.fromMe && (remoteJid === myJid || (!!ownLid && rawRemoteJid === ownLid));

        // Pesan yang dibalas (reply/quote). Medianya juga diunduh lazily, hanya bila diperlukan.
        const quotedInfo = extractQuotedInfo(msgContent, { ownJids: [myJid, ownLid], jokoMessageIds });
        const quoted = quotedInfo ? {
          text: quotedInfo.text,
          author: quotedInfo.author,
          media: quotedInfo.media ? {
            ...quotedInfo.media,
            download: () => downloadMediaMessage({
              key: { remoteJid: rawRemoteJid, id: quotedInfo.stanzaId, fromMe: quotedInfo.author !== 'other', participant: quotedInfo.participant || undefined },
              message: quotedInfo.message
            }, 'buffer', {}, {
              logger: pino({ level: 'silent' }),
              reuploadRequest: thisSock.updateMediaMessage
            })
          } : null
        } : null;

        console.log(`[Baileys Inbound] 📩 [${type}] Dari ${senderName} (${senderNumber}, fromMe: ${!!m.key?.fromMe}${isSelfChat ? ', self' : ''})${media ? ` [${media.kind}${media.ptt ? '/ptt' : ''}${media.isForwarded ? '/fwd' : ''}]` : ''}${quoted ? ` [reply→${quoted.author}${quoted.media ? `/${quoted.media.kind}` : ''}]` : ''}: "${rawText.slice(0, 70)}"`);

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
              isSelfChat,
              media,
              quoted,
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
  console.log(`[Baileys Outbox] 📤 Mengirim ke ${recipient} (${messageText.length} karakter)...`);
  return sendRegistered(recipient, { text: messageText });
}

/**
 * Kirim file: kind 'image' | 'audio' | 'document'.
 * @param {{buffer:Buffer, kind:string, mimetype:string, fileName:string, caption?:string}} file
 */
export async function sendBaileysFile(recipient, { buffer, kind, mimetype, fileName, caption = '' }) {
  let content;
  if (kind === 'image') content = { image: buffer, mimetype, caption: caption || undefined };
  else if (kind === 'audio') content = { audio: buffer, mimetype, ptt: false };
  else content = { document: buffer, mimetype, fileName, caption: caption || undefined };
  console.log(`[Baileys Outbox] 📎 Mengirim ${kind} "${fileName}" (${Math.round(buffer.length / 1024)} KB) ke ${recipient}...`);
  return sendRegistered(recipient, content);
}

async function sendRegistered(recipient, content) {
  if (!sock || !isOpen) {
    throw new Error('Koneksi WhatsApp Baileys belum siap.');
  }

  const jid = formatToJid(recipient);
  if (!jid) {
    throw new Error('JID penerima tidak valid.');
  }

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
    rememberJokoMessage(preId);
    setTimeout(() => sentMessageIds.delete(preId), 300000);
  }

  const sent = await sock.sendMessage(jid, content, preId ? { messageId: preId } : undefined);
  if (sent?.key?.id) {
    if (sent.message) {
      storeMessage(sent.key.id, sent.message);
    }
    sentMessageIds.add(sent.key.id);
    rememberJokoMessage(sent.key.id);
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
    isConnecting,
    sessionHealthy: !sessionLooksBroken(),
    lastInboundAt: health.lastInboundAt || null,
    lastDecryptFailAt: health.lastDecryptFailAt || null
  };
}

/**
 * Tutup koneksi dengan rapi: hentikan reconnect, tunggu kredensial & kunci sesi
 * terakhir tersimpan, lalu tutup WebSocket. Dipanggil sebelum proses Joko keluar.
 */
export async function closeBaileys(timeoutMs = 4000) {
  shuttingDown = true;
  const s = sock;
  isOpen = false;
  const work = (async () => {
    await pendingCredsSave;
    try { s?.end(undefined); } catch {}
  })();
  await Promise.race([work, new Promise(r => setTimeout(r, timeoutMs))]);
}


// Nama grup (subject) untuk panel admin; di-cache 1 jam, gagal/terputus -> null.
const groupSubjectCache = new Map();
export async function getGroupSubject(jid, timeoutMs = 4000) {
  if (!String(jid).endsWith('@g.us')) return null;
  const hit = groupSubjectCache.get(jid);
  if (hit && Date.now() - hit.at < 3600000) return hit.subject;
  if (!sock || !isOpen) return hit?.subject ?? null;
  try {
    const meta = await Promise.race([sock.groupMetadata(jid), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    const subject = meta?.subject ? String(meta.subject).slice(0, 100) : null;
    groupSubjectCache.set(jid, { subject, at: Date.now() });
    return subject;
  } catch {
    return hit?.subject ?? null;
  }
}
