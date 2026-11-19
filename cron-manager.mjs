import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';

const JOBS_FILE = path.join(process.cwd(), 'cron-jobs.json');

// Batas untuk jadwal yang dibuat NON-OWNER (anggota grup / teman whitelist)
export const GUEST_JOB_LIMITS = Object.freeze({
  maxActiveJobs: 10,
  minIntervalMinutes: 30,
  allowCron: false
});

// Helper membaca daftar jadwal dari disk (file rusak dicadangkan, bukan ditimpa)
export function loadJobs() {
  return readJsonFile(JOBS_FILE, [], { validate: Array.isArray });
}

// Helper menyimpan daftar jadwal ke disk secara atomik
export function saveJobs(jobs) {
  writeJsonAtomic(JOBS_FILE, jobs);
}

/**
 * Ubah daftar jadwal secara aman: baca versi TERBARU dari disk, ubah, simpan.
 * Seluruhnya sinkron sehingga tidak bisa diselingi operasi lain di proses ini.
 */
export function updateJobs(mutator) {
  const jobs = loadJobs();
  const next = mutator(jobs);
  saveJobs(Array.isArray(next) ? next : jobs);
  return next;
}

// Tambah jadwal baru
export function addJob(job) {
  const newJob = {
    id: job.id || `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    title: job.title || 'Tugas Terjadwal',
    creator: job.creator,
    creatorName: job.creatorName || 'Pengguna',
    target: job.target, // nomor pribadi atau ID grup
    type: job.type,     // 'once', 'daily', 'weekly', 'interval', 'cron'
    config: job.config || {},
    actionType: job.actionType || 'text', // 'text', 'ai_prompt', 'executive_briefing'
    payload: job.payload,
    createdAt: new Date().toISOString(),
    lastRun: null,
    totalRuns: 0
  };
  updateJobs(jobs => [...jobs, newJob]);
  return newJob;
}

// Hapus jadwal berdasarkan ID
export function removeJob(id) {
  let removed = false;
  updateJobs(jobs => {
    const filtered = jobs.filter(j => j.id !== id);
    removed = filtered.length !== jobs.length;
    return filtered;
  });
  return removed;
}

/**
 * Validasi jadwal dari NON-OWNER. Mengembalikan pesan penolakan atau null bila boleh.
 */
export function checkGuestJobPolicy(job, creatorNumber, jobs = loadJobs()) {
  if (!job) return null;
  if (job.actionType && job.actionType !== 'text') {
    return 'penjadwalan tugas eksekusi AI/sistem hanya dapat dibuat oleh Mas Andika';
  }
  if (job.type === 'cron' && !GUEST_JOB_LIMITS.allowCron) {
    return 'jadwal berformat cron hanya dapat dibuat oleh Mas Andika';
  }
  if (job.type === 'interval' && (job.config?.intervalMinutes || 0) < GUEST_JOB_LIMITS.minIntervalMinutes) {
    return `pengingat berkala minimal setiap ${GUEST_JOB_LIMITS.minIntervalMinutes} menit`;
  }
  const active = jobs.filter(j => j.creator === creatorNumber).length;
  if (active >= GUEST_JOB_LIMITS.maxActiveJobs) {
    return `maksimal ${GUEST_JOB_LIMITS.maxActiveJobs} jadwal aktif per orang. Hapus salah satu dulu dengan "Joko hapus jadwal <ID>"`;
  }
  return null;
}

/**
 * Jadwal yang boleh dilihat / dihapus dari sebuah chat:
 *  - Owner di chat pribadi: semua jadwal.
 *  - Di grup: jadwal yang dikirim ke grup tersebut (pengingatnya memang tampil di grup itu).
 *  - Tamu di chat pribadi: hanya jadwal miliknya sendiri di chat tersebut.
 */
export function filterVisibleJobs(jobs, { isOwner, isGroup, targetRecipient, senderNumber }) {
  if (isOwner && !isGroup) return jobs;
  return jobs.filter(j => j.target === targetRecipient && (isGroup || isOwner || j.creator === senderNumber));
}

// Ambil waktu sekarang di zona Asia/Jakarta (WIB)
export function getWIBDate() {
  const now = new Date();
  const jakartaStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
  return new Date(jakartaStr);
}

/** Normalisasi jam ke "HH:MM" (mis. "7:00", "07.30", "7:05 WIB"). Null bila tidak valid. */
export function normalizeTime(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})(?:[:.](\d{1,2}))?(?:\s*(?:wib|wita|wit))?$/i);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const HARI_MAP = {
  'minggu': 0, 'ahad': 0,
  'senin': 1,
  'selasa': 2,
  'rabu': 3,
  'kamis': 4,
  'jumat': 5, "jum'at": 5,
  'sabtu': 6
};

// Helper normalisasi teks pengingat dari WhatsApp
function normalizeScheduleText(text) {
  let t = text.trim();
  t = t.replace(/^(!joko|joko|!bot|!ai|@bot)\b\s*[:,-]?\s*/i, '');
  // Bersihkan basa-basi obrolan santai di awal secara berulang
  let prev;
  do {
    prev = t;
    t = t.replace(/^(?:katanya\s+(?:lu|kamu)\s+pinter|(?:lu|kamu)\s+kan\s+pinter|eh\s+bro|bro|woi|halo|tes|coba\s+deh|bisa\s+nggak|bisa\s+gak|tolong|coba|bisa|minta\s+tolong|mohon|harap|please|plis|eh|dong|ya)\b\s*[,:-]?\s*/i, '');
  } while (t !== prev);
  return t.trim();
}

// Kata kerja pengingat yang EKSPLISIT. Sengaja tidak memuat "ingat"/"inget" polos,
// "kasih tahu", atau "bilang" agar pertanyaan biasa ("ingat nggak jam 3 kita bahas apa?",
// "kasih tahu jam 3 sore di Tokyo jam berapa") tidak berubah menjadi pengingat.
const VERB_REGEX = /\b(ing[ae]t(?:kan|in|i)|remind(?:er)?|pasang(?:kan)?\s+(?:alarm|timer|pengingat)|set(?:el)?\s+(?:alarm|timer|pengingat)|alarm(?:kan)?|timer(?:kan)?|bangun(?:kan|in))\b/i;
const SCHEDULE_INTENT_REGEX = /\b(?:jadwalkan|ing[ae]t(?:kan|in|i)|remind(?:er)?|alarm(?:kan)?|timer(?:kan)?|pengingat|bangun(?:kan|in))\b/i;
const TARGET_REGEX = /^(?:\s*(?:ke|pada|sama)\s+[a-zA-Z0-9_]+|\s*(?:buat|untuk)\s+(?:saya|aku|gue|gw|gua|kami|kita|anak[- ]*anak|semua|semuanya|member|grup|temen[- ]*temen|teman[- ]*teman|kalian)\b|\s*(?:saya|aku|gue|gw|gua|kami|kita|anak[- ]*anak|semua|semuanya|member|grup|temen[- ]*temen|teman[- ]*teman|kalian)\b)/i;
const PARTICLE_REGEX = /^(?:\s*(?:dong|ya|nih|deh|sih|plis|please|lah|kan|ta|tuh|coba|tolong|nanti|bisa))\b/i;
const REL_TIME_REGEX = /(?:\b(?:dalam|in)\s+)?(\d+)\s*(menit|mnt|jam|detik|dtk|minute|hour|second)s?(?:\s*(?:lagi|ke\s*depan|dari\s+sekarang))?/i;
const REL_TIME_AT_START = /^(?:dalam\s+)?\d+\s*(?:menit|mnt|jam|detik|dtk)\b\s*(?:lagi|ke\s*depan|dari\s+sekarang)\b/i;
const ABS_TIME_REGEX = /(?:\b(?:di|pada|pas|nanti|tepat|sekitar|pukul|at)\s+)?\b(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?(?:\s*(?:wib|wita|wit))?/i;

function cleanTask(task) {
  if (!task) return '';
  return task
    .replace(/^(?:ya|dong|nih|deh|plis|please|untuk|buat|supaya|agar|to|kalo|kalau|jangan\s+lupa)\b\s*/i, '')
    .replace(/\s+(?:ya|dong|nih|deh|plis|please|bro|joko)$/i, '')
    .trim();
}

// Untuk jadwal berulang: buang kata kerja + sasaran di awal tugas ("ingatkan saya minum obat" -> "minum obat")
function stripLeadingVerb(task) {
  let t = String(task || '').trim();
  const m = t.match(VERB_REGEX);
  if (m && m.index === 0) {
    t = t.slice(m[0].length).replace(TARGET_REGEX, '').replace(PARTICLE_REGEX, '').trim();
  }
  return t;
}

function parseHourModifier(hour, modifier) {
  let h = parseInt(hour, 10);
  if (!modifier) return h;
  const mod = modifier.toLowerCase().trim();
  if (mod === 'siang' && h < 12) {
    if (h >= 1 && h <= 5) h += 12;
  } else if (mod === 'sore' && h < 12) {
    h += 12;
  } else if (mod === 'malam' && h < 12) {
    h += 12;
  } else if (mod === 'pagi' && h === 12) {
    h = 0;
  }
  return h;
}

function buildTimeStr(rawH, rawM, mod) {
  const h = parseHourModifier(rawH, mod);
  const m = parseInt(rawM || '00', 10);
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Parser Bahasa Alami WhatsApp untuk membuat Jadwal/Pengingat
export function parseScheduleCommand(text, creatorNumber, creatorName, targetRecipient) {
  const cleaned = normalizeScheduleText(text);
  const wibNow = getWIBDate();
  const nowMs = Date.now();
  const hasIntent = SCHEDULE_INTENT_REGEX.test(cleaned);

  // 1. RECURRING: Daily, Weekly, Interval, Cron — hanya bila ada niat penjadwalan eksplisit
  if (hasIntent) {
    // Daily
    const pDaily = /(?:jadwalkan\s+)?(?:setiap|tiap)\s+hari\s+(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?\s*(?:untuk|buat|to)?\s*(.+)/i;
    const dailyMatch = cleaned.match(pDaily);
    if (dailyMatch) {
      const timeStr = buildTimeStr(dailyMatch[1], dailyMatch[2], dailyMatch[3]);
      const task = cleanTask(stripLeadingVerb(cleanTask(dailyMatch[4])));
      const isAI = /^ai:\s*/i.test(task);
      const actualTask = task.replace(/^ai:\s*/i, '') || 'Pengingat';
      if (timeStr) {
        return {
          title: `Harian ${timeStr}: ${actualTask.slice(0, 30)}`,
          creator: creatorNumber,
          creatorName,
          target: targetRecipient,
          type: 'daily',
          config: { time: timeStr, readableTime: `Setiap hari jam ${timeStr} WIB` },
          actionType: isAI ? 'ai_prompt' : 'text',
          payload: actualTask
        };
      }
    }

    // Weekly
    const pWeekly = /(?:jadwalkan\s+)?(?:setiap|tiap)\s+(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)\s+(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?\s*(?:untuk|buat|to)?\s*(.+)/i;
    const weeklyMatch = cleaned.match(pWeekly);
    if (weeklyMatch) {
      const dayName = weeklyMatch[1].toLowerCase();
      const dayIndex = HARI_MAP[dayName];
      const timeStr = buildTimeStr(weeklyMatch[2], weeklyMatch[3], weeklyMatch[4]);
      const task = cleanTask(stripLeadingVerb(cleanTask(weeklyMatch[5])));
      const isAI = /^ai:\s*/i.test(task);
      const actualTask = task.replace(/^ai:\s*/i, '') || 'Pengingat';
      if (timeStr && dayIndex !== undefined) {
        return {
          title: `Mingguan (${dayName} ${timeStr}): ${actualTask.slice(0, 30)}`,
          creator: creatorNumber,
          creatorName,
          target: targetRecipient,
          type: 'weekly',
          config: { day: dayIndex, dayName, time: timeStr, readableTime: `Setiap ${dayName.toUpperCase()} jam ${timeStr} WIB` },
          actionType: isAI ? 'ai_prompt' : 'text',
          payload: actualTask
        };
      }
    }

    // Interval
    const pInterval = /(?:jadwalkan\s+)?(?:setiap|tiap)\s+(\d+)\s*(menit|jam)\s*(?:untuk|buat|to)?\s*(.+)/i;
    const intervalMatch = cleaned.match(pInterval);
    if (intervalMatch) {
      const amount = parseInt(intervalMatch[1], 10);
      const unit = intervalMatch[2].toLowerCase();
      const task = cleanTask(stripLeadingVerb(cleanTask(intervalMatch[3])));
      const intervalMinutes = unit === 'jam' ? amount * 60 : amount;
      const isAI = /^ai:\s*/i.test(task);
      const actualTask = task.replace(/^ai:\s*/i, '') || 'Pengingat';
      if (intervalMinutes >= 1) {
        return {
          title: `Interval (${amount} ${unit}): ${actualTask.slice(0, 30)}`,
          creator: creatorNumber,
          creatorName,
          target: targetRecipient,
          type: 'interval',
          config: { intervalMinutes, readableTime: `Setiap ${amount} ${unit}` },
          actionType: isAI ? 'ai_prompt' : 'text',
          payload: actualTask
        };
      }
    }
  }

  // Cron (selalu eksplisit: "jadwalkan cron '...' <tugas>")
  const cronMatch = cleaned.match(/^jadwalkan\s+cron\s+["']([^"']+)["']\s+(.+)/i);
  if (cronMatch) {
    const cronExpr = cronMatch[1].trim();
    const task = cleanTask(cronMatch[2]);
    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');

    if (isValidCronExpression(cronExpr)) {
      return {
        title: `Cron [${cronExpr}]: ${actualTask.slice(0, 30)}`,
        creator: creatorNumber,
        creatorName,
        target: targetRecipient,
        type: 'cron',
        config: { cronExpr, readableTime: `Cron: "${cronExpr}"` },
        actionType: isAI ? 'ai_prompt' : 'text',
        payload: actualTask
      };
    }
  }

  // 2. RELATIVE TIMER: X menit/jam/detik lagi
  // Wajib ada kata kerja pengingat, ATAU kalimat diawali waktu relatif ("5 menit lagi minum obat").
  const relTimeMatch = cleaned.match(REL_TIME_REGEX);
  const verbMatch = cleaned.match(VERB_REGEX);

  if (relTimeMatch && (verbMatch || REL_TIME_AT_START.test(cleaned))) {
    const amount = parseInt(relTimeMatch[1], 10);
    const unit = relTimeMatch[2].toLowerCase();

    let delayMs = amount * 60 * 1000;
    let standardUnit = 'menit';
    if (unit.startsWith('jam') || unit.startsWith('hour')) {
      delayMs = amount * 60 * 60 * 1000;
      standardUnit = 'jam';
    } else if (unit.startsWith('detik') || unit.startsWith('dtk') || unit.startsWith('second')) {
      delayMs = amount * 1000;
      standardUnit = 'detik';
    }

    let withoutTime = cleaned.replace(relTimeMatch[0], ' ');
    let rawTask = '';
    if (verbMatch) {
      const vIdx = withoutTime.search(VERB_REGEX);
      let afterVerb = withoutTime.slice(vIdx).replace(VERB_REGEX, '').trim();
      afterVerb = afterVerb.replace(TARGET_REGEX, '').trim();
      afterVerb = afterVerb.replace(PARTICLE_REGEX, '').trim();
      rawTask = afterVerb;
      if (!rawTask) {
        rawTask = withoutTime.slice(0, vIdx).trim();
      }
    } else {
      rawTask = withoutTime;
    }

    const task = cleanTask(rawTask);
    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '') || 'Pengingat';

    return {
      title: `Pengingat (${amount} ${standardUnit}): ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'once',
      config: {
        targetTimestamp: nowMs + delayMs,
        readableTime: `${amount} ${standardUnit} lagi`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // 3. ABSOLUTE TIME (Jam / Pukul HH:MM)
  const absTimeMatch = cleaned.match(ABS_TIME_REGEX);
  if (absTimeMatch && (verbMatch || /^(?:di\s+|pada\s+)?(?:jam|pukul)\s*\d/i.test(cleaned) || /\b(?:alarm|timer|pengingat)\b/i.test(cleaned))) {
    const timeStr = buildTimeStr(absTimeMatch[1], absTimeMatch[2], absTimeMatch[3]);
    if (!timeStr) return null;
    const [h, m] = timeStr.split(':').map(Number);
    const isTomorrow = /\bbesok\b/i.test(cleaned);

    let withoutTime = cleaned.replace(absTimeMatch[0], ' ');
    withoutTime = withoutTime.replace(/\bbesok\b/gi, ' ');
    let rawTask = '';

    if (verbMatch) {
      const vIdx = withoutTime.search(VERB_REGEX);
      let afterVerb = withoutTime.slice(vIdx).replace(VERB_REGEX, '').trim();
      afterVerb = afterVerb.replace(TARGET_REGEX, '').trim();
      afterVerb = afterVerb.replace(PARTICLE_REGEX, '').trim();
      rawTask = afterVerb;
      if (!rawTask) {
        rawTask = withoutTime.slice(0, vIdx).trim();
      }
    } else {
      rawTask = withoutTime;
    }

    const task = cleanTask(rawTask);
    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '') || 'Pengingat';

    const targetWib = new Date(wibNow);
    targetWib.setHours(h, m, 0, 0);
    let isNextDay = false;
    if (isTomorrow || targetWib.getTime() <= wibNow.getTime()) {
      targetWib.setDate(targetWib.getDate() + 1);
      isNextDay = true;
    }

    const diffMs = targetWib.getTime() - wibNow.getTime();
    const targetTimestamp = nowMs + diffMs;

    return {
      title: `Pengingat ${isNextDay ? 'Besok ' : ''}Jam ${timeStr}: ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'once',
      config: {
        targetTimestamp,
        readableTime: `${isNextDay ? 'Besok ' : ''}Jam ${timeStr} WIB`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  return null;
}

// Ekstrak dan susun Job dari blok JSON AI.
// Urutan penting: tipe berulang (daily/weekly) dicek LEBIH DULU, karena keduanya juga
// memiliki field "time" — sebelumnya semuanya jatuh ke cabang sekali jalan.
export function createJobFromAI(data, creatorNumber, creatorName, targetRecipient) {
  if (!data || typeof data !== 'object') return null;
  const wibNow = getWIBDate();
  const nowMs = Date.now();
  const task = cleanTask(String(data.task || data.payload || data.title || 'Pengingat')).slice(0, 300) || 'Pengingat';
  const type = String(data.type || '').toLowerCase().trim();

  if (type === 'daily') {
    const timeStr = normalizeTime(data.time);
    if (!timeStr) return null;
    return {
      title: `Harian ${timeStr}: ${task.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'daily',
      config: { time: timeStr, readableTime: `Setiap hari jam ${timeStr} WIB` },
      actionType: 'text',
      payload: task
    };
  }

  if (type === 'weekly') {
    const timeStr = normalizeTime(data.time);
    const dayName = String(data.day ?? '').toLowerCase().trim();
    const dayIndex = HARI_MAP[dayName];
    if (!timeStr || dayIndex === undefined) return null;
    return {
      title: `Mingguan (${dayName} ${timeStr}): ${task.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'weekly',
      config: { day: dayIndex, dayName, time: timeStr, readableTime: `Setiap ${dayName.toUpperCase()} jam ${timeStr} WIB` },
      actionType: 'text',
      payload: task
    };
  }

  if (type === 'once' || type === '' || data.delayMinutes || data.delaySeconds || data.time) {
    let targetTimestamp = null;
    let readableTime = '';

    const delayMinutes = Number(data.delayMinutes);
    const delaySeconds = Number(data.delaySeconds);
    if (Number.isFinite(delayMinutes) && delayMinutes > 0) {
      targetTimestamp = nowMs + Math.round(delayMinutes * 60 * 1000);
      readableTime = `${data.delayMinutes} menit lagi`;
    } else if (Number.isFinite(delaySeconds) && delaySeconds > 0) {
      targetTimestamp = nowMs + Math.round(delaySeconds * 1000);
      readableTime = `${data.delaySeconds} detik lagi`;
    } else if (data.time) {
      const timeStr = normalizeTime(data.time);
      if (!timeStr) return null;
      const [h, m] = timeStr.split(':').map(Number);
      const targetWib = new Date(wibNow);
      targetWib.setHours(h, m, 0, 0);
      let isNextDay = false;
      if (data.isTomorrow === true || targetWib.getTime() <= wibNow.getTime()) {
        targetWib.setDate(targetWib.getDate() + 1);
        isNextDay = true;
      }
      readableTime = `${isNextDay ? 'Besok ' : ''}Jam ${timeStr} WIB`;
      targetTimestamp = nowMs + (targetWib.getTime() - wibNow.getTime());
    }

    if (!targetTimestamp) return null; // jangan buat pengingat yang langsung terpicu tanpa waktu jelas

    return {
      title: `Pengingat: ${task.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'once',
      config: { targetTimestamp, readableTime },
      actionType: 'text',
      payload: task
    };
  }

  return null;
}

// ==========================================
// CRON EXPRESSION (5 field: menit jam tgl bln hari_dlm_minggu)
// Mendukung: *, angka, daftar "1,3,5", rentang "1-5", langkah "*/15" dan "1-30/5".
// ==========================================
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseCronField(field, [min, max]) {
  const values = new Set();
  for (const item of field.split(',')) {
    const m = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b === undefined ? (m[2] ? max : a) : b;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function parseCronExpression(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((p, i) => parseCronField(p, CRON_RANGES[i]));
  if (fields.some(f => f === null)) return null;
  if (fields[4].has(7)) fields[4].add(0); // 7 = Minggu
  return fields;
}

export function isValidCronExpression(expr) {
  return parseCronExpression(expr) !== null;
}

export function matchCronExpression(expr, wibDate) {
  const fields = parseCronExpression(expr);
  if (!fields) return false;
  const [m, h, dom, mon, dow] = fields;
  return (
    m.has(wibDate.getMinutes()) &&
    h.has(wibDate.getHours()) &&
    dom.has(wibDate.getDate()) &&
    mon.has(wibDate.getMonth() + 1) &&
    dow.has(wibDate.getDay())
  );
}

function minuteKeyOf(wibDate) {
  const hh = String(wibDate.getHours()).padStart(2, '0');
  const mm = String(wibDate.getMinutes()).padStart(2, '0');
  return `${wibDate.getFullYear()}-${wibDate.getMonth()}-${wibDate.getDate()} ${hh}:${mm}`;
}

// Cek apakah suatu job harus dijalankan sekarang
export function shouldRunJob(job, wibDate, nowTime = Date.now()) {
  const curTimeStr = `${String(wibDate.getHours()).padStart(2, '0')}:${String(wibDate.getMinutes()).padStart(2, '0')}`;
  const curDay = wibDate.getDay();

  // Jangan jalankan ulang jika sudah dijalankan di menit yang sama (WIB)
  if (job.lastRunMinute === minuteKeyOf(wibDate)) {
    return false;
  }

  switch (job.type) {
    case 'once':
      return !!(job.config?.targetTimestamp && nowTime >= job.config.targetTimestamp);
    case 'daily':
      return normalizeTime(job.config?.time) === curTimeStr;
    case 'weekly':
      return Number(job.config?.day) === curDay && normalizeTime(job.config?.time) === curTimeStr;
    case 'interval': {
      const intervalMs = (job.config?.intervalMinutes || 60) * 60 * 1000;
      const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : new Date(job.createdAt).getTime();
      return nowTime - lastRunTime >= intervalMs;
    }
    case 'cron':
      return !!job.config?.cronExpr && matchCronExpression(job.config.cronExpr, wibDate);
    default:
      return false;
  }
}

/**
 * Tandai jadwal yang jatuh tempo sebagai "sudah dijalankan" DAN simpan ke disk SEBELUM
 * dieksekusi. Jadwal sekali jalan langsung dihapus. Dengan begitu tick berikutnya tidak
 * akan memicu jadwal yang sama lagi walaupun eksekusinya lama (briefing / tugas AI),
 * dan perubahan jadwal oleh pengguna di tengah eksekusi tidak tertimpa.
 */
export function claimDueJobs(wibDate = getWIBDate(), nowTime = Date.now()) {
  const minuteKey = minuteKeyOf(wibDate);
  const claimed = [];
  updateJobs(jobs => {
    const next = [];
    for (const job of jobs) {
      if (!shouldRunJob(job, wibDate, nowTime)) {
        next.push(job);
        continue;
      }
      const runJob = {
        ...job,
        lastRun: new Date(nowTime).toISOString(),
        lastRunMinute: minuteKey,
        totalRuns: (job.totalRuns || 0) + 1
      };
      claimed.push(runJob);
      if (job.type !== 'once') next.push(runJob);
    }
    return next;
  });
  return claimed;
}

// Inisialisasi loop scheduler
export function startCronScheduler(onTriggerCallback) {
  console.log('[Cron Engine] Scheduler aktif (Zona Waktu: Asia/Jakarta - WIB)');

  const intervalId = setInterval(() => {
    let due = [];
    try {
      due = claimDueJobs();
    } catch (err) {
      console.error('[Cron Engine] Gagal memeriksa jadwal:', err.message);
      return;
    }

    for (const job of due) {
      console.log(`[Cron Engine] ⏰ Memicu jadwal "${job.title}" (${job.id})`);
      // Tidak di-await: jadwal lain tidak perlu menunggu tugas yang lama.
      Promise.resolve()
        .then(() => onTriggerCallback(job))
        .catch(err => console.error(`[Cron Engine] Error eksekusi job ${job.id}:`, err?.message || err));
    }
  }, 10000);

  return intervalId;
}
