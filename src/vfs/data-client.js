// The game data of an engine that runs in the page (GoldSrc, re3, OpenMW, the next ones — CLAUDE.md
// "Standardization"), the page's side: the data worker (data-worker.js: the Windows games' reader, the browser's copy,
// the learned order, the whole download) asked for bytes, kept here in 64 KiB pieces for the engine's many small reads.
// A read the engine waits for synchronously waits on shared memory (the page's thread spins: Atomics.wait is not
// allowed there); one it can wait for (JSPI: `ensure`) by message. The pieces the engine uses are told to the worker,
// which reports them to the server's learned order. Emscripten engines mount the files with emscripten-files.js.
import { treeFile } from './game-tree.js';

export const PIECE = 1 << 16;

/**
 * The player's choice, for every game (the settings' "offline copy"): each game kept whole in this browser, downloaded
 * in the background while it runs. Kept in this browser.
 */
// snapshot: no state — the page's preference, read from the browser's storage each time
export const offlineCopy = {
  get() { try { return localStorage.getItem('orthros.offlineCopy') === '1'; } catch { return false; } },
  set(on) { try { localStorage.setItem('orthros.offlineCopy', on ? '1' : '0'); } catch { /* storage off */ } },
};
/** The most bytes one answer of the worker carries (its shared buffer). */
const SPAN = 16 << 20;
/** A read the engine waits for fails once the worker's heartbeat stopped this long (it died). */
const DEAD_MS = 30000;
const PER_FILE = 2 ** 21; // (a piece's key: file id × PER_FILE + piece)

export class GameData {
  /**
   * The data of version `name` (and the versions it requires), its worker started and its files listed.
   * @param {{ name: string, session?: string, bw?: number, prefetch?: 'startup'|'start'|'first-read'|'none',
   *   cacheBytes?: number, memBytes?: number, cacheBlocks?: number, log?: (text: string) => void }} o
   *   prefetch: when the learned order starts loading in the background — with the startup set (startup() then start()),
   *   at the engine's start, or at its first read (an engine that downloads itself first: its download comes first)
   */
  static async open(o) {
    const g = new GameData(o);
    await g.ready;
    return g;
  }

  constructor(o) {
    this.log = o.log ?? (() => {});
    this.ctrl = new Int32Array(new SharedArrayBuffer(32));
    this.data = new Uint8Array(new SharedArrayBuffer(SPAN));
    this.cache = new Map(); this.held = 0; this.budget = o.cacheBytes ?? 256 << 20;
    this.files = new Map(); this.byId = []; this.gen = 0; this.used = []; this.asks = new Map(); this.nextAsk = 1;
    // (waits: the reads that waited for the worker — waitMs, waitBytes their time and bytes, syncFetches those that held
    // the page; fetchedBytes: what the worker received)
    const ctrl = this.ctrl;
    this.stats = { hits: 0, misses: 0, stallMs: 0, evictions: 0, bytes: 0, syncFetches: 0, get waits() { return this.misses; }, get waitMs() { return this.stallMs; },
      get waitBytes() { return this.bytes; }, get fetchedBytes() { return Atomics.load(ctrl, 2); } };
    this.listeners = { startup: [], whole: [], ahead: [] };
    // (o.worker: a test's stand-in, { postMessage, onmessage })
    this.worker = o.worker ?? new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.ready) { this.trees = m.ready.trees; this.kept = m.ready.kept; this.manifest = m.ready.manifest; this.name = o.name; resolve(this); }
        else if (m.failed) reject(new Error(m.failed));
        else if (m.id) { const a = this.asks.get(m.id); this.asks.delete(m.id); if (a) m.error ? a.reject(new Error(m.error)) : a.resolve(m.bytes); }
        else if (m.startup) for (const f of this.listeners.startup) f(m.startup);
        else if (m.whole) for (const f of this.listeners.whole) f(m.whole);
        else if (m.ahead) for (const f of this.listeners.ahead) f(m.ahead);
        else if (m.log) this.log(m.log);
      };
    });
    this.worker.postMessage({ init: { name: o.name, tree: o.tree, session: o.session ?? '', bw: o.bw, prefetch: o.prefetch ?? 'start', memBytes: o.memBytes, cacheBlocks: o.cacheBlocks, ctrl: this.ctrl.buffer, data: this.data.buffer } });
    this.timer = setInterval(() => { if (this.used.length) this.worker.postMessage({ used: this.used.splice(0) }); }, 2000);
    // (the page's loading indicator, src/host/web/data-meter.js, when it has one: these counters, read live)
    globalThis.orthrosDataMeter?.attach?.(this.ctrl.buffer);
  }

  /** A file of the version `name` (or of one it requires), found without case: its handle, or null. */
  file(name, path) {
    const key = name + '\n' + path.toLowerCase();
    let h = this.files.get(key);
    if (h === undefined) {
      const f = this.trees[name] ? treeFile(this.trees[name], path) : null;
      h = f ? { id: this.byId.length, name, path: f.path, size: f.size, mtime: f.mtime, last: -1, run: 0, whole: null } : null;
      if (h) this.byId.push(h);
      this.files.set(key, h);
    }
    return h;
  }

  /**
   * A file of elsewhere the engine reads (not the game's: a file the player picked — `handle` —, a Blob, a signed `url`;
   * read through the worker, not kept): its handle, as file()'s.
   */
  source({ url, handle, blob, size, label = '' }) {
    const h = { id: this.byId.length, src: this.byId.length, path: label, size, last: -1, run: 0, whole: null };
    this.byId.push(h);
    this.worker.postMessage({ source: { id: h.src, url, handle, blob } });
    return h;
  }

  /** A new address for a file of elsewhere (signed addresses expire): the bytes here stay. */
  setSourceUrl(h, url) { this.worker.postMessage({ setSource: { id: h.src, url } }); }

  /**
   * A handle for a game file known by its path and size before the files are listed (an engine that mounts its files
   * itself, as OpenMW's page: the worker finds the file in the listing).
   */
  fileAs(name, path, size) {
    const key = name + '\n' + path.toLowerCase();
    let h = this.files.get(key);
    if (!h) { h = { id: this.byId.length, name, path, size, last: -1, run: 0, whole: null }; this.byId.push(h); this.files.set(key, h); }
    return h;
  }

  /**
   * The engine starts: its reads are learned from now; the learned order loads in the background ('start'), and the
   * whole game after it when the player chose so (offlineCopy).
   */
  start() { this.worker.postMessage({ start: true }); if (offlineCopy.get()) this.download(true); }

  /**
   * The loading in the background, as it goes: `fn({ kind: 'ahead', done, total, finished })` — the learned order —, and
   * `fn({ kind: 'whole', bytes, total, done })` — the whole game.
   */
  onProgress(fn) {
    this.listeners.ahead.push((p) => fn({ kind: 'ahead', ...p }));
    this.listeners.whole.push((p) => fn({ kind: 'whole', ...p }));
  }

  /** What earlier sessions read first, loaded before the engine starts; `onProgress({ bytes, total, done })`. */
  startup(onProgress = () => {}) {
    return new Promise((resolve) => {
      const on = (p) => { onProgress(p); if (p.done) { this.listeners.startup = this.listeners.startup.filter((f) => f !== on); resolve(p); } };
      this.listeners.startup.push(on);
      this.worker.postMessage({ startup: true });
    });
  }

  /** The whole version kept in the browser, in the background (`on`: start, else stop); `onProgress({ bytes, total, done })`. */
  download(on = true, onProgress = null) {
    if (onProgress) this.listeners.whole.push(onProgress);
    this.worker.postMessage({ whole: on });
  }

  /** The engine reads `h` at random as it goes: all of it loaded in the background. */
  wantWhole(h) { this.worker.postMessage({ wantWhole: { name: h.name, path: h.path } }); }

  /**
   * Copies of game files an earlier version of the page kept elsewhere ([{ name, path, module, args }]): taken into the
   * browser's copy before each file's first read, by the runtime's `module` (its adopt(args, keep)).
   */
  legacy(list) { if (list.length) this.worker.postMessage({ legacy: list }); }

  /** Bytes a page kept elsewhere before ([{ name, path, at, bytes }]): into the browser's copy. */
  migrate(list) { this.worker.postMessage({ migrate: list }, [...new Set(list.map((e) => e.bytes.buffer))]); }

  /** The engine's reads wait for the network now. */
  get waiting() { return Atomics.load(this.ctrl, 6) > 0; }
  /** Bytes the worker received (decoded). */
  get received() { return Atomics.load(this.ctrl, 2); }

  /** The worker stopped (its pending reports sent first). */
  close() { clearInterval(this.timer); this.worker.postMessage({ close: true }); this.worker.terminate?.(); }

  /** The page's pieces and its waits: { cached, lruMax, hits, misses, stallMs, evictions, bytes }. */
  snapshot() { const s = this.stats; return { cached: this.cache.size, lruMax: Math.floor(this.budget / PIECE), hits: s.hits, misses: s.misses, stallMs: s.stallMs, evictions: s.evictions, bytes: s.bytes, fetchedBytes: s.fetchedBytes }; }

  // ---------------------------------------------------------------- reads

  /** Some of the bytes [position, position + length) of `h` are not in the page yet. */
  missing(h, position, length) {
    const end = Math.min(h.size, position + length);
    for (let p = Math.floor(position / PIECE); p * PIECE < end; p++) if (!this.cache.has(h.id * PER_FILE + p)) return true;
    return false;
  }

  /** The bytes [position, position + length) of `h` into the engine's `buffer` at `offset` (waiting when missing). */
  read(h, buffer, offset, length, position) {
    const end = Math.min(h.size, position + length);
    if (!(end > position)) return 0;
    const sequential = position >= h.last - PIECE && position <= h.last + 2 * PIECE;
    h.run = sequential ? h.run + (end - position) : 0;
    h.last = end;
    let pos = position, out = offset;
    while (pos < end) {
      const p = Math.floor(pos / PIECE), key = h.id * PER_FILE + p;
      let piece = this.cache.get(key);
      if (piece) { this.cache.delete(key); this.cache.set(key, piece); this.stats.hits++; }
      else { this.fetchSync(h, p, end); piece = this.cache.get(key); if (!piece) throw new Error(`${h.path}: bytes at ${p * PIECE} missing`); }
      if (piece.fresh) { piece.fresh = false; if (h.src === undefined) this.used.push([h.name, h.path, p]); }
      const within = pos - p * PIECE, n = Math.min(end - pos, piece.length - within);
      buffer.set(piece.subarray(within, within + n), out);
      pos += n; out += n;
    }
    return end - position;
  }

  /** The whole file (an engine that maps it: mmap). */
  whole(h) {
    if (h.whole) return h.whole;
    const all = new Uint8Array(h.size);
    for (let at = 0; at < h.size; at += SPAN) this.read(h, all, at, Math.min(SPAN, h.size - at), at);
    return (h.whole = all);
  }

  /** The bytes [position, position + length) of `h` into the page, without holding it (an engine that waits: JSPI). */
  async ensure(h, position, length) {
    const end = Math.min(h.size, position + length);
    for (let p = Math.floor(position / PIECE); p * PIECE < end;) {
      if (this.cache.has(h.id * PER_FILE + p)) { p++; continue; }
      const id = this.nextAsk++, t0 = performance.now();
      const bytes = await new Promise((resolve, reject) => {
        this.asks.set(id, { resolve, reject });
        this.worker.postMessage({ read: { id, ...this.whose(h), off: p * PIECE, len: end - p * PIECE, want: this.want(h, end - p * PIECE) } });
      });
      this.stats.misses++; this.stats.stallMs += performance.now() - t0;
      this.keep(h, p, bytes);
      p = Math.floor((p * PIECE + Math.max(PIECE, bytes.length)) / PIECE);
    }
  }

  /** A request's file: a game file's version and path, or a source's id. */
  whose(h) { return h.src !== undefined ? { src: h.src } : { name: h.name, path: h.path }; }

  /** How many bytes to take back from the worker (as far as it has them already): more for a file read in order. */
  want(h, need) { return Math.min(SPAN, Math.max(need, h.run > 0 ? Math.max(1 << 20, h.run) : 256 << 10)); }

  /** Piece `p` of `h` on, through `need`, from the worker: the page's thread waits for its answer. */
  fetchSync(h, p, need) {
    const start = p * PIECE;
    // (asked: from this piece to the end of the read, short of the first piece the page has — the worker adds what it
    // has here already beyond, up to want())
    let stop = Math.min(h.size, Math.max(need, start + PIECE));
    for (let q = p + 1; q * PIECE < stop; q++) if (this.cache.has(h.id * PER_FILE + q)) { stop = q * PIECE; break; }
    const gen = ++this.gen, { ctrl } = this;
    this.worker.postMessage({ gen, ...this.whose(h), off: start, len: Math.min(SPAN, stop - start), want: this.want(h, stop - start), used: this.used.splice(0) });
    const t0 = performance.now();
    let beat = Atomics.load(ctrl, 3), beatAt = t0;
    while (Atomics.load(ctrl, 0) !== gen) {
      const b = Atomics.load(ctrl, 3), now = performance.now();
      if (b !== beat) { beat = b; beatAt = now; } else if (now - beatAt > DEAD_MS) throw new Error('the game data worker stopped answering');
    }
    this.stats.misses++; this.stats.syncFetches++; this.stats.stallMs += performance.now() - t0;
    const n = ctrl[1];
    if (n < 0) throw new Error(`${h.path}: read failed at ${start}`);
    this.keep(h, p, this.data.subarray(0, n));
  }

  /** Bytes of `h` from piece `p` into the page's pieces (whole pieces, or the file's last), copied. */
  keep(h, p, bytes) {
    for (let at = 0; at < bytes.length; at += PIECE) {
      const len = Math.min(PIECE, bytes.length - at);
      if (len < PIECE && (p * PIECE + at + len) !== h.size) break;
      const key = h.id * PER_FILE + p + at / PIECE;
      if (this.cache.has(key)) continue;
      const piece = bytes.slice(at, at + len); piece.fresh = true;
      this.cache.set(key, piece); this.held += len; this.stats.bytes += len;
    }
    while (this.held > this.budget && this.cache.size > 1) {
      const [key, piece] = this.cache.entries().next().value;
      this.cache.delete(key); this.held -= piece.length; this.stats.evictions++;
    }
  }
}
