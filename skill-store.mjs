/**
 * Skill Joko untuk panel admin.
 * ------------------------------------------------------------
 *  - Skill aktif:     .agents/skills/<nama>/SKILL.md   (dibaca Antigravity)
 *  - Skill nonaktif:  .agents/skills-nonaktif/<nama>/SKILL.md (tidak dibaca agen)
 *  Menonaktifkan = memindahkan folder; tidak ada yang dihapus.
 *  Hanya SKILL.md yang bisa dibaca/diubah dari panel; nama folder dibatasi huruf kecil,
 *  angka & tanda hubung sehingga tidak bisa keluar dari folder skill.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_SKILL_BYTES = 100 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;

export class SkillError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Ambil name & description dari frontmatter YAML sederhana. */
export function parseFrontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { ...out, body: String(text).slice(m[0].length) };
}

export function validateSkill(name, content) {
  if (!NAME_RE.test(name)) throw new SkillError('Nama skill hanya huruf kecil, angka, dan tanda hubung (2–60 karakter).');
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new SkillError('Isi skill terlalu besar (maks. 100 KB).');
  const fm = parseFrontmatter(text);
  if (!fm) throw new SkillError('SKILL.md harus diawali frontmatter:\n---\nname: ...\ndescription: ...\n---');
  if (fm.name !== name) throw new SkillError(`"name" di frontmatter harus sama dengan nama folder (${name}).`);
  if (!fm.description || fm.description.length < 20) throw new SkillError('"description" wajib diisi (min. 20 karakter): kapan skill ini dipakai.');
  if (fm.description.length > 1024) throw new SkillError('"description" maksimal 1.024 karakter.');
  if (!fm.body.trim()) throw new SkillError('Isi skill (di bawah frontmatter) masih kosong.');
  return fm;
}

export function createSkillStore(root) {
  const activeDir = path.join(root, '.agents', 'skills');
  const inactiveDir = path.join(root, '.agents', 'skills-nonaktif');

  const dirOf = (name, active) => path.join(active ? activeDir : inactiveDir, name);
  function locate(name) {
    if (!NAME_RE.test(String(name))) throw new SkillError('Nama skill tidak valid.');
    for (const active of [true, false]) {
      const file = path.join(dirOf(name, active), 'SKILL.md');
      if (fs.existsSync(file)) return { name, active, file, dir: dirOf(name, active) };
    }
    throw new SkillError('Skill tidak ditemukan.', 404);
  }

  function list() {
    const out = [];
    for (const [dir, active] of [[activeDir, true], [inactiveDir, false]]) {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && NAME_RE.test(d.name)).map(d => d.name); } catch {}
      for (const name of names) {
        const file = path.join(dir, name, 'SKILL.md');
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const fm = parseFrontmatter(text) || {};
        const st = fs.statSync(file);
        out.push({ name, active, description: fm.description || '', bytes: st.size, updatedAt: st.mtimeMs, valid: !!(fm.name && fm.description) });
      }
    }
    return out.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  }

  return {
    activeDir,
    list,
    read(name) {
      const s = locate(name);
      return { name, active: s.active, content: fs.readFileSync(s.file, 'utf8') };
    },
    save(name, content) {
      validateSkill(name, content);
      const s = locate(name);
      const tmp = `${s.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, String(content).replace(/\r\n/g, '\n'));
      fs.renameSync(tmp, s.file);
      return { name, active: s.active };
    },
    create(name, content) {
      validateSkill(name, content);
      if (fs.existsSync(dirOf(name, true)) || fs.existsSync(dirOf(name, false))) throw new SkillError('Skill dengan nama itu sudah ada.', 409);
      fs.mkdirSync(dirOf(name, true), { recursive: true });
      fs.writeFileSync(path.join(dirOf(name, true), 'SKILL.md'), String(content).replace(/\r\n/g, '\n'));
      return { name, active: true };
    },
    setActive(name, active) {
      const s = locate(name);
      if (s.active === !!active) return { name, active: s.active };
      const dest = dirOf(name, !!active);
      if (fs.existsSync(dest)) throw new SkillError('Folder tujuan sudah ada.', 409);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(s.dir, dest);
      return { name, active: !!active };
    }
  };
}
