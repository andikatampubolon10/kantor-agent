import test from 'node:test';
import assert from 'node:assert/strict';
import { extractQuotedInfo, findContextInfo, describeQuoted, quotedAuthorLabel, MAX_QUOTED_TEXT } from '../reply-context.mjs';
import { buildOwnerAttachmentContext, defaultOwnerRequest } from '../media-input.mjs';

const OWN = ['6282163850914@s.whatsapp.net', '123456789@lid'];
const reply = (contextInfo, text = 'Joko rangkum ini') => ({ extendedTextMessage: { text, contextInfo } });

test('reply ke pesan teks orang lain', () => {
  const q = extractQuotedInfo(reply({
    stanzaId: 'ABC', participant: '6281299999999@s.whatsapp.net',
    quotedMessage: { conversation: 'Besok rapat jam 9 di ruang Melati, bawa laptop ya' }
  }), { ownJids: OWN });
  assert.equal(q.author, 'other');
  assert.equal(q.text, 'Besok rapat jam 9 di ruang Melati, bawa laptop ya');
  assert.equal(q.media, null);
  assert.equal(q.stanzaId, 'ABC');
});

test('pengirim dikenali: owner (termasuk LID & device suffix) dan jawaban Joko', () => {
  const owner = extractQuotedInfo(reply({ participant: '6282163850914:12@s.whatsapp.net', quotedMessage: { conversation: 'catatan saya' } }), { ownJids: OWN });
  assert.equal(owner.author, 'owner');
  const lid = extractQuotedInfo(reply({ participant: '123456789@lid', quotedMessage: { conversation: 'x y z' } }), { ownJids: OWN });
  assert.equal(lid.author, 'owner');
  const joko = extractQuotedInfo(reply({ stanzaId: 'JOKO1', participant: '6282163850914@s.whatsapp.net', quotedMessage: { conversation: 'jawaban joko' } }),
    { ownJids: OWN, jokoMessageIds: new Set(['JOKO1']) });
  assert.equal(joko.author, 'joko');
});

test('reply ke gambar & voice note: media ditandai fromQuote', () => {
  const img = extractQuotedInfo(reply({ participant: '628111@s.whatsapp.net', quotedMessage: { imageMessage: { mimetype: 'image/jpeg', caption: 'struk belanja' } } }, 'Joko ini apa?'), { ownJids: OWN });
  assert.equal(img.media.kind, 'image');
  assert.equal(img.media.fromQuote, true);
  assert.equal(img.text, 'struk belanja');

  const vn = extractQuotedInfo(reply({ participant: '628111@s.whatsapp.net', quotedMessage: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 20 } } }, 'Joko transkrip ini'), { ownJids: OWN });
  assert.equal(vn.media.kind, 'audio');
  assert.equal(vn.text, '');
});

test('voice note dari pesan yang dibalas = DATA, walaupun milik owner', () => {
  const ctx = buildOwnerAttachmentContext({ media: { kind: 'audio', isForwarded: false, fromQuote: true }, filePath: '/m/a.ogg' });
  assert.match(ctx, /AUDIO DARI PESAN YANG DIBALAS/);
  assert.match(ctx, /DATA TIDAK TERPERCAYA/);
  assert.doesNotMatch(ctx, /perintah LANGSUNG/);
  assert.match(buildOwnerAttachmentContext({ media: { kind: 'image', fromQuote: true }, filePath: '/m/b.jpg' }), /GAMBAR DARI PESAN YANG DIBALAS/);
  assert.match(defaultOwnerRequest({ kind: 'audio', fromQuote: true }), /transkripsikan/);
});

test('contextInfo dari caption gambar / tanpa quote / quote kosong', () => {
  const content = { imageMessage: { caption: 'Joko bandingkan', contextInfo: { quotedMessage: { conversation: 'harga A 10rb' } } } };
  assert.ok(findContextInfo(content));
  assert.equal(extractQuotedInfo(content).text, 'harga A 10rb');
  assert.equal(extractQuotedInfo({ conversation: 'Joko halo' }), null);
  assert.equal(extractQuotedInfo(reply({ mentionedJid: ['x'] })), null);
  assert.equal(extractQuotedInfo(reply({ quotedMessage: { reactionMessage: { text: '👍' } } })), null);
  assert.equal(extractQuotedInfo(null), null);
});

test('teks panjang dipotong & deskripsi tanpa nomor telepon', () => {
  const q = extractQuotedInfo(reply({ participant: '6281299999999@s.whatsapp.net', quotedMessage: { conversation: 'a'.repeat(5000) } }), { ownJids: OWN });
  assert.equal(q.text.length, MAX_QUOTED_TEXT + 1);
  const d = describeQuoted(q);
  assert.match(d, /Pengirim pesan yang dibalas: orang lain/);
  assert.doesNotMatch(d, /6281299999999/);
  assert.match(describeQuoted({ author: 'joko', text: 'x', media: { kind: 'image' } }, { mediaOpened: true }), /gambar \(file disertakan terpisah/);
  assert.match(describeQuoted({ author: 'other', text: '', media: { kind: 'audio' } }), /voice note\/audio \(tidak dapat dibuka\)/);
  assert.equal(quotedAuthorLabel('owner'), 'Mas Andika');
});
