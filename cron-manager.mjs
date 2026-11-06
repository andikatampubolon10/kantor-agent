import fs from 'node:fs';
import path from 'node:path';

const JOBS_FILE = path.join(process.cwd(), 'cron-jobs.json');

// Helper membaca daftar jadwal dari disk
export function loadJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    console.error('[Cron] Gagal membaca cron-jobs.json:', err.message);
  }
  return [];
}

// Helper menyimpan daftar jadwal ke disk
export function saveJobs(jobs) {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
  } catch (err) {
    console.error('[Cron] Gagal menyimpan cron-jobs.json:', err.message);
  }
}

// Tambah jadwal baru
export function addJob(job) {
  const jobs = loadJobs();
  const newJob = {
    id: job.id || `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    title: job.title || 'Tugas Terjadwal',
    creator: job.creator,
    creatorName: job.creatorName || 'Pengguna',
    target: job.target, // nomor pribadi atau ID grup
    type: job.type,     // 'once', 'daily', 'weekly', 'interval', 'cron'
    config: job.config || {},
    actionType: job.actionType || 'text', // 'text' atau 'ai_prompt'
    payload: job.payload,
    createdAt: new Date().toISOString(),
    lastRun: null,
    totalRuns: 0
  };
  jobs.push(newJob);
  saveJobs(jobs);
  return newJob;
}

// Hapus jadwal berdasarkan ID
export function removeJob(id) {
  const jobs = loadJobs();
  const filtered = jobs.filter(j => j.id !== id);
  if (filtered.length !== jobs.length) {
    saveJobs(filtered);
    return true;
  }
  return false;
}

// Ambil waktu sekarang di zona Asia/Jakarta (WIB)
export function getWIBDate() {
  const now = new Date();
  const jakartaStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
  return new Date(jakartaStr);
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

function cleanTask(task) {
  if (!task) return '';
  return task
    .replace(/^(?:ya|dong|nih|deh|plis|please|untuk|buat|supaya|agar|to|kalo|kalau|jangan\s+lupa)\b\s*/i, '')
    .replace(/\s+(?:ya|dong|nih|deh|plis|please|bro|joko)$/i, '')
    .trim();
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

const VERB_REGEX = /\b(ing[ae]t(?:kan|in|i|en)?|remind(?:er)?|pasang(?:kan)?\s+(?:alarm|timer|pengingat)|set(?:el)?\s+(?:alarm|timer|pengingat)|alarm(?:kan)?|timer(?:kan)?|kasih\s+tau|kasih\s+tahu|beri\s+tahu|bilang(?:in|an)?|bangun(?:kan|in)?)\b/i;
const TARGET_REGEX = /^(?:\s*(?:ke|pada|sama)\s+[a-zA-Z0-9_]+|\s*(?:buat|untuk)\s+(?:saya|aku|gue|gw|gua|kami|kita|anak[- ]*anak|semua|semuanya|member|grup|temen[- ]*temen|teman[- ]*teman|kalian)\b|\s*(?:saya|aku|gue|gw|gua|kami|kita|anak[- ]*anak|semua|semuanya|member|grup|temen[- ]*temen|teman[- ]*teman|kalian)\b)/i;
const PARTICLE_REGEX = /^(?:\s*(?:dong|ya|nih|deh|sih|plis|please|lah|kan|ta|tuh|coba|tolong|nanti|bisa))\b/i;
const REL_TIME_REGEX = /(?:(?:dalam|in)\s+)?(\d+)\s*(menit|mnt|jam|detik|dtk|minute|hour|second)s?(?:\s*(?:lagi|ke\s*depan|dari\s+sekarang))?/i;
const ABS_TIME_REGEX = /(?:(?:di|pada|pas|nanti|tepat|sekitar|pukul|at)\s+)?(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?(?:\s*(?:wib|wita|wit))?/i;

// Parser Bahasa Alami WhatsApp untuk membuat Jadwal/Pengingat
export function parseScheduleCommand(text, creatorNumber, creatorName, targetRecipient) {
  const cleaned = normalizeScheduleText(text);
  const wibNow = getWIBDate();
  const nowMs = Date.now();

  // 1. RECURRING: Daily, Weekly, Interval, Cron
  // Daily
  const pDaily = /(?:jadwalkan\s+)?(?:setiap|tiap)\s+hari\s+(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?\s*(?:untuk|buat|to)?\s*(.+)/i;
  const dailyMatch = cleaned.match(pDaily);
  if (dailyMatch) {
    const rawH = dailyMatch[1];
    const rawM = dailyMatch[2] || '00';
    const mod = dailyMatch[3];
    const rawTask = dailyMatch[4];
    const h = parseHourModifier(rawH, mod);
    const m = parseInt(rawM, 10);
    const task = cleanTask(rawTask);
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');

    return {
      title: `Harian ${timeStr}: ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'daily',
      config: {
        time: timeStr,
        readableTime: `Setiap hari jam ${timeStr} WIB`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // Weekly
  const pWeekly = /(?:jadwalkan\s+)?(?:setiap|tiap)\s+(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)\s+(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?\s*(?:untuk|buat|to)?\s*(.+)/i;
  const weeklyMatch = cleaned.match(pWeekly);
  if (weeklyMatch) {
    const dayName = weeklyMatch[1].toLowerCase();
    const dayIndex = HARI_MAP[dayName] ?? 1;
    const rawH = weeklyMatch[2];
    const rawM = weeklyMatch[3] || '00';
    const mod = weeklyMatch[4];
    const rawTask = weeklyMatch[5];
    const h = parseHourModifier(rawH, mod);
    const m = parseInt(rawM, 10);
    const task = cleanTask(rawTask);
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');

    return {
      title: `Mingguan (${dayName} ${timeStr}): ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'weekly',
      config: {
        day: dayIndex,
        dayName,
        time: timeStr,
        readableTime: `Setiap ${dayName.toUpperCase()} jam ${timeStr} WIB`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // Interval
  const pInterval = /(?:jadwalkan\s+)?(?:setiap|tiap)\s+(\d+)\s*(menit|jam)\s*(?:untuk|buat|to)?\s*(.+)/i;
  const intervalMatch = cleaned.match(pInterval);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const task = cleanTask(intervalMatch[3]);
    const intervalMinutes = unit === 'jam' ? amount * 60 : amount;
    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');

    return {
      title: `Interval (${amount} ${unit}): ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'interval',
      config: {
        intervalMinutes,
        readableTime: `Setiap ${amount} ${unit}`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // Cron
  const cronMatch = cleaned.match(/^jadwalkan\s+cron\s+["']([^"']+)["']\s+(.+)/i);
  if (cronMatch) {
    const cronExpr = cronMatch[1].trim();
    const task = cleanTask(cronMatch[2]);
    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');

    return {
      title: `Cron [${cronExpr}]: ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'cron',
      config: {
        cronExpr,
        readableTime: `Cron: "${cronExpr}"`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // 2. RELATIVE TIMER: X menit/jam/detik lagi
  const relTimeMatch = cleaned.match(REL_TIME_REGEX);
  const verbMatch = cleaned.match(VERB_REGEX);

  if (relTimeMatch && (verbMatch || /(?:lagi|ke\s*depan|dari\s+sekarang)/i.test(cleaned))) {
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
  if (absTimeMatch && (verbMatch || /^(?:di\s+)?(?:jam|pukul)\b/i.test(cleaned) || /alarm|timer|pengingat/i.test(cleaned))) {
    const rawH = absTimeMatch[1];
    const rawM = absTimeMatch[2] || '00';
    const mod = absTimeMatch[3];
    const h = parseHourModifier(rawH, mod);
    const m = parseInt(rawM, 10);
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

// Ekstrak dan susun Job dari blok JSON AI
export function createJobFromAI(data, creatorNumber, creatorName, targetRecipient) {
  if (!data || typeof data !== 'object') return null;
  const wibNow = getWIBDate();
  const nowMs = Date.now();
  const task = cleanTask(data.task || data.payload || data.title || 'Pengingat');

  if (data.type === 'once' || data.delayMinutes || data.delaySeconds || data.time) {
    let targetTimestamp = nowMs;
    let readableTime = '';

    if (data.delayMinutes) {
      const ms = Math.round(Number(data.delayMinutes) * 60 * 1000);
      targetTimestamp = nowMs + ms;
      readableTime = `${data.delayMinutes} menit lagi`;
    } else if (data.delaySeconds) {
      const ms = Math.round(Number(data.delaySeconds) * 1000);
      targetTimestamp = nowMs + ms;
      readableTime = `${data.delaySeconds} detik lagi`;
    } else if (data.time) {
      const [hStr, mStr] = String(data.time).split(/[:.]/);
      const h = parseInt(hStr, 10) || 0;
      const m = parseInt(mStr, 10) || 0;
      const targetWib = new Date(wibNow);
      targetWib.setHours(h, m, 0, 0);
      let isNextDay = false;
      if (data.isTomorrow || targetWib.getTime() <= wibNow.getTime()) {
        targetWib.setDate(targetWib.getDate() + 1);
        isNextDay = true;
      }
      readableTime = `${isNextDay ? 'Besok ' : ''}Jam ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} WIB`;
      const diffMs = targetWib.getTime() - wibNow.getTime();
      targetTimestamp = nowMs + diffMs;
    }

    return {
      title: `Pengingat: ${task.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'once',
      config: {
        targetTimestamp,
        readableTime: readableTime || 'Waktu ditentukan'
      },
      actionType: 'text',
      payload: task
    };
  } else if (data.type === 'daily' && data.time) {
    const timeStr = String(data.time).trim();
    return {
      title: `Harian ${timeStr}: ${task.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'daily',
      config: {
        time: timeStr,
        readableTime: `Setiap hari jam ${timeStr} WIB`
      },
      actionType: 'text',
      payload: task
    };
  } else if (data.type === 'weekly' && data.day && data.time) {
    const dayName = String(data.day).toLowerCase().trim();
    const dayIndex = HARI_MAP[dayName] ?? 1;
    const timeStr = String(data.time).trim();
    return {
      title: `Mingguan (${dayName} ${timeStr}): ${task.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'weekly',
      config: {
        day: dayIndex,
        dayName,
        time: timeStr,
        readableTime: `Setiap ${dayName.toUpperCase()} jam ${timeStr} WIB`
      },
      actionType: 'text',
      payload: task
    };
  }

  return null;
}

// Helper pencocokan cron 5 field (menit jam tgl bln hari_dlm_minggu)
function matchCronPart(val, part) {
  if (part === '*') return true;
  if (part.includes('/')) {
    const [, step] = part.split('/');
    return val % parseInt(step, 10) === 0;
  }
  if (part.includes(',')) {
    return part.split(',').map(Number).includes(val);
  }
  return parseInt(part, 10) === val;
}

function matchCronExpression(expr, wibDate) {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [m, h, dom, mon, dow] = parts;
    const curMinute = wibDate.getMinutes();
    const curHour = wibDate.getHours();
    const curDom = wibDate.getDate();
    const curMon = wibDate.getMonth() + 1;
    const curDow = wibDate.getDay();

    return (
      matchCronPart(curMinute, m) &&
      matchCronPart(curHour, h) &&
      matchCronPart(curDom, dom) &&
      matchCronPart(curMon, mon) &&
      matchCronPart(curDow, dow)
    );
  } catch {
    return false;
  }
}

// Cek apakah suatu job harus dijalankan sekarang
function shouldRunJob(job, wibDate) {
  const nowTime = Date.now();
  const curHours = String(wibDate.getHours()).padStart(2, '0');
  const curMinutes = String(wibDate.getMinutes()).padStart(2, '0');
  const curTimeStr = `${curHours}:${curMinutes}`;
  const curDay = wibDate.getDay();

  // Jangan jalankan ulang jika sudah dijalankan di menit yang sama (WIB)
  if (job.lastRunMinute === `${wibDate.getFullYear()}-${wibDate.getMonth()}-${wibDate.getDate()} ${curTimeStr}`) {
    return false;
  }

  // 1. Tipe Sekali Jalan ('once')
  if (job.type === 'once') {
    if (job.config.targetTimestamp && nowTime >= job.config.targetTimestamp) {
      return true;
    }
  }

  // 2. Tipe Harian ('daily')
  if (job.type === 'daily') {
    if (job.config.time === curTimeStr) {
      return true;
    }
  }

  // 3. Tipe Mingguan ('weekly')
  if (job.type === 'weekly') {
    if (job.config.day === curDay && job.config.time === curTimeStr) {
      return true;
    }
  }

  // 4. Tipe Interval ('interval')
  if (job.type === 'interval') {
    const intervalMs = (job.config.intervalMinutes || 60) * 60 * 1000;
    const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : new Date(job.createdAt).getTime();
    if (nowTime - lastRunTime >= intervalMs) {
      return true;
    }
  }

  // 5. Tipe Custom Cron ('cron')
  if (job.type === 'cron' && job.config.cronExpr) {
    if (matchCronExpression(job.config.cronExpr, wibDate)) {
      return true;
    }
  }

  return false;
}

// Inisialisasi loop scheduler
export function startCronScheduler(onTriggerCallback) {
  console.log('[Cron Engine] Scheduler aktif (Zona Waktu: Asia/Jakarta - WIB)');

  const intervalId = setInterval(async () => {
    const jobs = loadJobs();
    if (jobs.length === 0) return;

    const wibDate = getWIBDate();
    const curHours = String(wibDate.getHours()).padStart(2, '0');
    const curMinutes = String(wibDate.getMinutes()).padStart(2, '0');
    const curMinuteKey = `${wibDate.getFullYear()}-${wibDate.getMonth()}-${wibDate.getDate()} ${curHours}:${curMinutes}`;

    let updated = false;
    const remainingJobs = [];

    for (const job of jobs) {
      if (shouldRunJob(job, wibDate)) {
        console.log(`[Cron Engine] ⏰ Memicu jadwal "${job.title}" (${job.id})`);

        job.lastRun = new Date().toISOString();
        job.lastRunMinute = curMinuteKey;
        job.totalRuns = (job.totalRuns || 0) + 1;
        updated = true;

        try {
          await onTriggerCallback(job);
        } catch (err) {
          console.error(`[Cron Engine] Error eksekusi job ${job.id}:`, err.message);
        }

        if (job.type === 'once') {
          console.log(`[Cron Engine] Tugas sekali jalan "${job.title}" selesai dan dihapus.`);
          continue;
        }
      }
      remainingJobs.push(job);
    }

    if (updated) {
      saveJobs(remainingJobs);
    }
  }, 10000);

  return intervalId;
}
