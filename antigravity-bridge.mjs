#!/usr/bin/env node
/**
 * Antigravity to Kantor Agent Bridge
 * Menghubungkan aktivitas AI Antigravity secara real-time ke kantor 3D (Kantor Agent).
 */
import fs from 'node:fs';
import path from 'node:path';

// 1. Tentukan folder project & root transkrip Kantor Agent
const projectDir = fs.realpathSync(process.cwd());
const slug = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
const home = process.env.USERPROFILE || process.env.HOME || '';
const kantorTranscriptsRoot = path.join(home, '.claude', 'projects', slug);

const sessionName = 'antigravity-session';
const sessionFile = path.join(kantorTranscriptsRoot, `${sessionName}.jsonl`);
const subagentsDir = path.join(kantorTranscriptsRoot, sessionName, 'subagents');

fs.mkdirSync(subagentsDir, { recursive: true });

function appendLog(filePath, data) {
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
}

function cleanPath(p) {
  if (!p || typeof p !== 'string') return '';
  return path.basename(p.replace(/^["'\s]+|["'\s]+$/g, ''));
}
const brainDir = path.join(home, '.gemini', 'antigravity', 'brain');
const explicitId = process.env.ANTIGRAVITY_CONVERSATION_ID || 'c2b1dfa6-0b4f-4d6f-bfcc-ce24a49b3ef6';

function getLatestConversationDir() {
  if (explicitId && fs.existsSync(path.join(brainDir, explicitId))) {
    return { path: path.join(brainDir, explicitId), id: explicitId };
  }
  if (!fs.existsSync(brainDir)) return null;
  const entries = fs.readdirSync(brainDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'tempmediaStorage')
    .map(d => {
      const p = path.join(brainDir, d.name);
      const logP = path.join(p, '.system_generated', 'logs', 'transcript.jsonl');
      const size = fs.existsSync(logP) ? fs.statSync(logP).size : 0;
      return { path: p, mtime: fs.statSync(p).mtimeMs, size, id: d.name };
    })
    .sort((a, b) => b.size - a.size);
  return entries.length ? entries[0] : null;
}

const activeConv = getLatestConversationDir();
if (!activeConv) {
  console.error('[Bridge] Folder Antigravity brain tidak ditemukan di:', brainDir);
  process.exit(1);
}

const transcriptPath = path.join(activeConv.path, '.system_generated', 'logs', 'transcript.jsonl');
console.log(`\x1b[32m[Antigravity Bridge Aktif]\x1b[0m`);
console.log(`- Memantau Sesi Antigravity: ${activeConv.id}`);
console.log(`- Sumber Log               : ${transcriptPath}`);
console.log(`- Kantor Agent Dashboard   : http://127.0.0.1:8788/kerja`);

let lastProcessedLine = 0;
const activeSubagents = new Map(); // id -> meta

function processLine(rawLine) {
  if (!rawLine.trim()) return;
  let entry;
  try {
    entry = JSON.parse(rawLine);
  } catch {
    return;
  }

  const nowIso = entry.created_at || new Date().toISOString();

  // 1. Saat user mengirim instruksi
  if (entry.type === 'USER_INPUT') {
    appendLog(sessionFile, {
      type: 'user',
      timestamp: nowIso,
      message: { content: typeof entry.content === 'string' ? entry.content.slice(0, 200) : 'Instruksi user' }
    });
    console.log(`\x1b[36m[Antigravity] User memberi instruksi -> Joko bersiap di mejanya.\x1b[0m`);
    return;
  }

  // 2. Saat Antigravity menjalankan tools
  if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
    for (const tool of entry.tool_calls) {
      const name = tool.name;
      const args = tool.args || {};

      if (name === 'invoke_subagent') {
        const subId = Math.floor(100 + Math.random() * 900);
        const role = args.Role || 'Subagent';
        const prompt = args.Prompt || 'Menjalankan tugas';

        const metaPath = path.join(subagentsDir, `agent-${subId}.meta.json`);
        const subLogPath = path.join(subagentsDir, `agent-${subId}.jsonl`);

        fs.writeFileSync(metaPath, JSON.stringify({ agentType: role, description: prompt, parentAgentId: null }));
        appendLog(subLogPath, {
          type: 'user',
          timestamp: nowIso,
          message: { content: prompt }
        });
        appendLog(subLogPath, {
          type: 'assistant',
          timestamp: nowIso,
          message: { content: [{ type: 'tool_use', name: 'Read', input: { path: role } }] }
        });

        appendLog(sessionFile, {
          type: 'assistant',
          timestamp: nowIso,
          message: { content: [{ type: 'tool_use', name: 'Agent', input: { description: prompt } }] }
        });

        activeSubagents.set(subId, { subLogPath, role, prompt });
        console.log(`\x1b[35m[Antigravity] Subagent dipanggil (${role}) -> Anggota tim berjalan ke meja!\x1b[0m`);
      } else if (name === 'write_file' || name === 'edit_file') {
        const filePath = cleanPath(args.Path) || 'code.js';
        appendLog(sessionFile, {
          type: 'assistant',
          timestamp: nowIso,
          message: { content: [{ type: 'tool_use', name: 'Write', input: { path: filePath, file_path: filePath } }] }
        });
        console.log(`\x1b[32m[Antigravity] Menulis file (${filePath}) -> Joko mengetik di mejanya.\x1b[0m`);
      } else if (name === 'run_command') {
        const desc = (args.toolSummary || 'Eksekusi terminal').replace(/^["'\s]+|["'\s]+$/g, '');
        appendLog(sessionFile, {
          type: 'assistant',
          timestamp: nowIso,
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: desc } }] }
        });
        console.log(`\x1b[33m[Antigravity] Terminal (${desc}) -> Joko mengoperasikan terminal.\x1b[0m`);
      } else if (name === 'read_file') {
        const filePath = cleanPath(args.Path) || 'file';
        appendLog(sessionFile, {
          type: 'assistant',
          timestamp: nowIso,
          message: { content: [{ type: 'tool_use', name: 'Read', input: { path: filePath, file_path: filePath } }] }
        });
        console.log(`\x1b[34m[Antigravity] Membaca file (${filePath}) -> Joko memeriksa dokumen.\x1b[0m`);
      } else {
        appendLog(sessionFile, {
          type: 'assistant',
          timestamp: nowIso,
          message: { content: [{ type: 'tool_use', name: name, input: {} }] }
        });
      }
    }
    return;
  }

  // 3. Saat Antigravity merespons teks dan selesai
  if (entry.source === 'MODEL' && entry.status === 'DONE' && (!entry.tool_calls || entry.tool_calls.length === 0)) {
    // Selesaikan sesi utama
    appendLog(sessionFile, {
      type: 'assistant',
      timestamp: nowIso,
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Selesai menjawab user.' }]
      }
    });

    // Selesaikan subagents bila ada
    for (const [subId, subData] of activeSubagents.entries()) {
      appendLog(subData.subLogPath, {
        type: 'assistant',
        timestamp: nowIso,
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Subagent selesai.' }]
        }
      });
      activeSubagents.delete(subId);
    }
    console.log(`\x1b[32m[Antigravity] Turn selesai -> Joko dan tim santai kembali ke lounge.\x1b[0m`);
  }
}

function pollTranscript() {
  if (!fs.existsSync(transcriptPath)) return;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > lastProcessedLine) {
      for (let i = lastProcessedLine; i < lines.length; i++) {
        processLine(lines[i]);
      }
      lastProcessedLine = lines.length;
    }
  } catch (err) {
    // Abaikan jika file sedang ditulis bersamaan
  }
}

// Inisialisasi awal: proses dari beberapa baris terakhir
if (fs.existsSync(transcriptPath)) {
  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  lastProcessedLine = Math.max(0, lines.length - 10);
  console.log(`[Bridge] Sinkronisasi awal dimulai dari baris ${lastProcessedLine}...`);
}

// Loop pemantau berkala tiap 1 detik
setInterval(pollTranscript, 1000);

