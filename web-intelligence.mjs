/**
 * Web Intelligence & Autonomous Scraper for Joko
 * Membaca & mengekstrak intisari artikel dari link, serta riset topik berita terkini.
 *
 * Keamanan:
 *  - Setiap URL (termasuk redirect & sub-request) wajib lolos url-guard: hanya alamat
 *    publik; jaringan lokal / privat / metadata cloud ditolak (anti-SSRF).
 *  - Browser memakai profil sementara yang bersih, BUKAN profil Threads yang sedang
 *    login, sehingga halaman asing tidak pernah berjalan dengan cookie akun Mas Andika.
 */
import puppeteer from 'puppeteer-core';
import { getChromePath } from './browser-utils.mjs';
import { assertPublicHttpUrl, UnsafeUrlError } from './url-guard.mjs';

const NAV_TIMEOUT_MS = 25000;
const RSS_TIMEOUT_MS = 10000;

function launchArgs() {
  const args = ['--disable-dev-shm-usage', '--disable-gpu', '--blink-settings=imagesEnabled=false'];
  // Di Linux/EC2 Chromium (snap) umumnya butuh --no-sandbox; di Windows sandbox tetap aktif.
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-setuid-sandbox');
  return args;
}

/**
 * Ekstrak konten artikel bersih dari URL publik.
 * @param {string} targetUrl URL halaman yang akan dibaca
 */
export async function scrapeUrl(targetUrl) {
  const safeUrl = await assertPublicHttpUrl(targetUrl); // melempar UnsafeUrlError bila ditolak
  console.log(`[Web Intelligence] 🌐 Menjelajah ke: ${safeUrl.href}...`);
  let browser = null;

  try {
    browser = await puppeteer.launch({
      executablePath: getChromePath(),
      headless: true,
      args: launchArgs()
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Blokir resource berat, dan periksa SETIAP request lain terhadap url-guard
    // (menutup celah redirect / iframe / fetch ke jaringan internal).
    const hostVerdicts = new Map();
    const isAllowedRequest = (reqUrl) => {
      let parsed;
      try { parsed = new URL(reqUrl); } catch { return Promise.resolve(false); }
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return Promise.resolve(true);
      const key = `${parsed.protocol}//${parsed.host}`;
      if (!hostVerdicts.has(key)) {
        hostVerdicts.set(key, assertPublicHttpUrl(reqUrl).then(() => true, () => false));
      }
      return hostVerdicts.get(key);
    };

    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      try {
        if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) {
          await req.abort();
          return;
        }
        if (await isAllowedRequest(req.url())) {
          await req.continue();
        } else {
          console.warn(`[Web Intelligence] ⛔ Request diblokir (alamat tidak publik): ${req.url().slice(0, 120)}`);
          await req.abort('accessdenied');
        }
      } catch {
        // request bisa sudah ditangani / halaman ditutup
      }
    });

    await page.goto(safeUrl.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Link Google News adalah halaman pengalih berbasis JavaScript: tunggu sampai berpindah ke situs asli.
    if (/(^|\.)news\.google\.com$/i.test(new URL(page.url()).hostname)) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
    }

    const finalUrl = page.url();

    const extracted = await page.evaluate(() => {
      const garbageSelectors = [
        'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript',
        'iframe', '.ad', '.ads', '.advertisement', '.popup', '.cookie-banner',
        '.social-share', '#comments', '.comments'
      ];
      for (const sel of garbageSelectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }

      const title = document.title ||
                    document.querySelector('meta[property="og:title"]')?.content ||
                    document.querySelector('h1')?.innerText || 'Tanpa Judul';
      const description = document.querySelector('meta[name="description"]')?.content ||
                          document.querySelector('meta[property="og:description"]')?.content || '';
      const author = document.querySelector('meta[name="author"]')?.content ||
                     document.querySelector('.author, [rel="author"]')?.innerText || '';

      const mainContainers = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '#content'];
      let contentEl = null;
      for (const c of mainContainers) {
        const found = document.querySelector(c);
        if (found && found.innerText.trim().length > 200) {
          contentEl = found;
          break;
        }
      }

      let text = '';
      if (contentEl) {
        text = contentEl.innerText;
      } else {
        text = Array.from(document.querySelectorAll('p'))
          .map(p => p.innerText.trim())
          .filter(t => t.length > 30)
          .join('\n\n');
      }
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

      return {
        title: title.trim(),
        description: description.trim(),
        author: author.trim(),
        content: text.slice(0, 10000),
        wordCount: text ? text.split(/\s+/).length : 0
      };
    });

    console.log(`[Web Intelligence] ✅ Berhasil mengekstrak: "${extracted.title}" (${extracted.wordCount} kata)`);
    return {
      success: true,
      url: finalUrl,
      ...extracted,
      scrapedAt: new Date().toISOString()
    };

  } catch (err) {
    if (!(err instanceof UnsafeUrlError)) {
      console.error(`[Web Intelligence] ❌ Gagal scrape URL ${safeUrl.href}:`, err.message);
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function stripHtml(s) {
  return decodeXmlEntities(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Ambil daftar berita dari RSS Google News (tanpa membuka browser). */
export async function fetchNewsHeadlines(query, maxResults = 3) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=id&gl=ID&ceid=ID:id`;
  const res = await fetch(rssUrl, { signal: AbortSignal.timeout(RSS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  return items.slice(0, maxResults).map(item => {
    const pick = (tag) => (item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] || '';
    return {
      title: stripHtml(pick('title')),
      link: decodeXmlEntities(pick('link')).trim(),
      pubDate: stripHtml(pick('pubDate')),
      source: stripHtml(pick('source')),
      summary: stripHtml(pick('description')).slice(0, 400)
    };
  }).filter(i => i.title && i.link);
}

/**
 * Cari topik berita terkini via Google News dan (opsional) ekstrak isi artikelnya.
 * @param {string} query Kata kunci topik
 * @param {number} maxResults Jumlah berita
 * @param {{ scrape?: boolean }} options scrape=false untuk judul + ringkasan RSS saja (cepat)
 */
export async function searchAndScrapeTopic(query, maxResults = 3, { scrape = true } = {}) {
  console.log(`[Web Intelligence] 🔍 Riset topik di web: "${query}"...`);
  try {
    const headlines = await fetchNewsHeadlines(query, maxResults);
    console.log(`[Web Intelligence] Ditemukan ${headlines.length} artikel teratas:`, headlines.map(i => i.title));

    const articles = [];
    for (const item of headlines) {
      const base = {
        url: item.link,
        title: item.title,
        pubDate: item.pubDate,
        source: item.source,
        snippet: item.summary || `Berita: ${item.title}`
      };
      if (!scrape) {
        articles.push(base);
        continue;
      }
      try {
        const article = await scrapeUrl(item.link);
        const stillOnGoogle = /(^|\.)google\.com$/i.test(new URL(article.url).hostname);
        if (!stillOnGoogle && article.content && article.content.length > 200) {
          articles.push({ ...base, url: article.url, title: article.title || item.title, snippet: article.content.slice(0, 1500) });
        } else {
          articles.push(base);
        }
      } catch (err) {
        console.warn(`[Web Intelligence] Skip isi artikel ${item.link}:`, err.message);
        articles.push(base);
      }
    }

    return { success: true, query, articleCount: articles.length, articles };
  } catch (err) {
    console.error(`[Web Intelligence] Error riset topik:`, err.message);
    return { success: false, query, articles: [], error: err.message };
  }
}
