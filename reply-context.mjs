/**
 * Konteks pesan yang dibalas (reply / quote) di WhatsApp.
 * ------------------------------------------------------------
 * Saat Mas Andika membalas sebuah pesan dengan "Joko rangkum ini", isi pesan yang
 * dibalas ikut dikirim ke agen. Pesan yang dibalas SELALU diperlakukan sebagai data
 * tidak terpercaya (bisa ditulis orang lain), termasuk gambar/voice note-nya.
 */
import { extractMediaInfo } from './media-input.mjs';

export const MAX_QUOTED_TEXT = 2000;

/** Ambil contextInfo dari node pesan mana pun (extendedText, image, audio, video, dokumen). */
export function findContextInfo(msgContent) {
  if (!msgContent || typeof msgContent !== 'object') return null;
  for (const node of Object.values(msgContent)) {
    if (node && typeof node === 'object' && node.contextInfo) return node.contextInfo;
  }
  return null;
}

function quotedText(q) {
  if (!q) return '';
  return String(
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    q.documentMessage?.caption ||
    q.documentMessage?.fileName ||
    q.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  ).trim();
}

/**
 * Info pesan yang dibalas.
 * @param {object} msgContent  isi pesan masuk yang sudah dinormalisasi
 * @param {{ownJids?: string[], jokoMessageIds?: {has(id:string):boolean}}} ctx
 * @returns {null | {text:string, author:'owner'|'joko'|'other', stanzaId:string, participant:string, media:object|null, message:object}}
 */
export function extractQuotedInfo(msgContent, { ownJids = [], jokoMessageIds = null } = {}) {
  const ci = findContextInfo(msgContent);
  const q = ci?.quotedMessage;
  if (!q) return null;

  const participant = String(ci.participant || '');
  const stanzaId = String(ci.stanzaId || '');
  const own = ownJids.filter(Boolean).map(j => j.split(':')[0].split('@')[0]);
  const participantId = participant.split(':')[0].split('@')[0];
  let author = 'other';
  if (stanzaId && jokoMessageIds?.has(stanzaId)) author = 'joko';
  else if (participantId && own.includes(participantId)) author = 'owner';

  const text = quotedText(q);
  const mediaInfo = extractMediaInfo(q);
  if (!text && !mediaInfo) return null;

  return {
    text: text.length > MAX_QUOTED_TEXT ? `${text.slice(0, MAX_QUOTED_TEXT)}…` : text,
    author,
    stanzaId,
    participant,
    // Media dari pesan yang dibalas selalu DATA (bukan perintah), apa pun pengirimnya.
    media: mediaInfo ? { ...mediaInfo, fromQuote: true } : null,
    message: q
  };
}

const AUTHOR_LABEL = { owner: 'Mas Andika', joko: 'Joko (jawaban sebelumnya)', other: 'orang lain' };

/** Label pengirim pesan yang dibalas (tanpa nomor telepon). */
export function quotedAuthorLabel(author) {
  return AUTHOR_LABEL[author] || AUTHOR_LABEL.other;
}

/** Ringkasan isi pesan yang dibalas untuk dibungkus sebagai data tidak terpercaya. */
export function describeQuoted(quoted, { mediaOpened = false } = {}) {
  const parts = [`Pengirim pesan yang dibalas: ${quotedAuthorLabel(quoted.author)}`];
  if (quoted.media) {
    const what = quoted.media.kind === 'image' ? 'gambar' : 'voice note/audio';
    parts.push(mediaOpened
      ? `Lampiran: ${what} (file disertakan terpisah sebagai LAMPIRAN)`
      : `Lampiran: ${what} (tidak dapat dibuka)`);
  }
  if (quoted.text) parts.push(`Isi teks:\n${quoted.text}`);
  return parts.join('\n');
}
