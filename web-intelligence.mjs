/**
 * Web Intelligence & Autonomous Scraper for Joko
 * Menggunakan puppeteer-core dengan Chrome lokal di komputer Mas Andika.
 * Mampu membaca dan mengekstrak intisari artikel dari link apa pun,
 * memfilter iklan/navigasi, dan melakukan riset topik terkini di web.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.join(process.cwd(), '.chrome-threads-profile');

/**
 * Ekstrak konten artikel bersih dari URL web mana pun
 * @param {string} targetUrl URL halaman yang akan dibaca
 */
export async function scrapeUrl(targetUrl) {
  if (!targetUrl || !targetUrl.startsWith('http')) {
    throw new Error('URL tidak valid. Pastikan diawali http:// atau https://');
  }

  console.log(`[Web Intelligence] 🌐 Menjelajah ke: ${targetUrl}...`);
  let browser = null;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      userDataDir: USER_DATA_DIR,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--blink-settings=imagesEnabled=false' // Nonaktifkan gambar agar loading super cepat
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Blokir resource berat (gambar, font, css eksternal) agar scraping secepat kilat
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Ekstrak teks bersih dan metadata
    const extracted = await page.evaluate(() => {
      // Hapus elemen sampah (iklan, navigasi, komentar, pop-up)
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

      // Prioritaskan kontainer artikel utama
      const mainContainers = [
        'article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '#content'
      ];

      let contentEl = null;
      for (const c of mainContainers) {
        const found = document.querySelector(c);
        if (found && found.innerText.trim().length > 200) {
          contentEl = found;
          break;
        }
      }

      // Jika kontainer khusus tidak ketemu, ambil kumpulan paragraf terpanjang
      let text = '';
      if (contentEl) {
        text = contentEl.innerText;
      } else {
        const paragraphs = Array.from(document.querySelectorAll('p'))
          .map(p => p.innerText.trim())
          .filter(t => t.length > 30);
        text = paragraphs.join('\n\n');
      }

      // Bersihkan spasi berlebih
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

      return {
        title: title.trim(),
        description: description.trim(),
        author: author.trim(),
        content: text.slice(0, 10000), // Batasi 10k karakter untuk efisiensi konteks AI
        wordCount: text.split(/\s+/).length
      };
    });

    console.log(`[Web Intelligence] ✅ Berhasil mengekstrak: "${extracted.title}" (${extracted.wordCount} kata)`);
    return {
      success: true,
      url: targetUrl,
      ...extracted,
      scrapedAt: new Date().toISOString()
    };

  } catch (err) {
    console.error(`[Web Intelligence] ❌ Gagal scrape URL ${targetUrl}:`, err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Cari topik di web dan kumpulkan berita/artikel terkait secara otomatis
 * @param {string} query Kata kunci pencarian
 * @param {number} maxResults Jumlah artikel yang dicari
 */
/**
 * Cari topik berita terkini via Google News dan ekstrak artikelnya
 * @param {string} query Kata kunci topik
 * @param {number} maxResults Jumlah berita yang dicari
 */
export async function searchAndScrapeTopic(query, maxResults = 3) {
  console.log(`[Web Intelligence] 🔍 Melakukan riset topik di web: "${query}"...`);
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=id&gl=ID&ceid=ID:id`;
    const res = await fetch(rssUrl);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<pubDate>(.*?)<\/pubDate>/g)];
    const topItems = items.slice(0, maxResults).map(m => ({
      title: m[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim(),
      link: m[2].trim(),
      pubDate: m[3].trim()
    }));

    console.log(`[Web Intelligence] Ditemukan ${topItems.length} artikel teratas:`, topItems.map(i => i.title));

    const scrapedArticles = [];
    for (const item of topItems) {
      try {
        const article = await scrapeUrl(item.link);
        if (article.content && article.content.length > 80) {
          scrapedArticles.push({
            url: item.link,
            title: article.title || item.title,
            pubDate: item.pubDate,
            snippet: article.content.slice(0, 1500)
          });
        }
      } catch (err) {
        console.warn(`[Web Intelligence] Skip link ${item.link}:`, err.message);
        // Fallback gunakan judul berita
        scrapedArticles.push({
          url: item.link,
          title: item.title,
          pubDate: item.pubDate,
          snippet: `Berita: ${item.title}`
        });
      }
    }

    return {
      success: true,
      query,
      articleCount: scrapedArticles.length,
      articles: scrapedArticles
    };

  } catch (err) {
    console.error(`[Web Intelligence] Error riset topik:`, err.message);
    return { success: false, query, articles: [], error: err.message };
  }
}
