import mqtt from 'mqtt';
import fs from 'node:fs';
import path from 'node:path';

const TJ_API_BASE = 'https://tijeapi.transjakarta.co.id/v1';
const TJ_MQTT_URL = 'wss://mqtt.tj.co.id:8084/mqtt';
const CACHE_DIR = path.join(process.cwd(), '.tj-cache');

if (!fs.existsSync(CACHE_DIR)) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
}

const TJ_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'okhttp/4.12.0',
  'X-App-OS': 'android',
  'X-App-Version': '2.10.2',
  'X-Device-ID': 'tj-joko-assistant'
};

let cachedGuestToken = null;
let tokenExpiresAt = 0;

// Helper login guest TJ API
export async function getTJToken() {
  const now = Date.now();
  if (cachedGuestToken && tokenExpiresAt > now + 60000) {
    return cachedGuestToken;
  }

  try {
    const res = await fetch(`${TJ_API_BASE}/auth/login/guest`, {
      method: 'POST',
      headers: TJ_HEADERS,
      body: JSON.stringify({ device_id: 'tj-joko-assistant' })
    });
    const data = await res.json();
    if (data.token) {
      cachedGuestToken = data.token;
      tokenExpiresAt = (data.token_valid_until ? data.token_valid_until * 1000 : now + 3600000);
      return cachedGuestToken;
    }
  } catch (err) {
    console.error('[TJ Tracker] Error login guest:', err.message);
  }
  return null;
}

// Memory Cache untuk rute & halte
const routeCache = new Map();

// Ambil detail rute (termasuk urutan halte)
export async function getRouteDetail(routeId) {
  const id = String(routeId).toUpperCase().trim();
  if (routeCache.has(id)) {
    return routeCache.get(id);
  }

  const cacheFile = path.join(CACHE_DIR, `route_${id}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      routeCache.set(id, data);
      return data;
    } catch {}
  }

  const token = await getTJToken();
  if (!token) return null;

  try {
    const res = await fetch(`${TJ_API_BASE}/route/${encodeURIComponent(id)}`, {
      headers: { ...TJ_HEADERS, 'Authorization': `Bearer ${token}` }
    });
    const result = await res.json();
    if (result.code === 200 && result.data) {
      routeCache.set(id, result.data);
      try { fs.writeFileSync(cacheFile, JSON.stringify(result.data, null, 2)); } catch {}
      return result.data;
    }
  } catch (err) {
    console.error(`[TJ Tracker] Error getRouteDetail ${id}:`, err.message);
  }
  return null;
}

// In-Memory Live Armada Map (Key: bus_body_no)
const liveBuses = new Map();
let mqttClient = null;
let isConnected = false;

// Mulai koneksi background MQTT ke TransJakarta
export function startTJTracker() {
  if (mqttClient) return;

  console.log('[TJ Tracker] Menghubungkan ke live MQTT feed Transjakarta...');
  mqttClient = mqtt.connect(TJ_MQTT_URL, {
    protocolVersion: 4,
    clean: true,
    connectTimeout: 15000,
    reconnectPeriod: 5000
  });

  mqttClient.on('connect', () => {
    isConnected = true;
    console.log('[TJ Tracker] ✅ Terhubung ke live GPS broker TransJakarta (wss://mqtt.tj.co.id:8084/mqtt)');
    mqttClient.subscribe('/mobile_armada/#', { qos: 0 }, (err) => {
      if (err) {
        console.error('[TJ Tracker] Subscribe error:', err.message);
      } else {
        console.log('[TJ Tracker] 📡 Berhasil subscribe ke seluruh armada live TransJakarta (/mobile_armada/#)');
      }
    });
  });

  mqttClient.on('message', (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      if (data && data.bus_body_no && data.route_code) {
        liveBuses.set(data.bus_body_no, {
          ...data,
          topic,
          receivedAt: Date.now()
        });
      }
    } catch (e) {}
  });

  mqttClient.on('error', (err) => {
    console.error('[TJ Tracker] MQTT error:', err.message);
  });

  mqttClient.on('close', () => {
    isConnected = false;
  });

  // Prune armada yang sudah offline lebih dari 10 menit
  setInterval(() => {
    const now = Date.now();
    for (const [bodyNo, bus] of liveBuses.entries()) {
      if (now - bus.receivedAt > 600000) {
        liveBuses.delete(bodyNo);
      }
    }
  }, 120000);
}

// Ambil semua armada live untuk suatu rute (misal '10H', '1', '9', dll)
export function getLiveBusesByRoute(routeCode) {
  const code = String(routeCode).toUpperCase().trim();
  const results = [];
  for (const bus of liveBuses.values()) {
    if (bus.route_code && bus.route_code.toUpperCase() === code) {
      results.push(bus);
    }
  }
  return results;
}

// Cari nama halte yang cocok berdasarkan alias / query
export function findMatchingStop(stops, query) {
  if (!query || !Array.isArray(stops)) return null;
  const q = query.toLowerCase().replace(/^(?:halte|stasiun)\s+/i, '').replace(/^(?:tj|transjakarta)\s+/i, '').trim();

  // Alias umum Transjakarta
  const aliases = {
    'senayan bank jakarta': ['senayan bank jakarta', 'gelora bung karno', 'gbk', 'senayan'],
    'bundaran senayan': ['bundaran senayan', 'bunsen'],
    'petamburan': ['petamburan', 'slipi petamburan'],
    'gerbang pemuda': ['gerbang pemuda', 'taman ria'],
    'pasar baru': ['pasar baru', 'pasar baru timur'],
    'tanjung priok': ['tanjung priok', 'priok'],
    'tomang': ['tomang', 'tomang raya'],
    'kemanggisan': ['kemanggisan', 'slipi kemanggisan'],
    'kota bambu': ['kota bambu'],
    'harmoni': ['harmoni'],
    'monas': ['monas', 'monumen nasional'],
    'tosari': ['tosari'],
    'dukuh atas': ['dukuh atas', 'galunggung'],
    'karet': ['karet', 'karet sudirman'],
    'semanggi': ['semanggi', 'bendungan hilir', 'benhil']
  };

  for (const s of stops) {
    const nameLower = s.stop_name.toLowerCase();
    if (nameLower.includes(q) || q.includes(nameLower)) {
      return s;
    }
    for (const [key, aliasList] of Object.entries(aliases)) {
      if (nameLower.includes(key)) {
        if (aliasList.some(a => q.includes(a))) {
          return s;
        }
      }
    }
  }
  return null;
}

// Query cerdas untuk informasi transit real-time
export async function getLiveTransitInfo({ origin, destination, corridor }) {
  const corridorCode = (corridor || '10H').toUpperCase().trim();
  const routeData = await getRouteDetail(corridorCode);

  if (!routeData) {
    return {
      success: false,
      message: `Rute koridor ${corridorCode} tidak ditemukan di sistem Transjakarta saat ini.`
    };
  }

  const routeInfo = routeData.route || {};
  const allStops = routeData.loop?.stops || routeData.inbound?.stops || routeData.outbound?.stops || [];

  if (allStops.length === 0) {
    return {
      success: false,
      message: `Daftar halte untuk koridor ${corridorCode} (${routeInfo.route_long_name || ''}) belum tersedia.`
    };
  }

  // Cari halte asal dan halte tujuan di dalam daftar rute
  const originStop = findMatchingStop(allStops, origin || 'Senayan Bank Jakarta');
  const destStop = destination ? findMatchingStop(allStops, destination) : null;

  // Cari posisi armada live dari MQTT
  const activeBuses = getLiveBusesByRoute(corridorCode);

  // Kumpulkan semua bus yang relevan dengan halte asal
  const busesWithEta = [];

  for (const bus of activeBuses) {
    const etas = bus.eta_by_parent_stop_id || bus.eta_by_stop || {};
    let originEta = null;
    let destEta = null;

    if (originStop && etas[originStop.stop_id] !== undefined) {
      originEta = etas[originStop.stop_id];
    }
    if (destStop && etas[destStop.stop_id] !== undefined) {
      destEta = etas[destStop.stop_id];
    }

    // Jika bus sedang menuju ke arah halte tujuan (atau punya ETA valid)
    busesWithEta.push({
      bodyNo: bus.bus_body_no,
      currStop: bus.curr_stops || '',
      nextStop: bus.next_stops || '',
      headsign: bus.trip_headsign || bus.route_long_name || '',
      speed: bus.speed || 0,
      lat: bus.latitude,
      lon: bus.longitude,
      etaOriginMinutes: originEta,
      etaDestMinutes: destEta
    });
  }

  // Urutkan bus berdasarkan yang paling cepat tiba di halte asal (ETA terkecil)
  busesWithEta.sort((a, b) => {
    if (a.etaOriginMinutes === null) return 1;
    if (b.etaOriginMinutes === null) return -1;
    return a.etaOriginMinutes - b.etaOriginMinutes;
  });

  return {
    success: true,
    corridor: corridorCode,
    routeName: routeInfo.route_long_name || 'Rute Transjakarta',
    price: routeInfo.price || 3500,
    originStop: originStop ? originStop.stop_name : (origin || 'Halte Asal'),
    originStopId: originStop ? originStop.stop_id : null,
    destStop: destStop ? destStop.stop_name : (destination || null),
    destStopId: destStop ? destStop.stop_id : null,
    activeBusCount: activeBuses.length,
    buses: busesWithEta,
    operatingHours: `${routeInfo.start_time || '05:00:00'} - ${routeInfo.end_time || '22:00:00'} WIB`
  };
}

// Parser deteksi apakah user menanyakan Transjakarta
export function isTransjakartaQuery(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /(?:transjakarta|\btj\b|busway)/i.test(t) ||
    /(?:koridor\s*[0-9]{1,2}[a-z]?|bus\s*[0-9]{1,2}[a-z]?)/i.test(t) ||
    /(?:halte|stasiun\s+brt)/i.test(t) && /(?:bus|nyampe|kapan|lama|berapa\s+menit)/i.test(t)
  );
}

// Ekstraksi parameter asal, tujuan, dan koridor dari teks user
export function extractTransitParams(text) {
  const t = text.toLowerCase();

  // Ekstrak koridor (misal: 10H, 1, 9, 3F, 4B, JAK.102, dll)
  let corridor = null;
  const corridorMatch = t.match(/(?:koridor|rute|bus)\s*([0-9]{1,2}[a-z]?|jak\.?[0-9]{1,3})\b/i);
  if (corridorMatch) {
    corridor = corridorMatch[1].toUpperCase();
  }

  // Ekstrak halte asal ("di halte TJ Senayan Bank Jakarta", "dari halte GBK")
  let origin = null;
  const originMatch = t.match(/(?:sekarang\s+)?(?:di|dari)\s+(?:halte\s+)?(?:tj\s+)?([^,.]+?)(?:\s+(?:coba|mau|ke|arah|berapa|tolong|jadwal)|,|$)/i);
  if (originMatch) {
    origin = originMatch[1].trim();
  }

  // Ekstrak halte tujuan ("mau ke arah Petamburan", "ke Petamburan", "arah Tanjung Priok")
  let destination = null;
  const destMatch = t.match(/(?:mau\s+)?(?:ke|arah|tujuan|turun\s+di)\s+(?:halte\s+)?(?:tj\s+)?([^,.]+?)(?:\s+(?:coba|berapa|naik|tolong)|,|$)/i);
  if (destMatch) {
    destination = destMatch[1].trim();
  }

  return { corridor: corridor || '10H', origin, destination };
}
