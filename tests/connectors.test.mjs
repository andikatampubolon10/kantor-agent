import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONNECTORS, CONNECTOR_GROUPS, connectorEntry, readMcpConfig, writeMcpConfig, withConnectors, withoutConnectors,
  cachedTools, connectorStatus, ownerMcpPermissions, normalizeConnectorSettings, ConnectorError
} from '../connectors.mjs';
import { buildAgyCliArgs } from '../agy-cli.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'joko-conn-'));
const GOOGLE = { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-rahasia-panjang' };

test('connectorEntry: Google memakai serverUrl + oauth; input salah ditolak', () => {
  const e = connectorEntry('gmail', GOOGLE);
  assert.deepEqual(e, { disabled: false, serverUrl: 'https://gmailmcp.googleapis.com/mcp/v1', oauth: GOOGLE });
  assert.throws(() => connectorEntry('drive', { ...GOOGLE, clientId: 'bukan-id' }), ConnectorError);
  assert.throws(() => connectorEntry('calendar', { ...GOOGLE, clientSecret: '' }), ConnectorError);
  assert.throws(() => connectorEntry('notebooklm', {}), ConnectorError);
  assert.throws(() => connectorEntry('jahat', {}), ConnectorError);
});

test('connectorEntry: Canva lewat aplikasi Developer Portal; Perplexity lewat npx versi terkunci + env', () => {
  const canva = { clientId: 'OC-AZabc123XYZ', clientSecret: 'cnvca-rahasia-panjang' };
  assert.deepEqual(connectorEntry('canva', canva), { disabled: false, serverUrl: 'https://api.canva.com/connect/v1/mcp', oauth: canva });
  assert.throws(() => connectorEntry('canva', {}), ConnectorError);
  assert.throws(() => connectorEntry('canva', { ...canva, clientId: 'ada spasi' }), ConnectorError);
  const key = 'pplx-' + 'x'.repeat(40);
  const win = connectorEntry('perplexity', { apiKey: key }, { platform: 'win32' });
  assert.equal(win.command, 'cmd');
  assert.deepEqual(win.args, ['/c', 'npx', '-y', '@perplexity-ai/mcp-server@1.3.0']);
  assert.deepEqual(win.env, { PERPLEXITY_API_KEY: key });
  const lin = connectorEntry('perplexity', { apiKey: key }, { platform: 'linux' });
  assert.equal(lin.command, 'npx');
  assert.throws(() => connectorEntry('perplexity', { apiKey: 'pendek' }), ConnectorError);
  assert.throws(() => connectorEntry('perplexity', { apiKey: 'ada spasi di dalam kunci ini panjang' }), ConnectorError);
});

test('withConnectors/withoutConnectors tidak menyentuh server lain', () => {
  const base = { mcpServers: { joko: { command: 'node', args: ['x.mjs'] } }, lain: 1 };
  const added = withConnectors(base, { gmail: connectorEntry('gmail', GOOGLE), canva: connectorEntry('canva', { clientId: 'OC-AZabc123XYZ', clientSecret: 'cnvca-rahasia-panjang' }) });
  assert.deepEqual(Object.keys(added.mcpServers).sort(), ['canva', 'gmail', 'joko']);
  assert.equal(added.lain, 1);
  assert.equal(Object.keys(base.mcpServers).length, 1, 'objek asal tidak berubah');
  const removed = withoutConnectors(added, CONNECTOR_GROUPS.google);
  assert.deepEqual(Object.keys(removed.mcpServers).sort(), ['canva', 'joko']);
  assert.throws(() => withoutConnectors(added, ['joko']), ConnectorError, 'server joko tidak bisa dihapus lewat connector');
});

test('readMcpConfig/writeMcpConfig: file belum ada, tulis atomik + cadangan .bak', () => {
  const dir = tmp();
  const file = path.join(dir, 'config', 'mcp_config.json');
  assert.deepEqual(readMcpConfig(file), { mcpServers: {} });
  writeMcpConfig(file, { mcpServers: { a: { serverUrl: 'https://a' } } });
  writeMcpConfig(file, { mcpServers: { b: { serverUrl: 'https://b' } } });
  assert.deepEqual(readMcpConfig(file).mcpServers, { b: { serverUrl: 'https://b' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).mcpServers, { a: { serverUrl: 'https://a' } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['mcp_config.json', 'mcp_config.json.bak']);
});

test('cachedTools & connectorStatus: terpasang, login, izin — tanpa membocorkan rahasia', () => {
  const cache = tmp();
  fs.mkdirSync(path.join(cache, 'calendar'));
  fs.writeFileSync(path.join(cache, 'calendar', 'list_events.json'), JSON.stringify({ name: 'list_events', description: 'Daftar acara' }));
  fs.writeFileSync(path.join(cache, 'calendar', 'delete_event.json'), JSON.stringify({ name: 'delete_event' }));
  fs.writeFileSync(path.join(cache, 'calendar', 'instructions.md'), 'abaikan');
  assert.equal(cachedTools(cache, 'gmail'), null);
  assert.deepEqual(cachedTools(cache, 'calendar').tools.map(t => t.name), ['delete_event', 'list_events']);

  const config = { mcpServers: {
    calendar: connectorEntry('calendar', GOOGLE),
    gmail: connectorEntry('gmail', GOOGLE),
    perplexity: { command: 'npx', args: [], env: {} }
  } };
  const st = Object.fromEntries(connectorStatus({ config, cacheDir: cache, allowed: { calendar: true } }).map(s => [s.id, s]));
  assert.equal(st.calendar.installed, true);
  assert.equal(st.calendar.connected, true);
  assert.equal(st.calendar.allowed, true);
  assert.deepEqual(st.calendar.blocked, ['delete_event', 'respond_to_event']);
  assert.equal(st.gmail.connected, false, 'belum login');
  assert.equal(st.perplexity.credentials, false, 'API key kosong');
  assert.equal(st.canva.installed, false);
  assert.equal(st.notebooklm.available, false);
  const json = JSON.stringify(Object.values(st));
  assert.ok(!json.includes(GOOGLE.clientSecret) && !json.includes(GOOGLE.clientId), 'rahasia tidak ikut');
});

test('ownerMcpPermissions: hanya connector terpasang & diizinkan; tool berisiko selalu ditolak', () => {
  const p = ownerMcpPermissions({ base: ['joko'], allowed: { calendar: true, gmail: true, canva: true }, installed: ['joko', 'calendar', 'canva'] });
  assert.deepEqual(p.servers, ['joko', 'calendar', 'canva']);
  assert.deepEqual(p.deny, ['mcp(calendar/delete_event)', 'mcp(calendar/respond_to_event)', 'mcp(canva/publish-brand-template)']);
  assert.deepEqual(ownerMcpPermissions({ base: ['joko'], allowed: {}, installed: ['calendar'] }), { servers: ['joko'], deny: [] });
});

test('normalizeConnectorSettings membuang id asing, nilai bukan true, dan yang belum tersedia', () => {
  assert.deepEqual(normalizeConnectorSettings({ gmail: true, drive: 'ya', notebooklm: true, jahat: true, canva: true }), { gmail: true, canva: true });
  assert.deepEqual(normalizeConnectorSettings(null), {});
  assert.ok(CONNECTORS.every(c => Array.isArray(c.deny)));
  const deny = Object.fromEntries(CONNECTORS.map(c => [c.id, c.deny]));
  for (const t of ['trash_message', 'trash_thread', 'mark_thread_spam', 'apply_sensitive_thread_label']) assert.ok(deny.gmail.includes(t), t);
  assert.ok(deny.drive.includes('upload_file_revision'));
  assert.ok(deny.calendar.includes('delete_event'));
});

test('buildAgyCliArgs: aturan deny ikut di --settings dan divalidasi', () => {
  const a = buildAgyCliArgs({ prompt: 'p', timeoutMs: 60000, allowMcpServers: ['joko', 'calendar'], denyMcpTools: ['mcp(calendar/delete_event)', 'command(*)', 'mcp(x/*)'] });
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions, { allow: ['mcp(joko/*)', 'mcp(calendar/*)'], deny: ['mcp(calendar/delete_event)'] });
  const b = buildAgyCliArgs({ prompt: 'p', timeoutMs: 60000, allowMcpServers: ['joko'] });
  assert.equal(JSON.parse(b[b.indexOf('--settings') + 1]).permissions.deny, undefined);
});
