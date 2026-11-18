// Frozen builds (docs/builds.md): every page loads all its code from one immutable, content-addressed copy of the tree,
// /b/<id>/src/... (src/shared/build-path.js) — a deploy during a session (a merge into the live tree, a restart) can no
// longer hand a page of one version the worker, render worker or lazy modules of another: the page, picked at its load,
// names its build, and its modules name each other relatively.
//
// A build is the live tree's src/ but the server's own code (src/server/: no page loads it — a server-only change makes
// no new build, so no player downloads the page's code again for it), its id the start of the SHA-256 of its files'
// paths and contents. The store (`dir`, the server's state: <learn>/../builds) keeps each file's bytes once, by content
// (blobs/<sha>), and each build as a tree of hard links to them (<id>/src/..., <id>/build.json: its version and files):
// a new build costs its changed files and ~260 links. The live tree is looked at (one stat a file, ~1 ms) at most every
// `checkMs` when a page is picked; changed and quiet for `settleMs` (a merge or a checkout writing it: the build before
// meanwhile), it is cut. A build is kept while it is the live one or the pinned stable one, or was used (a page picked or
// a file served from it) within `keepMs`: a running session keeps loading its lazy modules from it.
//
// Channels (<dir>/channel.json, written by tools/ops/build-channel.mjs): by default (`auto`) players get the live tree's
// latest build — every deploy, a merge into the live tree or a restart, reaches the next page loaded, as before builds.
// `restart`: the build of the tree as it was when the server started — a merge reaches players at the next restart.
// `stable` (promote): a pinned build, until the next promotion, whatever the live tree does. ?channel=main (a cookie)
// gets the live tree's latest build whatever the channel.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUILD_ID } from '../shared/build-path.js';

/** Builds kept this long after their last use (a page picked, a file served). */
export const KEEP_MS = 7 * 86400e3;
/** A build's last use written to its directory's mtime at most this often. */
const TOUCH_MS = 3600e3;

/** A live tree path ('src/...', '/'-separated) a build holds: src/, but the server's own code. */
export const inBuild = (rel) => rel.startsWith('src/') && !rel.startsWith('src/server/');

/** The live tree's files a build holds: [{ rel, file, size, mtimeMs }], sorted by rel (regular files: no symlink). */
export function treeFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const r = `${rel}/${e.name}`, f = path.join(dir, e.name);
      if (e.isDirectory()) { if (inBuild(r + '/')) walk(f, r); } else if (e.isFile() && inBuild(r)) {
        try { const st = fs.statSync(f); out.push({ rel: r, file: f, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* gone meanwhile */ }
      }
    }
  };
  walk(path.join(root, 'src'), 'src');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** A file's content hash (its blob's name). */
const contentHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);

/** A build's id from its files' [{ rel, hash }] (sorted by rel). */
export const buildIdOf = (list) => {
  const h = crypto.createHash('sha256');
  for (const { rel, hash } of list) h.update(`${rel}\0${hash}\n`);
  return h.digest('hex').slice(0, 16);
};

/** The id the live tree at `root` has now, read only (tools/ops/build-channel.mjs: is the server's live build the tree's?). */
export const treeBuildId = (root) => buildIdOf(treeFiles(root).map((f) => ({ rel: f.rel, hash: contentHash(fs.readFileSync(f.file)) })));

/**
 * A page's HTML with its addresses of the live tree's code (`src="/src/`, `href="/src/`, `import('/src/`, `from '/src/`)
 * moved into build `id` (unchanged without one). The pages' own text and what the server adds to it (the OpenMW engine
 * page's scripts) go through it; a module's text never does — its addresses are relative to it.
 */
export const pageInBuild = (text, id) => (id ? text.replace(/(\b(?:src|href)\s*=\s*["']|\bimport\(\s*["']|\bfrom\s+["'])\/src\//g, `$1/b/${id}/src/`) : text);

/** The channel file: { stable (a pinned build's id, or null), mode ('auto' | 'restart': without a pin) }. */
export function readChannel(dir) {
  let c = null; try { c = JSON.parse(fs.readFileSync(path.join(dir, 'channel.json'), 'utf8')); } catch { /* none: auto */ }
  return { stable: BUILD_ID.test(String(c?.stable)) ? c.stable : null, mode: c?.mode === 'restart' ? 'restart' : 'auto' };
}

export class BuildStore {
  /**
   * @param {{ root: string, dir: string, version?: () => string | null, keepMs?: number, maxBuilds?: number,
   *   settleMs?: number, checkMs?: number, log?: (m: string) => void }} o `root` the live tree, `dir` the store,
   *   `version` the tree's version for telemetry (server.js buildVersion), `maxBuilds` kept at most whatever their use
   */
  constructor({ root, dir, version = () => null, keepMs = KEEP_MS, maxBuilds = 300, settleMs = 1500, checkMs = 2000, log = () => {} }) {
    Object.assign(this, { root, dir, version, keepMs, maxBuilds, settleMs, checkMs, log });
    this.blobs = path.join(dir, 'blobs');
    fs.mkdirSync(this.blobs, { recursive: true });
    /** @type {Map<string, { id: string, dir: string, version: string | null, at: string, files: Map<string, string>, usedAt: number, sources?: any }>} */
    this.known = new Map();
    this.hashes = new Map(); // (live file -> { size, mtimeMs, hash }: hashed again only when changed)
    this.live = null; this.stamp = null; this.checkedAt = 0; this.pending = null;
    this.pin = { stable: null, mode: 'auto', stamp: undefined };
    this.readPin();
    this.refresh(true);
    /** the build of the tree as it was at the start (the `restart` channel's) */
    this.startBuild = this.live;
    this.prune();
  }

  blob(hash) { return path.join(this.blobs, hash); }

  /** The live tree looked at again (at most every checkMs unless `force`): cut when changed and quiet. */
  refresh(force = false) {
    const now = Date.now();
    if (!force && now - this.checkedAt < this.checkMs) return;
    this.checkedAt = now;
    const files = treeFiles(this.root);
    const stamp = files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`).join('\n');
    if (this.live && stamp === this.stamp) return;
    // (quiet: no file written in the last settleMs, or the same changes seen settleMs ago — a file dated ahead of the
    // clock does not hold the cut)
    if (this.pending?.stamp !== stamp) this.pending = { stamp, at: now };
    const quiet = files.every((f) => now - f.mtimeMs >= this.settleMs) || now - this.pending.at >= this.settleMs;
    if (this.live && !force && !quiet) return;
    try {
      const list = files.map((f) => ({ rel: f.rel, hash: this.hashOf(f) }));
      const id = buildIdOf(list);
      this.stamp = stamp; this.pending = null;
      if (this.live?.id !== id) {
        this.live = this.get(id) ?? this.cut(id, list);
        this.log(`build ${id} (${this.live.version ?? '?'}, ${list.length} files)`);
      }
    } catch (e) {
      this.log(`build: the live tree not cut: ${e.message}`);
      if (!this.live) throw e;
    }
  }

  /** A live file's content hash, its bytes in the store (the bytes hashed: a file written meanwhile is cut as read). */
  hashOf(f) {
    const c = this.hashes.get(f.file);
    if (c && c.size === f.size && c.mtimeMs === f.mtimeMs && fs.existsSync(this.blob(c.hash))) return c.hash;
    const buf = fs.readFileSync(f.file), hash = contentHash(buf), b = this.blob(hash);
    if (!fs.existsSync(b)) { const tmp = `${b}.${process.pid}.tmp`; fs.writeFileSync(tmp, buf, { mode: 0o444 }); fs.renameSync(tmp, b); }
    this.hashes.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, hash });
    return hash;
  }

  /** Build `id` made of `list` ([{ rel, hash }], their blobs in the store): a tree of links, renamed into place whole. */
  cut(id, list) {
    const final = path.join(this.dir, id), tmp = path.join(this.dir, `.cut-${id}-${process.pid}`), made = new Set();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const { rel, hash } of list) {
      const f = path.join(tmp, rel), d = path.dirname(f);
      if (!made.has(d)) { fs.mkdirSync(d, { recursive: true }); made.add(d); }
      fs.linkSync(this.blob(hash), f);
    }
    const meta = { id, version: this.version?.() ?? null, at: new Date().toISOString(), files: Object.fromEntries(list.map((x) => [x.rel, x.hash])) };
    fs.writeFileSync(path.join(tmp, 'build.json'), JSON.stringify(meta));
    try { fs.renameSync(tmp, final); } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(path.join(final, 'build.json'))) throw e; // (else cut by another process: the same bytes)
    }
    return this.get(id);
  }

  /** Build `id` (one of this store, cut before a restart too), or null: none, or no longer kept. */
  get(id) {
    if (!BUILD_ID.test(String(id))) return null;
    let b = this.known.get(id);
    if (!b) {
      const dir = path.join(this.dir, id);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
        b = { id, dir, version: meta.version ?? null, at: meta.at ?? null, files: new Map(Object.entries(meta.files ?? {})), usedAt: fs.statSync(dir).mtimeMs };
      } catch { return null; }
      this.known.set(id, b);
    }
    return b;
  }

  /** Build `b` used now (a page picked it, a file of it served): kept keepMs more. */
  touch(b) {
    const now = Date.now();
    if (now - b.usedAt < TOUCH_MS) return;
    b.usedAt = now;
    fs.utimes(b.dir, new Date(now), new Date(now), () => {});
  }

  /** The channel file read again when it changed (a stat at each page picked). */
  readPin() {
    let m = null; try { const st = fs.statSync(path.join(this.dir, 'channel.json')); m = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { /* none: auto */ }
    if (m === this.pin.stamp) return;
    const c = m === null ? { stable: null, mode: 'auto' } : readChannel(this.dir);
    if (c.stable !== this.pin.stable || c.mode !== this.pin.mode) {
      this.log(c.stable ? `builds: stable channel pinned to ${c.stable}${this.get(c.stable) ? '' : ' (not in the store: the live build served)'}`
        : c.mode === 'restart' ? 'builds: restart channel (the build of the tree as it was at the server\'s start)' : 'builds: auto channel (the live tree\'s latest build)');
    }
    this.pin = { ...c, stamp: m };
  }

  /**
   * The build a page picks: the stable pin when set and kept, the start's in the restart channel, else the live tree's
   * latest — that one whatever the channel for `channel` 'main'.
   */
  served(channel = null) {
    this.readPin();
    this.refresh();
    let b = this.live;
    if (channel !== 'main') b = (this.pin.stable && this.get(this.pin.stable)) || (this.pin.mode === 'restart' && this.startBuild) || this.live;
    this.touch(b);
    return b;
  }

  /** The builds no longer kept removed, then the blobs no build links (a blob's one link left: the store's). */
  prune(now = Date.now()) {
    let names = []; try { names = fs.readdirSync(this.dir); } catch { return; }
    const all = [];
    for (const n of names) {
      const f = path.join(this.dir, n);
      if (n.startsWith('.cut-')) { try { if (now - fs.statSync(f).mtimeMs > 3600e3) fs.rmSync(f, { recursive: true, force: true }); } catch { /* gone */ } continue; }
      if (!BUILD_ID.test(n)) continue;
      try { all.push({ id: n, f, usedAt: Math.max(fs.statSync(f).mtimeMs, this.known.get(n)?.usedAt ?? 0) }); } catch { /* gone */ }
    }
    all.sort((a, b) => b.usedAt - a.usedAt);
    let builds = 0, blobs = 0;
    all.forEach((b, i) => {
      if (b.id === this.live?.id || b.id === this.startBuild?.id || b.id === this.pin.stable || (now - b.usedAt <= this.keepMs && i < this.maxBuilds)) return;
      fs.rmSync(b.f, { recursive: true, force: true }); this.known.delete(b.id); builds++;
    });
    // (written over an hour ago: never a blob another process has just written for the cut it is making)
    for (const n of fs.readdirSync(this.blobs)) {
      const f = path.join(this.blobs, n);
      try { const st = fs.statSync(f); if (st.nlink === 1 && now - st.mtimeMs > 3600e3) { fs.unlinkSync(f); blobs++; } } catch { /* gone */ }
    }
    if (builds || blobs) this.log(`builds: ${builds} build(s) and ${blobs} file(s) no longer used removed`);
  }
}
