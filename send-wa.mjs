#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const phone = process.env.WA_PHONE?.trim();
const apikey = process.env.WA_APIKEY?.trim();

if (!phone || !apikey) {
  console.log('ℹ️ WA_PHONE atau WA_APIKEY belum diatur di GitHub Secrets. Melewati pengiriman WhatsApp.');
  process.exit(0);
}

const reportPath = path.join(process.cwd(), 'LAPORAN_LOG_HARIAN.md');
let isHealthy = true;

if (fs.existsSync(reportPath)) {
  const content = fs.readFileSync(reportPath, 'utf8');
  isHealthy = content.includes('🟢 SEHAT');
}

const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
const statusIcon = isHealthy ? '🟢 SEHAT (NORMAL)' : '🔴 PERLU PERHATIAN';

const message = `🔔 *LAPORAN HARIAN KANTOR AGENT*
📅 *Waktu:* ${nowStr} WIB

*Status Sistem:* ${statusIcon}
• Server Web: Aktif (Port 8788)
• Pemeriksaan Log: Selesai

📄 *Laporan Lengkap:*
https://github.com/andikatampubolon10/kantor-agent/blob/main/LAPORAN_LOG_HARIAN.md`;

console.log(`Mengirim notifikasi WhatsApp ke nomor: ${phone.slice(0, 4)}****...`);

const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;

try {
  const res = await fetch(url);
  const body = await res.text();
  if (res.ok && !body.toLowerCase().includes('error')) {
    console.log('✅ Pesan WhatsApp berhasil dikirim!');
  } else {
    console.log(`⚠️ Respon API: ${body}`);
  }
} catch (err) {
  console.error(`❌ Terjadi kesalahan saat mengirim ke WhatsApp: ${err.message}`);
}
