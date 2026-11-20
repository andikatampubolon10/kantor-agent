/**
 * Halaman lokal penautan WhatsApp: http://127.0.0.1:8795/tautkan
 * ------------------------------------------------------------
 * Kode pairing & QR Baileys hanya berlaku selama socket yang membuatnya hidup
 * (sekitar 1–2 menit), jadi menyalinnya lewat chat hampir selalu terlambat.
 * Halaman ini menampilkan QR + kode TERBARU dan memperbarui diri tiap 5 detik.
 * Server Joko hanya mendengarkan di 127.0.0.1, jadi halaman ini tidak terbuka ke jaringan.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode/index.js');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** QR sebagai SVG (modul hitam di atas putih, dengan quiet zone 4 modul). */
export function renderQrSvg(text, size = 320) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet},${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR penautan WhatsApp"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/**
 * @param {{ready:boolean, number?:string, code?:string|null, codeAt?:number, qr?:string|null, qrAt?:number, now?:number}} s
 */
export function renderLinkPage(s) {
  const now = s.now ?? Date.now();
  const age = (t) => (t ? `${Math.max(0, Math.round((now - t) / 1000))} detik lalu` : '');
  let body;
  if (s.ready) {
    body = `<div class="ok">✅ WhatsApp Joko sudah <b>terhubung</b>${s.number ? ` sebagai <b>${esc(s.number)}</b>` : ''}.</div>
<p>Halaman ini boleh ditutup.</p>`;
  } else if (!s.qr && !s.code) {
    body = `<div class="wait">⏳ Menyiapkan kode tautan baru… halaman akan diperbarui otomatis.</div>`;
  } else {
    body = `<div class="grid">
  ${s.qr ? `<section>
    <h2>Cara 1 — Scan QR</h2>
    <div class="qr">${renderQrSvg(s.qr)}</div>
    <p class="muted">Dibuat ${age(s.qrAt)}. QR berganti otomatis.</p>
    <ol><li>WhatsApp → <b>Setelan → Perangkat Tertaut</b></li><li>Ketuk <b>Tautkan Perangkat</b></li><li>Arahkan kamera ke QR ini</li></ol>
  </section>` : ''}
  ${s.code ? `<section>
    <h2>Cara 2 — Kode tautan</h2>
    <div class="code">${esc(s.code)}</div>
    <p class="muted">Dibuat ${age(s.codeAt)}. Berlaku selama halaman belum berganti kode.</p>
    <ol><li>WhatsApp → <b>Setelan → Perangkat Tertaut</b></li><li>Ketuk <b>Tautkan Perangkat</b> → <b>Tautkan dengan nomor telepon saja</b></li><li>Masukkan kode di atas</li></ol>
  </section>` : ''}
</div>
<p class="muted">Bila muncul "Gagal menautkan", tunggu halaman menampilkan kode/QR baru lalu coba lagi.</p>`;
  }
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Tautkan WhatsApp Joko</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f6f8; color: #1d2329; margin: 0; padding: 24px 16px; }
  main { max-width: 760px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 16px; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; }
  .qr svg { width: 100%; max-width: 320px; height: auto; border: 1px solid #e3e7eb; }
  .code { font: 700 34px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 3px; padding: 12px 16px; background: #eef7f1; border-radius: 8px; display: inline-block; }
  .ok { font-size: 18px; padding: 16px; background: #eef7f1; border-radius: 8px; }
  .wait { font-size: 16px; padding: 16px; background: #fff7e6; border-radius: 8px; }
  .muted { color: #5f6b76; font-size: 13px; } ol { padding-left: 20px; line-height: 1.6; }
</style></head>
<body><main><h1>Tautkan WhatsApp ke Joko</h1>${body}</main></body></html>`;
}
