// A Windows game's data through the data worker (CLAUDE.md "Standardization"; docs/slow-network.md "The data worker
// of the Windows games"), the emulator's side: the version opened in data-worker.js — the same reader as the engines
// that run in the page (game-data.js: HttpBackend, the OPFS store, the learned order, the prediction of opens, the
// offline copy) —, its network, decompression, store and background loading on that worker's thread, not the guest's.
// The blocks it has are in shared memory (shared-blocks.js): a ReadFile whose bytes are there is a plain copy (straight
// into guest memory), noted in a ring for the reader's planning there. A read that misses:
// - asynchronous (HttpFile.prepare's contract, kernel32 ReadFile's parked read): asked by message; the data worker answers
//   at once when it has the bytes (memory, store: the emulator waits for that a moment, QUICK_MS), else says it needs
//   the network and the guest thread is parked — its completion visible in shared memory (`ready()`: the scheduler sees
//   it between slices, no event loop turn needed) and by message;
// - synchronous (a read that cannot park: a nested wait, a program image): the emulator's thread waits on shared memory
//   (Atomics.wait) for the data worker's answer.
// A player's page uses it on a thin or not yet measured link (net-link.js dataWorkerWanted: measured 2026-11-11/12,
// docs/slow-network.md "The data worker of the Windows games" and "The first launch on a slow link"), the reader on the
// emulator's thread otherwise (src/web/worker.js); ?dbg=ORTHROS_DATA_WORKER=1: always, =0: never, =auto: by the link in
// a harness run too (a harness run without it: never). A data worker that stopped answering (no heartbeat for DEAD_MS) is left: the reads
// from then on are fetched on the emulator's thread (FallbackReader: the files themselves, as the reader before the
// data worker without its store). A synchronous read that waits long tells the page the link's progress every second
// (onWait: the emulator's own statistics stop while it waits).
import { acct, C as ACCT } from '../core/frame-acct.js';
import { treeLookup, treeStat, treeReaddir, isVideoFile } from './game-tree.js';
import { SharedBlocks, fileKeys, BLOCK, CHUNK } from './shared-blocks.js';
import { NetLink } from './net-link.js';

/**
 * Whether the game's data goes through the data worker (read at the start): ORTHROS_DATA_WORKER=1 (the page sets it
 * by its link: dataWorkerWanted).
 */
export function dataWorkerOn() { const v = globalThis.ORTHROS_DATA_WORKER; return typeof Worker !== 'undefined' && !!globalThis.crossOriginIsolated && v !== undefined && v !== '' && v !== 'auto' && Number(v) !== 0; }
/** How long an asynchronous read waits for the data worker's first answer (ms: memory, the browser's store) before it parks. */
const QUICK_MS = 2;
/** ... once most of the recent waits ended without an answer (the data worker busy: cores shared): a shorter one. */
const QUICK_BUSY_MS = 0.25;
/** The data worker is left once its heartbeat stopped this long (it died, or hangs): the reads fetched here instead. */
const DEAD_MS = 10000;

export class DataLink {
  /**
   * The version `o.name` and the versions it requires opened in a data worker. o: { name, tree, manifest, mounts (the
   * versions the guest mounts: the game's, then manifest.extraMounts'), session, lang, bw, cacheBlocks, encoded, stores
   * ('opfs' | 'none'), memPrefetch, prefetch, offline, netLog }, log(kind, msg); `worker`: the worker (a test's).
   */
  static open(o, log, worker = new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' })) {
    const link = new DataLink(worker, log);
    return new Promise((resolve, reject) => {
      link.opened = { resolve, reject };
      worker.onerror = (e) => { if (link.opened) { link.opened = null; reject(new Error(`data worker: ${e.message ?? 'failed to start'}`)); } };
      // (the worker's debug globals — ?dbg=ORTHROS_…: data-worker.js reads some — go with it)
      const globals = {};
      for (const k of Object.keys(globalThis)) if (k.startsWith('ORTHROS_') && (typeof globalThis[k] !== 'object' || globalThis[k] === null)) globals[k] = globalThis[k];
      worker.postMessage({ w32: { ...o, globals } });
    });
  }

  constructor(worker, log) {
    this.worker = worker; this.log = log;
    worker.onmessage = (e) => this.message(e.data);
    /** the shared blocks (shared-blocks.js), from the data worker's ready */
    this.blocks = null;
    /** mounted version -> { tree, keys (fileKeys), backend } */
    this.mounts = new Map();
    this.nextH = 0; this.seq = 0; this.gen = 0; this.answer = null;
    /** asynchronous reads in flight: seq -> resolve */
    this.pending = new Map();
    /** each read of the game (path, start, end, file): the session's read log (worker.js) */
    this.onRead = null;
    /** the reads the data worker reports itself (a session restored from a snapshot: those the server did not learn) */
    this.onReads = null;
    /** the game's reads, whatever answered them: bytes, those of movies */
    this.reads = { bytes: 0, videoBytes: 0 };
    /** the data worker's counters, as last told (every 250 ms) */
    this.state = null;
    this.stats = { syncReads: 0, syncMs: 0, prepares: 0, quick: 0, parked: 0, late: 0, settleMs: 0, fallbackReads: 0 };
    /** the recent first-answer waits that ended without an answer, out of 16 (an average: QUICK_BUSY_MS above 8) */
    this.lateness = 0;
    /** a synchronous read waiting longer than a second: told every second ({ ms, rx: bytes received, bw }) — in the
     * emulator's worker, to the page (main.js 'netbeat') */
    this.onWait = typeof WorkerGlobalScope !== 'undefined' && typeof postMessage === 'function' ? ({ rx, bw }) => postMessage({ type: 'netbeat', net: { rx, bw: bw || null, waiting: true } }) : null;
    /** the reader here once the data worker stopped answering (FallbackReader), null while it answers */
    this.fallback = null;
  }

  message(m) {
    if (m.log) { this.log(m.kind ?? 'file', m.log); return; }
    if (m.w32done !== undefined) { const r = this.pending.get(m.w32done); if (r) { this.pending.delete(m.w32done); r(); } return; }
    if (m.w32stats) { this.state = m.w32stats; return; }
    if (m.w32reads) { const d = m.t0 - performance.timeOrigin; for (const [name, path, a, b, t] of m.w32reads) this.onReads?.(name, path, a, b, t + d); return; }
    if (m.w32ready) {
      const r = m.w32ready;
      this.blocks = new SharedBlocks(r.sab);
      r.mounts.forEach(({ name, tree, parts }, i) => this.mounts.set(name, { name, tree, keys: fileKeys(tree, i), parts, backend: null }));
      this.manifest = r.manifest; this.partNames = r.parts;
      this.opened?.resolve(this); this.opened = null;
      return;
    }
    if (m.failed) { this.opened?.reject(new Error(m.failed)); this.opened = null; }
  }

  /** The guest's view of mounted version `name` (a VFS backend: lookup, stat, readdir, open). */
  backend(name) {
    const m = this.mounts.get(name); if (!m) throw new Error(`${name}: not opened`);
    return (m.backend ??= new RemoteBackend(this, m));
  }

  /** A handle of the file `path` (a tree path) of mounted version `name`, opened in the data worker (its reader state). */
  open(name, path) {
    const h = ++this.nextH;
    this.worker.postMessage({ w32open: [h, name, path] });
    return h;
  }
  close(h) { this.worker.postMessage({ w32close: h }); }

  /**
   * An asynchronous read of [off, off + len) of handle `h` that the shared blocks do not hold: null once the data worker
   * put it there within QUICK_MS, else a promise (resolved when it is there; `ready()` says so before the message).
   */
  prepare(h, off, len, held) {
    if (this.fallback) return null; // (read here, synchronously)
    const seq = this.seq = (this.seq + 1) & 0x3fffffff || 1, B = this.blocks;
    this.stats.prepares++;
    let resolve; const p = new Promise((r) => { resolve = r; });
    this.pending.set(seq, resolve);
    this.worker.postMessage({ w32prep: { seq, h, off, len, held: !!held } });
    // (the first answer waited for a moment — memory, the store —, shorter while the data worker is mostly late)
    const quick = Number(globalThis.ORTHROS_DATA_QUICK_MS ?? (this.lateness > 8 ? QUICK_BUSY_MS : QUICK_MS));
    const t0 = performance.now(), how = B.settle(seq, quick);
    this.stats.settleMs += performance.now() - t0;
    this.lateness += ((how === 'late' ? 16 : 0) - this.lateness) / 8;
    if (how === 'done') { this.pending.delete(seq); this.stats.quick++; return null; }
    this.stats.parked++; if (how === 'late') this.stats.late++;
    p.ready = () => B.isDone(seq);
    // (its completion wakes this worker's event loop through the shared memory as soon as it is there — not only by the
    // data worker's message, which queues behind its other messages)
    if (typeof Atomics.waitAsync === 'function') this.wake(seq, resolve);
    return p;
  }
  /** Resolve the parked read `seq` as soon as the shared memory says it is here (Atomics.waitAsync on the signal word). */
  wake(seq, resolve) {
    const B = this.blocks, step = () => {
      const v = B.signal;
      if (B.isDone(seq) || this.fallback) { if (this.pending.delete(seq)) resolve(); return; }
      if (!this.pending.has(seq)) return; // (answered by message)
      const w = B.waitSignal(v, 5000);
      if (w.async) w.value.then(step); else step();
    };
    step();
  }

  /**
   * A synchronous read: the data worker reads [off, end) of handle `h` (its reader state, its fetches) and answers the
   * bytes from `from` on, copied into `out` at `at`. Their count.
   */
  syncRead(h, off, end, from, out, at, file = null) {
    if (this.fallback) return this.fallbackRead(file, from, end, out, at);
    const need = end - from, B = this.blocks, t0 = performance.now();
    let buf;
    if (!this.answer || this.answer.length < need) { let n = 1 << 20; while (n < need) n *= 2; this.answer = new Uint8Array(new SharedArrayBuffer(n)); buf = this.answer.buffer; }
    const gen = this.gen = (this.gen + 1) & 0x3fffffff || 1;
    this.worker.postMessage({ w32sync: { gen, h, off, end, from, buf } });
    const ap = acct.enter(ACCT.net); // (the game's thread waits for the data: its network part, as the reader on this thread counted it)
    try {
      let beats = B.beats, beatAt = t0;
      for (;;) {
        const n = B.waitAnswer(gen, 1000);
        if (n !== null) {
          if (n < 0) throw new Error(`game file read failed (${need} bytes at ${from})`);
          const k = Math.min(n, need);
          if (k === 1) out[at] = this.answer[0]; else out.set(this.answer.subarray(0, k), at);
          return k;
        }
        const now = performance.now();
        if (B.beats !== beats) { beats = B.beats; beatAt = now; } else if (now - beatAt > DEAD_MS && file) { this.leave(); return this.fallbackRead(file, from, end, out, at); }
        this.onWait?.({ ms: now - t0, rx: B.rx, bw: B.bw });
      }
    } finally { acct.leave(ap); this.stats.syncReads++; this.stats.syncMs += performance.now() - t0; }
  }
  /** The data worker stopped answering: left, the reads fetched on this thread from now on (FallbackReader). */
  leave() {
    if (this.fallback) return;
    this.fallback = new FallbackReader();
    this.log('warn', `the game data worker stopped answering for ${DEAD_MS / 1000} s: the game's files are read on the emulator's thread from now on`);
    for (const [seq, r] of this.pending) { this.pending.delete(seq); r(); } // (their reads ask again, here)
    try { this.worker.terminate(); } catch { /* gone */ }
  }
  /** [from, end) of RemoteFile `file` read here into `out` at `at` (the fallback): its count. */
  fallbackRead(file, from, end, out, at) {
    this.stats.fallbackReads++;
    const bytes = this.fallback.read(file.readName, file.path, from, end);
    out.set(bytes, at);
    return bytes.length;
  }

  /** The browser's copy of the files synced (force: now). */
  flush(force = false) { this.worker.postMessage({ w32flush: !!force }); }
  /** A session restored from a snapshot: the data worker reports the reads the server did not learn (onReads). */
  unlearnedOnly() { this.worker.postMessage({ w32unlearned: true }); }
  /** The session ends: the background loading stops, the stores synced. */
  stop() { this.worker.postMessage({ w32stop: true }); }
  /** A line for the exit report: how the reads were answered. */
  report() {
    const b = this.blocks?.stats ?? {}, w = this.state?.blocks ?? {}, s = this.stats;
    return `reads from the shared blocks ${b.hits ?? 0}, sent to the data worker ${b.misses ?? 0} (${Math.round(s.syncMs)} ms waited; ${b.torn ?? 0} torn copies), asynchronous reads asked ${s.prepares} (${s.quick} answered within ${QUICK_MS} ms, ${s.parked} parked, ${s.late} of them without an answer in time; ${Math.round(s.settleMs)} ms waiting for the first answers); blocks published ${w.published ?? 0}, slots replaced ${w.evicted ?? 0}, notes dropped ${w.drops ?? 0}${this.fallback ? `; LEFT (it stopped answering): ${s.fallbackReads} reads fetched on the emulator's thread` : ''}`;
  }
  /** Any message to the data worker (data-worker.js dispatch: mark, phase, …). */
  post(m) { this.worker.postMessage(m); }

  /**
   * The emulator's statistics and reports read the reader through objects of the reader's shapes (worker.js: its NetLink,
   * the parts — files.stats, files.reads, files.stepEstimate(), store.stats —, the game folder's PartsBackend — parts,
   * predictor.stats —, the learned prefetch's and the offline copy's progress): those, fed by the data worker's counters
   * (every W32_STATS_MS). The game's reads are counted here, on the first part.
   */
  views(name) {
    const link = this, idle = new NetLink({ fixed: true }).snapshot();
    const parts = this.partNames.map((pn, i) => ({
      name: pn,
      files: { get stats() { return link.state?.parts[i]?.stats ?? { requests: 0, bytes: 0, ms: 0 }; }, reads: i === 0 ? link.reads : { bytes: 0, videoBytes: 0 },
        stepEstimate: () => { const b = link.state?.parts[i]?.step; return b === null || b === undefined ? null : { bytes: b }; } },
      get store() { const s = link.state?.parts[i]?.store; return s ? { stats: s } : null; },
    }));
    const net = { snapshot: () => ({ ...(link.state?.net ?? idle) }), ratio: () => link.state?.ratio ?? 1, fast: () => !!link.state?.fast, thin: () => !!link.state?.thin };
    const primary = this.backend(name), own = new Set(this.mounts.get(name).parts);
    primary.parts = parts.filter((p) => own.has(p.name));
    const runs = () => primary.parts.map((p) => link.state?.parts[parts.indexOf(p)]?.prefetch).filter(Boolean);
    const prefetch = { get blocks() { return runs().reduce((n, r) => n + r.blocks, 0); }, get bytes() { return runs().reduce((n, r) => n + r.bytes, 0); },
      get total() { return runs().reduce((n, r) => n + (r.total ?? 0), 0); }, get done() { const l = runs(); return l.length > 0 && l.every((r) => r.done); } };
    const offline = { get bytes() { return link.state?.whole?.bytes ?? 0; }, get total() { return link.state?.whole?.total ?? 0; }, get done() { return !!link.state?.whole?.done; } };
    return { net, parts, primary, prefetch, offline, store: { flush: (force) => link.flush(force) } };
  }
}

/** A mounted version as the guest sees it: its tree (stat, readdir, lookup), its files read through the data worker. */
export class RemoteBackend {
  constructor(link, mount) {
    this.link = link; this.name = mount.name; this.tree = mount.tree; this.keys = mount.keys;
    const i = [...link.mounts.keys()].indexOf(mount.name);
    /** the data worker's prediction of opens, its counters (game-data.js PartsBackend.predictor) */
    this.predictor = { get stats() { return link.state?.predicted?.[i] ?? {}; } };
  }
  lookup(rel) { return treeLookup(this.tree, rel); }
  stat(rel) { return treeStat(this.tree, rel); }
  readdir(rel) { return treeReaddir(this.tree, rel); }
  open(rel, opts = {}) {
    if (opts.write || opts.create || opts.truncate) return null; // (read-only mount)
    const r = treeLookup(this.tree, rel); if (!r || r.dir) return null;
    const key = this.keys.get(r.path); if (key === undefined) return null;
    return new RemoteFile(this.link, this.name, r.path, r.file.size ?? 0, r.file.mtime ?? 0, key);
  }
  mkdir() { return false; }
  unlink() { return false; }
  rename() { return false; }
}

/** A file of a mounted version (HttpFile's interface: size, prepare, read, close). */
class RemoteFile {
  constructor(link, name, path, size, mtime, key) {
    this.link = link; this.path = path; this.len = size; this.mtime = mtime; this.key = key;
    // (the version and path the game opened it under: its reads reported so, ReadLog)
    this.readName = name; this.readPath = path;
    this.video = isVideoFile(path);
    this.h = link.open(name, path);
    this.readC0 = -1; this.closed = false;
  }
  size() { return this.len; }
  /** Every piece of [off, end) is in the shared blocks. */
  here(off, end) {
    const B = this.link.blocks;
    for (let bi = Math.floor(off / BLOCK); bi * BLOCK < end; bi++) if (!B.here(this.key, bi, Math.max(off, bi * BLOCK) - bi * BLOCK, Math.min(end, (bi + 1) * BLOCK) - bi * BLOCK)) return false;
    return true;
  }
  /** HttpFile.prepare: null when a read of [off, off + len) needs no wait, else a promise of its bytes being here. */
  prepare(off, len, held = false) {
    const end = Math.min(off + len, this.len);
    if (off >= end || this.here(off, end)) return null;
    return this.link.prepare(this.h, off, end - off, held);
  }
  /** `into`: where the bytes go when the caller owns a destination of `len` bytes (guest memory: no second copy) */
  read(off, len, into) {
    // (frame accounting: a game file read — its network part is `net`; from guest code only a sample is timed, as HttpFile)
    const kind = acct.ioTimed();
    if (!kind) return this.readNow(off, len, into);
    const ap = acct.enter(ACCT.io), a0 = acct.acc[ACCT.io];
    try { return this.readNow(off, len, into); } finally { acct.ioEnd(ap, a0, kind); }
  }
  readNow(off, len, into) {
    const end = Math.min(off + len, this.len);
    if (off >= end) return new Uint8Array(0);
    const link = this.link, B = link.blocks;
    link.reads.bytes += end - off; if (this.video) link.reads.videoBytes += end - off;
    // (the read log keeps each 64 KiB piece's first read, as HttpFile's)
    if (link.onRead) { const c0 = Math.floor(off / CHUNK), c1 = Math.floor((end - 1) / CHUNK); if (c0 !== this.readC0 || c1 !== c0) { this.readC0 = c1 === c0 ? c0 : -1; link.onRead(this.path, off, end, this); } }
    const out = into && into.length >= end - off ? into : new Uint8Array(end - off);
    let pos = off;
    while (pos < end) {
      const bi = Math.floor(pos / BLOCK), b0 = bi * BLOCK, stop = Math.min(end, b0 + BLOCK);
      if (!B.copy(this.key, bi, pos - b0, stop - b0, out, pos - off)) break;
      pos = stop;
    }
    if (pos === end) { B.stats.hits++; B.note(this.h, off, end); return out.length === end - off ? out : out.subarray(0, end - off); }
    // (the data worker reads it all — its reader's state follows every read —, the bytes from the first missing on come back)
    B.stats.misses++;
    const n = link.syncRead(this.h, off, end, pos, out, pos - off, this);
    const got = pos - off + n;
    return out.length === got ? out : out.subarray(0, got);
  }
  write() { return 0; }
  truncate() {}
  close() { if (this.closed) return; this.closed = true; this.link.close(this.h); }
}

/**
 * The reads of a game whose data worker stopped answering (DataLink.leave): each fetched on the emulator's thread, the
 * file itself by range (/game/<version>/<path>: the server resolves the version's file), as the reader on this thread
 * fetched it — no store, no read-ahead: the game goes on, slower, instead of failing its reads.
 */
export class FallbackReader {
  constructor(retryWaits = [500, 2000, 5000]) { this.retryWaits = retryWaits; }
  read(name, path, start, end) {
    const url = `/game/${encodeURIComponent(name)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    for (let attempt = 0; ; attempt++) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
      let problem = null;
      try { xhr.send(); } catch (e) { problem = e.message; }
      if (!problem && xhr.status !== 206 && xhr.status !== 200) problem = `status ${xhr.status}`;
      if (!problem) {
        const all = new Uint8Array(xhr.response), data = xhr.status === 200 ? all.subarray(start, end) : all;
        if (data.length === end - start) return data;
        problem = `${data.length} bytes of ${end - start}`;
      }
      if (attempt >= this.retryWaits.length) throw new Error(`game file read failed (${problem}) ${url} ${start}-${end}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.retryWaits[attempt]); // (a pause: this thread waits anyway)
    }
  }
}
