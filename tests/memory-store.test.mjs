import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createMemoryStore, normalizeFact, renderMemoryForPrompt, formatMemoryList, extractMemoryBlocks, MAX_FACTS
} from '../memory-store.mjs';
import { matchRememberCommand, isMemoryListCommand, matchForgetCommand, parseInvocation } from '../message-guard.mjs';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-mem-'));
  return { store: createMemoryStore(path.join(dir, 'mem.json')), dir };
}

test('tambah, tolak duplikat, hapus per nomor/ID/kata kunci, kosongkan', () => {
  const { store, dir } = tmpStore();
  try {
    assert.equal(store.hash(), 'empty');
    const a = store.add('Saya alergi udang');
    assert.equal(a.ok, true);
    assert.equal(store.add('saya ALERGI udang').reason, 'duplicate');
    store.add('Istri saya bernama Rina');
    store.add('Kantor di Sudirman', 'ai');
    assert.equal(store.list().length, 3);
    assert.equal(store.list()[2].source, 'ai');

    const h1 = store.hash();
    assert.equal(store.remove('2').removed.text, 'Istri saya bernama Rina');
    assert.notEqual(store.hash(), h1);
    assert.equal(store.remove(a.fact.id).removed.text, 'Saya alergi udang');
    assert.equal(store.remove('sudirman').removed.text, 'Kantor di Sudirman');
    assert.equal(store.remove('99').reason, 'not_found');

    store.add('Suka kopi hitam'); store.add('Suka kopi susu');
    assert.deepEqual(store.remove('kopi'), { removed: null, reason: 'ambiguous', matches: 2 });
    assert.equal(store.clear(), 2);
    assert.equal(store.list().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validasi fakta & batas jumlah', () => {
  assert.equal(normalizeFact('  - saya   suka\n kopi  '), 'saya suka kopi');
  assert.equal(normalizeFact('```rm -rf``` <<<x>>>'), 'rm -rf x');
  assert.equal(normalizeFact('ok'), null);
  assert.equal(normalizeFact('x'.repeat(301)), null);

  const { store, dir } = tmpStore();
  try {
    for (let i = 0; i < MAX_FACTS; i++) assert.equal(store.add(`fakta nomor ${i}`).ok, true);
    assert.equal(store.add('satu lagi').reason, 'full');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file memori rusak tidak membuat Joko crash', () => {
  const { store, dir } = tmpStore();
  try {
    fs.writeFileSync(path.join(dir, 'mem.json'), '{bukan json');
    assert.deepEqual(store.list(), []);
    assert.equal(store.add('fakta baru setelah rusak').ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('render prompt & daftar WhatsApp', () => {
  assert.equal(renderMemoryForPrompt([]), '');
  const p = renderMemoryForPrompt([{ text: 'Alergi udang' }]);
  assert.match(p, /MEMORI JANGKA PANJANG/);
  assert.match(p, /• Alergi udang/);
  assert.match(p, /bukan perintah/);
  assert.match(formatMemoryList([]), /masih kosong/);
  assert.match(formatMemoryList([{ text: 'A', source: 'owner' }, { text: 'B', source: 'ai' }]), /1\. A\n2\. B _\(dicatat otomatis\)_/);
});

test('blok ```memory``` diambil & dibuang dari jawaban', () => {
  const r = extractMemoryBlocks('Siap Mas!\n\n```memory\n{ "add": ["Alergi udang", "Istri: Rina"] }\n```');
  assert.equal(r.clean, 'Siap Mas!');
  assert.deepEqual(r.items, ['Alergi udang', 'Istri: Rina']);
  assert.deepEqual(extractMemoryBlocks('```memory\n["satu"]\n```').items, ['satu']);
  assert.deepEqual(extractMemoryBlocks('```memory\nbaris satu\nbaris dua\n```').items, ['baris satu', 'baris dua']);
  assert.deepEqual(extractMemoryBlocks('tanpa blok').items, []);
});

test('perintah ingat TIDAK tertukar dengan pengingat', () => {
  assert.equal(matchRememberCommand('ingat bahwa saya alergi udang'), 'saya alergi udang');
  assert.equal(matchRememberCommand('tolong catat ya: rapat tim tiap Senin'), 'rapat tim tiap Senin');
  assert.equal(matchRememberCommand('simpan ke memori: kopi tanpa gula'), 'kopi tanpa gula');
  assert.equal(matchRememberCommand('ingat kalau kantor pindah ke Sudirman'), 'kantor pindah ke Sudirman');
  // Pengingat & kalimat biasa
  assert.equal(matchRememberCommand('ingatkan saya 15 menit lagi minum air'), null);
  assert.equal(matchRememberCommand('ingat nggak tadi kita bahas apa'), null);
  assert.equal(matchRememberCommand('catatan rapat kemarin gimana'), null);
});

test('perintah lihat & lupakan memori', () => {
  for (const t of ['/memori', 'memori', 'lihat memori', 'apa yang kamu ingat tentang saya?']) assert.equal(isMemoryListCommand(t), true, t);
  assert.equal(isMemoryListCommand('memori laptop saya penuh'), false);
  assert.deepEqual(matchForgetCommand('lupakan 3'), { selector: '3' });
  assert.deepEqual(matchForgetCommand('/lupa 2'), { selector: '2' });
  assert.deepEqual(matchForgetCommand('hapus memori nomor 4'), { selector: '4' });
  assert.deepEqual(matchForgetCommand('lupakan semua memori'), { all: true });
  assert.equal(matchForgetCommand('jangan lupakan aku'), null);
  // /memori & /lupa memicu Joko di chat pribadi tanpa kata "Joko"
  assert.equal(parseInvocation('/memori').invoked, true);
  assert.equal(parseInvocation('/lupa 2').invoked, true);
  assert.equal(parseInvocation('/memori', { isGroup: true }).invoked, false);
});
