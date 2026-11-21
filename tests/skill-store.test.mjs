import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSkillStore, validateSkill, parseFrontmatter, SkillError } from '../skill-store.mjs';

const md = (name, desc = 'Pakai saat Mas Andika meminta resep masakan rumahan.') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# Isi\n\nLangkah.\n`;

test('frontmatter & validasi skill', () => {
  assert.equal(parseFrontmatter(md('a-b')).name, 'a-b');
  assert.equal(parseFrontmatter('tanpa frontmatter'), null);
  assert.doesNotThrow(() => validateSkill('joko-resep', md('joko-resep')));
  assert.throws(() => validateSkill('../etc', md('../etc')), /huruf kecil/);
  assert.throws(() => validateSkill('Joko', md('Joko')), /huruf kecil/);
  assert.throws(() => validateSkill('joko-resep', md('joko-lain')), /sama dengan nama folder/);
  assert.throws(() => validateSkill('joko-resep', md('joko-resep', 'pendek')), /description/);
  assert.throws(() => validateSkill('joko-resep', `---\nname: joko-resep\ndescription: ${'x'.repeat(30)}\n---\n`), /kosong/);
  assert.throws(() => validateSkill('joko-resep', md('joko-resep') + 'x'.repeat(110 * 1024)), /terlalu besar/);
});

test('daftar, simpan, buat, nonaktif/aktifkan skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-skill-'));
  try {
    const store = createSkillStore(root);
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'joko-surat'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'joko-surat', 'SKILL.md'), md('joko-surat'));
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'SUMBER.md'), 'bukan skill');
    assert.deepEqual(store.list().map(s => [s.name, s.active, s.valid]), [['joko-surat', true, true]]);

    store.create('joko-resep', md('joko-resep'));
    assert.throws(() => store.create('joko-resep', md('joko-resep')), (e) => e instanceof SkillError && e.status === 409);
    store.save('joko-resep', md('joko-resep', 'Deskripsi baru yang cukup panjang untuk lolos.').replace(/\n/g, '\r\n'));
    assert.match(store.read('joko-resep').content, /Deskripsi baru/);
    assert.ok(!store.read('joko-resep').content.includes('\r'));

    store.setActive('joko-resep', false);
    assert.ok(fs.existsSync(path.join(root, '.agents', 'skills-nonaktif', 'joko-resep', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(root, '.agents', 'skills', 'joko-resep')));
    assert.equal(store.list().find(s => s.name === 'joko-resep').active, false);
    store.save('joko-resep', md('joko-resep')); // tetap bisa diubah saat nonaktif
    store.setActive('joko-resep', true);
    assert.equal(store.read('joko-resep').active, true);

    assert.throws(() => store.read('tidak-ada'), (e) => e.status === 404);
    assert.throws(() => store.read('../../x'), /tidak valid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
