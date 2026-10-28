// The game data of an engine that runs in the page (GoldSrc, re3, OpenMW, the next ones — CLAUDE.md
// "Standardization"), the page's side: the data worker (data-worker.js: the Windows games' reader, the browser's copy,
// the learned order, the whole download) asked for bytes, kept here in 64 KiB pieces for the engine's many small reads.
// A read the engine waits for synchronously waits on shared memory (the page's thread spins: Atomics.wait is not
// allowed there); one it can wait for (JSPI: `ensure`) by message. The pieces the engine uses are told to the worker,
// which reports them to the server's learned order. Emscripten engines mount the files with emscripten-files.js.
// A texture's load reads its light copy (src/host/light-copies.js: the texture without its finest levels) on a thin link
// or one not measured yet, unless the file itself is here; the file comes in the background, for its next load. A page
// may say what its loads are for (prefer): 'light' — the far ring of a view that grows — or 'real'. A page whose engine
// loads a file again in place once it is here (reloads: a texture made sharp while it is shown) reads the light copies
// first on every link that is not fast, their files coming soon after them.
// The reads the engine waits for, as the worker counts them for the page's indicator (data-worker.js ctrl[6]): a
// synchronous read always (the page's thread is held); an asynchronous one (JSPI: `ensure`) when the engine has not gone
// on since it asked for it by the page's next task — an engine that suspends until its bytes are here gives the page its
// turn at once, having called nothing more; one that asked ahead and goes on (re3's streaming: a model, a sound not here
// yet shows a moment later) reads, asks for more or shows a frame first (progress) —, until it goes on; one fetched in
// the background (readable) never. A load made of many short waits counts as a wait all along.
// Announced reads (want, wantWait — docs/slow-network.md "Announced reads"): an engine that knows what its next load
// reads says so first; the worker fetches all of it in parallel, and the engine waits once (on shared memory: ctrl[12],
// the last batch settled) instead of a round trip per file. A big announced load of an engine that reloads in place
// (its batch's files would hold the link more than LOAD_BUDGET_S, a fast link included) reads the light copies first,
// the files after it (docs/slow-network.md "Big loads light first").
// Content files (game-tree.js isLightContent: a TES3 master's light copy keeps what the content load reads, every offset
// the file's): read light on every link while the engine says it loads its content (contentLoading), the file itself
// once it says its content is loaded (contentLoaded) — every read from then on, every handle, for good; never fetched
// whole after the copy; an engine that says nothing reads the file (docs/slow-network.md "Content files light before
// the menu").
import { treeFile, LIGHT_DIR, isLightContent } from './game-tree.js';
import { FAST_BPS } from './net-link.js';

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
/**
 * The rate this browser measured on its link to the server last time (bytes/s), for every game: the estimate a reader
 * starts with until it measures its own (src/vfs/net-link.js). Kept in this browser.
 */
// snapshot: no state — the browser's storage, read each time
export const linkRate = {
  get() { try { const v = Number(localStorage.getItem('orthros.netBw')); return v > 0 ? v : undefined; } catch { return undefined; } },
  set(bw) { if (bw > 0) try { localStorage.setItem('orthros.netBw', String(Math.round(bw))); } catch { /* storage off */ } },
  /** The link was fast last time (FAST_BPS, net-link.js): a page's choice before its game data opens — unknown is not fast. */
  fast() { return this.get() >= FAST_BPS; },
};
/** The most bytes one answer of the worker carries (its shared buffer). */
const SPAN = 16 << 20;
/** A read the engine waits for fails once the worker's heartbeat stopped this long (it died). */
const DEAD_MS = 30000;
const PER_FILE = 2 ** 21; // (a piece's key: file id × PER_FILE + piece)
/** A read at a file's start this long after its last read is a new load of it: light copy or file, chosen again. */
const LOAD_GAP_MS = 2000;
/** an announced choice (GameData.want: light copy or file) holds for the load that starts within this time (its waits, ~30 s at most) */
const PIN_MS = 60000;
/**
 * An announced load (GameData.want) whose batch's files that have a light copy would take the link longer than this (s,
 * at its measured rate) is a big load: an engine that reloads in place reads their light copies first, even on a fast
 * link — the player waits for ~15 MB instead of ~100 (a new device at a place of large textures: ~8 s frozen at 12 MB/s,
 * ~19 s at 5 MB/s) —, the files coming after the load, sharpened in place.
 */
export const LOAD_BUDGET_S = 2;
/**
 * The big load's state (GameData.bigLoadNow: the other loads of that moment — the engine's preloads, readable() — read
 * light too) holds this long after the engine's last wait for its batches ended (PIN_MS at most while it never waits).
 */
const BIG_HOLD_MS = 5000;
/**
 * Files made sharp in place delivered to the page's listeners (onReal) at most this many each 100 ms (a burst of reloads
 * is a hitch) — only those the page read light (the others reload nothing: not queued, the queue never outgrows them).
 */
const REAL_PER_TICK = 2;
/** The page's game data is quiet (GameData.quiet) after this long without a read waiting for the network. */
export const QUIET_MS = 3000;

/**
 * A load of a file that has a light copy reads the file itself (true) or its light copy (false): the file when it is
 * here; else as the page prefers (`prefer`: 'real', or 'light' — loads that can do with less for now, as the far ring
 * of a view that grows); else, the link fast — or, for an engine that cannot load a file again in place (`reloads`
 * false), measured between thin and fast —, the file unless its light copy is here (the learned order brought it: no
 * wait); on a thin link or one not measured yet, the light copy. An engine that reloads in place reads the light copy
 * on every link that is not fast: its file, fetched soon after, replaces it while it is shown (on a link of 1 MB/s,
 * the files themselves before the menu cost a third more time to it).
 * @param {{ here: boolean, lightHere: boolean, fast: boolean, thin: boolean, measured: boolean, prefer?: 'real'|'light'|null, reloads?: boolean }} o
 */
export function readsReal({ here, lightHere, fast, thin, measured, prefer = null, reloads = false }) {
  if (here) return true;
  if (prefer === 'real' || prefer === 'light') return prefer === 'real';
  return (fast || (!reloads && measured && !thin)) && !lightHere;
}

export class GameData {
  /**
   * The data of version `name` (and the versions it requires), its worker started and its files listed.
   * @param {{ name: string, session?: string, lang?: string|null, bw?: number, prefetch?: 'startup'|'start'|'first-read'|'none',
   *   cacheBytes?: number, memBytes?: number, cacheBlocks?: number, reloads?: boolean, log?: (text: string) => void,
   *   tree?: object, manifest?: object, orderAtOpen?: boolean }} o
   *   tree, manifest: the version's /api/tree and /api/manifest when the page holds them (not asked again: game-data.js
   *   openVersion); orderAtOpen: the learned order's list asked at the open, its bytes not (a page that opens its data
   *   while its engine downloads: the list here before the startup set or the first read asks for it)
   *   lang: the game's language (its sessions' own launch set: the startup set, and the mark it adds to — launch-set.js)
   *   prefetch: when the learned order starts loading in the background — with the startup set (startup() then start()),
   *   at the engine's start, or at its first read (an engine that downloads itself first: its download comes first);
   *   reloads: the engine loads a file again in place (see reloads)
   */
  static async open(o) {
    const g = new GameData(o);
    await g.ready;
    return g;
  }

  constructor(o) {
    this.log = o.log ?? (() => {});
    /** when the data was opened and when its worker answered (performance.now(): the page's clock, from its navigation;
     * ready null before; mounted: when a port's page mounted its files, port-files.js) — a page's start measured
     * (docs/slow-network.md "Opened early") */
    this.times = { open: Math.round(performance.now()), ready: null, mounted: null, contentLoading: null, contentLoaded: null };
    this.ctrl = new Int32Array(new SharedArrayBuffer(64));
    this.data = new Uint8Array(new SharedArrayBuffer(SPAN));
    this.cache = new Map(); this.held = 0; this.budget = o.cacheBytes ?? 256 << 20;
    this.files = new Map(); this.byId = []; this.gen = 0; this.used = [];
    /** the announced batches posted (want): the last one's number — wantWait waits for ctrl[12] to reach it —, and the
     * first one of the current wait's window (the batches announced since the last wait: an older one that never
     * settled — timed out, a request hung — does not hold the next waits) */
    this.wantSeq = 0; this.wantFrom = 1; this.asks = new Map(); this.nextAsk = 1;
    /** the asynchronous reads under way the engine may wait for: id → { at (the engine's progress when it asked), held (told so) } */
    this.pending = new Map();
    /** how many times the engine went on (progress: it called the game data, or showed a frame) */
    this.goes = 0;
    /** the files that have a light copy and are here whole (told by the worker): read themselves */
    this.realHere = new Set();
    /** those whose light copy is here whole (the file not): read light, the link fast or not */
    this.lightHere = new Set();
    /** what the page says its loads are for now (prefer) */
    this.preferred = null;
    /** the page's engine loads a file again in place once it is here (reloads) */
    this.reloadsInPlace = !!o.reloads;
    /** the content files (isLightContent) as the engine reads them: 'real' (it said nothing), 'light' (its content load
     * under way: contentLoading), 'done' (its content loaded: contentLoaded — the files themselves for good) */
    this.content = 'real';
    /** the engine's reads that want a content file's ids only (contentIds: its references listed, what the content load
     * read), nested — served light once the content is loaded too */
    this.contentIdsDepth = 0;
    /** a big announced load reads light first (lightFirst; the page's ?lightfirst=0 turns it off) */
    this.lightFirstOn = o.lightFirst ?? true;
    /** the big load under way (wantFlush): { at, end, seq } — announced at, the end of its window's wait (null before),
     * its window's last batch —, or null */
    this.bigLoad = null;
    /** the files the page read light, here whole now, not delivered to the listeners yet (onReal: REAL_PER_TICK at a
     * time, the latest first); lightReads: the keys of the files whose last load read the light copy (pick) */
    this.realQ = []; this.lightReads = new Set();
    /** the announced batches not posted yet (want: posted together at the wait, or once the page's thread yields —
     * wantFlush), and the current wait window's verdict: its countable bytes (bigBatch), big or not */
    this.wantPending = []; this.wantTimer = null; this.win = { bytes: 0, big: false };
    // (waits: the reads that waited for the worker — waitMs, waitBytes their time and bytes, syncFetches those that held
    // the page; fetchedBytes: what the worker received)
    const ctrl = this.ctrl;
    // (wants: announced entries posted; wantWaits / wantWaitMs / wantTimeouts: the engine's waits for them — want, wantWait;
    // bigLoads / bigFiles / bigBytes: the big loads read light first, the files and their bytes left for later; reloaded:
    // the files the page loaded again in place — reloaded(); fileWaits: the waits by file, { path: [waits, ms] } — waited())
    this.stats = { fileWaits: {}, hits: 0, misses: 0, stallMs: 0, evictions: 0, bytes: 0, syncFetches: 0, wants: 0, wantWaits: 0, wantWaitMs: 0, wantTimeouts: 0, bigLoads: 0, bigFiles: 0, bigBytes: 0, reloaded: 0, get waits() { return this.misses; }, get waitMs() { return this.stallMs; },
      get waitBytes() { return this.bytes; }, get fetchedBytes() { return Atomics.load(ctrl, 2); } };
    this.listeners = { startup: [], whole: [], ahead: [], real: [], launch: [] };
    // (o.worker: a test's stand-in, { postMessage, onmessage })
    this.worker = o.worker ?? new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.ready) { this.times.ready = Math.round(performance.now()); this.trees = m.ready.trees; this.kept = m.ready.kept; this.manifest = m.ready.manifest; this.name = o.name; for (const k of m.ready.real ?? []) this.realHere.add(k); resolve(this); }
        else if (m.failed) reject(new Error(m.failed));
        else if (m.id) { const a = this.asks.get(m.id); this.asks.delete(m.id); if (a) m.error ? a.reject(new Error(m.error)) : a.resolve(m.bytes); }
        else if (m.startup) for (const f of this.listeners.startup) f(m.startup);
        else if (m.whole) for (const f of this.listeners.whole) f(m.whole);
        else if (m.ahead) for (const f of this.listeners.ahead) f(m.ahead);
        else if (m.launch) for (const f of this.listeners.launch) f(m.launch);
        else if (m.real) {
          for (const k of m.real) { this.realHere.add(k); this.lightHere.delete(k); }
          for (const k of m.lightHere ?? []) if (!this.realHere.has(k)) this.lightHere.add(k);
          // (to the listeners paced — holdWatch —, the files the page read light only: the others reload nothing)
          for (const k of m.real) if (this.lightReads.delete(k) && this.listeners.real.length) this.realQ.push(k);
        }
        else if (m.net) this.net = m.net;
        else if (m.log) this.log(m.log);
      };
    });
    this.worker.postMessage({ init: { name: o.name, tree: o.tree, session: o.session ?? '', lang: o.lang ?? null, bw: o.bw ?? linkRate.get(), prefetch: o.prefetch ?? 'start', reloads: !!o.reloads, manifest: o.manifest, orderAtOpen: !!o.orderAtOpen, memBytes: o.memBytes, cacheBlocks: o.cacheBlocks, ctrl: this.ctrl.buffer, data: this.data.buffer } });
    this.timer = setInterval(() => { if (this.used.length) this.worker.postMessage({ used: this.used.splice(0) }); }, 2000);
    this.holdTimer = setInterval(() => this.holdWatch(), 100);
    // (the page's loading indicator, src/host/web/data-meter.js, when it has one: these counters, read live)
    globalThis.orthrosDataMeter?.attach?.(this.ctrl.buffer);
    // (the link's rate as measured, kept for the next page: ctrl[8], KB/s)
    this.saveRate = () => linkRate.set(Atomics.load(this.ctrl, 8) * 1024);
    globalThis.addEventListener?.('pagehide', this.saveRate);
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
   * The engine leaves the link idle for a while before its first read (its own download over, its init under way): the
   * learned order loaded from now ('first-read', 'start' — no-op once it runs), only on a cold store — less than half
   * the launch set here (data-worker.js prefetchNow: a warm store waits for the first read, as before) —, its progress told
   * sparingly until that read.
   */
  prefetchNow() { this.worker.postMessage({ prefetch: true }); }

  /**
   * The files that have a light copy and are here whole now, as they come: `fn(keys)` (`name\npath` lower case) — an
   * engine that can load a file again (a texture in place) does it for those whose light copy it read (lightRead), after
   * repick(h).
   */
  onReal(fn) { this.listeners.real.push(fn); }

  /** The page loaded a file again in place (its count in snapshot: `reloaded`). */
  reloaded(n = 1) { this.stats.reloaded += n; }

  /** `h` was read from its light copy at its last load. */
  lightRead(h) { return !!h.as; }

  /**
   * The next load of `h` (its next read at its start) chooses between the light copy and the file again, however soon it
   * comes: an engine about to load `h` again in place. The rest of a load under way keeps what it read (its offsets are
   * that copy's).
   */
  repick(h) { h.repick = true; }

  /**
   * The page's engine loads a file again in place once it is here (`on`): the light copies read first on every link
   * that is not fast (readsReal), their files fetched soon after them (HttpBackend.upgrade's `soon`) — the player sees
   * them sharpen at once; the worker judges a cold store on the light launch set on every link (data-worker.js
   * prefetchNow, launch-set.js lightLaunch).
   */
  reloads(on = true) { if (this.reloadsInPlace !== !!on) this.worker.postMessage({ reloads: !!on }); this.reloadsInPlace = !!on; }

  /**
   * A big announced load reads the light copies first (`on`, the default), even on a fast link — for an engine that
   * reloads in place only (want, LOAD_BUDGET_S); off: the link alone decides (the page's ?lightfirst=0).
   */
  lightFirst(on = true) { this.lightFirstOn = !!on; if (!on) this.bigLoad = null; }

  /**
   * A big load is under way (want): the loads of this moment read light (loadsReal) — until BIG_HOLD_MS after the
   * engine's last wait for it, PIN_MS after its announce while it never waited.
   */
  bigLoadNow(now = performance.now()) {
    const b = this.bigLoad;
    if (!b) return false;
    if (b.end === null ? now - b.at <= PIN_MS : now - b.end <= BIG_HOLD_MS) return true;
    this.bigLoad = null;
    return false;
  }

  /**
   * The loading in the background, as it goes: `fn({ kind: 'ahead', done, total, finished })` — the learned order —,
   * `fn({ kind: 'whole', bytes, total, done })` — the whole game —, and `fn({ kind: 'launch', bytes, here, wireLeft,
   * seconds, done })` — the way to playable (the launch set: what the game still waits for until it plays without
   * holding; `seconds` at the link's measured rate, null until measured), while the game is not playable yet.
   */
  onProgress(fn) {
    this.listeners.ahead.push((p) => fn({ kind: 'ahead', ...p }));
    this.listeners.whole.push((p) => fn({ kind: 'whole', ...p }));
    this.listeners.launch.push((p) => fn({ kind: 'launch', ...p }));
  }

  /** What earlier sessions read first, loaded before the engine starts; `onProgress({ bytes, total, done })`. */
  startup(onProgress = () => {}) {
    return new Promise((resolve) => {
      const on = (p) => { onProgress(p); if (p.done) { this.listeners.startup = this.listeners.startup.filter((f) => f !== on); resolve(p); } };
      this.listeners.startup.push(on);
      this.worker.postMessage({ startup: true });
    });
  }

  /**
   * The game reached a moment of its own: 'playable' — it first draws in play (a port's page: its loading screen hidden,
   * OpenMW's player in the world). Told to the server once with the pieces used before it: the reads before the mark are
   * the version's launch set (src/vfs/launch-set.js — the startup set, the home's "playable after X MB").
   */
  mark(kind) { this.worker.postMessage({ mark: { kind }, used: this.used.splice(0) }); }

  /**
   * The game entered a phase of its own (`name`: a map, a level — the engine's glue knows it) `ago` ms before now: the
   * reads from then on are learned as that phase's (the server's learned order keeps each phase's reads together, in
   * the order the phase reads them — what a load of that map needs, then what comes next; server.js prefetchList).
   */
  phase(name, ago = 0) {
    this.worker.postMessage({ phase: { name: String(name).slice(0, 64), ago: Math.max(0, Number(ago) || 0) }, used: this.used.splice(0) });
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

  /** The engine's reads wait for the network now (those it waits for: holdCheck). */
  get waiting() { return Atomics.load(this.ctrl, 6) > 0; }
  /**
   * The engine went on (a page tells each frame its engine shows; every call of the engine's into the game data says
   * so too): the reads it asked for until now without waiting for them are not among its waits.
   */
  progress() { this.goes++; }
  /**
   * The page's next task after an asynchronous read was asked for (`id`): the engine has not gone on since — it gave the
   * page its turn waiting for it — is one it waits for, told to the worker (`held`: [id, 1]).
   */
  holdCheck(id) {
    const a = this.pending.get(id);
    if (a && !a.held && this.goes === a.at) { a.held = true; this.worker.postMessage({ held: [[id, 1]] }); }
  }
  /**
   * Every 100 ms: a read the engine waited for and has gone on past since (an engine that yields while it goes on) is not
   * one any more; the files here whole since to the page's listeners (onReal), REAL_PER_TICK of them — an engine that
   * loads them again in place does it over frames, not dozens in one.
   */
  holdWatch() {
    // (the latest first: the files the player saw last)
    if (this.realQ.length) { const keys = this.realQ.splice(-REAL_PER_TICK).reverse(); for (const f of this.listeners.real) f(keys); }
    let told = null;
    for (const [id, a] of this.pending) if (a.held && this.goes !== a.at) { a.held = false; (told ??= []).push([id, 0]); }
    if (told) this.worker.postMessage({ held: told });
  }
  /** The link is thin (measured below THIN_BPS, net-link.js). */
  get thin() { return Atomics.load(this.ctrl, 9) === 1; }
  /**
   * Nothing waits: no read waited for the network for `ms`, and the learned order's loading has nothing left for the
   * game's current step (data-worker.js) — a page may load more of its game now (a view that grows).
   */
  quiet(ms = QUIET_MS) { const c = this.ctrl; return Atomics.load(c, 6) === 0 && Atomics.load(c, 11) >= ms && Atomics.load(c, 10) === 1; }
  /**
   * What the next loads are for, until said again (readsReal): 'light' — loads that can do with less for now (the far
   * ring of a view that grows: their files come after them, for their next loads) —, 'real', or null (the link decides).
   */
  prefer(kind = null) { this.preferred = kind === 'real' || kind === 'light' ? kind : null; }
  /** Bytes the worker received (decoded). */
  get received() { return Atomics.load(this.ctrl, 2); }

  /** The worker stopped (its pending reports sent first). */
  close() { this.saveRate(); clearInterval(this.timer); clearInterval(this.holdTimer); clearTimeout(this.wantTimer); this.worker.postMessage({ close: true }); this.worker.terminate?.(); }

  /**
   * The page's pieces and its waits: { cached, lruMax, hits, misses, stallMs, evictions, bytes, fetchedBytes, openMs,
   * readyMs, mountedMs, content, contentLoadingMs, contentLoadedMs, net } — openMs, readyMs, mountedMs: when the data was
   * opened, its worker answered, a port's page mounted its files (times, null before); content: how the content files
   * are read (this.content), contentLoadingMs / contentLoadedMs when the engine said its content load started / ended;
   * net: the link as the worker last told it (NetLink.snapshot, every second: rate, waits, loading, the background's
   * bytes by producer — bgBy), null before.
   */
  snapshot() { const s = this.stats; return { cached: this.cache.size, lruMax: Math.floor(this.budget / PIECE), hits: s.hits, misses: s.misses, syncFetches: s.syncFetches, stallMs: s.stallMs, evictions: s.evictions, bytes: s.bytes, fetchedBytes: s.fetchedBytes, wants: s.wants, placeWants: s.placeWants ?? 0, wantWaits: s.wantWaits, wantWaitMs: s.wantWaitMs, wantTimeouts: s.wantTimeouts, bigLoads: s.bigLoads, bigFiles: s.bigFiles, bigBytes: s.bigBytes, reloaded: s.reloaded, openMs: this.times.open, readyMs: this.times.ready, mountedMs: this.times.mounted, content: this.content, contentLoadingMs: this.times.contentLoading, contentLoadedMs: this.times.contentLoaded, net: this.net ?? null }; }

  // ---------------------------------------------------------------- light copies

  /**
   * The engine loads its content now and reads its content files light (isLightContent: their light copies keep what
   * that load reads): until contentLoaded, on every link — unless a file is here whole. Said by the engine (OpenMW's
   * Orthros build: globalThis.orthrosContentLoading, streamfs.js); an engine that does not say it reads them as they are.
   */
  contentLoading() { if (this.content === 'real') { this.content = 'light'; this.times.contentLoading = Math.round(performance.now()); } }
  /**
   * The engine's content is loaded: its content files read themselves from now on, every read of every handle (an
   * engine keeps readers open — OpenMW's ReadersCache, up to 100 — each sought again before it reads: its next bytes the
   * file's), for good — what it reads now (a cell's land, its references) the light copy zeroed.
   */
  contentLoaded() {
    if (this.content !== 'done') this.times.contentLoaded = Math.round(performance.now());
    this.content = 'done';
    for (const h of this.byId) if (h.content) h.as = null;
  }
  /**
   * The engine's next reads of its content files want what its content load read only — a cell's references listed by
   * their ids (OpenMW's CellStore::listRefs: a search through every cell, orthros-r13.patch) — (`on` true), or no
   * longer (false; nested). Those reads are served from the light copies once the content is loaded too (contentPick):
   * what the content load brought, in the page or the store, not every cell's records of the file fetched one by one
   * while the page's thread waits. Nothing before the content load said it read light (content 'real': the files).
   */
  contentIds(on) { this.contentIdsDepth = Math.max(0, this.contentIdsDepth + (on ? 1 : -1)); }
  /**
   * `h` is a content file whose light copy keeps its layout (isLightContent, the tree's light size its size): read light
   * while the content loads only (contentPick).
   */
  contentFile(h) {
    if (h.content !== undefined) return h.content;
    if (h.src !== undefined || !this.trees) return false;
    return (h.content = isLightContent(h.path) && this.lightOf(h) === h.size);
  }
  /**
   * What a read of the content file `h` reads now: its light copy's handle while the content loads, or once it is loaded
   * for a read of ids only (contentIds) — unless the file is here whole —, else `h`.
   */
  contentPick(h) {
    const light = this.content === 'light' || (this.content === 'done' && this.contentIdsDepth > 0);
    return light && !this.realHere.has(h.name + '\n' + h.path.toLowerCase()) ? this.fileAs(h.name, `${LIGHT_DIR}/${h.path}`, h.light) : h;
  }

  /** The size of `h`'s light copy (the tree's `light`), 0 when it has none (or not known yet: the file then). */
  lightOf(h) {
    if (h.light !== undefined) return h.light;
    if (h.src !== undefined || h.path.startsWith(LIGHT_DIR + '/')) return (h.light = 0);
    const tree = this.trees?.[h.name]; if (!tree) return 0;
    return (h.light = treeFile(tree, h.path)?.light ?? 0);
  }

  /**
   * What a read of `h` at `position` reads: `h`, or its light copy's handle. Chosen at each load of the file (a read at
   * its start, LOAD_GAP_MS after its last one, or the first after repick), kept until its next load (readsReal); its
   * light copy read, the worker fetches the file in the background (told once; soon for an engine that reloads). A load
   * announced (want) reads what was announced (h.pin, within PIN_MS: the link's measure may cross FAST_BPS during the
   * wait — the other one was not fetched), unless the file itself is here.
   */
  pick(h, position) {
    if (!this.lightOf(h)) return h;
    const now = performance.now();
    // (a content file: chosen at each read — the engine's content load or not —, never told to the worker: no upgrade)
    if (this.contentFile(h)) { const v = this.contentPick(h); h.as = v === h ? null : v; h.at = now; return v; }
    if (position === 0 && this.newLoad(h, now)) {
      h.repick = false;
      const pin = h.pin && now - h.pin.at <= PIN_MS ? h.pin : null;
      h.pin = null;
      const real = pin ? pin.real || this.realHere.has(h.name + '\n' + h.path.toLowerCase()) : this.loadsReal(h);
      h.as = real ? null : this.fileAs(h.name, `${LIGHT_DIR}/${h.path}`, h.light);
      const key = h.name + '\n' + h.path.toLowerCase();
      if (h.as && !this.realHere.has(key)) this.lightReads.add(key); else this.lightReads.delete(key);
      if (h.as && !h.told) { h.told = true; this.worker.postMessage({ light: { name: h.name, path: h.path, soon: this.reloadsInPlace } }); }
    }
    h.at = now;
    return h.as ?? h;
  }

  /** A read of `h` at its start now is a new load of it (pick chooses again). */
  newLoad(h, now = performance.now()) { return !!h.repick || now - (h.at ?? -Infinity) > LOAD_GAP_MS; }
  /**
   * A load of `h` that has a light copy, starting now, reads the file itself (readsReal, with what the page knows now);
   * `big`: a big load under way (bigLoadNow) — light, as the page's 'light', unless the page said what its loads are for.
   */
  loadsReal(h, big = this.bigLoadNow()) {
    const key = h.name + '\n' + h.path.toLowerCase(), c = this.ctrl;
    return readsReal({ here: this.realHere.has(key), lightHere: this.lightHere.has(key), fast: Atomics.load(c, 7) === 1,
      thin: Atomics.load(c, 9) === 1, measured: Atomics.load(c, 8) > 0, prefer: this.preferred ?? (big ? 'light' : null), reloads: this.reloadsInPlace });
  }
  /**
   * What the next load of `h` will read — `h`, or its light copy's handle — as pick will choose it; with `pin`, that
   * choice held for that load (h.pin: what is announced is what it reads — pick), not made yet (its first read makes it).
   * `big`: whether a big load is under way (default: bigLoadNow). `position`: where the read starts — past the file's
   * start, pick chooses nothing (a texture inside an archive the engine keeps open): what the file's current load reads
   * (h.as; the file itself before any), pinned all the same when asked (an engine that opens the archive again meanwhile
   * — a new load of it — reads what was announced).
   */
  nextPick(h, pin = false, big = undefined, position = 0) {
    if (!this.lightOf(h)) return h;
    if (this.contentFile(h)) return this.contentPick(h);
    if (position > 0) { const v = h.as ?? h; if (pin) h.pin = { real: v === h, at: performance.now() }; return v; }
    const v = !this.newLoad(h) ? h.as ?? h : this.loadsReal(h, big) ? h : this.fileAs(h.name, `${LIGHT_DIR}/${h.path}`, h.light);
    if (pin) h.pin = { real: v === h, at: performance.now() };
    return v;
  }

  // ---------------------------------------------------------------- announced reads

  /**
   * The engine's next reads, announced (docs/slow-network.md "Announced reads"): `entries` [{ h, off, len }] (len -1 or
   * absent: to the end of the file; off absent: 0), `label` what the load is for ('<kind>:<place>', kept for the
   * learned places). A file read light (nextPick: the light copy the next load of it reads, on a link that is not fast)
   * is announced as its light copy, whole (a texture is read whole; its light copy is smaller — never the file itself
   * there), and that load reads it (pinned: nextPick). The bytes the page holds already are not; the rest go to the
   * worker (fetched in parallel, kept: HttpBackend.wantList), one batch (`from`: the first batch of the current wait's
   * window — the worker's ctrl[12] counts from it), posted with the window's other batches (wantFlush: at the wait, or
   * once the page's thread yields — the window's light-or-file verdict is the whole window's). Returns how many entries
   * are not in the page as either copy that verdict may choose (0: nothing to wait for — no batch).
   * `opts` (or the label alone): { label, prio } — prio 'place': a list the page predicts (the place a saved game will
   * load, docs/openmw.md "Anticipated places"), not one the engine waits for: fetched in the background below the
   * game's reads, a load's and the launch set (HttpBackend.wantList `prio: 'place'`), outside the wait's window (no
   * batch number: wantWait never waits for it), its light-or-file choice made by the link now and not pinned (nor
   * made light by a big load: the player idles meanwhile, a fast link brings the files themselves).
   * `wait` false: a list the engine waits for through its own reads, not wantWait (an engine whose reads are synchronous
   * and that cannot be told to wait: GoldSrc's, src/ports/goldsrc/bsp-reads.js — a map's load says what it reads once
   * the map's file is read): posted at once (the page's thread does not yield before those reads), no batch number
   * (wantWait never waits for it), the link's light-or-file choice pinned (nextPick at each entry's offset: a range past a
   * file's start reads what the file's current load reads), not weighed as a big load; the worker's list holds the link
   * for it as for any announced load (HttpBackend.wantList), and the engine's reads join its requests.
   * A big load (bigBatch: an engine that reloads in place, its window's files that have a light copy more than
   * LOAD_BUDGET_S of the link): those files announced and read as their light copies, the loads of the moment too
   * (bigLoadNow).
   */
  want(entries, opts = '') {
    const { label = '', prio = null, wait = true } = typeof opts === 'string' ? { label: opts } : opts ?? {};
    if (prio === 'place' || wait === false) {
      const place = prio === 'place', list = [];
      for (const { h, off = 0, len = -1 } of entries) {
        if (!h || h.src !== undefined || h.failed) continue;
        const r = this.announced(h, off, len, this.nextPick(h, !place, false, place ? 0 : off));
        if (r) list.push(r);
      }
      if (!list.length) return 0;
      const text = String(label ?? '').slice(0, 80);
      if (place) { this.stats.placeWants = (this.stats.placeWants ?? 0) + list.length; this.worker.postMessage({ wantPlace: { list, label: text } }); }
      else { this.stats.wants += list.length; this.worker.postMessage({ want: { seq: 0, list, label: text, wait: false }, used: this.used.splice(0) }); }
      return list.length;
    }
    this.progress();
    const kept = [];
    let n = 0;
    for (const e of entries) {
      const h = e?.h;
      if (!h || h.src !== undefined || h.failed) continue;
      kept.push(e);
      // (not in the page as either copy the window's verdict may choose: one to wait for)
      const { off = 0, len = -1 } = e;
      const as = this.contentFile(h) ? [this.contentPick(h)] : !this.newLoad(h) ? [h.as ?? h] : this.lightOf(h) && !this.realHere.has(h.name + '\n' + h.path.toLowerCase()) ? [h, this.fileAs(h.name, `${LIGHT_DIR}/${h.path}`, h.light)] : [h];
      if (as.some((v) => this.announced(h, off, len, v))) n++;
    }
    if (!n) return 0;
    // (its batch number now — the wait's window counts it —, posted with the window's other batches: wantFlush)
    this.wantPending.push({ seq: ++this.wantSeq, from: this.wantFrom, entries: kept, label: String(label ?? '').slice(0, 80) });
    this.wantTimer ??= setTimeout(() => this.wantFlush(), 0);
    return n;
  }

  /**
   * What an announce of `h`'s [off, off + len) asks when its load reads `v` (h, or its light copy: whole — unless it keeps
   * the file's layout, sameLayout: that range of it): [name, path, off, len], or null when the page has it.
   */
  announced(h, off, len, v) {
    const whole = v !== h && !this.sameLayout(h, v);
    const a = whole ? 0 : Math.max(0, Math.min(h.size, off)), n = whole ? v.size : len < 0 ? h.size - a : Math.min(len, h.size - a);
    return !(n > 0) || this.inPage(v, a, n) ? null : [v.name, v.path, a, n];
  }

  /**
   * The announced batches not posted yet, to the worker: the window's verdict first (bigBatch over all of them — an
   * engine announces one load in several lists, e.g. a place's textures and its land's, then waits once), then each
   * batch's entries pinned as that verdict says (big: their light copies; else the link's choice — a small load during
   * a big one's hold too). At the wait, or once the page's thread yields (an engine that announces and goes on).
   */
  wantFlush() {
    clearTimeout(this.wantTimer); this.wantTimer = null;
    const batches = this.wantPending.splice(0);
    if (!batches.length) return;
    if (!this.win.big && this.bigBatch(batches.flatMap((b) => b.entries))) this.win.big = true;
    const big = this.win.big;
    for (const { seq, from, entries, label } of batches) {
      const list = [];
      for (const { h, off = 0, len = -1 } of entries) {
        if (h.failed) continue;
        const r = this.announced(h, off, len, this.nextPick(h, true, big, off));
        if (r) list.push(r);
      }
      // (an empty batch too: the worker settles its number at once)
      this.stats.wants += list.length;
      this.worker.postMessage({ want: { seq, from, list, label }, used: this.used.splice(0) });
    }
    if (big && this.bigLoad) this.bigLoad.seq = batches.at(-1).seq;
  }

  /**
   * The announced batches of the current wait window (`entries`: theirs not posted yet; this.win: the window's bytes
   * counted so far) make a big load: the page's engine reloads in place, the page lets it (lightFirst) and did not say
   * what its loads are for (prefer), and the files of the window that have a light copy and whose next load would read
   * the file itself — not here, nor in the page, nor in a load under way — would hold the link more than LOAD_BUDGET_S
   * (their bytes on the wire — the link's wire/file ratio, ctrl[15] — at its measured rate; FAST_BPS before it is
   * measured). Then the big-load state starts (bigLoad: those files, and the loads of the moment, read light —
   * loadsReal), counted in stats.big*; the files come after the load (their light copy read: HttpBackend.upgrade,
   * `soon`, held while a load is under way). Small loads unchanged. Only the files that have a light copy count: what
   * else the window fetches (meshes, archives) is read as is either way, and may be in the worker's store already (the
   * page cannot tell).
   */
  bigBatch(entries) {
    if (!this.reloadsInPlace || !this.lightFirstOn || this.preferred !== null) return false;
    const seen = new Set();
    let bytes = 0, files = 0;
    for (const { h } of entries) {
      // (a content file's ranges — a cell's land and references — are the file's, read as they are: not a texture)
      if (!h || h.src !== undefined || h.failed || seen.has(h) || !this.lightOf(h) || this.contentFile(h)) continue;
      seen.add(h);
      if (!this.newLoad(h) || this.realHere.has(h.name + '\n' + h.path.toLowerCase()) || !this.loadsReal(h, false) || this.inPage(h, 0, h.size)) continue;
      bytes += h.size; files++;
    }
    this.win.bytes += bytes;
    const rate = (Atomics.load(this.ctrl, 8) * 1024) || FAST_BPS, ratio = Atomics.load(this.ctrl, 15) / 1000 || 1;
    if (!(this.win.bytes * ratio > rate * LOAD_BUDGET_S)) return false;
    this.bigLoad = { at: performance.now(), end: null, seq: this.wantSeq };
    this.stats.bigLoads++; this.stats.bigFiles += files; this.stats.bigBytes += this.win.bytes;
    this.log(`a big load (${Math.round(this.win.bytes / 1e6)} MB of files > ${LOAD_BUDGET_S} s of the link): light copies first`);
    return true;
  }

  /**
   * The page waits (its thread spins, as fetchSync: no message gets through meanwhile — the worker's answer is ctrl[12])
   * until every batch announced since the last wait (want: wantFrom..wantSeq) is in the worker, each entry stored or
   * failed, or `timeoutMs` passed (or the worker stopped beating — DEAD_MS): true when all of it is there (or failed: its
   * reads say why), false on time out (the reads fetch the rest themselves). The page's next waits count only batches
   * after these, whatever the outcome. The window's batches posted first (wantFlush); a big load's hold counts from
   * the end of its own window's wait (a later small load's wait does not extend it).
   */
  wantWait(timeoutMs = 15000) {
    this.wantFlush();
    const from = this.wantFrom, target = this.wantSeq;
    const ok = this.wantWaitFor(timeoutMs);
    const b = this.bigLoad;
    if (b && b.seq >= from && b.seq <= target && this.bigLoadNow()) b.end = performance.now();
    this.win = { bytes: 0, big: false };
    return ok;
  }
  /** wantWait's wait itself. */
  wantWaitFor(timeoutMs) {
    this.progress();
    const target = this.wantSeq, c = this.ctrl;
    if (target < this.wantFrom) return true;
    this.wantFrom = target + 1;
    if (Atomics.load(c, 12) >= target) return true;
    const t0 = performance.now();
    let beat = Atomics.load(c, 3), beatAt = t0, ok = true;
    while (Atomics.load(c, 12) < target) {
      const b = Atomics.load(c, 3), now = performance.now();
      if (b !== beat) { beat = b; beatAt = now; } else if (now - beatAt > DEAD_MS) { ok = false; break; }
      if (now - t0 >= timeoutMs) { ok = false; break; }
    }
    this.stats.wantWaits++; this.stats.wantWaitMs += performance.now() - t0;
    if (!ok) this.stats.wantTimeouts++;
    return ok;
  }
  /** Announced entries the worker has not settled yet (ctrl[13]), and those that failed since the start (ctrl[14]). */
  get wantLeft() { return Atomics.load(this.ctrl, 13); }
  get wantFailed() { return Atomics.load(this.ctrl, 14); }

  /**
   * `v`, the light copy of `h`, keeps the file's layout: its size is the file's (a WAD3's — light-copies.js lightWad: the
   * same archive, every offset kept, only pixels redrawn), so a range of one is the same range of the other.
   */
  sameLayout(h, v) { return v !== h && v.size === h.size; }

  /**
   * The bytes [position, position + length) of `h` from the page's pieces, nothing fetched: a copy, or null when some are
   * not in the page — those of the file, or else of its light copy when it keeps the file's layout (sameLayout: an
   * archive's directory, read as either) —, to read what the engine read already (a map's lumps, an archive's directory).
   */
  peek(h, position, length) {
    const at = Math.max(0, position), end = Math.min(h.size, at + length);
    if (!(end > at)) return new Uint8Array(0);
    // (not a content file's: its copy's zeroed payloads are not the file's bytes)
    const light = this.lightOf(h) === h.size && !this.contentFile(h) ? this.fileAs(h.name, `${LIGHT_DIR}/${h.path}`, h.size) : null;
    const v = this.inPage(h, at, end - at) ? h : light && this.inPage(light, at, end - at) ? light : null;
    if (!v) return null;
    const out = new Uint8Array(end - at);
    for (let pos = at; pos < end;) {
      const p = Math.floor(pos / PIECE), piece = this.cache.get(v.id * PER_FILE + p), within = pos - p * PIECE, n = Math.min(end - pos, piece.length - within);
      out.set(piece.subarray(within, within + n), pos - at);
      pos += n;
    }
    return out;
  }

  /** Every byte of [position, position + length) of `h` (as is: no light copy chosen) is in the page's pieces. */
  inPage(h, position, length) {
    const end = Math.min(h.size, position + length);
    for (let p = Math.floor(position / PIECE); p * PIECE < end; p++) if (!this.cache.has(h.id * PER_FILE + p)) return false;
    return true;
  }

  // ---------------------------------------------------------------- reads

  /** Some of the bytes [position, position + length) of `h` are not in the page yet. */
  missing(h, position, length) {
    this.progress();
    const v = this.pick(h, position);
    if (v !== h) return position < v.size && this.missing(v, position, Math.min(length, v.size - position));
    return !this.inPage(h, position, length);
  }

  /** The bytes [position, position + length) of `h` into the engine's `buffer` at `offset` (waiting when missing). */
  read(h, buffer, offset, length, position) {
    this.progress();
    const end = Math.min(h.size, position + length);
    if (!(end > position)) return 0;
    const v = this.pick(h, position);
    if (v !== h) {
      // (the light copy's bytes as the file's — zeros past them, up to the file's size: the engine reads what its
      // header says)
      const n = position < v.size ? this.read(v, buffer, offset, Math.min(end, v.size) - position, position) : 0;
      buffer.fill(0, offset + n, offset + end - position);
      return end - position;
    }
    const sequential = position >= h.last - PIECE && position <= h.last + 2 * PIECE;
    h.run = sequential ? h.run + (end - position) : 0;
    h.last = end;
    let pos = position, out = offset;
    while (pos < end) {
      const p = Math.floor(pos / PIECE), key = h.id * PER_FILE + p;
      let piece = this.cache.get(key);
      if (piece) { this.cache.delete(key); this.cache.set(key, piece); this.stats.hits++; }
      else { this.fetchSync(h, p, end); piece = this.cache.get(key); if (!piece) throw new Error(`${h.path}: bytes at ${p * PIECE} missing`); }
      // (a content file read as itself while the content loads — here whole —: learned as its light copy's read, what
      // that load reads — a content file's own reads learned are those after it: server.js CONTENT_REAL)
      if (piece.fresh) { piece.fresh = false; if (h.src === undefined) this.used.push([h.name, h.content && this.content === 'light' ? `${LIGHT_DIR}/${h.path}` : h.path, p]); }
      const within = pos - p * PIECE, n = Math.min(end - pos, piece.length - within);
      buffer.set(piece.subarray(within, within + n), out);
      pos += n; out += n;
    }
    return end - position;
  }

  /** The whole file (an engine that maps it: mmap). */
  whole(h) {
    if (h.whole) return h.whole;
    h.as = null; h.at = performance.now(); // (the file itself, not its light copy: mapped whole)
    this.lightReads.delete(h.name + '\n' + h.path.toLowerCase());
    const all = new Uint8Array(h.size);
    for (let at = 0; at < h.size; at += SPAN) this.read(h, all, at, Math.min(SPAN, h.size - at), at);
    return (h.whole = all);
  }

  /**
   * The bytes [position, position + length) of `h` into the page, without holding it (an engine that waits: JSPI).
   * `background`: nothing waits for them (readable()) — never counted among the engine's waits; else they are while
   * the engine does not go on (holdCheck: an engine that asked ahead goes on).
   */
  ensure(h, position, length, background = false, real = false) { this.progress(); return this.fetchAsync(h, position, length, background, this.goes, real); }

  /** ensure(), the engine having asked at its progress `at`; `real`: the file's own bytes, whatever its loads read. */
  async fetchAsync(h, position, length, background, at, real = false) {
    const v = real ? h : this.pick(h, position);
    if (v !== h) { if (position < v.size) await this.fetchAsync(v, position, Math.min(length, v.size - position), background, at); return; }
    const end = Math.min(h.size, position + length);
    for (let p = Math.floor(position / PIECE); p * PIECE < end;) {
      if (this.cache.has(h.id * PER_FILE + p)) { p++; continue; }
      const id = this.nextAsk++, t0 = performance.now(), held = false;
      if (!background) { this.pending.set(id, { at, held }); setTimeout(() => this.holdCheck(id), 0); }
      let bytes;
      try {
        bytes = await new Promise((resolve, reject) => {
          this.asks.set(id, { resolve, reject });
          this.worker.postMessage({ read: { id, ...this.whose(h), off: p * PIECE, len: end - p * PIECE, want: this.takeBytes(h, end - p * PIECE), held } });
        });
      } finally { this.pending.delete(id); }
      // (the engine's waits: the reads it did not go on past — the time since it asked)
      if (!background && this.goes === at) this.waited(h, performance.now() - t0);
      this.keep(h, p, bytes);
      p = Math.floor((p * PIECE + Math.max(PIECE, bytes.length)) / PIECE);
    }
  }

  /**
   * Whether the bytes [position, position + length) of `h` (by default the whole file; a negative length: to its end)
   * can be read without the page's thread waiting: true, or false and those bytes fetched in the background (ensure,
   * once at a time for the same bytes) — an engine that would rather skip or put off a load than wait (OpenMW's sounds
   * played once, orthros-r2.patch; its preloads, a file inside an archive among them, orthros-r5.patch). A file whose
   * fetch failed: true (its read waits, and says what failed). A content file (contentFile): the file's own bytes,
   * whatever its light copy in the page — what the engine asks of it is what it reads once its content is loaded (a
   * cell's land: OpenMW's terrain chunks put off until it is here, orthros-r12.patch).
   */
  readable(h, position = 0, length = h.size) {
    const at = Math.max(0, Math.min(h.size, position)), len = length < 0 ? h.size - at : Math.min(length, h.size - at);
    const real = this.contentFile(h);
    if (h.failed || !(len > 0) || (real ? (this.progress(), this.inPage(h, at, len)) : !this.missing(h, at, len))) return true;
    const whole = at === 0 && len === h.size, key = `${at}+${len}`;
    if (whole ? h.ensuring : h.ensuringRanges?.has(key)) return false;
    const done = whole ? () => { h.ensuring = null; } : () => { h.ensuringRanges.delete(key); };
    const p = this.ensure(h, at, len, true, real).catch((e) => { h.failed = true; this.log(`${h.path}: ${e?.message ?? e}`); }).finally(done);
    if (whole) h.ensuring = p; else (h.ensuringRanges ??= new Map()).set(key, p);
    return false;
  }

  /** A request's file: a game file's version and path, or a source's id. */
  whose(h) { return h.src !== undefined ? { src: h.src } : { name: h.name, path: h.path }; }

  /** How many bytes to take back from the worker (as far as it has them already): more for a file read in order. */
  takeBytes(h, need) { return Math.min(SPAN, Math.max(need, h.run > 0 ? Math.max(1 << 20, h.run) : 256 << 10)); }

  /**
   * Piece `p` of `h` on, through `need`, from the worker: the page's thread waits for its answer. Not before `ready`: Chrome
   * hands a module worker the messages sent before its scripts ran through the page's thread, which spins here — such a
   * read is never answered (its heartbeat, ctrl[3], still 0).
   */
  fetchSync(h, p, need) {
    const start = p * PIECE;
    // (asked: from this piece to the end of the read, short of the first piece the page has — the worker adds what it
    // has here already beyond, up to want())
    let stop = Math.min(h.size, Math.max(need, start + PIECE));
    for (let q = p + 1; q * PIECE < stop; q++) if (this.cache.has(h.id * PER_FILE + q)) { stop = q * PIECE; break; }
    const gen = ++this.gen, { ctrl } = this;
    this.worker.postMessage({ gen, ...this.whose(h), off: start, len: Math.min(SPAN, stop - start), want: this.takeBytes(h, stop - start), used: this.used.splice(0) });
    const t0 = performance.now();
    let beat = Atomics.load(ctrl, 3), beatAt = t0;
    while (Atomics.load(ctrl, 0) !== gen) {
      const b = Atomics.load(ctrl, 3), now = performance.now();
      if (b !== beat) { beat = b; beatAt = now; } else if (now - beatAt > DEAD_MS) throw new Error(b === 0 ? 'the game data worker never started (a read the page waited for before GameData.ready)' : 'the game data worker stopped answering');
    }
    this.stats.syncFetches++; this.waited(h, performance.now() - t0);
    const n = ctrl[1];
    if (n < 0) throw new Error(`${h.path}: read failed at ${start}`);
    this.keep(h, p, this.data.subarray(0, n));
  }

  /**
   * One wait of the engine for `h`'s bytes (`ms` long): counted (misses, stallMs) and by file (fileWaits: which file a
   * session's waits were for — the passive records' attribution, perf-page.js portDataSummary).
   */
  waited(h, ms) {
    const s = this.stats, w = (s.fileWaits[h.path ?? `src:${h.src}`] ??= [0, 0]);
    s.misses++; s.stallMs += ms; w[0]++; w[1] += ms;
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
