#!/usr/bin/env node
/**
 * Pasang / hapus connector MCP (Google, Canva, Perplexity) di Antigravity CLI.
 * Biasanya dijalankan lewat pasang-connector.bat (yang meminta kunci rahasia secara tersembunyi).
 *
 *   node setup-connectors.mjs list
 *   node setup-connectors.mjs add google       (butuh env JOKO_GOOGLE_CLIENT_ID & JOKO_GOOGLE_CLIENT_SECRET)
 *   node setup-connectors.mjs add canva        (butuh env JOKO_CANVA_CLIENT_ID & JOKO_CANVA_CLIENT_SECRET)
 *   node setup-connectors.mjs add perplexity   (butuh env JOKO_PERPLEXITY_API_KEY)
 *   node setup-connectors.mjs add github       (butuh env JOKO_GITHUB_TOKEN: token fine-grained baca saja)
 *   node setup-connectors.mjs remove <google|canva|perplexity|github|gmail|drive|calendar>
 *
 * Kunci rahasia dibaca dari environment variable (bukan argumen) agar tidak terlihat di daftar proses.
 */
import {
  CONNECTOR_GROUPS, connectorEntry, readMcpConfig, writeMcpConfig, withConnectors, withoutConnectors,
  defaultMcpConfigPath, defaultMcpCacheDir, connectorStatus, ConnectorError
} from './connectors.mjs';

const file = process.env.JOKO_MCP_CONFIG || defaultMcpConfigPath();
const [cmd, target] = process.argv.slice(2);
const idsOf = (t) => CONNECTOR_GROUPS[t] || (t ? [t] : []);

try {
  const config = readMcpConfig(file);
  if (cmd === 'add') {
    const ids = idsOf(target);
    if (!ids.length) throw new ConnectorError('Sebutkan: google, canva, perplexity, atau github.');
    const isCanva = target === 'canva';
    const secrets = {
      clientId: isCanva ? process.env.JOKO_CANVA_CLIENT_ID : process.env.JOKO_GOOGLE_CLIENT_ID,
      clientSecret: isCanva ? process.env.JOKO_CANVA_CLIENT_SECRET : process.env.JOKO_GOOGLE_CLIENT_SECRET,
      apiKey: target === 'github' ? process.env.JOKO_GITHUB_TOKEN : process.env.JOKO_PERPLEXITY_API_KEY
    };
    const entries = Object.fromEntries(ids.map(id => [id, connectorEntry(id, secrets)]));
    writeMcpConfig(file, withConnectors(config, entries));
    console.log(`Terpasang: ${ids.join(', ')}  (${file})`);
  } else if (cmd === 'remove') {
    const ids = idsOf(target);
    if (!ids.length) throw new ConnectorError('Sebutkan connector yang dihapus.');
    writeMcpConfig(file, withoutConnectors(config, ids));
    console.log(`Dihapus: ${ids.join(', ')}`);
  } else if (cmd === 'list' || !cmd) {
    for (const s of connectorStatus({ config, cacheDir: defaultMcpCacheDir() })) {
      if (!s.available) { console.log(`- ${s.label}: belum tersedia`); continue; }
      const st = !s.installed ? 'belum dipasang' : s.connected ? `tersambung (${s.tools.length} tool)` : 'terpasang, belum login/tersambung';
      console.log(`- ${s.label}: ${st}`);
    }
  } else {
    throw new ConnectorError(`Perintah tidak dikenal: ${cmd}`);
  }
} catch (err) {
  console.error(`Gagal: ${err.message}`);
  process.exit(1);
}
