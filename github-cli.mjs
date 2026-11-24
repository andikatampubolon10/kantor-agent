/**
 * Integrasi GitHub untuk Mode Coding lewat GitHub CLI (`gh`) resmi.
 * Token TIDAK pernah dibaca/disimpan Joko: autentikasi sepenuhnya dikelola `gh auth login`.
 * Dipakai untuk: daftar repo, membuat Pull Request, dan menggabungkan (merge) Pull Request.
 * Clone/pull/push tetap memakai git biasa (kredensial git yang sama).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const REPO_SPEC_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export function findGh({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.JOKO_GH_PATH) return env.JOKO_GH_PATH;
  if (platform === 'win32') {
    const candidates = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'gh', 'bin', 'gh.exe'),
      'C:\\Program Files\\GitHub CLI\\gh.exe'
    ].filter(Boolean);
    for (const c of candidates) if (exists(c)) return c;
  }
  return 'gh';
}

export function makeGh({ ghPath = findGh(), timeoutMs = 60_000 } = {}) {
  return (args, { cwd } = {}) => new Promise((resolve, reject) => {
    execFile(ghPath, args, {
      cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT' ? 'GitHub CLI (gh) belum terpasang.' : String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 300);
        return reject(Object.assign(new Error(msg), { code: err.code }));
      }
      resolve(String(stdout));
    });
  });
}

/** "owner/repo", "repo" (milik login), atau URL github.com -> { owner, repo } */
export function parseRepoSpec(spec, { login } = {}) {
  let s = String(spec || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)$/i) || s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
  if (url) s = `${url[1]}/${url[2]}`;
  if (!s.includes('/') && login) s = `${login}/${s}`;
  if (!REPO_SPEC_RE.test(s)) throw Object.assign(new Error('Format repo: "nama-repo", "pemilik/nama-repo", atau URL github.com.'), { status: 400 });
  const [owner, repo] = s.split('/');
  return { owner, repo, full: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}.git` };
}

/** URL remote git -> "owner/repo" bila di github.com, selain itu null */
export function githubRepoOfRemote(remoteUrl) {
  const m = String(remoteUrl || '').trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function createGithub({ gh = makeGh() } = {}) {
  let cachedLogin = null;
  return {
    async status() {
      try {
        cachedLogin = (await gh(['api', 'user', '--jq', '.login'])).trim() || null;
        return { ok: !!cachedLogin, login: cachedLogin };
      } catch (err) {
        return { ok: false, login: null, error: /not logged|auth login|401/i.test(err.message) ? 'Belum login. Jalankan "gh auth login" di laptop.' : err.message };
      }
    },
    async login() {
      if (cachedLogin) return cachedLogin;
      const s = await this.status();
      if (!s.ok) throw Object.assign(new Error(`GitHub belum siap: ${s.error}`), { status: 400 });
      return s.login;
    },
    async listRepos({ limit = 20 } = {}) {
      const out = await gh(['repo', 'list', '--limit', String(limit), '--json', 'name,nameWithOwner,isPrivate,pushedAt,description']);
      return JSON.parse(out || '[]').map(r => ({ name: r.name, full: r.nameWithOwner, private: r.isPrivate, pushedAt: r.pushedAt, description: (r.description || '').slice(0, 140) }));
    },
    /** Buat PR (atau ambil PR yang sudah ada untuk branch itu). -> { url, number } */
    async createPr({ cwd, repo, head, base, title, body }) {
      try {
        const out = await gh(['pr', 'create', '--repo', repo, '--head', head, '--base', base, '--title', title, '--body', body], { cwd });
        const url = out.trim().split('\n').filter(l => /^https:\/\/github\.com\//.test(l)).pop();
        if (!url) throw new Error('URL PR tidak ditemukan pada keluaran gh.');
        return { url, number: Number(url.split('/').pop()) };
      } catch (err) {
        if (!/already exists/i.test(err.message)) throw err;
        const j = JSON.parse(await gh(['pr', 'view', head, '--repo', repo, '--json', 'url,number'], { cwd }));
        return { url: j.url, number: j.number };
      }
    },
    async prState({ cwd, repo, number }) {
      const j = JSON.parse(await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergeable,url'], { cwd }));
      return { state: j.state, mergeable: j.mergeable, url: j.url };
    },
    async mergePr({ cwd, repo, number }) {
      await gh(['pr', 'merge', String(number), '--repo', repo, '--merge'], { cwd });
    }
  };
}
