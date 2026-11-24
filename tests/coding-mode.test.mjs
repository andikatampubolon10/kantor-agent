import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseCodingCommand, resolveProject, parseCodingReport, createCodingManager, buildCodingPrompt, formatTaskResult, CodingError
} from '../coding-mode.mjs';

const quiet = { log() {}, warn() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'joko-coding-'));
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('parseCodingCommand: tugas, status, aksi, dan bukan perintah coding', () => {
  assert.deepEqual(parseCodingCommand('Joko coding web-toko: tambah halaman kontak'), { kind: 'start', project: 'web-toko', instruction: 'tambah halaman kontak' });
  assert.deepEqual(parseCodingCommand('joko, coding di kalkulator: buat CLI\nbaris dua'), { kind: 'start', project: 'kalkulator', instruction: 'buat CLI\nbaris dua' });
  assert.deepEqual(parseCodingCommand('Joko coding status'), { kind: 'status' });
  assert.deepEqual(parseCodingCommand('Joko coding proyek'), { kind: 'projects' });
  assert.deepEqual(parseCodingCommand('Joko coding push c3'), { kind: 'push', id: 'C3' });
  assert.deepEqual(parseCodingCommand('Joko coding gabung C12'), { kind: 'merge', id: 'C12' });
  assert.deepEqual(parseCodingCommand('Joko coding lihat C2'), { kind: 'show', id: 'C2' });
  assert.equal(parseCodingCommand('Joko coding').kind, 'help');
  assert.equal(parseCodingCommand('Joko coding tolong bantu').kind, 'help');
  assert.equal(parseCodingCommand('Joko apa itu coding?'), null);
  assert.equal(parseCodingCommand('status trading'), null);
});

test('resolveProject: tolak nama berbahaya & folder yang tumpang tindih dengan Joko', () => {
  const root = tmp();
  assert.equal(resolveProject(root, 'app-1'), path.join(root, 'app-1'));
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.git', '-x', 'C:']) assert.throws(() => resolveProject(root, bad), CodingError, bad);
  assert.throws(() => resolveProject(path.join(root, 'joko', 'proyek'), 'a', { jokoDir: path.join(root, 'joko') }), /folder Joko/);
  assert.throws(() => resolveProject(root, 'a', { jokoDir: path.join(root, 'joko') }), /folder Joko/);
});

test('parseCodingReport: blok resmi & cadangan teks', () => {
  const { report } = parseCodingReport('Selesai.\n```laporan-coding\n{"ringkasan":"Tambah fungsi","tes":"lulus","perintah_tes":"npm test","catatan":""}\n```');
  assert.equal(report.summary, 'Tambah fungsi');
  assert.equal(report.tests, 'lulus');
  assert.equal(report.testCommand, 'npm test');
  const r2 = parseCodingReport('Saya sudah menambah file.').report;
  assert.equal(r2.unstructured, true);
  assert.match(r2.summary, /menambah file/);
});

test('prompt coding memuat folder kerja, larangan push, dan format laporan', () => {
  const p = buildCodingPrompt({ task: { instruction: 'buat api' }, projectDir: 'D:\\Joko-Proyek\\x', isNew: true, branch: 'joko/c1-buat-api', baseBranch: 'main' });
  assert.match(p, /D:\\Joko-Proyek\\x/);
  assert.match(p, /JANGAN menjalankan git push/);
  assert.match(p, /laporan-coding/);
  assert.match(p, /buat api$/);
});

test('manager: proyek baru -> branch tugas, commit otomatis, diff, kembali ke main, lalu gabung', async () => {
  const base = tmp();
  const root = path.join(base, 'proyek');
  const jokoDir = path.join(base, 'joko');
  fs.mkdirSync(jokoDir);
  const notes = [];
  let seenCwd;
  const mgr = createCodingManager({
    root, jokoDir, file: path.join(jokoDir, '.joko-coding.json'), log: quiet,
    notify: async (t, text) => notes.push(text),
    runAgent: async ({ cwd, prompt }) => {
      seenCwd = cwd;
      assert.match(prompt, /proyek BARU/);
      fs.writeFileSync(path.join(cwd, 'halo.js'), 'console.log("halo");\n');
      return 'Dibuat.\n```laporan-coding\n{"ringkasan":"Membuat halo.js","tes":"lulus","perintah_tes":"node halo.js","catatan":""}\n```';
    }
  });
  const { task, done } = mgr.start({ project: 'demo', instruction: 'buat skrip halo' });
  assert.equal(task.id, 'C1');
  await done;
  const t = mgr.get('C1');
  assert.equal(seenCwd, path.join(root, 'demo'));
  assert.equal(t.status, 'selesai');
  assert.equal(t.branch, 'joko/c1-buat-skrip-halo');
  assert.deepEqual(t.files, [{ status: 'A', path: 'halo.js' }]);
  assert.equal(t.report.tests, 'lulus');
  const dir = path.join(root, 'demo');
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'kembali ke branch asal');
  assert.equal(fs.existsSync(path.join(dir, 'halo.js')), false, 'main belum berisi perubahan sebelum digabung');
  assert.match(mgr.diff('C1'), /\+console\.log\("halo"\)/);
  assert.match(notes[0], /Tugas coding C1/);
  assert.match(notes[0], /halo\.js/);
  assert.match(notes[0], /coding push C1/);
  await assert.rejects(mgr.push('C1'), /remote "origin"/);
  await mgr.merge('C1');
  assert.equal(fs.existsSync(path.join(dir, 'halo.js')), true, 'setelah digabung, main berisi perubahan');
  await assert.rejects(mgr.merge('C1'), /sudah digabung/);
  assert.deepEqual(mgr.projects().map(p => p.name), ['demo']);
});

test('manager: push hanya branch tugas ke origin', async () => {
  const base = tmp();
  const root = path.join(base, 'proyek');
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const mgr = createCodingManager({
    root, file: path.join(base, 'c.json'), log: quiet,
    runAgent: async ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'a.txt'), 'a'); return 'ok'; }
  });
  const { done } = mgr.start({ project: 'p', instruction: 'tambah a' });
  await done;
  g(path.join(root, 'p'), 'remote', 'add', 'origin', remote);
  await mgr.push('C1');
  const branches = g(remote, 'branch', '--list');
  assert.match(branches, /joko\/c1-tambah-a/);
  assert.doesNotMatch(branches, /\bmain\b/, 'main tidak ikut di-push');
  assert.ok(mgr.get('C1').pushedAt);
});

test('manager: proyek kotor ditolak; tanpa perubahan; agen gagal tetap menyimpan sebagian; tripwire folder Joko', async () => {
  const base = tmp();
  const root = path.join(base, 'proyek');
  const jokoDir = path.join(base, 'joko');
  fs.mkdirSync(jokoDir);
  g(jokoDir, 'init', '-q');
  g(jokoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  let mode = 'nothing';
  const mgr = createCodingManager({
    root, jokoDir, file: path.join(base, 'c.json'), log: quiet,
    runAgent: async ({ cwd }) => {
      if (mode === 'partial') { fs.writeFileSync(path.join(cwd, 'b.txt'), 'b'); throw Object.assign(new Error('timeout'), { partial: 'setengah jalan' }); }
      if (mode === 'escape') { fs.writeFileSync(path.join(jokoDir, 'jahat.txt'), 'x'); fs.writeFileSync(path.join(cwd, 'c.txt'), 'c'); }
      return 'tidak ada yang diubah';
    }
  });
  await mgr.start({ project: 'q', instruction: 'cek saja' }).done;
  assert.equal(mgr.get('C1').status, 'tanpa-perubahan');

  mode = 'partial';
  await mgr.start({ project: 'q', instruction: 'kerja panjang' }).done;
  const t2 = mgr.get('C2');
  assert.equal(t2.status, 'gagal');
  assert.match(t2.error, /tetap disimpan/);
  assert.equal(t2.files.length, 1);

  mode = 'escape';
  await mgr.start({ project: 'q', instruction: 'nakal' }).done;
  assert.ok(mgr.get('C3').warnings?.some(w => /folder kode Joko/i.test(w)), JSON.stringify(mgr.get('C3')));

  fs.writeFileSync(path.join(root, 'q', 'kotor.txt'), 'x');
  await mgr.start({ project: 'q', instruction: 'lagi' }).done;
  assert.match(mgr.get('C4').error, /belum di-commit/);
  assert.match(formatTaskResult(mgr.get('C4')), /gagal/);
});

test('manager: tugas yang terputus saat restart ditandai gagal', () => {
  const base = tmp();
  const file = path.join(base, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ seq: 1, tasks: [{ id: 'C1', project: 'x', instruction: 'abc', status: 'jalan', createdAt: 1 }] }));
  const mgr = createCodingManager({ root: path.join(base, 'r'), file, log: quiet, runAgent: async () => '' });
  assert.equal(mgr.get('C1').status, 'gagal');
  assert.match(mgr.get('C1').error, /dimulai ulang/);
});

test('parseCodingCommand: perintah GitHub (repo, clone, pr)', () => {
  assert.deepEqual(parseCodingCommand('Joko coding repo'), { kind: 'repos' });
  assert.deepEqual(parseCodingCommand('Joko coding clone andika/web-toko'), { kind: 'clone', spec: 'andika/web-toko' });
  assert.deepEqual(parseCodingCommand('Joko coding pr web-toko: tambah fitur login'), { kind: 'start', project: 'web-toko', instruction: 'tambah fitur login', autoPr: true });
});

test('github-cli: parseRepoSpec, githubRepoOfRemote, findGh', async () => {
  const { parseRepoSpec, githubRepoOfRemote, findGh } = await import('../github-cli.mjs');
  assert.equal(parseRepoSpec('web', { login: 'andi' }).full, 'andi/web');
  assert.equal(parseRepoSpec('https://github.com/a/b.git').url, 'https://github.com/a/b.git');
  assert.equal(parseRepoSpec('git@github.com:a/b.git').full, 'a/b');
  for (const bad of ['a/b/c', '../x', 'a b', 'https://evil.com/a/b', '']) assert.throws(() => parseRepoSpec(bad, { login: 'x' }), /Format repo/, bad);
  assert.equal(githubRepoOfRemote('https://github.com/a/b.git'), 'a/b');
  assert.equal(githubRepoOfRemote('git@github.com:a/b.git'), 'a/b');
  assert.equal(githubRepoOfRemote('D:/repo.git'), null);
  assert.equal(findGh({ env: { JOKO_GH_PATH: 'X' } }), 'X');
  assert.equal(findGh({ env: { LOCALAPPDATA: 'L' }, platform: 'win32', exists: p => p.startsWith('L') }), path.join('L', 'Programs', 'gh', 'bin', 'gh.exe'));
  assert.equal(findGh({ env: {}, platform: 'linux' }), 'gh');
});

test('manager: pull sebelum tugas, PR otomatis bila tes tidak gagal, merge lewat PR', async () => {
  const base = tmp();
  const root = path.join(base, 'proyek');
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  // Isi remote dengan commit awal dari "orang lain"
  const other = path.join(base, 'lain');
  execFileSync('git', ['clone', '-q', remote, other]);
  fs.writeFileSync(path.join(other, 'README.md'), 'v1');
  g(other, 'add', '-A'); g(other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'v1'); g(other, 'push', '-q', 'origin', 'HEAD:main');
  fs.mkdirSync(root);
  execFileSync('git', ['clone', '-q', remote, 'web'], { cwd: root });
  // Ada commit baru di GitHub setelah clone -> harus ter-pull sebelum Joko bekerja
  fs.writeFileSync(path.join(other, 'README.md'), 'v2');
  g(other, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '-am', 'v2'); g(other, 'push', '-q', 'origin', 'HEAD:main');

  const prs = [];
  const github = {
    createPr: async (o) => { prs.push(o); return { url: 'https://github.com/a/web/pull/7', number: 7 }; },
    prState: async () => ({ state: 'OPEN', mergeable: 'MERGEABLE' }),
    mergePr: async () => { prs.push('merged'); },
    status: async () => ({ ok: true, login: 'a' }), login: async () => 'a', listRepos: async () => []
  };
  let tests = 'lulus', readme;
  const mgr = createCodingManager({
    root, file: path.join(base, 'c.json'), log: quiet, github,
    runAgent: async ({ cwd, prompt }) => {
      readme = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8');
      assert.match(prompt, /sudah di-pull dari GitHub/);
      fs.writeFileSync(path.join(cwd, 'fitur.js'), String(Date.now()));
      return '```laporan-coding\n{"ringkasan":"tambah fitur","tes":"' + tests + '","perintah_tes":"npm test","catatan":""}\n```';
    }
  });
  await mgr.start({ project: 'web', instruction: 'tambah fitur', autoPr: true }).done;
  const t1 = mgr.get('C1');
  assert.equal(readme, 'v2', 'mulai dari versi terbaru GitHub');
  assert.ok(t1.pulled);
  assert.ok(t1.pushedAt, 'di-push otomatis');
  assert.match(g(remote, 'branch', '--list'), /joko\/c1-tambah-fitur/);
  assert.equal(t1.pr, undefined, 'remote bukan github.com -> tanpa PR');

  // Tes gagal -> tidak di-push
  tests = 'gagal';
  await mgr.start({ project: 'web', instruction: 'fitur rusak', autoPr: true }).done;
  const t2 = mgr.get('C2');
  assert.equal(t2.pushedAt, undefined);
  assert.ok(t2.warnings.some(w => /Tes GAGAL/.test(w)));

  // Remote terlihat sebagai github.com (push tetap ke repo lokal) -> PR dibuat, merge lewat PR
  const dir = path.join(root, 'web');
  g(dir, 'remote', 'set-url', 'origin', 'https://github.com/a/web.git');
  g(dir, 'remote', 'set-url', '--push', 'origin', remote);
  tests = 'lulus';
  const t3 = await mgr.push('C1');
  assert.equal(t3.pr.number, 7);
  assert.equal(prs[0].repo, 'a/web');
  assert.equal(prs[0].head, 'joko/c1-tambah-fitur');
  assert.equal(prs[0].base, 'main');
  assert.match(prs[0].body, /tambah fitur/);
  assert.match(formatTaskResult(t3), /Pull Request #7/);
  g(dir, 'remote', 'set-url', 'origin', remote); // agar pull setelah merge bisa jalan lokal
  const m = await mgr.merge('C1');
  assert.equal(m.mergedVia, 'pr');
  assert.ok(prs.includes('merged'));
});
