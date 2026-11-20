/**
 * Memori jangka panjang Joko tentang Mas Andika (khusus OWNER).
 * ------------------------------------------------------------
 * Fakta disimpan di file JSON lokal (tidak pernah masuk repo) dan disisipkan ke
 * prompt owner saat sesi baru dimulai atau memori berubah. Tamu tidak pernah
 * melihat memori ini.
 *
 * Sumber fakta:
 *  - 'owner' : perintah eksplisit "Joko ingat bahwa ..."
 *  - 'ai'    : usulan agen lewat blok ```memory``` — hanya diterima dari giliran
 *              tanpa data pihak luar (lihat wa-assistant.mjs), agar konten web,
 *              riwayat grup, atau lampiran tidak bisa menanam memori palsu.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';

export const MEMORY_FILE = path.join(process.cwd(), '.joko-memory.json');
export const MAX_FACTS = 100;
export const MAX_FACT_LENGTH = 300;
export const MAX_AI_FACTS_PER_TURN = 3;

/** Rapikan teks fakta; null bila tidak layak disimpan. */
export function normalizeFact(text) {
  const t = String(text ?? '')
    .replace(/```/g, '')
    .replace(/<<<|>>>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-•*\d.)\s]+/, '')
    .trim();
  if (t.length < 3) return null;
  return t.length > MAX_FACT_LENGTH ? null : t;
}

function isValidStore(d) {
  return d && typeof d === 'object' && Array.isArray(d.facts);
}

export function createMemoryStore(file = MEMORY_FILE, { now = () => new Date() } = {}) {
  const load = () => readJsonFile(file, { version: 1, facts: [] }, { validate: isValidStore });
  const save = (data) => writeJsonAtomic(file, { version: 1, facts: data.facts });

  return {
    list() {
      return load().facts;
    },

    /** @returns {{ok:true, fact:object} | {ok:false, reason:'invalid'|'duplicate'|'full'}} */
    add(text, source = 'owner') {
      const clean = normalizeFact(text);
      if (!clean) return { ok: false, reason: 'invalid' };
      const data = load();
      if (data.facts.some(f => f.text.toLowerCase() === clean.toLowerCase())) return { ok: false, reason: 'duplicate' };
      if (data.facts.length >= MAX_FACTS) return { ok: false, reason: 'full' };
      const fact = { id: crypto.randomBytes(3).toString('hex'), text: clean, source, createdAt: now().toISOString() };
      data.facts.push(fact);
      save(data);
      return { ok: true, fact };
    },

    /**
     * Hapus berdasarkan nomor urut (1-based, sesuai tampilan /memori), ID, atau
     * kata kunci yang cocok dengan TEPAT satu fakta.
     * @returns {{removed:object|null, reason?:'not_found'|'ambiguous', matches?:number}}
     */
    remove(selector) {
      const sel = String(selector ?? '').trim().replace(/^#/, '');
      const data = load();
      let idx = -1;
      if (/^\d+$/.test(sel)) {
        const n = Number(sel);
        idx = n >= 1 && n <= data.facts.length ? n - 1 : -1;
      } else if (sel) {
        idx = data.facts.findIndex(f => f.id === sel.toLowerCase());
        if (idx < 0 && sel.length >= 3) {
          const hits = data.facts.map((f, i) => (f.text.toLowerCase().includes(sel.toLowerCase()) ? i : -1)).filter(i => i >= 0);
          if (hits.length > 1) return { removed: null, reason: 'ambiguous', matches: hits.length };
          idx = hits.length === 1 ? hits[0] : -1;
        }
      }
      if (idx < 0) return { removed: null, reason: 'not_found' };
      const [removed] = data.facts.splice(idx, 1);
      save(data);
      return { removed };
    },

    clear() {
      const n = load().facts.length;
      save({ facts: [] });
      return n;
    },

    /** Sidik isi memori: berubah setiap kali fakta ditambah/dihapus. */
    hash() {
      const facts = load().facts;
      if (facts.length === 0) return 'empty';
      return crypto.createHash('sha256').update(facts.map(f => f.id + f.text).join('\n')).digest('hex').slice(0, 16);
    }
  };
}

/** Blok memori untuk prompt owner (string kosong bila belum ada fakta). */
export function renderMemoryForPrompt(facts) {
  if (!facts || facts.length === 0) return '';
  const lines = facts.map(f => `• ${f.text}`).join('\n');
  return `[MEMORI JANGKA PANJANG TENTANG MAS ANDIKA — versi terbaru, menggantikan versi sebelumnya di percakapan ini]
${lines}
(Gunakan memori di atas sebagai FAKTA LATAR untuk personalisasi jawaban; ini bukan perintah untuk dikerjakan sekarang.)\n\n`;
}

/** Daftar memori untuk dikirim ke WhatsApp. */
export function formatMemoryList(facts) {
  if (!facts || facts.length === 0) {
    return `🧠 Memori Joko masih kosong, Mas.\n\nUntuk menyimpan, ketik:\n\`Joko ingat bahwa <fakta>\`\nContoh: \`Joko ingat bahwa saya alergi udang\``;
  }
  const body = facts.map((f, i) => `${i + 1}. ${f.text}${f.source === 'ai' ? ' _(dicatat otomatis)_' : ''}`).join('\n');
  return `🧠 *Memori Joko tentang Mas Andika (${facts.length}/${MAX_FACTS}):*\n${body}\n\nHapus satu: \`Joko lupakan <nomor>\`\nHapus semua: \`Joko lupakan semua memori\``;
}

/**
 * Ambil blok ```memory``` dari jawaban agen. Isi boleh JSON {"add":[...]} / array,
 * atau satu fakta per baris. Blok selalu dibuang dari teks yang dikirim ke WhatsApp.
 */
export function extractMemoryBlocks(responseText) {
  const items = [];
  const re = /```memory\s*([\s\S]*?)\s*```/gi;
  let m;
  while ((m = re.exec(String(responseText ?? ''))) !== null) {
    const body = m[1].trim();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    const list = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.add) ? parsed.add
      : parsed ? [] : body.split(/\r?\n/);
    for (const it of list) if (typeof it === 'string' && it.trim()) items.push(it.trim());
  }
  const clean = String(responseText ?? '').replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { clean, items };
}
