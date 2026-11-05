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

// Parser Bahasa Alami WhatsApp untuk membuat Jadwal/Pengingat
export function parseScheduleCommand(text, creatorNumber, creatorName, targetRecipient) {
  const cleaned = text.trim();
  const wibNow = getWIBDate();
  const nowMs = Date.now();

  // 1. "ingatkan saya X menit/jam lagi untuk [pesan]"
  const relMatch = cleaned.match(/^(?:ingatkan(?:\s+saya)?|remind(?:\s+me)?)\s+(\d+)\s*(menit|jam|detik)\s+lagi\s+(?:untuk\s+)?(.+)/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const task = relMatch[3].trim();
    let delayMs = amount * 60 * 1000;
    if (unit === 'jam') delayMs = amount * 60 * 60 * 1000;
    if (unit === 'detik') delayMs = amount * 1000;

    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');

    return {
      title: `Pengingat (${amount} ${unit}): ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'once',
      config: {
        targetTimestamp: nowMs + delayMs,
        readableTime: `${amount} ${unit} lagi`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // 2. "ingatkan saya besok jam HH:MM untuk [pesan]"
  const besokMatch = cleaned.match(/^(?:ingatkan(?:\s+saya)?|remind(?:\s+me)?)\s+besok\s+jam\s+(\d{1,2})[:.](\d{2})\s*(?:wib)?\s+(?:untuk\s+)?(.+)/i);
  if (besokMatch) {
    const h = parseInt(besokMatch[1], 10);
    const m = parseInt(besokMatch[2], 10);
    const task = besokMatch[3].trim();

    // Besok di WIB
    const targetWib = new Date(wibNow);
    targetWib.setDate(targetWib.getDate() + 1);
    targetWib.setHours(h, m, 0, 0);

    const diffMs = targetWib.getTime() - wibNow.getTime();
    const targetTimestamp = nowMs + diffMs;

    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    return {
      title: `Pengingat Besok ${timeStr}: ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'once',
      config: {
        targetTimestamp,
        readableTime: `Besok jam ${timeStr} WIB`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // 3. "ingatkan saya jam HH:MM untuk [pesan]" (Hari ini atau besok jika jam sudah lewat)
  const jamMatch = cleaned.match(/^(?:ingatkan(?:\s+saya)?|remind(?:\s+me)?)\s+jam\s+(\d{1,2})[:.](\d{2})\s*(?:wib)?\s+(?:untuk\s+)?(.+)/i);
  if (jamMatch) {
    const h = parseInt(jamMatch[1], 10);
    const m = parseInt(jamMatch[2], 10);
    const task = jamMatch[3].trim();

    const targetWib = new Date(wibNow);
    targetWib.setHours(h, m, 0, 0);
    if (targetWib.getTime() <= wibNow.getTime()) {
      // Jika jam sudah lewat hari ini, jadwalkan besok
      targetWib.setDate(targetWib.getDate() + 1);
    }

    const diffMs = targetWib.getTime() - wibNow.getTime();
    const targetTimestamp = nowMs + diffMs;
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    const isAI = /^ai:\s*/i.test(task);
    const actualTask = task.replace(/^ai:\s*/i, '');

    return {
      title: `Pengingat Jam ${timeStr}: ${actualTask.slice(0, 30)}`,
      creator: creatorNumber,
      creatorName,
      target: targetRecipient,
      type: 'once',
      config: {
        targetTimestamp,
        readableTime: `Jam ${timeStr} WIB`
      },
      actionType: isAI ? 'ai_prompt' : 'text',
      payload: actualTask
    };
  }

  // 4. "jadwalkan setiap hari jam HH:MM [pesan]"
  const dailyMatch = cleaned.match(/^jadwalkan\s+setiap\s+hari\s+jam\s+(\d{1,2})[:.](\d{2})\s*(?:wib)?\s+(.+)/i);
  if (dailyMatch) {
    const h = parseInt(dailyMatch[1], 10);
    const m = parseInt(dailyMatch[2], 10);
    const task = dailyMatch[3].trim();
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

  // 5. "jadwalkan setiap [senin/selasa/...] jam HH:MM [pesan]"
  const weeklyMatch = cleaned.match(/^jadwalkan\s+setiap\s+(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)\s+jam\s+(\d{1,2})[:.](\d{2})\s*(?:wib)?\s+(.+)/i);
  if (weeklyMatch) {
    const dayName = weeklyMatch[1].toLowerCase();
    const dayIndex = HARI_MAP[dayName];
    const h = parseInt(weeklyMatch[2], 10);
    const m = parseInt(weeklyMatch[3], 10);
    const task = weeklyMatch[4].trim();
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

  // 6. "jadwalkan setiap X menit/jam [pesan]"
  const intervalMatch = cleaned.match(/^jadwalkan\s+setiap\s+(\d+)\s*(menit|jam)\s+(.+)/i);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const task = intervalMatch[3].trim();
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

  // 7. "jadwalkan cron '0 8 * * *' [pesan]"
  const cronMatch = cleaned.match(/^jadwalkan\s+cron\s+["']([^"']+)["']\s+(.+)/i);
  if (cronMatch) {
    const cronExpr = cronMatch[1].trim();
    const task = cronMatch[2].trim();

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
  }, 25000);

  return intervalId;
}
