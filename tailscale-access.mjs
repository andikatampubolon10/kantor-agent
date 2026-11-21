/**
 * Akses panel admin dari HP lewat Tailscale (jaringan pribadi antar-perangkat Mas Andika).
 * ------------------------------------------------------------
 * `tailscale serve --bg 8795` membuka https://<laptop>.<tailnet>.ts.net/ yang meneruskan ke
 * http://127.0.0.1:8795 — hanya bisa dibuka perangkat yang login ke akun Tailscale yang sama.
 * Server Joko tetap hanya mendengarkan di 127.0.0.1.
 *
 * Modul ini membaca status Tailscale (terpasang? login? nama DNS? panel sudah dibagikan?)
 * agar panel tahu nama host mana yang sah (cek Host/Origin di admin-panel.mjs).
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const CANDIDATES = [
  process.env.TAILSCALE_EXE,
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale'
].filter(Boolean);

function findExe() {
  for (const p of CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch {} }
  return 'tailscale'; // coba dari PATH
}

function run(exe, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? { ok: false, error: err.code === 'ENOENT' ? 'ENOENT' : String(err.message).slice(0, 200) } : { ok: true, stdout: String(stdout) });
    });
  });
}

/** Apakah konfigurasi `tailscale serve` meneruskan ke port panel? */
export function serveTargetsPort(serveJson, port) {
  const text = typeof serveJson === 'string' ? serveJson : JSON.stringify(serveJson || {});
  return new RegExp(`(127\\.0\\.0\\.1|localhost):${port}(?!\\d)`).test(text);
}

export function createTailscaleAccess({ port, refreshMs = 120000 } = {}) {
  let state = { installed: null, running: false, dnsName: null, serving: false, loginName: null, checkedAt: 0, error: null };
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const exe = findExe();
      const st = await run(exe, ['status', '--json']);
      if (!st.ok) {
        state = { ...state, installed: st.error !== 'ENOENT', running: false, dnsName: null, serving: false, checkedAt: Date.now(), error: st.error === 'ENOENT' ? null : st.error };
        return state;
      }
      let j = {};
      try { j = JSON.parse(st.stdout); } catch {}
      const running = j.BackendState === 'Running';
      const dnsName = running && j.Self?.DNSName ? String(j.Self.DNSName).replace(/\.$/, '').toLowerCase() : null;
      const user = j.User && j.Self?.UserID != null ? j.User[j.Self.UserID] : null;
      let serving = false;
      if (running) {
        const sv = await run(exe, ['serve', 'status', '--json']);
        serving = sv.ok && serveTargetsPort(sv.stdout, port);
      }
      state = { installed: true, running, dnsName, serving, loginName: user?.LoginName || null, backend: j.BackendState || null, checkedAt: Date.now(), error: null };
      return state;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  refresh().catch(() => {});
  const timer = setInterval(() => refresh().catch(() => {}), refreshMs);
  timer.unref?.();

  return {
    refresh,
    /** Nama host HTTPS yang boleh membuka panel (kosong bila belum dibagikan). */
    hosts: () => (state.running && state.serving && state.dnsName ? [state.dnsName] : []),
    info() {
      if (Date.now() - state.checkedAt > 10000) refresh().catch(() => {});
      const { installed, running, dnsName, serving, loginName, backend, checkedAt } = state;
      return { installed, running, dnsName, serving, loginName, backend, checkedAt };
    }
  };
}
