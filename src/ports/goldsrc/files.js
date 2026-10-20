// The game files of a GoldSrc port (an re3 port's too), streamed (docs/browser-ports.md): the engine sees the whole
// tree from the start (names and sizes), a file's bytes come when it reads them. Before the engine starts, the page
// loads what earlier sessions read first (the server's learned list, /api/prefetch/<manifest>: menu, first map); the
// rest of that list follows in the background while the game runs; a read of bytes not here yet fetches them on the
// spot — the engine is synchronous, so does that fetch (a synchronous XHR: the page waits, mostly during a map load).
// Files kept in the browser (IndexedDB) are read from there. The page reports the reads it served (path, range, time
// since the engine started) and the server orders the list by them.

/** The learned list's units: 1 MiB blocks, 64 KiB pieces (src/host/server.js, src/vfs/http-backend.js). */
export const BLOCK = 1 << 20, PIECE = 1 << 16;
/** The startup set ends at the first pause of this long between two learned first reads. */
export const STARTUP_GAP_MS = 2000;
/** Native binaries of an installation: useless to the WebAssembly engine, never part of its tree. */
const NATIVE = /\.(exe|dll|so|dylib)$/i;
const MAX_RANGE = 32 * 1024 * 1024; // (per request: the server answers 64 MiB at most)
/** A file whose every piece is here becomes one array up to this size (mmap reads it); a bigger one stays in pieces. */
const COALESCE_MAX = 64 * 1024 * 1024;
/** Every byte of `f` here: one array, or all its pieces. */
const whole = (f) => !!f.data || (f.pieces?.size ?? 0) * PIECE >= f.size;
/** demandFirst: a background load starts again this long after the engine's last read that waited. */
export const QUIET_MS = 300;
/** open()'s flags (Emscripten's, musl's values). */
const O_ACCMODE = 3, O_EXCL = 0o200, O_TRUNC = 0o1000;

/** The files of a tree from /api/tree (dot files and native binaries left out). */
export function treeFiles(tree) {
  const files = [];
  (function walk(node, prefix) {
    for (const [dir, sub] of Object.entries(node.dirs)) if (!dir.startsWith('.')) walk(sub, prefix + dir + '/');
    for (const [file, st] of Object.entries(node.files)) if (!file.startsWith('.') && !NATIVE.test(file)) files.push({ path: prefix + file, size: st.size, mtime: st.mtime });
  })(tree, '');
  return files;
}

/**
 * The game's files as a language shows them (goldsrc.languages.<code>.overlays: { "valve_french": "valve" }): each file of
 * a language folder is mounted at the same place in the folder it translates (`at`), over the original of that path
 * (compared without case, as the engine finds files); the language folders themselves are not mounted otherwise.
 * Without overlays, the files as they are, the language folders left out of the engine's tree.
 */
export function languageFiles(files, overlays = {}, known = []) {
  const lower = (p) => p.toLowerCase(), top = (p) => lower(p.split('/')[0]);
  const over = new Map(Object.entries(overlays).map(([from, to]) => [lower(from), to]));
  const hidden = new Set([...known.map(lower)].filter((d) => !over.has(d)));
  const translated = new Map();
  for (const f of files) {
    const to = over.get(top(f.path)); if (!to) continue;
    const at = to + f.path.slice(f.path.indexOf('/'));
    translated.set(lower(at), { ...f, at });
  }
  const out = [];
  for (const f of files) {
    const t = top(f.path);
    if (over.has(t) || hidden.has(t)) continue;
    if (!translated.has(lower(f.path))) out.push(f);
  }
  return [...out, ...translated.values()];
}

/**
 * The learned list ([path, block, mask, t] by earliest first read) as files to load (`files`: those of the
 * StreamedFiles, whose nodes the engine reads), in order: per file, its pieces
 * (null: the whole file — read for the most part, or small), and its first time. `startup`: the leading entries up
 * to the first pause of STARTUP_GAP_MS — what the engine reads from its start to its first idle moment (init, menu,
 * the first map when the page asks for one).
 */
export function learnedPlan(list, files) {
  const byPath = new Map(files.map((f) => [f.path, f])), plan = new Map();
  let startupEnd = Infinity, prevT = null;
  for (const [path, block, mask, t] of Array.isArray(list) ? list : []) {
    const f = byPath.get(path);
    if (!f || !Number.isInteger(block) || block < 0 || block * BLOCK >= f.size) continue;
    if (startupEnd === Infinity && prevT !== null && t - prevT > STARTUP_GAP_MS) startupEnd = prevT;
    prevT = t;
    let e = plan.get(path);
    if (!e) plan.set(path, e = { file: f, pieces: new Set(), t });
    const perBlock = BLOCK / PIECE;
    for (let i = 0; i < perBlock; i++) if (!mask || (mask >>> i) & 1) { const p = block * perBlock + i; if (p * PIECE < f.size) e.pieces.add(p); }
  }
  const out = [];
  for (const e of plan.values()) {
    const total = Math.ceil(e.file.size / PIECE);
    out.push({ file: e.file, pieces: e.file.size <= BLOCK || e.pieces.size * 2 >= total ? null : [...e.pieces].sort((a, b) => a - b), t: e.t, startup: e.t <= startupEnd });
  }
  return out;
}

/**
 * A file's bytes over a synchronous XHR (the engine's thread waits); `url` answers the range [start, end). A window's
 * synchronous request has no binary response: the bytes come as x-user-defined text (one character per byte), after
 * one padding byte the server puts first (&pad=1) — text decoding would take a leading byte-order mark as one.
 */
export function fetchSync(url, size) {
  for (let attempt = 0; ; attempt++) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url + '&pad=1', false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    try { xhr.send(); } catch (e) { if (attempt < 2) continue; throw e; }
    const text = xhr.status === 200 ? xhr.responseText : '';
    if (text.length === size + 1) {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i++) out[i] = text.charCodeAt(i + 1) & 0xff;
      return out;
    }
    if (attempt >= 2) throw new Error(`${url}: HTTP ${xhr.status}, ${text.length - 1} bytes of ${size}`);
  }
}

export class StreamedFiles {
  /**
   * @param {object} o
   * @param {string} o.name the manifest
   * @param {{path: string, size: number, mtime: number}[]} o.files
   * @param {{read: Function, write: Function, writeMany?: Function, keys: Function, remove: Function}|null} o.store the
   *   browser's copy (IndexedDB); `writeMany([[key, bytes]])`, when there, keeps a response's pieces in one transaction
   * @param {(url: string, size: number) => Uint8Array} [o.syncGet] a synchronous range fetch
   * @param {(url: string) => Promise<Uint8Array>} [o.get] an asynchronous one
   * @param {() => number} [o.now]
   * @param {number} [o.readAhead] after a read fetched synchronously, this many of the file's next missing pieces
   *   loaded in the background (one such load per file at a time: the engine never waits for it); 0, none
   * @param {boolean} [o.rewritable] a game file the engine opens to write it anew (O_TRUNC: fopen's "w") replaced by a
   *   file of its own, empty, in its place (mount()); else, and opened to be changed in place, read-only (EACCES)
   * @param {boolean} [o.asyncReads] each mounted file's node tells its missing bytes and fetches them without holding
   *   the page (`node.orthrosStreamed`: { missing(position, length), ensure(position, length): Promise }) — an engine
   *   that suspends while it waits (JSPI) reads so instead of over a synchronous request
   * @param {boolean} [o.demandFirst] the background loads wait their turn while the engine waits for bytes, and a
   *   moment after (QUIET_MS): on a thin link the game's reads have it alone
   * @param {number} [o.backgroundRange] the bytes a background request asks for at most (a game read waits behind the one
   *   in flight)
   * @param {number} [o.backgroundRate] the bytes a second background requests fetch at most (0: as fast as the link
   *   goes) — on a fast link, hundreds of MB a minute kept in the browser hold the page's thread and the game with it;
   *   a field, set once the engine runs (its first files as fast as they come)
   */
  constructor({ name, files, store, syncGet = fetchSync, get = defaultGet, now = () => performance.now(), log = () => {}, readAhead = 0, rewritable = false, asyncReads = false, demandFirst = false, backgroundRange = MAX_RANGE, backgroundRate = 0 }) {
    this.name = name; this.store = store; this.syncGet = syncGet; this.get = get; this.now = now; this.log = log; this.readAhead = readAhead; this.rewritable = rewritable;
    this.asyncReads = asyncReads; this.demandFirst = demandFirst; this.backgroundRange = Math.max(PIECE, Math.min(MAX_RANGE, backgroundRange));
    this.demand = 0; this.demandEnd = -Infinity; // (the engine's reads waiting for bytes now; when the last one ended)
    this.backgroundRate = backgroundRate; this.backgroundAt = -Infinity; // (when the next background byte may be fetched)
    this.wholeWanted = new Set(); this.completed = new Set(); this.completing = null; this.completeWidth = 0; // (files the engine wants whole: complete())
    this.files = new Map(files.map((f) => [f.path, { ...f, key: `${f.path}\n${f.size}\n${f.mtime}`, data: null, pieces: null, local: null, seen: null }]));
    this.t0 = null; // (the engine's start: reads are learned from it)
    this.reads = []; // [path, start, end, t] not reported yet
    this.stats = { syncFetches: 0, syncBytes: 0, syncMs: 0, fetched: 0, fetchedBytes: 0, local: 0, localBytes: 0, waits: 0, waitBytes: 0, waitMs: 0 };
  }

  /** A range of `f` from the server, compressed when that saves bytes (`ahead`: a background load, else a read). */
  url(f, start, end, ahead = true) {
    return `/gamez/${encodeURIComponent(this.name)}/${f.path.split('/').map(encodeURIComponent).join('/')}?r=${start}-${end}${ahead ? '&p=1' : ''}`;
  }

  /** What the browser keeps of this installation: whole files and pieces; entries of older files are deleted. */
  async openLocal() {
    if (!this.store) return;
    const byKey = new Map([...this.files.values()].map((f) => [f.key, f])), stale = [];
    for (const key of await this.store.keys()) {
      const cut = key.lastIndexOf('\n#'), f = byKey.get(cut < 0 ? key : key.slice(0, cut));
      if (!f) { stale.push(key); continue; }
      f.local ??= { whole: false, pieces: new Set() };
      if (cut < 0) f.local.whole = true; else f.local.pieces.add(Number(key.slice(cut + 2)));
    }
    if (stale.length) this.store.remove(stale).catch((e) => this.log(`cache cleanup: ${e.message}`));
  }

  /** The engine's tree under `root`: directories, and a node per file whose bytes come at its first read. */
  mount(FS, root) {
    const self = this;
    for (const f of this.files.values()) {
      const at = f.at ?? f.path; // (a language's file: mounted where the file it translates is, languageFiles)
      const slash = at.lastIndexOf('/'), dir = root + (slash < 0 ? '' : '/' + at.slice(0, slash));
      FS.mkdirTree(dir);
      const node = f.node = FS.createFile(dir, at.slice(slash + 1), {}, true, false);
      Object.defineProperty(node, 'usedBytes', { get: () => f.size });
      Object.defineProperty(node, 'contents', { get: () => f.data, set: () => {} }); // (whole, once here: mmap reads it)
      const ops = node.stream_ops, own = { ...ops };
      // (bytes that cannot be fetched: a read error for the engine (EIO), not an exception through its code)
      const io = (fn) => { try { return fn(); } catch (e) { if (e instanceof FS.ErrnoError) throw e; self.log(`${f.path}: ${e.message}`); throw new FS.ErrnoError(29); } };
      own.read = (stream, buffer, offset, length, position) => io(() => self.read(f, buffer, offset, length, position));
      own.mmap = (...a) => io(() => { self.ensure(f, 0, f.size); self.join(f); return ops.mmap(...a); });
      own.write = () => { throw new FS.ErrnoError(69); }; // (EROFS: the game files are read-only)
      node.stream_ops = own;
      if (this.asyncReads) node.orthrosStreamed = { missing: (position, length) => self.missing(f, position, position + length), ensure: (position, length) => self.ensureAsync(f, position, position + length), complete: () => self.wantWhole(f) };
    }
    // (rewritable: a game file opened to be written anew — its bytes not wanted, never fetched — unlinked first, an
    // empty file of the engine's own in its place, as in a game folder the player may write in. Not when the open
    // must create the file (O_EXCL: it fails as it is), nor to change it in place (read-write, append): read-only.)
    if (this.rewritable) {
      const nodes = new Set([...this.files.values()].map((f) => f.node)), open = FS.open;
      const anew = (flags) => (typeof flags === 'string' ? flags[0] === 'w' && !flags.includes('x') : (flags & O_TRUNC) && (flags & O_ACCMODE) && !(flags & O_EXCL));
      FS.open = function (at, flags, mode) {
        if (typeof at === 'string' && anew(flags)) {
          let node = null; try { node = FS.lookupPath(at, { follow: true }).node; } catch { /* not there */ }
          if (node && nodes.has(node)) { FS.unlink(at); FS.writeFile(at, new Uint8Array(0)); }
        }
        return open.call(this, at, flags, mode);
      };
    }
  }

  /** The engine starts now: its reads are learned from this time. */
  start() { this.t0 = this.now(); }

  read(f, buffer, offset, length, position) {
    const end = Math.min(f.size, position + length);
    if (end <= position) return 0;
    this.ensure(f, position, end);
    if (f.data) buffer.set(f.data.subarray(position, end), offset);
    else for (let p = Math.floor(position / PIECE); p * PIECE < end; p++) {
      const piece = f.pieces.get(p), a = Math.max(position, p * PIECE), b = Math.min(end, (p + 1) * PIECE);
      buffer.set(piece.subarray(a - p * PIECE, b - p * PIECE), offset + a - position);
    }
    this.learn(f, position, end);
    return end - position;
  }

  /** The bytes [start, end) of `f` here, fetched now (synchronously) when missing. */
  ensure(f, start, end) {
    if (f.data) return;
    let runStart = -1, fetched = false;
    const fetchRun = (a, b) => { // (pieces a..b-1, one request per MAX_RANGE)
      fetched = true;
      for (let s = a * PIECE, e = Math.min(f.size, b * PIECE); s < e; s += MAX_RANGE) {
        const until = Math.min(e, s + MAX_RANGE), t = this.now();
        const bytes = this.syncGet(this.url(f, s, until, false), until - s);
        this.stats.syncFetches++; this.stats.syncBytes += bytes.length; this.stats.syncMs += this.now() - t;
        this.put(f, s, bytes, true);
        if (f.data) return;
      }
    };
    const first = Math.floor(start / PIECE), last = Math.ceil(end / PIECE);
    for (let p = first; p <= last; p++) {
      const missing = p < last && !f.pieces?.has(p);
      if (missing && runStart < 0) runStart = p;
      if (!missing && runStart >= 0) { fetchRun(runStart, p); runStart = -1; if (f.data) return; }
    }
    if (fetched && this.readAhead > 0) this.ahead(f, last);
  }

  /** Some of the bytes [start, end) of `f` are not here yet. */
  missing(f, start, end) {
    if (f.data) return false;
    end = Math.min(f.size, end);
    for (let p = Math.floor(start / PIECE); p * PIECE < end; p++) if (!f.pieces?.has(p)) return true;
    return false;
  }

  /**
   * The bytes [start, end) of `f` here, without holding the page (asyncReads: the engine waits suspended): from the
   * browser's copy, else the server, as the engine's own read (not a background load: no turn to wait); then, as a
   * synchronous read does, the file's next pieces read ahead.
   */
  async ensureAsync(f, start, end) {
    end = Math.min(f.size, end);
    const want = [];
    for (let p = Math.floor(start / PIECE); p * PIECE < end; p++) if (!f.data && !f.pieces?.has(p)) want.push(p);
    if (!want.length) return;
    const t = this.now(), before = this.stats.fetchedBytes + this.stats.localBytes;
    this.demand++;
    try { await this.load(f, want, true); }
    finally {
      this.demand--; this.demandEnd = this.now();
      this.stats.waits++; this.stats.waitBytes += this.stats.fetchedBytes + this.stats.localBytes - before; this.stats.waitMs += this.now() - t;
    }
    if (this.readAhead > 0) this.ahead(f, Math.ceil(end / PIECE));
  }

  /**
   * The engine reads `f` at random as it goes (a streaming archive, a sound bank): all of it loaded in the background,
   * once completeWanted() runs — after what earlier sessions read first —, its turn as any background load's.
   */
  wantWhole(f) {
    if (whole(f) || this.wholeWanted.has(f)) return;
    this.wholeWanted.add(f);
    if (this.completeWidth) this.completeWanted(this.completeWidth);
  }

  /**
   * The files wanted whole loaded, `width` requests at a time; later wishes too (one run at a time). Each file once: a
   * piece whose load failed waits for the engine's read.
   */
  completeWanted(width = 2) {
    this.completeWidth = width;
    this.completing ??= (async () => {
      for (const f of this.wholeWanted) { // (a wish made meanwhile joins this loop)
        if (this.completed.has(f)) continue;
        this.completed.add(f);
        if (whole(f)) continue;
        const pieces = []; for (let p = 0; p * PIECE < f.size; p++) if (!f.pieces?.has(p)) pieces.push(p);
        const per = Math.max(1, Math.floor(this.backgroundRange / PIECE)), runs = [];
        for (let i = 0; i < pieces.length; i += per) runs.push(pieces.slice(i, i + per));
        await StreamedFiles.pool(runs.map((run) => () => this.load(f, run).catch((e) => this.log(`${f.path}: ${e.message}`))), width);
        if (whole(f)) this.stats.completed = (this.stats.completed ?? 0) + 1;
      }
    })().finally(() => { this.completing = null; if ([...this.wholeWanted].some((f) => !this.completed.has(f))) this.completeWanted(width); });
    return this.completing;
  }

  /** A background load's turn (demandFirst): none while the engine waits for bytes, nor QUIET_MS after. */
  async turn() {
    if (!this.demandFirst) return;
    while (this.demand > 0 || this.now() - this.demandEnd < QUIET_MS) await new Promise((r) => setTimeout(r, 50));
  }

  /** A background request of `bytes`, at backgroundRate: it waits until the bytes before it had their time. */
  async pace(bytes) {
    const now = this.now(), at = Math.max(this.backgroundAt, now);
    this.backgroundAt = at + bytes / this.backgroundRate * 1000;
    if (at > now) { this.stats.pacedMs = (this.stats.pacedMs ?? 0) + (at - now); await new Promise((r) => setTimeout(r, at - now)); }
  }

  /**
   * After a read that waited for the network: the next `readAhead` pieces of `f` still missing from piece `from` on,
   * loaded in the background — a file read as a stream finds its next bytes here. One such load per file at a time.
   */
  ahead(f, from) {
    if (f.ahead || f.data) return;
    const pieces = [];
    for (let p = from; p * PIECE < f.size && pieces.length < this.readAhead; p++) if (!f.pieces?.has(p)) pieces.push(p);
    if (!pieces.length) return;
    this.stats.ahead = (this.stats.ahead ?? 0) + 1;
    f.ahead = this.load(f, pieces).catch((e) => this.log(`${f.path}: ${e.message}`)).finally(() => { f.ahead = null; });
  }

  /** Bytes of `f` from offset `at` (a piece boundary): whole when they are, else as pieces; kept in the browser. */
  put(f, at, bytes, keep) {
    if (f.data) return;
    if (at === 0 && bytes.length === f.size) {
      f.data = bytes; f.pieces = null;
      if (keep && this.store) this.store.write(f.key, bytes).catch((e) => this.log(`cache: ${e.message}`));
      return;
    }
    f.pieces ??= new Map();
    const kept = [];
    for (let o = 0; o < bytes.length; o += PIECE) {
      const p = (at + o) / PIECE, piece = bytes.subarray(o, Math.min(bytes.length, o + PIECE));
      if (f.pieces.has(p)) continue;
      f.pieces.set(p, piece);
      if (keep && this.store) kept.push([`${f.key}\n#${p}`, piece.slice()]);
    }
    // (the browser's copy: the response's pieces in one transaction when the store can — a transaction a piece costs the
    // page's thread as many round trips)
    if (kept.length && this.store.writeMany) this.store.writeMany(kept).catch((e) => this.log(`cache: ${e.message}`));
    else for (const [key, piece] of kept) this.store.write(key, piece).catch((e) => this.log(`cache: ${e.message}`));
    if (f.size <= COALESCE_MAX) this.join(f); // (a big file stays in pieces: its copy a hitch)
  }

  /** Every piece of `f` here: one array (mmap needs it). */
  join(f) {
    if (f.data || !whole(f)) return;
    const all = new Uint8Array(f.size);
    for (const [p, piece] of f.pieces) all.set(piece, p * PIECE);
    f.data = all; f.pieces = null;
  }

  /** The engine read [start, end) of `f`: pieces not reported yet are learned with the time since its start. */
  learn(f, start, end) {
    if (this.t0 === null) return;
    f.seen ??= new Set();
    let a = -1;
    const t = Math.round(this.now() - this.t0), last = Math.ceil(end / PIECE);
    for (let p = Math.floor(start / PIECE); p <= last; p++) {
      const fresh = p < last && !f.seen.has(p);
      if (fresh) { f.seen.add(p); if (a < 0) a = p; } else if (a >= 0) { this.reads.push([f.path, a * PIECE, Math.min(f.size, p * PIECE), t]); a = -1; }
    }
  }

  /** The reads to report (taken: reported once). */
  takeReads() { const r = this.reads; this.reads = []; return r; }

  /**
   * Load `f` (or its `pieces`) from the browser's copy, else from the server — `demand`: for the engine waiting on them,
   * else a background load (its turn first, its requests within backgroundRange). Pieces another load is fetching are
   * waited for, not fetched twice.
   */
  async load(f, pieces = null, demand = false) {
    if (f.data) return;
    if (!demand && this.demandFirst) { await this.turn(); if (f.data) return; }
    if (f.local?.whole) {
      const bytes = await this.store.read(f.key);
      if (bytes?.length === f.size) { this.stats.local++; this.stats.localBytes += f.size; this.put(f, 0, bytes, false); return; }
    }
    const want = pieces ?? Array.from({ length: Math.ceil(f.size / PIECE) }, (_, i) => i);
    const missing = [];
    for (const p of want) {
      if (f.data || f.pieces?.has(p)) continue;
      const bytes = f.local?.pieces.has(p) ? await this.store.read(`${f.key}\n#${p}`) : null;
      if (bytes && bytes.length === Math.min(PIECE, f.size - p * PIECE)) { this.stats.localBytes += bytes.length; this.put(f, p * PIECE, bytes, false); } else missing.push(p);
    }
    if (f.data || !missing.length) return;
    // (pieces another load is fetching: waited for, then only what is still missing)
    const others = new Set(missing.map((p) => f.inflight?.get(p)).filter(Boolean));
    if (others.size) {
      await Promise.allSettled([...others]);
      const still = missing.filter((p) => !f.data && !f.pieces?.has(p));
      if (f.data || !still.length) return;
      missing.splice(0, missing.length, ...still);
    }
    const limit = demand ? MAX_RANGE : this.backgroundRange;
    const fetchRange = async (s, e) => {
      const first = s / PIECE, count = Math.ceil((e - s) / PIECE);
      const done = (async () => {
        if (!demand && this.backgroundRate > 0) await this.pace(e - s);
        const bytes = await this.get(this.url(f, s, e, !demand));
        if (bytes.length !== e - s) throw new Error(`${f.path}: incomplete`);
        this.stats.fetched++; this.stats.fetchedBytes += bytes.length; this.put(f, s, bytes, true);
      })();
      f.inflight ??= new Map();
      for (let p = first; p < first + count; p++) f.inflight.set(p, done);
      try { await done; } finally { for (let p = first; p < first + count; p++) if (f.inflight.get(p) === done) f.inflight.delete(p); }
    };
    // (nothing of it here and within one request: the whole file, compressed, in one request)
    if (!pieces && missing.length === want.length && f.size <= limit) return fetchRange(0, f.size);
    for (let i = 0; i < missing.length;) { // (runs of consecutive pieces)
      let j = i + 1; while (j < missing.length && missing[j] === missing[j - 1] + 1 && (j - i + 1) * PIECE <= limit) j++;
      await fetchRange(missing[i] * PIECE, Math.min(f.size, missing[j - 1] * PIECE + PIECE));
      i = j;
      if (!demand && this.demandFirst && i < missing.length) await this.turn(); // (a game read that came meanwhile goes first)
    }
  }

  /** Run `jobs` (async functions) `width` at a time; `onDone` after each. */
  static async pool(jobs, width, onDone = () => {}) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => { while (next < jobs.length) { await jobs[next++](); onDone(); } }));
  }

  /** What the browser keeps and is not loaded yet, as load() jobs: whole files, or the pieces kept of the others. */
  localNotLoaded() {
    return [...this.files.values()].filter((f) => !f.data && f.local).map((f) => ({ file: f, pieces: f.local.whole ? null : [...f.local.pieces].sort((a, b) => a - b) }));
  }
}

/** A file's bytes; a network failure (the request's or its body's) or a server error tried again three times, 0.5, 1.5 and 4 s later. */
async function defaultGet(url) {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const response = await fetch(url);
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      status = response.status; response.body?.cancel().catch(() => {});
    } catch (error) { if (attempt >= 3) throw error; }
    if (status && (status < 500 || attempt >= 3)) throw new Error(`${url}: HTTP ${status}`);
    await new Promise((r) => setTimeout(r, [500, 1500, 4000][attempt]));
  }
}
