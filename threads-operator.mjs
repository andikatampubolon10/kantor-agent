/**
 * Threads & Web Automation Operator for Joko
 * Menggunakan puppeteer-core dengan Chrome lokal di komputer Mas Andika.
 * Profile browser disimpan di .chrome-threads-profile agar login tersimpan permanen.
 */
import path from 'node:path';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { getChromePath, hasDisplay, createMutex } from './browser-utils.mjs';

const CHROME_PATH = getChromePath();
const USER_DATA_DIR = path.join(process.cwd(), '.chrome-threads-profile');

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-blink-features=AutomationControlled'
];

// Pastikan direktori profil browser ada
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

// Chrome mengunci userDataDir: semua pemakaian profil Threads dijalankan bergiliran.
const runWithThreadsProfile = createMutex();
const LOGIN_WINDOW_MAX_MS = 10 * 60 * 1000;
let loginSessionActive = false;

/**
 * Buka browser Chrome terlihat (GUI) agar Mas Andika bisa login sekali ke Threads.
 * Jendela otomatis ditutup begitu login terdeteksi (cookie sessionid) atau setelah
 * 10 menit, supaya profil tidak terkunci selamanya dan posting berikutnya tidak gagal.
 * Fungsi ini tidak menunggu proses login selesai.
 */
export async function openThreadsLogin() {
  if (!hasDisplay()) {
    throw new Error('Server ini tidak punya layar (headless). Gunakan perintah "Joko session threads <sessionid>" untuk login di server.');
  }
  if (loginSessionActive) {
    return { success: true, message: 'Jendela login Threads sudah terbuka.' };
  }
  loginSessionActive = true;

  runWithThreadsProfile(async () => {
    console.log('[Threads Operator] Membuka Chrome untuk login akun Threads...');
    let browser = null;
    try {
      browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: false,
        userDataDir: USER_DATA_DIR,
        defaultViewport: null,
        args: ['--start-maximized']
      });
      const page = (await browser.pages())[0] || (await browser.newPage());
      await page.goto('https://www.threads.net/login', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      console.log('[Threads Operator] Silakan login di jendela Chrome yang terbuka (maks. 10 menit).');

      const deadline = Date.now() + LOGIN_WINDOW_MAX_MS;
      while (Date.now() < deadline && browser.connected) {
        await new Promise(r => setTimeout(r, 5000));
        const cookies = await (typeof browser.cookies === 'function'
          ? browser.cookies()
          : page.cookies('https://www.threads.net')).catch(() => []);
        if (cookies.some(c => c.name === 'sessionid' && c.value && /threads\.(net|com)$/i.test(String(c.domain || '').replace(/^\./, '')))) {
          console.log('[Threads Operator] ✅ Login Threads terdeteksi. Menyimpan sesi dan menutup browser...');
          await new Promise(r => setTimeout(r, 3000));
          break;
        }
      }
    } catch (err) {
      console.error('[Threads Operator] Error sesi login:', err.message);
    } finally {
      if (browser) await browser.close().catch(() => {});
      loginSessionActive = false;
    }
  }).catch(() => { loginSessionActive = false; });

  return { success: true, message: 'Browser login Threads telah dibuka.' };
}

/** Cek apakah browser sudah dalam kondisi login di Threads. */
export function checkThreadsLogin() {
  return runWithThreadsProfile(() => checkThreadsLoginUnlocked());
}

/** Posting ke Threads (bergiliran dengan pemakaian profil lain). */
export function postToThreads(content) {
  return runWithThreadsProfile(() => postToThreadsUnlocked(content));
}

export function saveSessionIdCookie(sessionid) {
  const cleanId = (sessionid || '').trim();
  if (!cleanId) throw new Error('Session ID tidak boleh kosong.');
  const cookies = [
    {
      name: 'sessionid',
      value: cleanId,
      domain: '.threads.net',
      path: '/',
      secure: true,
      httpOnly: true
    },
    {
      name: 'sessionid',
      value: cleanId,
      domain: '.instagram.com',
      path: '/',
      secure: true,
      httpOnly: true
    }
  ];
  fs.writeFileSync(path.join(process.cwd(), 'threads-cookies.json'), JSON.stringify(cookies, null, 2));
  return true;
}

async function injectSavedCookies(page) {
  const cookiesPath = path.join(process.cwd(), 'threads-cookies.json');
  if (fs.existsSync(cookiesPath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        console.log(`[Threads Operator] 🍪 Menyuntikkan ${cookies.length} cookies session ke browser...`);
        const validCookies = cookies.filter(c => c.name && c.value);
        
        // Gandakan cookies untuk semua domain Meta Threads & Instagram agar otentikasi 100% tembus
        const targetDomains = ['.threads.net', 'www.threads.net', '.threads.com', 'www.threads.com', '.instagram.com'];
        const expandedCookies = [];
        
        for (const c of validCookies) {
          for (const d of targetDomains) {
            expandedCookies.push({
              name: c.name,
              value: c.value,
              domain: d,
              path: '/',
              secure: true,
              httpOnly: c.httpOnly ?? true,
              sameSite: 'None'
            });
          }
        }
        
        await page.setCookie(...expandedCookies);
        console.log(`[Threads Operator] ✅ Berhasil menyuntikkan ${expandedCookies.length} cookie domain variants.`);
      }
    } catch (cErr) {
      console.warn('[Threads Operator] Gagal membaca cookies:', cErr.message);
    }
  }
}

/**
 * Cek apakah browser sudah dalam kondisi login di Threads
 */
async function checkThreadsLoginUnlocked() {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      userDataDir: USER_DATA_DIR,
      args: PUPPETEER_ARGS
    });

    const page = await browser.newPage();
    await injectSavedCookies(page);
    await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2', timeout: 30000 });

    const isLoggedIn = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const hasLoginText = text.includes('Log in with Instagram') || text.includes('Masuk dengan Instagram');
      const hasProfile = !!document.querySelector('a[href^="/@"], svg[aria-label*="Profile" i], svg[aria-label*="Profil" i]');
      return !hasLoginText || hasProfile;
    });

    return { isLoggedIn };
  } catch (err) {
    console.error('[Threads Operator] Error cek login:', err.message);
    return { isLoggedIn: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Otomatisasi posting konten ke Threads dengan verifikasi ketat
 * @param {string} content Teks utas / postingan
 */
async function postToThreadsUnlocked(content) {
  if (!content || !content.trim()) {
    throw new Error('Konten thread tidak boleh kosong.');
  }

  let cleanContent = content.trim();
  // Batas maksimal single post di Threads adalah 500 karakter.
  // Jika konten melebihi 500 karakter, tombol Post akan otomatis terkunci (disabled) oleh Threads.
  if (cleanContent.length > 500) {
    console.warn(`[Threads Operator] ⚠️ Konten melebihi batas 500 karakter Threads (${cleanContent.length} karakter). Memotong otomatis ke batas aman...`);
    let truncated = cleanContent.slice(0, 485);
    const lastPunctuation = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf('!'), truncated.lastIndexOf('?'), truncated.lastIndexOf('\n'));
    if (lastPunctuation > 300) {
      truncated = truncated.slice(0, lastPunctuation + 1);
    } else {
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > 350) truncated = truncated.slice(0, lastSpace) + '...';
    }
    cleanContent = truncated.trim();
    console.log(`[Threads Operator] Konten disesuaikan menjadi ${cleanContent.length} karakter.`);
  }

  console.log(`[Threads Operator] Memulai proses posting ke Threads (${cleanContent.length} karakter)...`);
  let browser = null;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true, // Berjalan di latar belakang
      userDataDir: USER_DATA_DIR,
      args: PUPPETEER_ARGS
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    // Atur user agent agar menyerupai browser normal
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await injectSavedCookies(page);

    // 1. Buka Threads
    console.log('[Threads Operator] Membuka https://www.threads.net/...');
    await page.goto('https://www.threads.net/', { waitUntil: 'networkidle2', timeout: 45000 });

    // 2. Periksa status otentikasi halaman
    const authCheck = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const hasLoginText = bodyText.includes('Log in with Instagram') || bodyText.includes('Masuk dengan Instagram');
      const hasProfileLink = !!document.querySelector('a[href^="/@"], svg[aria-label*="Profile" i], svg[aria-label*="Profil" i]');
      return { hasLoginText, hasProfileLink, url: window.location.href };
    });

    console.log('[Threads Operator] Status Autentikasi:', JSON.stringify(authCheck));

    if (authCheck.hasLoginText && !authCheck.hasProfileLink) {
      await page.screenshot({ path: path.join(process.cwd(), 'threads-debug-not-logged-in.png') });
      throw new Error('Sesi akun Threads tidak aktif di server. Cookie login ditolak atau kedaluwarsa.');
    }

    // 3. Buka Composer postingan
    console.log('[Threads Operator] Mencari tombol pembuka composer...');
    let composerOpened = await page.evaluate(() => {
      // 1. Cek tombol navigasi Create
      const navCreate = document.querySelector('svg[aria-label="Create"], svg[aria-label="Buat"], a[href*="/intent/post"]');
      if (navCreate) {
        const target = navCreate.closest('a, button, div[role="button"]') || navCreate;
        target.click();
        return true;
      }
      
      // 2. Cek composer bar di atas feed
      const allButtons = Array.from(document.querySelectorAll('div[role="button"], button'));
      const feedBox = allButtons.find(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t.includes("what's new") || t.includes("ada kabar apa") || t.includes("start a thread") || t === "new thread" || t === "utas baru";
      });
      if (feedBox) {
        feedBox.click();
        return true;
      }
      
      return false;
    });

    if (!composerOpened) {
      console.log('[Threads Operator] Membuka composer via URL intent/post...');
      await page.goto(`https://www.threads.net/intent/post?text=${encodeURIComponent(cleanContent)}`, { waitUntil: 'networkidle2', timeout: 30000 });
    }

    // 4. Tunggu editor siap
    console.log('[Threads Operator] Menunggu editor aktif...');
    const editorSelector = 'div[contenteditable="true"], [role="textbox"], [data-lexical-editor="true"]';
    await page.waitForSelector(editorSelector, { timeout: 20000 });
    const editor = await page.$(editorSelector);

    if (!editor) {
      await page.screenshot({ path: path.join(process.cwd(), 'threads-debug-no-editor.png') });
      throw new Error('Gagal menemukan area editor postingan Threads.');
    }

    // 5. Fokus dan isi konten ke editor Lexical
    console.log('[Threads Operator] Mengisi konten ke editor...');
    await editor.click();
    await new Promise(r => setTimeout(r, 400));

    // Bersihkan isi lama jika ada
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 200));

    // Masukkan teks via document.execCommand (menghasilkan native beforeinput & input events untuk Lexical)
    await page.evaluate((text) => {
      document.execCommand('insertText', false, text);
    }, cleanContent);

    // Cek apakah teks sudah masuk
    const enteredLen = await page.evaluate(el => (el.innerText || '').trim().length, editor);
    if (enteredLen < 5) {
      console.log('[Threads Operator] Fallback: Mengetik manual via keyboard...');
      await page.keyboard.type(cleanContent, { delay: 10 });
    }

    // Pemicu input event tambahan agar state React 100% sinkron
    await page.keyboard.type(' ');
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 1500));

    // 6. Cari tombol Post yang aktif (enabled)
    console.log('[Threads Operator] Mencari tombol Post yang aktif...');
    let buttonInfo = null;

    for (let attempt = 1; attempt <= 10; attempt++) {
      buttonInfo = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]') || document.body;
        const buttons = Array.from(dialog.querySelectorAll('div[role="button"], button'));
        
        const matches = buttons.filter(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          return t === 'post' || t === 'posting' || t === 'kirim';
        });

        if (matches.length === 0) return null;

        const enabledBtn = matches.find(b => {
          const ariaDisabled = b.getAttribute('aria-disabled');
          const hasDisabledAttr = b.hasAttribute('disabled');
          return ariaDisabled !== 'true' && !hasDisabledAttr;
        });

        const target = enabledBtn || matches[matches.length - 1];
        return {
          found: true,
          text: (target.innerText || '').trim(),
          ariaDisabled: target.getAttribute('aria-disabled'),
          disabled: target.hasAttribute('disabled'),
          isEnabled: target.getAttribute('aria-disabled') !== 'true' && !target.hasAttribute('disabled')
        };
      });

      if (buttonInfo && buttonInfo.isEnabled) {
        console.log(`[Threads Operator] Tombol Post aktif terdeteksi pada percobaan ${attempt}!`);
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('[Threads Operator] Status tombol Post akhir:', JSON.stringify(buttonInfo));

    const postBtnHandle = await page.evaluateHandle(() => {
      const dialog = document.querySelector('div[role="dialog"]') || document.body;
      const buttons = Array.from(dialog.querySelectorAll('div[role="button"], button'));
      const matches = buttons.filter(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t === 'post' || t === 'posting' || t === 'kirim';
      });
      const enabledBtn = matches.find(b => {
        return b.getAttribute('aria-disabled') !== 'true' && !b.hasAttribute('disabled');
      });
      return enabledBtn || matches[matches.length - 1] || null;
    });

    if (!postBtnHandle || !postBtnHandle.asElement()) {
      await page.screenshot({ path: path.join(process.cwd(), 'threads-debug-no-post-btn.png') });
      throw new Error('Tombol Post tidak ditemukan di composer Threads.');
    }

    // Klik tombol Kirim / Post
    console.log('[Threads Operator] 🚀 Mengklik tombol Post!');
    await postBtnHandle.asElement().click();

    // 7. Verifikasi penutupan dialog modal
    console.log('[Threads Operator] Menunggu dialog modal tertutup...');
    let dialogClosed = false;
    try {
      await page.waitForFunction(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        return !dialog;
      }, { timeout: 15000 });
      dialogClosed = true;
      console.log('[Threads Operator] ✅ Modal dialog postingan tertutup!');
    } catch (e) {
      console.warn('[Threads Operator] Modal dialog belum tertutup setelah 15s.');
      await page.screenshot({ path: path.join(process.cwd(), 'threads-debug-dialog-stuck.png') });
    }

    // Tunggu tambahan 5 detik untuk memastikan background request selesai
    await new Promise(r => setTimeout(r, 5000));

    // Periksa apakah ada pesan error dari Threads
    const errorAlert = await page.evaluate(() => {
      const el = document.querySelector('[role="alert"], [data-testid="toast"]');
      return el ? (el.innerText || '').trim() : null;
    });

    if (errorAlert && (errorAlert.toLowerCase().includes('gagal') || errorAlert.toLowerCase().includes('error') || errorAlert.toLowerCase().includes("couldn't post"))) {
      await page.screenshot({ path: path.join(process.cwd(), 'threads-debug-error-toast.png') });
      throw new Error(`Threads menolak postingan: "${errorAlert}"`);
    }

    // 8. VERIFIKASI LANGSUNG DI PROFIL MAS ANDIKA
    console.log('[Threads Operator] 🔍 Memverifikasi keberadaan postingan di profil @andikatampubolon._...');
    let verifiedOnProfile = false;
    try {
      await page.goto('https://www.threads.net/@andikatampubolon._', { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
      const profileText = await page.evaluate(() => document.body.innerText || '');
      const snippet = cleanContent.slice(0, 35);
      
      if (profileText.includes(snippet)) {
        verifiedOnProfile = true;
        console.log(`[Threads Operator] 🎉 TAYANG TERVERIFIKASI DI PROFIL @andikatampubolon._!`);
        await page.screenshot({ path: path.join(process.cwd(), 'threads-success.png') });
      } else {
        console.warn(`[Threads Operator] Cuplikan teks belum terdeteksi di feed profil.`);
      }
    } catch (verErr) {
      console.warn('[Threads Operator] Gagal memuat profil verifikasi:', verErr.message);
    }

    if (!dialogClosed && !verifiedOnProfile) {
      throw new Error('Gagal memposting: Dialog Threads tidak tertutup dan postingan tidak muncul di profil.');
    }

    return {
      success: true,
      dialogClosed,
      verifiedOnProfile,
      postedAt: new Date().toISOString(),
      contentPreview: cleanContent.slice(0, 100)
    };

  } catch (err) {
    console.error('[Threads Operator] ❌ Gagal posting:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Riset tren web cepat menggunakan pencarian
 */
export async function searchWebTopic(query) {
  console.log(`[Web Operator] Mencari topik di web: "${query}"...`);
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    const html = await res.text();

    // Ekstrak hasil snippet sederhana
    const snippets = [];
    const regex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) !== null && snippets.length < 5) {
      const clean = match[1].replace(/<[^>]+>/g, '').trim();
      if (clean) snippets.push(clean);
    }

    return {
      query,
      results: snippets
    };
  } catch (err) {
    console.error('[Web Operator] Error search:', err.message);
    return { query, results: [], error: err.message };
  }
}

