import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractMediaInfo, mediaExtension, checkMediaLimits, saveMediaToInbox, cleanupMediaInbox,
  buildOwnerAttachmentContext, defaultOwnerRequest, guestAttachmentNote
} from '../media-input.mjs';
import { isVoiceInvocation } from '../message-guard.mjs';

test('deteksi gambar & voice note dari pesan Baileys', () => {
  const img = extractMediaInfo({ imageMessage: { mimetype: 'image/jpeg', fileLength: { low: 2048, high: 0 }, caption: 'Joko ini apa' } });
  assert.deepEqual(img, { kind: 'image', mimetype: 'image/jpeg', fileLength: 2048, seconds: 0, ptt: false, isForwarded: false });

  const vn = extractMediaInfo({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 12, ptt: true, fileLength: 9000 } });
  assert.equal(vn.kind, 'audio');
  assert.equal(vn.ptt, true);
  assert.equal(vn.seconds, 12);

  const fwd = extractMediaInfo({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, contextInfo: { isForwarded: true } } });
  assert.equal(fwd.isForwarded, true);

  assert.equal(extractMediaInfo({ conversation: 'teks biasa' }), null);
  assert.equal(extractMediaInfo({ documentMessage: { mimetype: 'application/pdf' } }), null);
  assert.equal(extractMediaInfo({ imageMessage: { mimetype: 'image/x-unknown' } }), null);
  assert.equal(extractMediaInfo(null), null);
});

test('ekstensi file dari mimetype WhatsApp', () => {
  assert.equal(mediaExtension('audio/ogg; codecs=opus'), '.ogg');
  assert.equal(mediaExtension('image/jpeg'), '.jpg');
  assert.equal(mediaExtension('image/webp'), '.webp');
  assert.equal(mediaExtension('application/x-msdownload'), null);
});

test('batas ukuran & durasi lampiran', () => {
  assert.equal(checkMediaLimits({ kind: 'image', fileLength: 1_000_000 }), null);
  assert.match(checkMediaLimits({ kind: 'image', fileLength: 50 * 1024 * 1024 }), /melebihi batas 10 MB/);
  assert.equal(checkMediaLimits({ kind: 'audio', seconds: 120, fileLength: 200_000 }), null);
  assert.match(checkMediaLimits({ kind: 'audio', seconds: 15 * 60 }), /durasi audio melebihi batas 10 menit/);
  assert.match(checkMediaLimits({ kind: 'video' }), /belum didukung/);
});

test('simpan ke inbox dengan nama acak & bersihkan file lama', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-media-test-'));
  try {
    const media = { kind: 'audio', mimetype: 'audio/ogg; codecs=opus' };
    const a = saveMediaToInbox(Buffer.from('OggS-data'), media, dir);
    const b = saveMediaToInbox(Buffer.from('OggS-data'), media, dir);
    assert.notEqual(a, b);
    assert.equal(path.dirname(a), dir);
    assert.match(path.basename(a), /^\d{4}-\d{2}-\d{2}-audio-[0-9a-f]{12}\.ogg$/);

    assert.throws(() => saveMediaToInbox(Buffer.alloc(0), media, dir), /kosong/);
    assert.throws(() => saveMediaToInbox(Buffer.alloc(11 * 1024 * 1024), { kind: 'image', mimetype: 'image/png' }, dir), /melebihi batas/);

    const old = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(a, old / 1000, old / 1000);
    assert.equal(cleanupMediaInbox(dir), 1);
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), true);
    assert.equal(cleanupMediaInbox(path.join(dir, 'tidak-ada')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('voice note asli owner = perintah; gambar & forward = data tidak terpercaya', () => {
  const own = buildOwnerAttachmentContext({ media: { kind: 'audio', isForwarded: false }, filePath: '/x/a.ogg' });
  assert.match(own, /pesan\/perintah LANGSUNG dari Mas Andika/);
  assert.match(own, /\/x\/a\.ogg/);

  const fwd = buildOwnerAttachmentContext({ media: { kind: 'audio', isForwarded: true }, filePath: '/x/b.ogg', nonce: 'abcd' });
  assert.match(fwd, /DITERUSKAN/);
  assert.match(fwd, /DATA TIDAK TERPERCAYA/);
  assert.doesNotMatch(fwd, /perintah LANGSUNG/);

  const img = buildOwnerAttachmentContext({ media: { kind: 'image' }, filePath: '/x/c.jpg' });
  assert.match(img, /LAMPIRAN GAMBAR/);
  assert.match(img, /DATA TIDAK TERPERCAYA/);

  assert.match(defaultOwnerRequest({ kind: 'image' }), /jelaskan isi gambar/i);
  assert.match(defaultOwnerRequest({ kind: 'audio', isForwarded: true }), /transkripsikan/);
  assert.match(guestAttachmentNote({ kind: 'image' }), /TIDAK dapat membuka lampiran/);
});

test('voice note hanya dianggap panggilan dari owner di chat diri sendiri', () => {
  const vn = { kind: 'audio' };
  assert.equal(isVoiceInvocation({ media: vn, isSelfChat: true, isOwner: true, isGroup: false }), true);
  // Voice note Mas Andika ke teman: tidak boleh dikirim ke AI
  assert.equal(isVoiceInvocation({ media: vn, isSelfChat: false, isOwner: true, isGroup: false }), false);
  // Voice note di grup
  assert.equal(isVoiceInvocation({ media: vn, isSelfChat: true, isOwner: true, isGroup: true }), false);
  // Voice note dari orang lain
  assert.equal(isVoiceInvocation({ media: vn, isSelfChat: false, isOwner: false, isGroup: false }), false);
  assert.equal(isVoiceInvocation({ media: vn, isSelfChat: true, isOwner: false, isGroup: false }), false);
  // Gambar tanpa caption di chat diri sendiri tetap butuh "Joko ..."
  assert.equal(isVoiceInvocation({ media: { kind: 'image' }, isSelfChat: true, isOwner: true, isGroup: false }), false);
  assert.equal(isVoiceInvocation({ media: null, isSelfChat: true, isOwner: true, isGroup: false }), false);
});
