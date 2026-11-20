import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractFileBlocks, resolveOutboxFile, canSendFiles, cleanupOutbox, fileKindOf, containsSecret, MAX_FILE_BYTES
} from '../file-outbox.mjs';
import { ownerRequestedFile } from '../message-guard.mjs';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-outbox-'));
  const outbox = path.join(base, 'media-outbox');
  fs.mkdirSync(outbox);
  fs.writeFileSync(path.join(base, 'joko-aws-key.pem'), '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
  fs.writeFileSync(path.join(base, 'rahasia.txt'), 'data di luar outbox');
  return { base, outbox, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('blok ```kirim-file``` diambil (objek, array, baris) & dibuang dari teks', () => {
  const r = extractFileBlocks('Ini laporannya Mas!\n\n```kirim-file\n{ "path": "laporan.pdf", "caption": "Laporan Q4" }\n```');
  assert.equal(r.clean, 'Ini laporannya Mas!');
  assert.deepEqual(r.requests, [{ path: 'laporan.pdf', caption: 'Laporan Q4' }]);
  assert.equal(extractFileBlocks('```kirim-file\n[{"path":"a.png"},{"path":"b.csv","caption":"x"}]\n```').requests.length, 2);
  assert.deepEqual(extractFileBlocks('```kirim-file\na.png\nb.pdf\n```').requests.map(x => x.path), ['a.png', 'b.pdf']);
  assert.deepEqual(extractFileBlocks('tanpa blok').requests, []);
});

test('file sah di dalam outbox lolos & jenis kiriman benar', () => {
  const s = sandbox();
  try {
    fs.writeFileSync(path.join(s.outbox, 'grafik.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(s.outbox, 'data.csv'), 'tanggal,nominal\n2026-11-20,50000\n');
    const img = resolveOutboxFile('grafik.png', s.outbox);
    assert.equal(img.ok, true);
    assert.equal(img.kind, 'image');
    const csv = resolveOutboxFile(path.join(s.outbox, 'data.csv'), s.outbox);
    assert.equal(csv.ok, true);
    assert.equal(csv.kind, 'document');
    assert.equal(csv.mimetype, 'text/csv');
    assert.equal(fileKindOf('x.pdf').kind, 'document');
    assert.equal(fileKindOf('x.ogg').kind, 'audio');
    assert.equal(fileKindOf('x.exe'), null);
  } finally { s.done(); }
});

test('ANTI PENCURIAN: path di luar outbox, traversal, & path absolut lain ditolak', () => {
  const s = sandbox();
  try {
    for (const p of ['../joko-aws-key.pem', '../rahasia.txt', path.join(s.base, 'rahasia.txt'), path.join(s.base, 'joko-aws-key.pem'), 'tidak-ada.pdf', '']) {
      const r = resolveOutboxFile(p, s.outbox);
      assert.equal(r.ok, false, p);
    }
    assert.match(resolveOutboxFile('../rahasia.txt', s.outbox).reason, /di luar folder media-outbox/);
  } finally { s.done(); }
});

test('ANTI PENCURIAN: kunci yang disalin ke outbox tetap ditolak (nama, ekstensi, isi)', () => {
  const s = sandbox();
  try {
    const put = (name, body) => fs.writeFileSync(path.join(s.outbox, name), body);
    put('joko-aws-key.pem', 'x'); put('server.key', 'x'); put('.env', 'A=1'); put('creds.txt', 'x');
    put('id_rsa.txt', 'x'); put('backup.zip', 'x'); put('creds.json', '{}'); put('program.exe', 'x');
    for (const n of ['joko-aws-key.pem', 'server.key', '.env', 'creds.txt', 'id_rsa.txt', 'backup.zip', 'creds.json', 'program.exe']) {
      assert.equal(resolveOutboxFile(n, s.outbox).ok, false, n);
    }
    // Isi rahasia disamarkan dengan nama & ekstensi yang "aman"
    put('catatan.txt', 'kunci server:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n');
    put('laporan.md', 'aws key AKIAABCDEFGHIJKLMNOP');
    put('ringkasan.pdf', '%PDF-1.4 ... {"noiseKey":{"private":"x"}}');
    put('notes.csv', 'token,ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    for (const n of ['catatan.txt', 'laporan.md', 'ringkasan.pdf', 'notes.csv']) {
      const r = resolveOutboxFile(n, s.outbox);
      assert.equal(r.ok, false, n);
      assert.match(r.reason, /rahasia/, n);
    }
    put('kosong.pdf', '');
    assert.match(resolveOutboxFile('kosong.pdf', s.outbox).reason, /kosong/);
    assert.equal(containsSecret(Buffer.from('laporan penjualan biasa')), false);
  } finally { s.done(); }
});

test('ANTI PENCURIAN: symlink ke file rahasia ditolak', (t) => {
  const s = sandbox();
  try {
    try {
      fs.symlinkSync(path.join(s.base, 'rahasia.txt'), path.join(s.outbox, 'link.txt'));
    } catch {
      t.skip('symlink tidak didukung tanpa hak admin di OS ini');
      return;
    }
    assert.equal(resolveOutboxFile('link.txt', s.outbox).ok, false);
  } finally { s.done(); }
});

test('batas ukuran file', () => {
  const s = sandbox();
  try {
    fs.writeFileSync(path.join(s.outbox, 'besar.png'), Buffer.alloc(MAX_FILE_BYTES + 1));
    assert.match(resolveOutboxFile('besar.png', s.outbox).reason, /melebihi/);
  } finally { s.done(); }
});

test('kebijakan penerima file', () => {
  assert.equal(canSendFiles({ isOwner: true, isOwnerChat: true, ownerAskedForFile: false }), true);
  assert.equal(canSendFiles({ isOwner: true, isOwnerChat: false, ownerAskedForFile: true }), true);
  assert.equal(canSendFiles({ isOwner: true, isOwnerChat: false, ownerAskedForFile: false }), false);
  assert.equal(canSendFiles({ isOwner: false, isOwnerChat: true, ownerAskedForFile: true }), false);

  assert.equal(ownerRequestedFile('kirim file excel-nya ke sini'), true);
  assert.equal(ownerRequestedFile('buatkan PDF ringkasan meeting'), true);
  assert.equal(ownerRequestedFile('bikin grafik pengeluaran'), true);
  assert.equal(ownerRequestedFile('rangkum obrolan grup tadi'), false);
  assert.equal(ownerRequestedFile('apa itu file system?'), false);
  assert.equal(ownerRequestedFile(''), false);
});

test('outbox lama dibersihkan', () => {
  const s = sandbox();
  try {
    const f = path.join(s.outbox, 'lama.pdf');
    fs.writeFileSync(f, 'x');
    const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(f, old, old);
    fs.writeFileSync(path.join(s.outbox, 'baru.pdf'), 'x');
    assert.equal(cleanupOutbox(s.outbox), 1);
    assert.deepEqual(fs.readdirSync(s.outbox), ['baru.pdf']);
  } finally { s.done(); }
});
