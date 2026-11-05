#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

// Menentukan root transkrip sesuai format Kantor Agent
const projectDir = fs.realpathSync(process.cwd());
const slug = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
const home = process.env.USERPROFILE || process.env.HOME || '';
const transcriptsRoot = path.join(home, '.claude', 'projects', slug);

const sessionName = 'simulasi-kantor';
const sessionFile = path.join(transcriptsRoot, `${sessionName}.jsonl`);
const subagentsDir = path.join(transcriptsRoot, sessionName, 'subagents');

// Pastikan folder ada
fs.mkdirSync(subagentsDir, { recursive: true });

function appendLog(filePath, data) {
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
}

function writeNewLog(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data) + '\n');
}

const sampleTasks = [
  { type: 'code-reviewer', desc: 'Review kode & optimasi query database', tool: 'Read', file: 'src/database.js' },
  { type: 'tester', desc: 'Menjalankan unit test & coverage', tool: 'Bash', descTool: 'npm test -- --coverage' },
  { type: 'designer', desc: 'Memperbarui styling UI dashboard', tool: 'Write', file: 'src/components/Dashboard.css' },
  { type: 'refactor', desc: 'Refactor handler API authentication', tool: 'Write', file: 'src/api/auth.js' },
  { type: 'devops', desc: 'Menyiapkan konfigurasi Docker & CI/CD pipeline', tool: 'Write', file: 'Dockerfile' },
  { type: 'security-audit', desc: 'Audit celah keamanan dependensi npm', tool: 'Bash', descTool: 'npm audit fix' },
  { type: 'doc-writer', desc: 'Menulis dokumentasi panduan API', tool: 'Write', file: 'docs/api.md' }
];

function getActiveSubagentsFromDisk() {
  const result = [];
  if (!fs.existsSync(subagentsDir)) return result;
  const files = fs.readdirSync(subagentsDir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
  for (const f of files) {
    const fullPath = path.join(subagentsDir, f);
    const id = f.replace('agent-', '').replace('.jsonl', '');
    const metaFile = path.join(subagentsDir, `agent-${id}.meta.json`);
    let desc = 'Subagent ' + id;
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        desc = meta.description || desc;
      } catch {}
    }
    try {
      const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\n').filter(Boolean);
      const lastLine = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      const stop = lastLine?.message?.stop_reason;
      if (stop !== 'end_turn') {
        result.push({ id, desc, logPath: fullPath });
      }
    } catch {}
  }
  return result;
}

function getNextAgentId() {
  if (!fs.existsSync(subagentsDir)) return 101;
  const files = fs.readdirSync(subagentsDir).filter(f => f.startsWith('agent-'));
  const ids = files.map(f => {
    const m = /agent-(\d+)/.exec(f);
    return m ? parseInt(m[1], 10) : 0;
  });
  return ids.length ? Math.max(...ids) + 1 : 101;
}

function jokoBekerja() {
  const now = new Date().toISOString();
  const tools = [
    { type: 'tool_use', name: 'Write', input: { path: 'src/main.js' } },
    { type: 'tool_use', name: 'Bash', input: { description: 'git status & compile build' } },
    { type: 'tool_use', name: 'Edit', input: { path: 'README.md' } }
  ];
  const chosenTool = tools[Math.floor(Math.random() * tools.length)];

  appendLog(sessionFile, {
    type: 'user',
    timestamp: now,
    message: { content: 'Instruksi: Kerjakan fitur utama proyek' }
  });
  appendLog(sessionFile, {
    type: 'assistant',
    timestamp: now,
    message: { content: [chosenTool] }
  });
  console.log(`\x1b[32m✔ Joko (Ketua) mulai bekerja di mejanya! (Aksi: ${chosenTool.name})\x1b[0m`);
}

function panggilSubagent(customDesc) {
  const now = new Date().toISOString();
  const id = getNextAgentId();
  const task = sampleTasks[(id - 101) % sampleTasks.length];
  const desc = customDesc || task.desc;

  const metaPath = path.join(subagentsDir, `agent-${id}.meta.json`);
  const logPath = path.join(subagentsDir, `agent-${id}.jsonl`);

  fs.writeFileSync(metaPath, JSON.stringify({
    agentType: task.type,
    description: desc,
    parentAgentId: null
  }, null, 2));

  const toolObj = task.tool === 'Write' 
    ? { type: 'tool_use', name: 'Write', input: { path: task.file } }
    : { type: 'tool_use', name: 'Bash', input: { description: task.descTool } };

  writeNewLog(logPath, {
    type: 'user',
    timestamp: now,
    message: { content: `Mulai tugas: ${desc}` }
  });
  appendLog(logPath, {
    type: 'assistant',
    timestamp: now,
    message: { content: [toolObj] }
  });

  // Catat juga bahwa Joko memanggil subagent ini di sesi utama
  appendLog(sessionFile, {
    type: 'assistant',
    timestamp: now,
    message: { content: [{ type: 'tool_use', name: 'Agent', input: { description: desc } }] }
  });

  console.log(`\x1b[36m✔ Subagent baru dipanggil (ID: agent-${id}) -> "${desc}"\x1b[0m`);
  console.log(`  (Jika slot tim kosong, Budi/Sari/Agus/Rina akan jalan ke meja. Jika penuh, Freelancer akan datang!)`);
}

function selesaikanSatuSubagent() {
  const active = getActiveSubagentsFromDisk();
  if (active.length === 0) {
    console.log('\x1b[33mTidak ada subagent yang sedang aktif saat ini.\x1b[0m');
    return;
  }
  const item = active[0];
  const now = new Date().toISOString();

  appendLog(item.logPath, {
    type: 'assistant',
    timestamp: now,
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Tugas selesai dengan sukses!' }]
    }
  });
  console.log(`\x1b[32m✔ Subagent agent-${item.id} ("${item.desc}") selesai! Karakter merayakan lalu kembali ke lounge.\x1b[0m`);
}

function panggilBanyak(count) {
  for (let i = 0; i < count; i++) {
    panggilSubagent();
  }
}

function istirahatkanSemua() {
  const now = new Date().toISOString();

  // Selesaikan sesi utama
  appendLog(sessionFile, {
    type: 'assistant',
    timestamp: now,
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Semua pekerjaan sesi utama selesai.' }]
    }
  });

  // Selesaikan semua subagent yang masih aktif di disk
  const active = getActiveSubagentsFromDisk();
  for (const item of active) {
    appendLog(item.logPath, {
      type: 'assistant',
      timestamp: now,
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Selesai.' }]
      }
    });
  }
  console.log(`\x1b[35m✔ ${active.length} subagent diselesaikan! Joko, tim, dan freelancer selesai bekerja.\x1b[0m`);
}

function bersihkanSemua() {
  try {
    if (fs.existsSync(subagentsDir)) {
      fs.rmSync(subagentsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(subagentsDir, { recursive: true });
    if (fs.existsSync(sessionFile)) {
      fs.rmSync(sessionFile, { force: true });
    }
    // Hapus file simulasi lama bila ada
    const oldSim = path.join(transcriptsRoot, 'simulasi-sesi.jsonl');
    if (fs.existsSync(oldSim)) fs.rmSync(oldSim, { force: true });
    const oldSimDir = path.join(transcriptsRoot, 'simulasi-sesi');
    if (fs.existsSync(oldSimDir)) fs.rmSync(oldSimDir, { recursive: true, force: true });
    console.log('\x1b[35m✔ Semua transkrip simulasi dibersihkan! Kantor 3D kembali ke kondisi awal (semua santai).\x1b[0m');
  } catch (err) {
    console.error('Gagal membersihkan:', err.message);
  }
}

let autoInterval = null;
function toggleAutoMode() {
  if (autoInterval) {
    clearInterval(autoInterval);
    autoInterval = null;
    console.log('\x1b[33m⏹ Mode otomatis dihentikan.\x1b[0m');
  } else {
    console.log('\x1b[32m▶ Mode otomatis aktif! Karakter akan dipanggil dan bergantian selesai setiap 5 detik. Tekan 6 lagi untuk berhenti.\x1b[0m');
    autoInterval = setInterval(() => {
      jokoBekerja();
      const active = getActiveSubagentsFromDisk();
      if (active.length < 5 && Math.random() > 0.3) {
        panggilSubagent();
      } else if (active.length > 0) {
        selesaikanSatuSubagent();
      }
    }, 5000);
  }
}

function printMenu() {
  const activeCount = getActiveSubagentsFromDisk().length;
  console.log('\n=========================================');
  console.log('       KANTOR AGENT - CONTROLLER         ');
  console.log('=========================================');
  console.log(' Web Dashboard : http://127.0.0.1:8788/kerja');
  console.log(' Subagent Aktif: ' + activeCount);
  console.log('-----------------------------------------');
  console.log(' [1] Suruh Joko (Ketua) bekerja di mejanya');
  console.log(' [2] Panggil 1 Subagent (Budi/Sari/Agus/Rina)');
  console.log(' [3] Panggil 5 Subagent (Tim Penuh + Freelancer Datang)');
  console.log(' [4] Selesaikan 1 tugas subagent ("Beres! Kembali ke lounge")');
  console.log(' [5] Selesaikan semua tugas (Kembali ke lounge)');
  console.log(' [6] Bersihkan semua data simulasi (Reset total)');
  console.log(' [7] Mode Dinamis Otomatis (On/Off - bergerak sendiri)');
  console.log(' [0] Keluar dari simulator');
  console.log('=========================================');
}

const args = process.argv.slice(2);
if (args.length > 0) {
  const cmd = args[0].toLowerCase();
  if (cmd === 'joko' || cmd === '1') {
    jokoBekerja();
  } else if (cmd === 'panggil' || cmd === 'subagent' || cmd === '2') {
    panggilSubagent(args.slice(1).join(' ') || undefined);
  } else if (cmd === 'freelancer' || cmd === 'penuh' || cmd === '3') {
    panggilBanyak(5);
  } else if (cmd === 'selesai' || cmd === '4') {
    selesaikanSatuSubagent();
  } else if (cmd === 'santai' || cmd === 'reset' || cmd === '5') {
    istirahatkanSemua();
  } else if (cmd === 'bersih' || cmd === 'clean' || cmd === '6') {
    bersihkanSemua();
  } else {
    console.log('Perintah tidak dikenal. Gunakan: joko | panggil [tugas] | penuh | selesai | santai | bersih');
  }
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function promptUser() {
  printMenu();
  rl.question('Pilih opsi [0-7]: ', (ans) => {
    const choice = ans.trim();
    switch (choice) {
      case '1':
        jokoBekerja();
        break;
      case '2':
        panggilSubagent();
        break;
      case '3':
        console.log('Memanggil 5 subagent...');
        panggilBanyak(5);
        break;
      case '4':
        selesaikanSatuSubagent();
        break;
      case '5':
        istirahatkanSemua();
        break;
      case '6':
        bersihkanSemua();
        break;
      case '7':
        toggleAutoMode();
        break;
      case '0':
        console.log('Sampai jumpa!');
        if (autoInterval) clearInterval(autoInterval);
        rl.close();
        process.exit(0);
        return;
      default:
        console.log('\x1b[31mOpsi tidak dikenal.\x1b[0m');
    }
    setTimeout(promptUser, 800);
  });
}

console.log(`\x1b[32mSimulator siap! Terhubung ke: ${transcriptsRoot}\x1b[0m`);
promptUser();
