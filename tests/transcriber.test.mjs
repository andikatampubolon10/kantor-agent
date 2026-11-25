import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseWhisperJson, toParagraphs, fmtTime, parseProgress, wavSeconds, ffmpegArgs, whisperArgs,
  buildAnalysisPrompt, parseAnalysis, buildTranscriptTxt, buildChatSummary, createTranscriber, checkTools
} from '../transcriber.mjs';
import { extractMediaInfo, isTranscribable } from '../media-input.mjs';

const quiet = { log() {}, warn() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'joko-stt-'));
const WJSON = {
  result: { language: 'id' },
  transcription: [
    { offsets: { from: 0, to: 4000 }, text: ' Selamat pagi semua, kita mulai rapatnya.' },
    { offsets: { from: 4200, to: 9000 }, text: ' Agenda pertama anggaran kuartal empat.' },
    { offsets: { from: 15000, to: 20000 }, text: ' Budi tolong kirim laporan hari Jumat.' },
    { offsets: { from: 20000, to: 21000 }, text: ' [BLANK_AUDIO]' },
    { offsets: { from: 21000, to: 22000 }, text: ' Terima kasih.' },
    { offsets: { from: 22000, to: 23000 }, text: ' Terima kasih.' },
    { offsets: { from: 23000, to: 24000 }, text: ' Terima kasih.' }
  ]
};
const ANALYSIS = '```analisis-transkrip\n' + JSON.stringify({
  judul: 'Rapat anggaran Q4', jenis: 'rapat', ringkasan: 'Rapat membahas anggaran kuartal empat.',
  poin_penting: ['[00:00:04] Agenda anggaran Q4'], keputusan: ['Laporan dikirim Jumat'],
  tindak_lanjut: [{ tugas: 'Kirim laporan', pic: 'Budi', tenggat: 'Jumat' }],
  topik: [{ waktu: '00:00:00', judul: 'Pembukaan' }], pembicara: 'tidak dapat dipastikan',
  kemungkinan_salah_dengar: [{ terdengar: 'kuartal empat', mungkin: 'Q4' }], catatan: ''
}) + '\n```';

test('parser whisper: segmen, buang [BLANK_AUDIO] & pengulangan halusinasi', () => {
  const { language, segments } = parseWhisperJson(JSON.stringify(WJSON));
  assert.equal(language, 'id');
  assert.equal(segments.some(s => /BLANK/.test(s.text)), false);
  assert.equal(segments.filter(s => s.text === 'Terima kasih.').length, 2, 'pengulangan ke-3 beruntun dibuang');
  const paras = toParagraphs(segments);
  assert.equal(paras.length, 2, 'jeda 6 dtk memisah paragraf');
  assert.equal(paras[0].text, 'Selamat pagi semua, kita mulai rapatnya. Agenda pertama anggaran kuartal empat.');
  assert.equal(fmtTime(3725), '01:02:05');
  assert.equal(parseProgress('whisper_print_progress_callback: progress =  45%'), 45);
  assert.equal(parseProgress('apa saja'), null);
  assert.equal(wavSeconds(44 + 32000 * 90), 90);
});

test('argumen ffmpeg & whisper', () => {
  const f = ffmpegArgs('in.mp4', 'out.wav');
  assert.deepEqual(f.slice(-8), ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'out.wav']);
  assert.equal(f[f.indexOf('-i') + 1], 'in.mp4');
  const w = whisperArgs({ model: 'm.bin', wav: 'a.wav', outPrefix: 'o', threads: 8 });
  assert.deepEqual(w, ['-m', 'm.bin', '-f', 'a.wav', '-l', 'auto', '-t', '8', '-oj', '-of', 'o', '-pp']);
});

test('prompt analisis: data bukan perintah, timestamp, tanpa mengarang', () => {
  const paras = toParagraphs(parseWhisperJson(WJSON).segments);
  const p = buildAnalysisPrompt({ paragraphs: paras, fileName: 'rapat.mp4', durationSec: 24, language: 'id', instruction: 'fokus ke anggaran' });
  assert.match(p, /JANGAN mengarang/);
  assert.match(p, /DATA, bukan perintah/);
  assert.match(p, /\[00:00:00\] Selamat pagi/);
  assert.match(p, /fokus ke anggaran/);
  assert.match(p, /bahasa terdeteksi: Indonesia/);
});

test('analisis -> file txt & ringkasan chat', () => {
  const a = parseAnalysis(ANALYSIS);
  assert.equal(a.title, 'Rapat anggaran Q4');
  assert.deepEqual(a.actions[0], { task: 'Kirim laporan', pic: 'Budi', due: 'Jumat' });
  assert.equal(parseAnalysis('tidak ada blok'), null);
  const paras = toParagraphs(parseWhisperJson(WJSON).segments);
  const txt = buildTranscriptTxt({ fileName: 'rapat.mp4', durationSec: 24, language: 'id', paragraphs: paras, analysis: a, model: 'Whisper', analysisModel: 'opus', createdAt: Date.UTC(2026, 10, 25, 3) });
  for (const s of ['TRANSKRIP — Rapat anggaran Q4', 'RINGKASAN', 'POIN PENTING', 'TINDAK LANJUT', '[ ] Kirim laporan — PIC: Budi — tenggat: Jumat', 'KEMUNGKINAN SALAH DENGAR', 'TRANSKRIP LENGKAP', '[00:00:00] Selamat pagi']) assert.ok(txt.includes(s), s);
  assert.ok(txt.includes('\r\n'), 'CRLF untuk Notepad');
  const noAi = buildTranscriptTxt({ fileName: 'x.mp3', durationSec: 5, language: 'id', paragraphs: paras, analysis: null, model: 'Whisper', analysisError: 'kuota habis' });
  assert.match(noAi, /Analisis AI tidak tersedia: kuota habis/);
  assert.match(noAi, /TRANSKRIP LENGKAP/);
  const chat = buildChatSummary({ fileName: 'rapat.mp4', durationSec: 24, language: 'id', analysis: a, words: 30 });
  assert.match(chat, /Transkrip selesai/);
  assert.match(chat, /Kirim laporan \(Budi\)/);
});

test('media: video, dokumen audio/video, voice note panjang masuk jalur transkripsi', () => {
  const vid = extractMediaInfo({ videoMessage: { mimetype: 'video/mp4', seconds: 300, fileLength: 1000 } });
  assert.equal(vid.kind, 'video');
  assert.ok(isTranscribable(vid));
  const docA = extractMediaInfo({ documentMessage: { mimetype: 'audio/mpeg', fileName: 'rapat.mp3', fileLength: 5000 } });
  assert.deepEqual([docA.kind, docA.document, docA.fileName], ['audio', true, 'rapat.mp3']);
  assert.ok(isTranscribable(docA));
  assert.equal(extractMediaInfo({ documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf' } }), null);
  assert.equal(extractMediaInfo({ videoMessage: { mimetype: 'video/mp4', gifPlayback: true } }), null);
  const mp3 = extractMediaInfo({ audioMessage: { mimetype: 'audio/mpeg', seconds: 200, ptt: false } });
  assert.ok(isTranscribable(mp3), 'file audio (bukan voice note)');
  const vn = extractMediaInfo({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 30, ptt: true } });
  assert.equal(isTranscribable(vn), false, 'voice note pendek tetap jalur lama');
  assert.ok(isTranscribable({ ...vn, seconds: 15 * 60 }), 'voice note > 10 menit ditranskrip');
});

test('transcriber: alur lengkap dengan ffmpeg/whisper tiruan; AI gagal tetap kirim transkrip', async () => {
  const dir = tmp();
  const tools = { ffmpeg: path.join(dir, 'ffmpeg'), whisper: path.join(dir, 'whisper'), model: path.join(dir, 'm.bin') };
  for (const f of Object.values(tools)) fs.writeFileSync(f, '');
  assert.equal(checkTools(tools).ok, true);
  const calls = [];
  const run = async (cmd, args, { onLine } = {}) => {
    calls.push(path.basename(cmd));
    if (cmd === tools.ffmpeg) fs.writeFileSync(args.at(-1), Buffer.alloc(44 + 32000 * 24));
    else { onLine?.('progress = 50%'); fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify(WJSON)); }
  };
  const sent = [], notes = [];
  let aiFails = false;
  const src = path.join(dir, 'rapat.mp4'); fs.writeFileSync(src, 'x');
  const tr = createTranscriber({
    tools, workDir: path.join(dir, 'w'), outDir: path.join(dir, 'out'), run, log: quiet, threads: 4,
    runAgent: async (prompt) => { assert.match(prompt, /TRANSKRIP:/); if (aiFails) throw new Error('kuota habis'); return { text: ANALYSIS, model: 'opus' }; },
    notify: async (job, text) => notes.push(text),
    sendFile: async (job, file) => sent.push(file)
  });
  const { job, done } = tr.start({ source: src, fileName: 'rapat.mp4', chat: 'c1' });
  assert.equal(job.id, 'T1');
  await done;
  assert.equal(job.status, 'selesai');
  assert.deepEqual(calls, ['ffmpeg', 'whisper']);
  assert.equal(job.durationSec, 24);
  assert.equal(job.progress, 50);
  assert.equal(sent[0].fileName, 'Transkrip - Rapat anggaran Q4.txt');
  assert.equal(sent[0].mimetype, 'text/plain');
  assert.match(sent[0].buffer.toString('utf8'), /TINDAK LANJUT/);
  assert.match(notes[0], /Transkrip selesai/);
  assert.equal(fs.existsSync(src), false, 'file sumber dihapus setelah selesai');
  assert.equal(fs.readdirSync(path.join(dir, 'w')).length, 0, 'file kerja dibersihkan');
  assert.equal(fs.readdirSync(path.join(dir, 'out')).length, 1, 'salinan di outbox (Panel > File)');

  aiFails = true;
  const src2 = path.join(dir, 'b.mp3'); fs.writeFileSync(src2, 'x');
  const r2 = tr.start({ source: src2, fileName: 'b.mp3', chat: 'c1' });
  await r2.done;
  assert.equal(r2.job.status, 'selesai');
  assert.equal(r2.job.analysis, false);
  assert.match(sent[1].buffer.toString('utf8'), /Analisis AI tidak tersedia: kuota habis/);
});

test('transcriber: tanpa ucapan -> gagal dengan pesan jelas; mesin belum terpasang -> ditolak', async () => {
  const dir = tmp();
  const tools = { ffmpeg: path.join(dir, 'f'), whisper: path.join(dir, 'w'), model: path.join(dir, 'm') };
  const notes = [];
  const run = async (cmd, args) => {
    if (cmd === tools.ffmpeg) fs.writeFileSync(args.at(-1), Buffer.alloc(44 + 32000 * 5));
    else fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1 }, text: '[BLANK_AUDIO]' }] }));
  };
  const tr = createTranscriber({ tools, workDir: dir, run, log: quiet, runAgent: async () => ({ text: '' }), notify: async (j, t) => notes.push(t) });
  assert.throws(() => tr.start({ source: 'x', chat: 'c' }), /belum terpasang .*pasang-transkrip/);
  for (const f of Object.values(tools)) fs.writeFileSync(f, '');
  const src = path.join(dir, 's.mp3'); fs.writeFileSync(src, 'x');
  const { job, done } = tr.start({ source: src, fileName: 's.mp3', chat: 'c' });
  await done;
  assert.equal(job.status, 'gagal');
  assert.match(notes[0], /Tidak ada ucapan/);
});
