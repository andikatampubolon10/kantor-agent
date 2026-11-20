#!/usr/bin/env node
/**
 * Daftarkan server MCP "joko" ke Antigravity CLI di mesin ini.
 *   npm run setup-mcp            -> daftarkan / perbarui
 *   npm run setup-mcp -- --remove -> hapus
 * Aman dijalankan berulang (agy mcp add memperbarui konfigurasi yang sama).
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGY = process.env.AGY_PATH || (process.platform === 'win32'
  ? path.join(process.env.USERPROFILE || '', '.gemini', 'bin', 'agy.exe')
  : '/home/ubuntu/.local/bin/agy');
const SERVER = path.join(HERE, 'joko-mcp-server.mjs');

const run = (args) => execFileSync(AGY, args, { encoding: 'utf8', windowsHide: true }).trim();

try {
  if (process.argv.includes('--remove')) {
    console.log(run(['mcp', 'remove', 'joko']));
  } else {
    console.log(run(['mcp', 'add', 'joko', process.execPath, SERVER]));
    console.log(run(['mcp', 'list']));
    console.log('\nTool Joko siap. Jalankan/restart Joko agar token tool (.joko-tools-token) tersedia.');
  }
} catch (err) {
  console.error(`Gagal: ${err.stderr || err.message}`);
  process.exit(1);
}
