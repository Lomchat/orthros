// The game files of a GoldSrc port, streamed (docs/browser-ports.md): the engine sees the whole tree from the start
// (names and sizes), a file's bytes come when it reads them. Before the engine starts, the page loads what earlier
// sessions read first (the server's learned list, /api/prefetch/<manifest>: menu, first map); the rest of that list
// follows in the background while the game runs; a read of bytes not here yet fetches them on the spot — the engine
// is synchronous, so does that fetch (a synchronous XHR: the page waits, mostly during a map load). Files kept in the
// browser (IndexedDB) are read from there. The page reports the reads it served (path, range, time since the engine
// started) and the server orders the list by them.

/** The learned list's units: 1 MiB blocks, 64 KiB pieces (src/host/server.js, src/vfs/http-backend.js). */
export const BLOCK = 1 << 20, PIECE = 1 << 16;
/** The startup set ends at the first pause of this long between two learned first reads. */
export const STARTUP_GAP_MS = 2000;
/** Native binaries of an installation: useless to the WebAssembly engine, never part of its tree. */
const NATIVE = /\.(exe|dll|so|dylib)$/i;
const MAX_RANGE = 32 * 1024 * 1024; // (per request: the server answers 64 MiB at most)

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
   * @param {{read: Function, write: Function, keys: Function, remove: Function}|null} o.store the browser's copy (IndexedDB)
   * @param {(url: string, size: number) => Uint8Array} [o.syncGet] a synchronous range fetch
   * @param {(url: string) => Promise<Uint8Array>} [o.get] an asynchronous one
   * @param {() => number} [o.now]
   */
  constructor({ name, files, store, syncGet = fetchSync, get = defaultGet, now = () => performance.now(), log = () => {} }) {
    this.name = name; this.store = store; this.syncGet = syncGet; this.get = get; this.now = now; this.log = log;
    this.files = new Map(files.map((f) => [f.path, { ...f, key: `${f.path}\n${f.size}\n${f.mtime}`, data: null, pieces: null, local: null, seen: null }]));
    this.t0 = null; // (the engine's start: reads are learned from it)
    this.reads = []; // [path, start, end, t] not reported yet
    this.stats = { syncFetches: 0, syncBytes: 0, syncMs: 0, fetched: 0, fetchedBytes: 0, local: 0, localBytes: 0 };
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
      const slash = f.path.lastIndexOf('/'), dir = root + (slash < 0 ? '' : '/' + f.path.slice(0, slash));
      FS.mkdirTree(dir);
      const node = FS.createFile(dir, f.path.slice(slash + 1), {}, true, false);
      Object.defineProperty(node, 'usedBytes', { get: () => f.size });
      Object.defineProperty(node, 'contents', { get: () => f.data, set: () => {} }); // (whole, once here: mmap reads it)
      const ops = node.stream_ops, own = { ...ops };
      // (bytes that cannot be fetched: a read error for the engine (EIO), not an exception through its code)
      const io = (fn) => { try { return fn(); } catch (e) { if (e instanceof FS.ErrnoError) throw e; self.log(`${f.path}: ${e.message}`); throw new FS.ErrnoError(29); } };
      own.read = (stream, buffer, offset, length, position) => io(() => self.read(f, buffer, offset, length, position));
      own.mmap = (...a) => io(() => { self.ensure(f, 0, f.size); return ops.mmap(...a); });
      own.write = () => { throw new FS.ErrnoError(69); }; // (EROFS: the game files are read-only)
      node.stream_ops = own;
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
    let runStart = -1;
    const fetchRun = (a, b) => { // (pieces a..b-1, one request per MAX_RANGE)
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
    for (let o = 0; o < bytes.length; o += PIECE) {
      const p = (at + o) / PIECE, piece = bytes.subarray(o, Math.min(bytes.length, o + PIECE));
      if (f.pieces.has(p)) continue;
      f.pieces.set(p, piece);
      if (keep && this.store) this.store.write(`${f.key}\n#${p}`, piece.slice()).catch((e) => this.log(`cache: ${e.message}`));
    }
    if (f.pieces.size * PIECE >= f.size) { // (every piece here: one array)
      const all = new Uint8Array(f.size);
      for (const [p, piece] of f.pieces) all.set(piece, p * PIECE);
      f.data = all; f.pieces = null;
    }
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

  /** Load `f` (or its `pieces`) from the browser's copy, else from the server. */
  async load(f, pieces = null) {
    if (f.data) return;
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
    if (!pieces && missing.length === want.length) { // (nothing of it here: the whole file, compressed, in one request)
      const bytes = await this.get(this.url(f, 0, f.size));
      if (bytes.length !== f.size) throw new Error(`${f.path}: incomplete`);
      this.stats.fetched++; this.stats.fetchedBytes += bytes.length; this.put(f, 0, bytes, true);
      return;
    }
    for (let i = 0; i < missing.length;) { // (runs of consecutive pieces)
      let j = i + 1; while (j < missing.length && missing[j] === missing[j - 1] + 1 && (j - i) * PIECE < MAX_RANGE) j++;
      const s = missing[i] * PIECE, e = Math.min(f.size, missing[j - 1] * PIECE + PIECE);
      const bytes = await this.get(this.url(f, s, e));
      if (bytes.length !== e - s) throw new Error(`${f.path}: incomplete`);
      this.stats.fetched++; this.stats.fetchedBytes += bytes.length; this.put(f, s, bytes, true);
      i = j;
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
