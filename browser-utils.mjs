/**
 * Utilitas browser bersama (Puppeteer) untuk Joko.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Cari Chrome/Chromium yang terpasang (Windows laptop & Linux EC2). */
export function getChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    return candidates.find(p => fs.existsSync(p)) || candidates[0];
  }
  const linuxCandidates = [
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];
  return linuxCandidates.find(p => fs.existsSync(p)) || '/snap/bin/chromium';
}

/** true bila sistem punya layar untuk browser non-headless (Windows/macOS, atau Linux dengan DISPLAY). */
export function hasDisplay() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Mutex sederhana berbasis antrean promise. Dipakai untuk profil Chrome Threads agar
 * dua proses Puppeteer tidak membuka userDataDir yang sama bersamaan (Chrome mengunci profil).
 */
export function createMutex() {
  let tail = Promise.resolve();
  return function runExclusive(fn) {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };
}
