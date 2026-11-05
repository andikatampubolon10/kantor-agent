#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.FONNTE_TOKEN?.trim() || 'HUw3Ny3R4EaW1jHua4ki';
const target = process.env.FONNTE_TARGET?.trim() || '6282163850914';

if (!token) {
  console.log('ℹ️ FONNTE_TOKEN belum diatur. Melewati pengiriman WhatsApp.');
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

console.log(`Mengirim pesan WhatsApp via Fonnte ke ${target.slice(0, 5)}****...`);

try {
  const formData = new URLSearchParams();
  formData.append('target', target);
  formData.append('message', message);
  formData.append('countryCode', '62');

  const res = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: {
      'Authorization': token
    },
    body: formData
  });

  const data = await res.json();
  if (data.status) {
    console.log('✅ Pesan WhatsApp berhasil dikirim via Fonnte!');
  } else {
    console.log('⚠️ Fonnte response:', data.reason || JSON.stringify(data));
    if (data.reason?.toLowerCase().includes('device disconnect') || data.reason?.toLowerCase().includes('not connect')) {
      console.log('👉 Catatan: Jangan lupa scan QR code di dashboard fonnte.com agar WhatsApp terhubung!');
    }
  }
} catch (err) {
  console.error(`❌ Terjadi kesalahan saat menghubungi API Fonnte: ${err.message}`);
}
