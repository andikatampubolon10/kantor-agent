#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const projectDir = fs.realpathSync(process.cwd());
const reportFile = path.join(projectDir, 'LAPORAN_LOG_HARIAN.md');

console.log('=== MEMULAI PEMERIKSAAN LOG HARIAN ===');

const results = {
  timestamp: new Date().toISOString(),
  healthy: true,
  summary: [],
  errors: [],
  warnings: []
};

// Pemeriksaan layanan hanya bermakna bila skrip dijalankan DI MESIN tempat Joko berjalan
// (laptop / EC2). Di runner GitHub Actions tidak ada layanan lokal yang bisa dicek.
const isCI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
const JOKO_PORT = process.env.PORT || '8795';

if (isCI) {
  results.summary.push('ℹ️ Dijalankan di CI: pemeriksaan layanan lokal (Joko & Kantor) dilewati. Jalankan `node check-logs.mjs` di server Joko untuk cek nyata.');
} else {
  // 1. Periksa Joko (asisten WhatsApp) — layanan utama
  try {
    const res = await fetch(`http://127.0.0.1:${JOKO_PORT}/`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    results.summary.push(`✅ Joko aktif di port ${JOKO_PORT} — mode: ${data.mode || '-'}`);
    if (data.baileys && !/CONNECTED/i.test(data.baileys)) {
      results.healthy = false;
      results.errors.push(`❌ WhatsApp Joko belum terhubung (status: ${data.baileys}). Cek pairing Baileys.`);
    } else if (data.baileys) {
      results.summary.push(`✅ WhatsApp Joko: ${data.baileys}`);
    }
  } catch (err) {
    results.healthy = false;
    results.errors.push(`❌ Joko tidak dapat dihubungi di port ${JOKO_PORT}: ${err.message}`);
  }

  // 2. Periksa Server Kantor Agent (opsional — dashboard 3D, hanya peringatan)
  try {
    const res = await fetch('http://127.0.0.1:8788/kerja/api/ping', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      results.summary.push(`✅ Server Kantor Agent: Aktif (${data.runtime || 'node'} pada port 8788)`);
    } else {
      results.warnings.push(`Server Kantor Agent mengembalikan status HTTP ${res.status}`);
    }
  } catch {
    results.summary.push('ℹ️ Server Kantor Agent (dashboard 3D) tidak berjalan — opsional.');
  }
}

// 3. Periksa file log di direktori task / cache
const home = process.env.USERPROFILE || process.env.HOME || '';
const brainDir = path.join(home, '.gemini', 'antigravity', 'brain');

function scanLogFiles(dir, maxFiles = 10) {
  if (!fs.existsSync(dir)) return [];
  const logs = [];
  const findIn = (curr) => {
    try {
      const items = fs.readdirSync(curr, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(curr, item.name);
        if (item.isDirectory() && !item.name.startsWith('.')) {
          findIn(full);
        } else if (item.isFile() && item.name.endsWith('.log')) {
          logs.push(full);
        }
      }
    } catch {}
  };
  findIn(dir);
  return logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, maxFiles);
}

const recentLogs = scanLogFiles(brainDir, 10);
results.summary.push(`🔍 Memeriksa ${recentLogs.length} file log sistem terbaru...`);

for (const logPath of recentLogs) {
  const logName = path.basename(logPath);
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (/error|exception|fail|fatal|eacces|eaddrinuse/i.test(line)) {
        if (!line.includes('[check.mjs]') && !line.includes('display_errors')) {
          results.warnings.push(`[${logName}] ${line.trim().slice(0, 160)}`);
        }
      }
    }
  } catch (e) {
    results.warnings.push(`Gagal membaca ${logName}: ${e.message}`);
  }
}

// 4. Susun Laporan Markdown
const reportMarkdown = `# Laporan Pemeriksaan Log Harian
**Waktu Pemeriksaan:** ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB  
**Status Keseluruhan:** ${isCI ? '⚪ DILEWATI (dijalankan di CI, bukan di server Joko)' : (results.healthy && results.errors.length === 0 ? '🟢 SEHAT (HEALTHY)' : '🔴 PERLU PERHATIAN')}

## Ringkasan Layanan
${results.summary.map(s => `- ${s}`).join('\n')}

## Temuan Masalah & Error
${results.errors.length ? results.errors.map(e => `- ${e}`).join('\n') : '✅ Tidak ada error kritis pada layanan server.'}

## Catatan & Peringatan Log Terbaru
${results.warnings.length ? results.warnings.slice(0, 8).map(w => `- \`${w}\``).join('\n') : '✅ Tidak ditemukan catatan error atau warning yang mencurigakan.'}

---
*Laporan ini dihasilkan otomatis oleh cron job harian (Daily Log Error Check).*
`;

fs.writeFileSync(reportFile, reportMarkdown, 'utf8');
console.log(`✔ Laporan berhasil dibuat: ${reportFile}`);
console.log('\n' + reportMarkdown);

