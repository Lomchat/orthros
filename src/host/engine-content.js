// Engine files addressed by their content (docs/browser-ports.md "Engine files by content"): every file a browser
// port's page loads from its engine release (GoldSrc/Xash3D, re3, OpenMW) is given to the page — and to the home's
// "Prepare" — under /engines/_c/<sha256>/<name>, immutable, instead of /engines/<release>/<path>. Engine releases come
// often (Arsenal r2 -> r12, OpenMW r1 -> r11, reVC r1 -> r3) and change a file or two: a player coming back after one
// keeps, in the browser's HTTP cache, every file whose bytes did not change (Arsenal r11 -> r12: xash.wasm, the
// renderer, the menu, extras.pk3, the module graph — only the game's own modules fetched again), where release-keyed
// URLs made all of them new.
// A file's address is the sha256 of its bytes as read here — hashed once per file, size and mtime, in the background
// (one at a time), its release URL given meanwhile —, never only a release.json's word: a file replaced since its
// release was written (a copy of another release, then one file restored with its old mtime) must not take, immutable
// for a year in every browser, an address another release's bytes own. What a release.json says (`files`
// [{ path, sha256, bytes }] or { path: sha256 }; OpenMW's `engineFiles` { basename: sha256 }) is checked against the
// hash: a mismatch logged, the file addressed by what it holds. An ES module graph (scripts importing their siblings by
// relative paths: Xash3D's engine/) is addressed as one tree, /engines/_c/<tree sha256>/<path in the tree>, the tree's
// sha256 made of its members' paths and sha256s: unchanged scripts keep their URLs, relative imports resolve in the
// tree. The server serves a content URL only for a file it hashed from an installed release whose bytes are still the
// ones hashed (size and mtime checked at each request) — a request arriving while the server hashes (just restarted:
// addresses given by the previous process) waits for the hashing (served()) —; the release URLs keep answering for the
// pages already open with them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { engineFile } from './goldsrc.js';

/** The URL prefix of the engine files by content. */
export const CONTENT_PREFIX = '/engines/_c/';
const SHA256 = /^[0-9a-f]{64}$/;
/** A script of a module graph (in a tree), by its name. */
const SCRIPT = /\.m?js$/;

/**
 * The sha256s a release.json says of its files: Map(rel -> { sha, bytes|null }). Its `files` as a list of
 * { path, sha256, bytes } (Xash3D releases) or a map { path: sha256 } (re3 releases); OpenMW's `engineFiles`
 * { basename: sha256 } for the entries of its `files` list with that basename (one each: an ambiguous name says nothing).
 */
export function declaredShas(release) {
  const out = new Map();
  const files = release?.files;
  if (Array.isArray(files)) {
    for (const f of files) if (f && typeof f === 'object' && typeof f.path === 'string' && SHA256.test(f.sha256 ?? '')) out.set(f.path, { sha: f.sha256, bytes: Number.isFinite(f.bytes) ? f.bytes : null });
  } else if (files && typeof files === 'object') {
    for (const [p, s] of Object.entries(files)) if (typeof s === 'string' && SHA256.test(s)) out.set(p, { sha: s, bytes: null });
  }
  const named = release?.engineFiles;
  if (named && typeof named === 'object' && Array.isArray(files)) {
    for (const [base, sha] of Object.entries(named)) {
      if (typeof sha !== 'string' || !SHA256.test(sha)) continue;
      const at = files.filter((f) => typeof f === 'string' && path.posix.basename(f) === base);
      if (at.length === 1 && !out.has(at[0])) out.set(at[0], { sha, bytes: null });
    }
  }
  return out;
}

/**
 * The functions a release.json says its engine exports to its page (`exports`: [{ name, ... }] — OpenMW's
 * orthros_file_updated, its files loaded again in place): Set(name).
 */
export const exportNames = (release) => new Set((Array.isArray(release?.exports) ? release.exports : []).map((e) => e?.name).filter((n) => typeof n === 'string'));

/** A tree's sha256: its members' paths in the tree and sha256s, in order (a member renamed or changed: a new tree). */
export const treeSha = (members) => crypto.createHash('sha256').update('orthros-engine-tree-1\n' + [...members].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([p, s]) => `${p}\0${s}\n`).join('')).digest('hex');

/**
 * The engine files by content of the releases in `enginesDir`: `sha(release, rel)` (null while hashed — started then
 * — or not installed), `pending(release, rel)` (its hashing runs or waits), `hashed(release, rel)` (a promise of its
 * sha256 once hashed, null when it cannot be), `url(release, rel)` (its content URL, or null: the release URL
 * meanwhile), `pageUrls(release, rels, tree)` ({ rel: URL } of those addressed by content now — the scripts under
 * `tree`, a release directory ending in '/', as one tree, all or none —), `lookup(sha, rest)` (the file a request of
 * /engines/_c/<sha>/<rest> is served, or null), `served(sha, rest, { reindex, ms })` (the same, a promise waiting — at
 * most `ms` — for the hashing running: `reindex(force)` asks the server's releases again — `force`: once a hashing drained
 * since, else throttled by the server —),
 * `hashing()` (files being hashed or waiting to be), `exports(release)` (the names its release.json says the engine
 * exports: exportNames, read again when it changes).
 */
export function engineContent({ enginesDir, log = () => {} }) {
  const releases = new Map(); // release -> { size, mtimeMs, declared: Map } (its release.json, read again when it changes)
  const hashes = new Map(); // "<file>\0<size>\0<mtime>" -> sha256 | null (being hashed) | false (failed)
  const waits = new Map(); // "<file>\0<size>\0<mtime>" -> { promise, resolve } of hashed() while hashed
  let idle = null; // { promise, resolve } of served()'s wait for the queue to drain, while it runs
  let drains = 0, asked = 0; // the queue's drains, and at which one served() last asked the releases again
  const files = new Map(); // sha256 -> Map(file -> { size, mtimeMs, names: Set(basename) }) — what the route serves
  const trees = new Map(); // tree sha256 -> Map(path in the tree -> sha256)
  const queue = []; let running = false;
  const declaredOf = (release) => {
    const f = engineFile(enginesDir, release, 'release.json'); if (!f) return null;
    let st; try { st = fs.statSync(f); } catch { return null; }
    const c = releases.get(release);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c;
    let declared = new Map(), exports = new Set();
    try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); declared = declaredShas(r); exports = exportNames(r); } catch { /* unreadable: hashed */ }
    const v = { size: st.size, mtimeMs: st.mtimeMs, declared, exports };
    releases.set(release, v);
    return v;
  };
  /** The scripts of the release under directory `dir` (release paths), walked once per release.json. */
  const scriptsOf = (release, dir) => {
    const r = declaredOf(release); if (!r) return [];
    r.scripts ??= new Map();
    if (!r.scripts.has(dir)) {
      const out = [], root = engineFile(enginesDir, release, 'release.json') && path.join(enginesDir, release);
      const walk = (rel, depth) => {
        let ents = []; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory() && depth < 8) walk(rel + e.name + '/', depth + 1);
          else if (SCRIPT.test(e.name)) out.push(rel + e.name);
        }
      };
      if (root) walk(dir, 0);
      r.scripts.set(dir, out.sort());
    }
    return r.scripts.get(dir);
  };
  const pump = () => {
    if (running) return;
    if (!queue.length) { drains++; if (idle) { const r = idle.resolve; idle = null; r(); } return; }
    running = true;
    const { key, file, st, name, release, rel } = queue.shift(), h = crypto.createHash('sha256');
    // (indexed at once: a content address given before a restart is served as soon as its file is hashed again)
    const done = (v) => {
      hashes.set(key, v);
      if (v) {
        index(v, file, st, name);
        // (the release's word checked: a file changed since it was written is addressed by what it holds)
        const d = declaredOf(release)?.declared.get(rel);
        if (d && d.sha !== v) log(`engine file ${release}/${rel}: sha256 ${v}, not the ${d.sha} its release.json says (addressed by its bytes)`);
      }
      const w = waits.get(key); if (w) { waits.delete(key); w.resolve(v || null); }
      running = false; pump();
    };
    fs.createReadStream(file, { highWaterMark: 1 << 20 }).on('data', (b) => h.update(b))
      .on('error', (e) => { log(`engine file ${file}: ${e.message}`); done(false); }).on('end', () => done(h.digest('hex')));
  };
  const index = (sha, file, st, name) => {
    let at = files.get(sha); if (!at) files.set(sha, at = new Map());
    let e = at.get(file);
    if (!e || e.size !== st.size || e.mtimeMs !== st.mtimeMs) at.set(file, e = { size: st.size, mtimeMs: st.mtimeMs, names: new Set() });
    e.names.add(name); // (the name the release gives it: its URL's last part)
    return sha;
  };
  /** The release's file: { file, st, key } — its real path, size and mtime, the key of its hash —, or null. */
  const fileOf = (release, rel) => {
    const file = engineFile(enginesDir, release, rel); if (!file) return null;
    let st; try { st = fs.statSync(file); } catch { return null; }
    return { file, st: { size: st.size, mtimeMs: st.mtimeMs }, key: `${file}\0${st.size}\0${st.mtimeMs}` };
  };
  const sha = (release, rel) => {
    const f = fileOf(release, rel); if (!f) return null;
    const h = hashes.get(f.key);
    if (h) return index(h, f.file, f.st, path.posix.basename(rel));
    if (h === undefined) { hashes.set(f.key, null); queue.push({ ...f, name: path.posix.basename(rel), release, rel }); pump(); }
    return null;
  };
  const url = (release, rel) => { const s = sha(release, rel); return s ? `${CONTENT_PREFIX}${s}/${encodeURIComponent(path.posix.basename(rel))}` : null; };
  return {
    sha,
    exports(release) { return declaredOf(release)?.exports ?? new Set(); },
    pending(release, rel) { const f = fileOf(release, rel); return !!f && hashes.get(f.key) === null; },
    hashed(release, rel) {
      const s = sha(release, rel), f = fileOf(release, rel);
      if (s || !f || hashes.get(f.key) !== null) return Promise.resolve(s);
      let w = waits.get(f.key);
      if (!w) { let resolve; const promise = new Promise((r) => { resolve = r; }); waits.set(f.key, w = { promise, resolve }); }
      return w.promise;
    },
    url,
    pageUrls(release, rels, tree = null) {
      const out = {}, members = [];
      for (const rel of new Set(rels)) {
        if (tree && rel.startsWith(tree) && SCRIPT.test(rel)) { members.push(rel); continue; }
        const u = url(release, rel); if (u) out[rel] = u;
      }
      if (members.length) {
        // (the tree: every script under its directory, not only those listed — a module the graph imports is in it)
        const all = new Set([...members, ...scriptsOf(release, tree)]);
        const shas = [...all].map((rel) => [rel.slice(tree.length), sha(release, rel)]);
        if (shas.every(([, s]) => s)) {
          const t = treeSha(shas);
          trees.set(t, new Map(shas));
          for (const p of members.map((rel) => rel.slice(tree.length))) out[tree + p] = `${CONTENT_PREFIX}${t}/${p.split('/').map(encodeURIComponent).join('/')}`;
        }
      }
      return out;
    },
    lookup(s, rest) {
      if (!SHA256.test(s ?? '') || typeof rest !== 'string') return null;
      // (a tree's member: its own content, by its sha256)
      const t = trees.get(s);
      if (t) { const m = t.get(rest); return m ? this.lookup(m, path.posix.basename(rest)) : null; }
      const at = files.get(s); if (!at || rest.includes('/')) return null;
      for (const [file, e] of at) {
        if (!e.names.has(rest)) continue;
        // (the bytes hashed only: a file changed or gone since is out of the index)
        let st = null; try { st = fs.statSync(file); } catch { /* gone */ }
        if (st && st.size === e.size && st.mtimeMs === e.mtimeMs) return file;
        at.delete(file);
      }
      if (!at.size) files.delete(s);
      return null;
    },
    async served(s, rest, { reindex = () => {}, ms = 60000 } = {}) {
      let file = this.lookup(s, rest); if (file || !SHA256.test(s ?? '')) return file;
      // (not indexed: a release installed since, or hashed now — a server just restarted: addresses the previous process
      // gave —: the releases asked again — at once after a hashing drained since, a tree known only once all its
      // members are hashed —, the hashing waited for)
      const end = Date.now() + ms;
      for (;;) {
        if (drains !== asked) { asked = drains; reindex(true); } else reindex(false);
        if ((file = this.lookup(s, rest)) || !(queue.length || running) || Date.now() >= end) return file;
        if (!idle) { let resolve; const promise = new Promise((r) => { resolve = r; }); idle = { promise, resolve }; }
        let timer; await Promise.race([idle.promise, new Promise((r) => { timer = setTimeout(r, end - Date.now()); timer.unref?.(); })]); clearTimeout(timer);
      }
    },
    hashing() { return queue.length + (running ? 1 : 0); },
  };
}
