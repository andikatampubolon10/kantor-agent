// Tes cron-manager. Dijalankan di folder sementara agar tidak menyentuh cron-jobs.json asli.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'joko-cron-test-'));
process.chdir(tmp);
const cron = await import('../cron-manager.mjs');
test.after(() => { process.chdir(os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });

const OWNER = '6282163850914';
const wib = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);

test('[#8] jadwal harian/mingguan dari AI tidak lagi jadi sekali jalan', () => {
  const daily = cron.createJobFromAI({ type: 'daily', time: '7:00', task: 'olahraga' }, OWNER, 'Mas Andika', OWNER);
  assert.equal(daily.type, 'daily');
  assert.equal(daily.config.time, '07:00');

  const weekly = cron.createJobFromAI({ type: 'weekly', day: 'Senin', time: '08.30', task: 'rapat' }, OWNER, 'Mas Andika', OWNER);
  assert.equal(weekly.type, 'weekly');
  assert.equal(weekly.config.day, 1);
  assert.equal(weekly.config.time, '08:30');

  assert.equal(cron.createJobFromAI({ type: 'weekly', day: 'harikiamat', time: '08:00', task: 'x' }, OWNER, 'A', OWNER), null);
  assert.equal(cron.createJobFromAI({ type: 'daily', time: '25:00', task: 'x' }, OWNER, 'A', OWNER), null);

  const once = cron.createJobFromAI({ type: 'once', delayMinutes: 5, task: 'minum' }, OWNER, 'A', OWNER);
  assert.equal(once.type, 'once');
  assert.ok(once.config.targetTimestamp > Date.now());
  // Tanpa waktu yang jelas -> tidak membuat pengingat yang langsung terpicu
  assert.equal(cron.createJobFromAI({ type: 'once', task: 'x' }, OWNER, 'A', OWNER), null);
});

test('normalizeTime', () => {
  assert.equal(cron.normalizeTime('7:00'), '07:00');
  assert.equal(cron.normalizeTime('07.5'), '07:05');
  assert.equal(cron.normalizeTime('19:30 WIB'), '19:30');
  assert.equal(cron.normalizeTime('24:00'), null);
  assert.equal(cron.normalizeTime('jam tujuh'), null);
});

test('[Sedang] parser jadwal tidak menangkap pertanyaan biasa', () => {
  const p = (t) => cron.parseScheduleCommand(t, OWNER, 'A', OWNER);
  assert.equal(p('jelaskan kenapa build butuh 5 menit lagi'), null);
  assert.equal(p('kasih tahu jam 3 sore di Tokyo jam berapa'), null);
  assert.equal(p('ingat nggak jam 3 kita bahas apa?'), null);
  assert.equal(p('tiap hari jam 7 aku olahraga, bagus nggak?'), null);

  assert.equal(p('ingatkan saya 15 menit lagi untuk minum air').type, 'once');
  assert.equal(p('5 menit lagi minum obat').type, 'once');
  assert.equal(p('ingetin aku jam 3 sore meeting').type, 'once');
  const daily = p('jadwalkan setiap hari jam 08:00 selamat pagi tim');
  assert.equal(daily.type, 'daily');
  assert.equal(daily.config.time, '08:00');
  const daily2 = p('setiap hari jam 7 malam ingatkan saya minum obat');
  assert.equal(daily2.type, 'daily');
  assert.equal(daily2.config.time, '19:00');
  assert.equal(daily2.payload, 'minum obat');
  assert.equal(p('ingatkan tiap 30 menit untuk peregangan').type, 'interval');
  assert.equal(p("jadwalkan cron '*/15 9-17 * * 1-5' cek email").type, 'cron');
  assert.equal(p("jadwalkan cron '99 * * * *' cek email"), null);
});

test('[Rendah] ekspresi cron: rentang, daftar, langkah', () => {
  assert.equal(cron.matchCronExpression('*/15 9-17 * * 1-5', wib(2026, 11, 19, 9, 45)), true);  // Kamis
  assert.equal(cron.matchCronExpression('*/15 9-17 * * 1-5', wib(2026, 11, 22, 9, 45)), false); // Minggu
  assert.equal(cron.matchCronExpression('0 8 * * 0', wib(2026, 11, 22, 8, 0)), true);
  assert.equal(cron.matchCronExpression('0 8 * * 7', wib(2026, 11, 22, 8, 0)), true);           // 7 = Minggu
  assert.equal(cron.matchCronExpression('5,35 * * * *', wib(2026, 11, 19, 3, 35)), true);
  assert.equal(cron.isValidCronExpression('61 * * * *'), false);
  assert.equal(cron.isValidCronExpression('* * *'), false);
});

test('[Sedang] kebijakan jadwal tamu', () => {
  const guest = '6281111111111';
  const base = { type: 'once', actionType: 'text', config: {} };
  assert.equal(cron.checkGuestJobPolicy(base, guest, []), null);
  assert.match(cron.checkGuestJobPolicy({ ...base, actionType: 'ai_prompt' }, guest, []), /Mas Andika/);
  assert.match(cron.checkGuestJobPolicy({ ...base, type: 'cron' }, guest, []), /cron/);
  assert.match(cron.checkGuestJobPolicy({ ...base, type: 'interval', config: { intervalMinutes: 1 } }, guest, []), /minimal/);
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `j${i}`, creator: guest }));
  assert.match(cron.checkGuestJobPolicy(base, guest, many), /maksimal/);
});

test('[Sedang] /jadwal hanya menampilkan jadwal yang relevan', () => {
  const G = '123@g.us';
  const jobs = [
    { id: 'a', target: OWNER, creator: OWNER },
    { id: 'b', target: G, creator: '6281111111111' },
    { id: 'c', target: '6282222222222', creator: '6282222222222' },
    { id: 'd', target: '6282222222222', creator: OWNER }
  ];
  const ids = (ctx) => cron.filterVisibleJobs(jobs, ctx).map(j => j.id).join(',');
  assert.equal(ids({ isOwner: true, isGroup: false, targetRecipient: OWNER, senderNumber: OWNER }), 'a,b,c,d');
  assert.equal(ids({ isOwner: false, isGroup: true, targetRecipient: G, senderNumber: '6289' }), 'b');
  assert.equal(ids({ isOwner: false, isGroup: false, targetRecipient: '6282222222222', senderNumber: '6282222222222' }), 'c');
});

test('[#4] penjadwal: jadwal diklaim & disimpan SEBELUM dieksekusi, tanpa duplikat', () => {
  const now = Date.now();
  cron.saveJobs([
    { id: 'once1', type: 'once', config: { targetTimestamp: now - 1000 }, title: 'x', target: OWNER },
    { id: 'daily1', type: 'daily', config: { time: '07:00' }, title: 'y', target: OWNER },
    { id: 'later', type: 'once', config: { targetTimestamp: now + 3600000 }, title: 'z', target: OWNER }
  ]);
  const at7 = wib(2026, 11, 19, 7, 0);

  const first = cron.claimDueJobs(at7, now).map(j => j.id).sort();
  assert.deepEqual(first, ['daily1', 'once1']);

  // Tick berikutnya di menit yang sama (eksekusi sebelumnya mungkin belum selesai) -> tidak ada duplikat
  assert.deepEqual(cron.claimDueJobs(at7, now + 10000), []);

  const remaining = cron.loadJobs().map(j => j.id).sort();
  assert.deepEqual(remaining, ['daily1', 'later']);
  assert.equal(cron.loadJobs().find(j => j.id === 'daily1').totalRuns, 1);

  // Jadwal yang ditambahkan pengguna di tengah eksekusi tidak hilang
  cron.addJob({ id: 'baru', type: 'once', config: { targetTimestamp: now + 7200000 }, title: 'baru', target: OWNER });
  cron.claimDueJobs(wib(2026, 11, 19, 7, 1), now + 60000);
  assert.ok(cron.loadJobs().some(j => j.id === 'baru'));
});

test('[Sedang] file jadwal rusak dicadangkan, bukan ditimpa diam-diam', () => {
  fs.writeFileSync('cron-jobs.json', '{ ini bukan json');
  assert.deepEqual(cron.loadJobs(), []);
  const backups = fs.readdirSync('.').filter(f => f.startsWith('cron-jobs.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(backups[0], 'utf8'), '{ ini bukan json');
});

test('panel: jadwal dari formulir divalidasi, bisa diubah & dijeda', () => {
  const now = Date.parse('2026-11-21T03:00:00Z');
  const daily = cron.buildJobFromPanel({ type: 'daily', time: '7.30', actionType: 'text', payload: 'minum air', target: OWNER }, { now });
  assert.deepEqual(daily.config, { time: '07:30', readableTime: 'Setiap hari jam 07:30 WIB' });
  assert.equal(daily.title, 'Jadwal: minum air');
  const weekly = cron.buildJobFromPanel({ type: 'weekly', time: '09:00', day: 1, actionType: 'ai_prompt', payload: 'rekap minggu lalu', target: '120363000000000000@g.us' }, { now });
  assert.equal(weekly.config.dayName, 'senin');
  const once = cron.buildJobFromPanel({ type: 'once', at: now + 3600000, payload: 'rapat', target: OWNER }, { now });
  assert.equal(once.config.targetTimestamp, now + 3600000);
  assert.match(once.config.readableTime, /WIB$/);
  const brief = cron.buildJobFromPanel({ type: 'cron', cronExpr: '0 7 * * 1-5', actionType: 'executive_briefing', target: OWNER }, { now });
  assert.equal(brief.title, 'Morning Executive Briefing');
  for (const [bad, re] of [
    [{ type: 'daily', time: '25:00', payload: 'x', target: OWNER }, /Jam/],
    [{ type: 'once', at: now - 3600000, payload: 'x', target: OWNER }, /lewat/],
    [{ type: 'interval', intervalMinutes: 1, payload: 'x', target: OWNER }, /Selang/],
    [{ type: 'cron', cronExpr: '* *', payload: 'x', target: OWNER }, /cron/],
    [{ type: 'daily', time: '07:00', payload: '', target: OWNER }, /wajib/],
    [{ type: 'daily', time: '07:00', payload: 'x', target: 'bukan nomor' }, /Tujuan/],
    [{ type: 'daily', time: '07:00', payload: 'x', target: OWNER, actionType: 'hapus_semua' }, /Jenis tugas/]
  ]) assert.throws(() => cron.buildJobFromPanel(bad, { now }), (e) => e instanceof cron.JobInputError && re.test(e.message));

  fs.writeFileSync('cron-jobs.json', '[]');
  const job = cron.addJob({ ...daily, creator: OWNER });
  assert.ok(cron.shouldRunJob(job, wib(2026, 11, 21, 7, 30)));
  const paused = cron.updateJob(job.id, { paused: true, id: 'lain', createdAt: 'x' });
  assert.equal(paused.id, job.id); // id & createdAt tidak bisa diubah
  assert.equal(paused.createdAt, job.createdAt);
  assert.equal(cron.shouldRunJob(paused, wib(2026, 11, 21, 7, 30)), false);
  assert.equal(cron.claimDueJobs(wib(2026, 11, 21, 7, 30)).length, 0);
  assert.equal(cron.updateJob('tidak-ada', {}), null);
});
