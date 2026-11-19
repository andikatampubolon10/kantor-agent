import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, assertPublicHttpUrl, extractFirstUrl, UnsafeUrlError } from '../url-guard.mjs';

// DNS palsu agar tes tidak bergantung jaringan
const fakeLookup = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('[#9] IP internal diblokir, IP publik diizinkan', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('[#9] URL berbahaya ditolak', async () => {
  const lookup = fakeLookup({ 'evil.example': ['127.0.0.1'], 'mixed.example': ['93.184.216.34', '10.0.0.5'] });
  for (const url of [
    'http://127.0.0.1:8795/test-send',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',            // 127.0.0.1 dalam bentuk desimal
    'http://0x7f.0.0.1/',
    'http://[::1]/',
    'http://localhost/',
    'http://printer.local/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://user:pass@example.com/',
    'http://example.com:22/',
    'http://evil.example/',          // DNS mengarah ke loopback
    'http://mixed.example/',         // salah satu alamat privat
    'http://tidak-ada.example/'
  ]) {
    await assert.rejects(assertPublicHttpUrl(url, { lookup }), UnsafeUrlError, url);
  }
});

test('URL publik diizinkan', async () => {
  const lookup = fakeLookup({ 'news.example.com': ['93.184.216.34'] });
  const url = await assertPublicHttpUrl('https://news.example.com/artikel?id=1', { lookup });
  assert.equal(url.hostname, 'news.example.com');
  await assertPublicHttpUrl('http://8.8.8.8/', { lookup });
});

test('ekstraksi URL membuang tanda baca penutup', () => {
  assert.equal(extractFirstUrl('Joko rangkum https://contoh.com/a-b?x=1. makasih'), 'https://contoh.com/a-b?x=1');
  assert.equal(extractFirstUrl('(lihat https://contoh.com/x)'), 'https://contoh.com/x');
  assert.equal(extractFirstUrl('tanpa link'), null);
});
