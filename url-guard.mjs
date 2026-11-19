/**
 * URL Guard (anti-SSRF) untuk Web Intelligence Joko.
 * Hanya mengizinkan URL http/https publik: setiap alamat IP hasil DNS diperiksa dan
 * alamat loopback, jaringan privat, link-local (termasuk metadata cloud 169.254.169.254),
 * CGNAT, multicast, dan rentang khusus lainnya ditolak.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const BLOCKED_HOSTNAMES = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp|metadata|metadata\.google\.internal)$/i;

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // privat
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local + metadata cloud
  ['172.16.0.0', 12],    // privat
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay
  ['192.168.0.0', 16],   // privat
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4]       // reserved + broadcast
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip) >>> 0;
  return BLOCKED_V4.some(({ base, mask }) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

function expandIPv6(ip) {
  let addr = ip.toLowerCase().split('%')[0];
  // IPv4 di ekor (mis. ::ffff:127.0.0.1)
  const v4Tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const n = ipv4ToInt(v4Tail[1]);
    addr = addr.replace(v4Tail[1], `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = addr.includes('::')
    ? [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts]
    : headParts;
  return parts.map(p => parseInt(p || '0', 16));
}

function isBlockedIPv6(ip) {
  const p = expandIPv6(ip);
  if (p.length !== 8 || p.some(n => Number.isNaN(n))) return true;
  const allZeroPrefix = (count) => p.slice(0, count).every(n => n === 0);
  if (p.every(n => n === 0)) return true;                                  // ::
  if (allZeroPrefix(7) && p[7] === 1) return true;                          // ::1
  if (allZeroPrefix(5) && p[5] === 0xffff) {                                // ::ffff:a.b.c.d
    return isBlockedIPv4(`${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`);
  }
  if (allZeroPrefix(6)) return true;                                        // ::a.b.c.d (deprecated)
  if (p[0] === 0x64 && p[1] === 0xff9b) {                                   // 64:ff9b::/96 NAT64
    return isBlockedIPv4(`${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`);
  }
  if ((p[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true;                              // fe80::/10 link-local
  if ((p[0] & 0xff00) === 0xff00) return true;                              // ff00::/8 multicast
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true;                      // dokumentasi
  return false;
}

/** true bila alamat IP termasuk rentang yang tidak boleh diakses. */
export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

/** Validasi sintaks URL (tanpa DNS). Melempar UnsafeUrlError bila ditolak. */
export function parseSafeUrlSyntax(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new UnsafeUrlError('URL tidak valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Hanya tautan http/https yang didukung.');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Tautan dengan kredensial tidak diizinkan.');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeUrlError('Port tautan tidak diizinkan.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || BLOCKED_HOSTNAMES.test(host)) {
    throw new UnsafeUrlError('Alamat tautan tidak diizinkan.');
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new UnsafeUrlError('Alamat tautan tidak diizinkan.');
  }
  // Catatan: parser WHATWG URL sudah menormalkan bentuk IP desimal/heksa/oktal
  // (mis. http://2130706433/ -> 127.0.0.1), sehingga tertangkap oleh pemeriksaan di atas.
  return { url, host };
}

/**
 * Validasi penuh: sintaks + semua alamat hasil DNS harus publik.
 * @returns {Promise<URL>}
 */
export async function assertPublicHttpUrl(rawUrl, { lookup = dns.lookup } = {}) {
  const { url, host } = parseSafeUrlSyntax(rawUrl);
  if (net.isIP(host)) return url;

  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('Domain tautan tidak dapat ditemukan.');
  }
  if (!addresses || addresses.length === 0 || addresses.some(a => isBlockedIp(a.address))) {
    throw new UnsafeUrlError('Alamat tautan tidak diizinkan.');
  }
  return url;
}

/** Ambil URL pertama dari teks dan buang tanda baca penutup kalimat. */
export function extractFirstUrl(text) {
  const m = String(text ?? '').match(/https?:\/\/[^\s<>"'`]+/i);
  if (!m) return null;
  return m[0].replace(/[.,!?;:)\]}>*_~]+$/, '');
}
