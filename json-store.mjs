/**
 * Penyimpanan JSON yang aman untuk state Joko.
 *  - writeJsonAtomic: tulis ke file sementara lalu rename, sehingga file tidak pernah
 *    setengah tertulis bila proses mati / disk penuh di tengah penulisan.
 *  - readJsonFile: bila file rusak (JSON tidak valid), file DICADANGKAN dulu
 *    (<nama>.corrupt-<waktu>) sebelum mengembalikan nilai bawaan, agar penyimpanan
 *    berikutnya tidak diam-diam menimpa data lama dengan daftar kosong.
 */
import fs from 'node:fs';

export function readJsonFile(file, fallback, { validate } = {}) {
  let raw;
  try {
    if (!fs.existsSync(file)) return fallback;
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[JSON Store] Gagal membaca ${file}:`, err.message);
    return fallback;
  }
  if (!raw.trim()) return fallback;

  try {
    const data = JSON.parse(raw);
    if (validate && !validate(data)) throw new Error('struktur data tidak sesuai');
    return data;
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      console.error(`[JSON Store] ⚠️ ${file} rusak (${err.message}). Dicadangkan ke ${backup}.`);
    } catch (bErr) {
      console.error(`[JSON Store] ⚠️ ${file} rusak dan gagal dicadangkan:`, bErr.message);
    }
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const content = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    // Windows dapat menolak rename bila file target sedang dibuka proses lain.
    try {
      fs.writeFileSync(file, content);
      return true;
    } catch (err2) {
      console.error(`[JSON Store] Gagal menyimpan ${file}:`, err2.message || err.message);
      return false;
    }
  }
}
