// Game files identical by content (docs/slow-network.md "Files identical by content"), for every game and runtime: two
// versions — of one game or of two — often ship the same bytes under paths, folders and dates of their own (Age of the
// Ring carries its own copies of RotWK 2.02's and BFME II 1.09's files: 150 of them, 5.25 GB). The owner marks
// (game-files.js listGameTree) share a file only when it is the very file (its device and inode); these are other files,
// and the browser keeps each under its own version's keys (path#size#mtime#block): a player of both downloaded and
// stored them twice. The server tells them by their bytes — a SHA-256 of each file that could have a twin: 64 KiB or
// more, another file of the catalog of the same size and the same hash of its head and tail (a cheap first pass) —,
// computed in the background at a bounded rate (one file at a time, TWIN_RATE bytes a second at most, paused while the
// machine is loaded) and kept by file version (device, inode, size, mtime: a file changed is hashed again, one gone
// forgotten) in the learned directory. /api/twins/<version> lists the groups of identical files the version reads: each
// place — the store a browser keeps it in (its owner, else the version), its path there, its date — of the same bytes
// (game-data.js TwinStore reads a block in any of them this browser holds).
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

/** files smaller than this are not looked at: a few blocks' worth of requests at most, many of them */
export const TWIN_MIN_BYTES = 64 << 10;
/** the hashing's reads, bytes a second at most (a background job on a shared machine: ~4 % of a core with SHA-NI) */
export const TWIN_RATE = 64 << 20;
/** the first pass's hash: the file's size, its first and its last TWIN_SAMPLE bytes (a file this short twice: whole) */
const TWIN_SAMPLE = 64 << 10;
/** a group lists this many places at most (one version's file in many versions' stores: the first ones by name) */
const TWIN_PLACES = 16;
/** the cache file written at most this often while a pass runs */
const SAVE_MS = 30000;
const READ = 1 << 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A file version's key: its device, inode, size and mtime (fs.Stats). */
export const fileKey = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;

/**
 * The content index (see the top of this file). `file`: the cache's JSON file (null: in memory only); `rate`: the reads'
 * bytes a second (Infinity: unbounded, a test); `minBytes`; `busy()`: true while the machine is loaded (the pass waits).
 */
export class ContentTwins {
  constructor({ file = null, rate = TWIN_RATE, minBytes = TWIN_MIN_BYTES, busy = defaultBusy, log = () => {} } = {}) {
    this.file = file; this.rate = rate; this.minBytes = minBytes; this.busy = busy; this.log = log;
    /** file version (fileKey) -> [first pass's hash, SHA-256 (null: not needed so far)] */
    this.hashes = new Map();
    /** version -> its groups ([size, [[store, path, mtime, light], ...]]), and their JSON (made at the first ask) */
    this.groups = new Map(); this.json = new Map();
    /** a pass running (its promise), passes done, the hashing's next free time (performance.now()), cache changed */
    this.running = null; this.passes = 0; this.due = 0; this.dirty = false; this.savedAt = 0;
    this.stats = { hashed: 0, bytes: 0, ms: 0 };
    /** stopped (the server closed): a pass running ends at its next file, none starts */
    this.stopped = false;
    this.load();
  }

  stop() { this.stopped = true; this.save(true); }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j?.v === 1 && j.files && typeof j.files === 'object') for (const [k, v] of Object.entries(j.files)) if (Array.isArray(v) && typeof v[0] === 'string') this.hashes.set(k, [v[0], typeof v[1] === 'string' ? v[1] : null]);
    } catch { /* none yet, or unreadable: hashed again */ }
  }

  save(force = false) {
    if (!this.file || !this.dirty || (!force && Date.now() - this.savedAt < SAVE_MS)) return;
    this.dirty = false; this.savedAt = Date.now();
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, files: Object.fromEntries(this.hashes) })); fs.renameSync(this.file + '.tmp', this.file); } catch { this.dirty = true; }
  }

  /** The groups of identical files version `id` reads, as /api/twins sends them: { v, groups, passes }. */
  twinsJson(id) {
    let j = this.json.get(id);
    if (j === undefined) { j = JSON.stringify({ v: 1, groups: this.groups.get(id) ?? [], passes: this.passes }); this.json.set(id, j); }
    return j;
  }

  /** A pass over the catalog (see scan); one at a time: the running one's promise when one runs. */
  update(places) { return this.stopped ? Promise.resolve(null) : (this.running ??= this.scan(places).finally(() => { this.running = null; })); }

  /**
   * One pass: `places` — every file of every version, { version, store, path, size, mtime, light, file } (`store`, `path`:
   * where a browser keeps it — its owner and its path there, else the version and the tree's; `file`: the file served,
   * null when it does not resolve) or a function giving them (an iterable, maybe async). Files of TWIN_MIN_BYTES or more
   * only; each stat'ed (a file changed since its tree was listed is left out); those of a size another file has hashed
   * (first pass, then SHA-256 for the same first hash) unless known; then the groups of every version made anew.
   */
  async scan(places) {
    const t0 = performance.now(), stats = { hashed: 0, bytes: 0 };
    const at = new Map(); // store\npath -> { store, path, size, mtime, light, key, versions: Set }
    const bySize = new Map(); // size -> Map(file key -> file)
    let n = 0;
    for await (const p of typeof places === 'function' ? places() : places) {
      if (++n % 2000 === 0) await new Promise((r) => setImmediate(r)); // (the server's requests in between)
      if (!p?.file || !(p.size >= this.minBytes)) continue;
      const k = `${p.store}\n${p.path}`;
      let e = at.get(k);
      if (!e) {
        let st; try { st = fs.statSync(p.file); } catch { continue; }
        if (st.size !== p.size || st.mtimeMs !== p.mtime) continue; // (changed since listed: the next pass)
        e = { store: p.store, path: p.path, size: p.size, mtime: p.mtime, light: p.light ?? 0, key: fileKey(st), versions: new Set() };
        at.set(k, e);
        let s = bySize.get(st.size); if (!s) bySize.set(st.size, s = new Map());
        s.set(e.key, p.file);
      }
      e.versions.add(p.version);
    }
    // (every file version looked at: the cache keeps those only — a file of a size no other file has is never hashed)
    const seen = new Set();
    for (const s of bySize.values()) for (const k of s.keys()) seen.add(k);
    const pass = async (files, full) => {
      for (const [k, file] of files) {
        if (this.stopped) return;
        const h = this.hashes.get(k);
        if (h && (!full || h[1])) continue;
        const r = await this.hash(file, k, full, stats); if (!r) continue;
        this.hashes.set(k, r); this.dirty = true; this.save();
      }
    };
    for (const s of bySize.values()) if (s.size > 1) await pass(s, false);
    // (the same size and first hash: their SHA-256)
    const byFirst = new Map();
    for (const [size, s] of bySize) {
      if (s.size < 2) continue;
      for (const [k, file] of s) { const h = this.hashes.get(k); if (!h) continue; const q = `${h[0]}:${size}`; let g = byFirst.get(q); if (!g) byFirst.set(q, g = new Map()); g.set(k, file); }
    }
    for (const g of byFirst.values()) if (g.size > 1) await pass(g, true);
    if (this.stopped) return null;
    // (the places by content: a group is two places or more)
    const byHash = new Map();
    for (const e of at.values()) {
      const h = this.hashes.get(e.key)?.[1]; if (!h) continue;
      const q = `${h}:${e.size}`; let g = byHash.get(q); if (!g) byHash.set(q, g = []); g.push(e);
    }
    const groups = new Map();
    for (const g of byHash.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const place = (e) => [e.store, e.path, e.mtime, e.light], all = g.length <= TWIN_PLACES ? [g[0].size, g.map(place)] : null;
      const versions = new Set(); for (const e of g) for (const v of e.versions) versions.add(v);
      for (const v of versions) {
        let l = groups.get(v); if (!l) groups.set(v, l = []);
        // (more places than a group lists: the version's own first, then the others in order)
        l.push(all ?? [g[0].size, [...g.filter((e) => e.versions.has(v)), ...g.filter((e) => !e.versions.has(v))].slice(0, TWIN_PLACES).map(place)]);
      }
    }
    // (the versions' groups replaced at once; the cache without the file versions no place has any longer)
    this.groups = groups; this.json = new Map(); this.passes++;
    for (const k of [...this.hashes.keys()]) if (!seen.has(k)) { this.hashes.delete(k); this.dirty = true; }
    this.save(true);
    const ms = performance.now() - t0;
    const twinned = [...byHash.values()].filter((g) => g.length > 1).length;
    this.stats = { hashed: stats.hashed, bytes: stats.bytes, ms, places: at.size, groups: twinned, versions: groups.size };
    if (stats.hashed) this.log(`content twins: ${stats.hashed} files hashed (${(stats.bytes / 1048576).toFixed(0)} MiB) in ${(ms / 1000).toFixed(0)} s; ${twinned} groups of identical files, read by ${groups.size} versions`);
    return this.stats;
  }

  /**
   * The hashes of a file version `k` at `file`: [first pass's, SHA-256 or null] — the SHA-256 when `full` or when the
   * first pass read the whole file —, or null (unreadable, or changed while read).
   */
  async hash(file, k, full, stats) {
    while (this.busy() && !this.stopped) await sleep(5000);
    if (this.stopped) return null;
    const size = Number(k.split(':')[2]), whole = size <= 2 * TWIN_SAMPLE;
    let fh; try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
    try {
      const st0 = await fh.stat(); if (fileKey(st0) !== k) return null;
      const buf = Buffer.allocUnsafe(Math.min(READ, size)), read = async (pos, len, h) => {
        for (let p = pos, end = pos + len; p < end;) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - p), p);
          if (!bytesRead) throw new Error('short read');
          h.update(buf.subarray(0, bytesRead)); p += bytesRead; stats.bytes += bytesRead;
          await this.pace(bytesRead);
        }
      };
      let first = null, sha = null;
      if (whole || full) { const h = crypto.createHash('sha256'); await read(0, size, h); sha = h.digest('hex'); }
      if (whole) first = sha;
      else {
        first = this.hashes.get(k)?.[0] ?? null;
        if (!first) { const h = crypto.createHash('sha256'); h.update(String(size)); await read(0, TWIN_SAMPLE, h); await read(size - TWIN_SAMPLE, TWIN_SAMPLE, h); first = h.digest('hex'); }
      }
      // (changed while read: not kept — the next pass)
      if (fileKey(await fh.stat()) !== k) return null;
      stats.hashed++;
      return [first, sha];
    } catch { return null; } finally { await fh.close().catch(() => {}); }
  }

  /** The reads' pace: `n` bytes read, the next ones once they fit in `rate`. */
  async pace(n) {
    if (!(this.rate < Infinity)) return;
    const now = performance.now();
    this.due = Math.max(this.due, now) + (n / this.rate) * 1000;
    if (this.due - now > 1) await sleep(this.due - now);
  }
}

/** The machine is loaded: its 1-minute load average at half its cores or more (the project's browser gate, for one). */
const defaultBusy = () => os.loadavg()[0] >= os.cpus().length / 2;

/**
 * Every file of a version's tree (game-tree.js's: `owner`/`op` its marks) as ContentTwins.scan's places, `file(rel)` its
 * file served (resolveGameFile), only for files of `minBytes` or more.
 */
export function* treePlaces(version, tree, file, minBytes = TWIN_MIN_BYTES) {
  const walk = function* (node, prefix) {
    for (const [name, f] of Object.entries(node.files ?? {})) {
      if (!(f.size >= minBytes)) continue;
      const rel = prefix + name;
      yield { version, store: f.owner ?? version, path: f.op ?? rel, size: f.size, mtime: f.mtime, light: f.light ?? 0, file: file(rel) };
    }
    for (const [name, d] of Object.entries(node.dirs ?? {})) yield* walk(d, prefix + name + '/');
  };
  yield* walk(tree, '');
}
