// Read-only VFS backend over HTTP range requests (synchronous XHR: the guest's ReadFile is
// synchronous and the emulator runs in a worker). The directory tree comes from the server's
// JSON listing so stat/readdir never hit the network; file data is fetched in blocks kept in a
// bounded LRU cache with read-ahead for sequential access.
import { acct, C as ACCT } from '../core/frame-acct.js';
import { NetLink } from './net-link.js';
import { LIGHT_DIR } from './game-tree.js';

export const BLOCK = 1 << 20; // 1 MiB
/**
 * A random read that misses fetches only the 64 KiB pieces it covers (a round trip plus 64 KiB instead of a whole
 * block: ~10x less waiting over the Internet while the game waits); the whole block follows in the background.
 */
export const CHUNK = 1 << 16;
const MAX_CHUNK_BYTES = 64 << 20;
/** sequential bytes after which a file is being read whole (whole blocks ahead) rather than streamed */
const STREAM_BYTES = 1 << 20;
/** sequential bytes and reads after which a file is a stream for the learned prefetch (see doneWith) */
const STREAM_SKIP = 256 << 10, STREAM_READS = 16;
/** at most this many bytes fetched ahead of a stream's read while the game waits (the rest comes in the background) */
const STREAM_WINDOW = 256 << 10; // pieces kept in memory (the blocks fetched behind them replace them)
/**
 * A file read whole (in sequence, past STREAM_BYTES): once fewer than READ_AHEAD_LOW bytes past its reader are here or on
 * their way, its next blocks are fetched asynchronously up to READ_AHEAD_HIGH bytes past it (see readAhead) — the reader
 * finds them here instead of waiting a round trip and a transfer every few blocks.
 */
const READ_AHEAD_LOW = 2 << 20, READ_AHEAD_HIGH = 4 << 20;
/** on a link that is not fast, a sequential reader gets this many seconds of the link ahead of it (see readAheadParts) */
const READ_AHEAD_SECONDS = 2;
/**
 * A read that misses a block (needs pieces not here yet) also starts the download of the whole block, at most this many
 * such downloads in flight (else the block waits for the background fill, as before): see noteMiss.
 */
const MISSED_BLOCK_FLIGHTS = 2;
/**
 * The blocks this close to a missed one (before and after it) are wanted too, at the lowest priority: downloaded by the
 * background fill once the blocks the game touched are here and the network has been quiet for NEAR_QUIET_MS (the
 * game's next misses are often next to its last ones: the parts of an archive one scene needs). At most NEAR_MAX wanted.
 */
const NEAR_BLOCKS = 2, NEAR_QUIET_MS = 500, NEAR_MAX = 64;
/**
 * the files whose light copy the game read (see upgrade): fetched once the game has read nothing for this long (ms) — the
 * player in an area loaded already, not between two reads of a load (an engine computes for seconds between them)
 */
const UPGRADE_QUIET_MS = 8000;
const DEFAULT_CACHE_BLOCKS = 256; // 256 MiB
/** learned pieces fetched ahead of the game (see pumpAhead): requests in flight at most, entries past its position */
const AHEAD_REQUESTS = 3, AHEAD_WINDOW = 32;
/** learned pieces ahead on a link neither fast nor thin: more requests at once (small files are latency-bound) */
const AHEAD_REQUESTS_MID = 8;
/** prefetch requests queued at once on a link that is not fast (see prefetch) */
const PREFETCH_PARTS = 6;
/** a pause this long (ms) between two learned entries ends a step of the game (see stepEstimate) */
const STEP_GAP_MS = 5000;
/** the download of the whole game before playing, on a link that is not fast: a request carries about this much of the link (s) */
const ALONE_SECONDS = 8;
const RETRY_WAITS = [250, 1000, 2000, 4000, 8000]; // ms before each new attempt of a failed range request
/** fetchBackground's answer for a download aborted because the game needed the network (fetched again later) */
const ABORTED = Symbol('aborted');
/**
 * Background download priorities on the shared link (NetLink.turn: lower first) and the quiet time (ms since the game's
 * last read) each waits for on a link that is not fast: the next blocks of a file read in sequence and the learned
 * pieces just ahead of the game first (its next reads), then the blocks the game touched, the learned blocks, the
 * blocks next to missed ones, the offline copy.
 */
const PRIO = { readAhead: [1, 0], ahead: [2, 0], miss: [3, 100], fill: [4, 150], prefetch: [5, 300], near: [6, 500], offline: [7, 500] };
/** wire length of a response (its encoded body: what crossed the link), else the decoded length */
const wireOf = (len, header) => { const n = Number(header); return Number.isFinite(n) && n > 0 ? n : len; };

/** Block the calling worker for `ms` (the reads are synchronous: nothing else can run meanwhile anyway). */
function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = performance.now() + ms; while (performance.now() < t) { /* no Atomics.wait here */ } }
}

export class HttpBackend {
  /**
   * @param {string} baseUrl e.g. "/game/bfme-vanilla/"
   * @param {{ dirs: Record<string, any>, files: Record<string, {size: number, mtime: number}> }} tree
   * @param {{ net?: NetLink, cacheBlocks?: number, store?: import('./opfs-store.js').OpfsBlockStore | null, onFetch?: (info: {url: string, start: number, end: number, ms: number}) => void, onRetry?: (info: {url: string, start: number, end: number, problem: string, attempt: number}) => void, retryWaits?: number[], encoded?: boolean, session?: string, link?: Set<HttpBackend> }} [opts]
   *   store: persistent block store (OPFS) consulted before the network and filled with every fetched block
   *   link: the backends sharing the player's connection (the game's folder and the games it requires, mounted beside
   *   it): the game's reads through any of them come first for the background downloads of all of them
   */
  constructor(baseUrl, tree, opts = {}) {
    this.base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.tree = tree;
    this.link = opts.link ?? null; this.link?.add(this);
    /** the player's connection (shared by the backends of one link): bandwidth, demand first, background turns */
    this.net = opts.net ?? null;
    if (!this.net && this.link) for (const b of this.link) if (b !== this && b.net) { this.net = b.net; break; }
    this.net ??= new NetLink({ fixed: true }); // (no measure given: the local-network policies, as a test or a tool expects)
    this.cache = new Map(); // key "path#block" -> Uint8Array (insertion order = LRU)
    this.maxBlocks = opts.cacheBlocks ?? DEFAULT_CACHE_BLOCKS;
    this.onFetch = opts.onFetch ?? null;
    this.onRetry = opts.onRetry ?? null;
    this.retryWaits = opts.retryWaits ?? RETRY_WAITS;
    // the server's compressed ranges (/gamez/...?r=start-end: zstd/gzip Content-Encoding, decoded by the browser)
    this.encoded = !!opts.encoded;
    /** session id sent with the compressed ranges (the server learns the order blocks are needed in, see prefetch) */
    this.session = opts.session ?? '';
    this.store = opts.store ?? null;
    this.stats = { requests: 0, bytes: 0, ms: 0 };
    /** 64 KiB pieces of blocks not fetched whole yet: "path#chunk" -> bytes (insertion order = LRU) */
    this.chunks = new Map(); this.chunkBytes = 0;
    /** whole blocks wanted in the background (a random read touched them): "path#block" -> {path, size, mtime, index} */
    this.want = new Map(); this.filling = false;
    /** blocks next to missed ones, wanted at the lowest priority (see NEAR_BLOCKS): same entries as `want` */
    this.near = new Map();
    /** blocks of files the game wants whole (see wantWhole), after `want` and `near`: same entries */
    this.later = new Map();
    /** blocks of files whose light copy the game read (see upgrade), last of all: same entries, the latest last */
    this.upgrades = new Map();
    /** the background downloads in flight (prefetch, block fill): their AbortControllers, aborted when the game
     * needs the network (see abortBackground) */
    this.bgAborts = new Set();
    /** the block fill's download in flight: { key, path, index, ctl, done, waiters } (waiters: parked reads waiting for it) */
    this.bgCur = null;
    /** asynchronous reads the game waits for, in flight (the background downloads wait for them to end) */
    this.fgPending = 0;
    /** learned pieces being fetched ahead of the game: "path#chunk" -> promise (see fetchPiecesAhead) */
    this.flights = new Map();
    /** whole blocks being fetched ahead of a sequential reader: "path#block" -> promise (see readAhead) */
    this.blockFlights = new Map(); this.readAheadPending = 0;
    /** whole blocks downloading because a read missed them (see noteMiss) */
    this.missFlights = 0;
    /** the learned prefetch list and the game's position in it (see prefetch, noteBlock) */
    this.learned = null;
    /** open handles of the game per file: a file opened then closed again is done with for now (see doneWith) */
    this.opened = new Map();
    /** files the game reads as a stream (in sequence, past STREAM_SKIP bytes): fetched ahead of their reader only */
    this.streams = new Set();
  }

  /**
   * Walk the tree case-insensitively; returns { node, dirNode, name, path } or null. A file's light copy (LIGHT_DIR/<path>,
   * src/host/light-copies.js) is a file of its own: its size the tree's `light`.
   */
  lookup(rel) {
    if (rel.startsWith(LIGHT_DIR + '/')) {
      const r = this.lookup(rel.slice(LIGHT_DIR.length + 1));
      return r?.file?.light ? { file: { size: r.file.light, mtime: r.file.mtime ?? 0 }, name: r.name, path: `${LIGHT_DIR}/${r.path}` } : null;
    }
    const parts = rel.split(/[\\/]/).filter(Boolean);
    let node = this.tree; const realParts = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], last = i === parts.length - 1;
      const dirs = node.dirs ?? {}, files = node.files ?? {};
      let hit = dirs[p] !== undefined ? p : Object.keys(dirs).find((n) => n.toLowerCase() === p.toLowerCase());
      if (hit !== undefined) { node = dirs[hit]; realParts.push(hit); continue; }
      if (!last) return null;
      hit = files[p] !== undefined ? p : Object.keys(files).find((n) => n.toLowerCase() === p.toLowerCase());
      if (hit === undefined) return null;
      return { file: files[hit], name: hit, path: [...realParts, hit].join('/') };
    }
    return { dir: node, name: realParts[realParts.length - 1] ?? '', path: realParts.join('/') };
  }

  stat(rel) {
    const r = this.lookup(rel);
    if (!r) return null;
    return r.dir ? { size: 0, isDir: true, mtime: 0 } : { size: r.file.size, isDir: false, mtime: r.file.mtime ?? 0 };
  }
  readdir(rel) {
    const r = this.lookup(rel);
    if (!r || !r.dir) return null;
    const out = [];
    for (const n of Object.keys(r.dir.dirs ?? {})) out.push({ name: n, size: 0, isDir: true, mtime: 0 });
    for (const [n, f] of Object.entries(r.dir.files ?? {})) out.push({ name: n, size: f.size, isDir: false, mtime: f.mtime ?? 0 });
    return out;
  }
  open(rel, opts = {}) {
    const r = this.lookup(rel);
    if (!r || r.dir) return null;
    if (opts.write || opts.create || opts.truncate) return null; // read-only mount
    this.opened.set(r.path, (this.opened.get(r.path) ?? 0) + 1);
    return new HttpFile(this, r.path, r.file.size, r.file.mtime ?? 0);
  }
  mkdir() { return false; }
  unlink() { return false; }
  rename() { return false; }

  /**
   * Fetch [start, end) of a file synchronously. A network error, an error status or a short answer (a connection
   * cut over the Internet) is retried after a pause, once per entry of retryWaits, before failing the read.
   */
  /** URL of [start, end) of a file: a compressed range, or the file itself (with a Range header) */
  rangeUrl(path, start, end, background = false, ahead = false) {
    const rel = path.split('/').map(encodeURIComponent).join('/');
    // (`ahead`: fetched ahead of the game but learned as its own read — the server counts it with the background)
    return this.encoded ? `${this.base.replace(/\/game\//, '/gamez/')}${rel}?r=${start}-${end}${background ? '&p=1' : this.session ? '&s=' + this.session : ''}${!background && ahead ? '&a=1' : ''}` : this.base + rel;
  }

  /**
   * Background prefetch: download the listed blocks ([path, block index, pieces mask?], in the order earlier sessions
   * first needed them) that the store does not hold yet, one request at a time (two consecutive blocks at most),
   * yielding while the game reads from the network (its reads come first). The list is followed from the game's
   * position in it (see noteBlock): the blocks just past the last listed block the game touched first, then the rest
   * from the start — sessions of different speeds (and menu times) interleave phases in the learned order, so the head
   * of the list is often a phase this session has not reached, or has passed without needing it. Meanwhile the learned
   * pieces of the entries just past the game's position are fetched ahead (see pumpAhead). `progress` gets
   * { bytes, blocks, done, k }. `opts.learnedOnly`: on a link that is not fast, the learned pieces only (not the rest of
   * their blocks) — what a page waits for before the game starts.
   */
  async prefetch(list, progress, stop = () => false, opts = {}) {
    const store = this.store; if (!store || typeof fetch !== 'function') return;
    progress.bytes = 0; progress.blocks = 0; progress.done = false;
    /** @type {{path: string, size: number, mtime: number, index: number, mask: number, seen?: boolean, ahead?: boolean, skip?: boolean}[]} */
    const entries = [], rankOf = new Map();
    for (const [p, b, mask, t] of list) {
      const r = this.lookup(p); if (!r || !r.file || !(b * BLOCK < r.file.size)) continue;
      const k = `${r.path}#${b}`; if (rankOf.has(k)) continue;
      rankOf.set(k, entries.length);
      // (t: when the earliest session first needed it, ms from its start — absent from older servers)
      entries.push({ path: r.path, size: r.file.size, mtime: r.file.mtime ?? 0, index: b, mask: typeof mask === 'number' ? mask & 0xffff : 0, t: Number.isFinite(t) ? t : null });
    }
    const L = this.learned = { entries, rankOf, pos: -1, inFlight: 0, stop };
    const skey = (e, i = e.index) => `${e.path}#${e.size}#${e.mtime}#${i}`;
    const stored = (e) => e.skip || store.map.has(skey(e)) || this.cache.has(`${e.path}#${e.index}`);
    // (the block the fill is downloading is left to it: it stores it too)
    const todo = (e) => !stored(e) && this.bgCur?.key !== `${e.path}#${e.index}` && !this.blockFlights.has(`${e.path}#${e.index}`) && !this.flights.has(`${e.path}#${e.index * (BLOCK / CHUNK)}`);
    // the entry to download next: the first one past the game's position not stored yet, else the first one
    const next = () => {
      for (let r = L.pos + 1; r < entries.length; r++) if (todo(entries[r])) return r;
      for (let r = 0; r <= L.pos && r < entries.length; r++) if (todo(entries[r])) return r;
      return -1;
    };
    // a link that is not fast: the pieces the earlier sessions read first (the learned masks: what the game will read),
    // in the order they needed them from the game's position, then the rest of those blocks; in background requests
    // of the link's size (see NetLink), each piece kept as it comes
    const nextPart = () => {
      // (a thin link: the learned pieces only — whole blocks are for links that can afford them)
      for (const tier of this.net.thin() || opts.learnedOnly ? [1] : [1, 2]) {
        for (let pass = 0; pass < 2; pass++) {
          const from = pass === 0 ? L.pos + 1 : 0, to = pass === 0 ? entries.length : Math.min(entries.length, L.pos + 1);
          for (let r = from; r < to; r++) {
            // (learnedOnly: an entry learned without its pieces — an older list — was read whole)
            const e = entries[r], mask = e.mask || (opts.learnedOnly ? 0xffff : 0);
            if (stored(e) || (tier === 1 && (!mask || e.maskDone)) || this.doneWith(e.path)) continue;
            const run = this.missingRun(e.path, e.size, e.mtime, e.index, tier === 1 ? mask : 0);
            if (run) return { r, e, run };
            if (tier === 1) { let fly = false; for (let c = e.index * 16; c < e.index * 16 + 16; c++) if (this.flights.has(`${e.path}#${c}`)) fly = true; if (!fly) { e.maskDone = true; progress.blocks++; } }
          }
        }
      }
      return null;
    };
    const parts = new Set(); let failed = false;
    for (;;) {
      if (stop() || store.failed) return;
      // (the game's own reads first; the block fill, when it has blocks to fetch, runs beside this pass rather than
      // before it: a session whose game keeps touching new blocks keeps the fill busy for good, and waiting for it
      // starved this pass for whole sessions)
      while (this.gameBusy(300)) { if (stop()) return; await new Promise((res) => setTimeout(res, 100)); }
      if (!this.net.fast()) {
        // (up to PREFETCH_PARTS requests queued at once: each waits for its turn on the link, which lets several small
        // ones run together — a run of small files is latency-bound — within the link's background bytes)
        if (parts.size >= PREFETCH_PARTS) { await Promise.race(parts); continue; }
        const job = nextPart();
        if (!job) { if (parts.size || this.flights.size) { await (parts.size ? Promise.race(parts) : new Promise((res) => setTimeout(res, 200))); if (parts.size || next() >= 0 || nextPart()) continue; } break; }
        progress.k = job.r;
        const pr = this.fetchPartBg(job.e.path, job.e.size, job.e.mtime, job.run[0], job.run[1], PRIO.prefetch, stop).then((r) => {
          if (r === null) failed = true;
          else if (r === undefined) job.e.skip = true;
          else if (r === true) progress.bytes += Math.min(job.e.size, (job.run[1] + 1) * CHUNK) - job.run[0] * CHUNK;
        }).finally(() => parts.delete(pr));
        parts.add(pr);
        if (failed) { failed = false; if (stop()) return; await new Promise((res) => setTimeout(res, 1000)); }
        continue;
      }
      const k = next(); progress.k = k;
      if (k < 0) break;
      const e = entries[k], f = entries[k + 1];
      const n = f && f.path === e.path && f.index === e.index + 1 && todo(f) ? 2 : 1;
      const start = e.index * BLOCK, end = Math.min(e.size, (e.index + n) * BLOCK);
      const data = await this.fetchBackground(e.path, start, end, null, true, false, { prio: PRIO.prefetch, stop });
      if (data === ABORTED) continue;
      if (data === null) return;
      if (!data) { e.skip = true; continue; } // (an answer to skip: not asked again this session)
      for (let i = 0; i < n; i++) store.put(skey(e, e.index + i), data.subarray(i * BLOCK, Math.min(data.length, (i + 1) * BLOCK)));
      // (done with, stored or not: a full store drops blocks silently, and the pass would fetch them again forever)
      e.skip = true; if (n === 2) f.skip = true;
      progress.bytes += data.length; progress.blocks += n;
    }
    store.flush?.(true); // (a sync point: the prefetch is over)
    progress.done = true;
  }

  /**
   * The file bytes the game's current step still needs from the network, by the learned order: the entries past the
   * game's position up to the first pause of STEP_GAP_MS in the earliest sessions' timeline (a step: a run of reads —
   * a loading screen, a level — the pause: the game busy with something else), their learned pieces (the whole block
   * when not known) not here yet. Null without a learned list with times.
   */
  stepEstimate() {
    const L = this.learned; if (!L || !L.entries.length || L.entries[0].t === null) return null;
    let bytes = 0, prevT = L.pos >= 0 ? L.entries[L.pos].t : null;
    for (let r = L.pos + 1, n = 0; r < L.entries.length && n < 4096; r++, n++) {
      const e = L.entries[r];
      if (e.t === null || (prevT !== null && e.t - prevT > STEP_GAP_MS)) break;
      prevT = e.t;
      if (this.peekBlockHere(e.path, e.size, e.mtime, e.index)) continue;
      const P = BLOCK / CHUNK, c0 = e.index * P, pieces = Math.ceil((Math.min(e.size, (e.index + 1) * BLOCK) - e.index * BLOCK) / CHUNK);
      for (let i = 0; i < pieces; i++) if ((!e.mask || ((e.mask >>> i) & 1)) && !this.pieceHere(e.path, e.size, e.mtime, c0 + i)) bytes += Math.min(CHUNK, e.size - (c0 + i) * CHUNK);
    }
    return { bytes };
  }

  /**
   * The game touches block `index` of `path` (a read, from here or not): its first touch of a block of the learned
   * list moves the game's position in the list there, and the pieces learned for the next entries are fetched ahead.
   */
  noteBlock(path, index) {
    const L = this.learned; if (!L) return;
    const r = L.rankOf.get(`${path}#${index}`); if (r === undefined) return;
    const e = L.entries[r]; if (e.seen) return;
    e.seen = true; L.pos = r;
    this.pumpAhead();
  }

  /**
   * Fetch ahead the pieces earlier sessions read (the entry's mask of 64 KiB pieces) of the learned entries just past
   * the game's position (AHEAD_WINDOW entries), AHEAD_REQUESTS requests in flight at most. While the game walks a run
   * of learned blocks reading a piece or two of each (a latency-bound chain of small reads, the link mostly idle
   * between them), its next reads are already here or on their way. These requests are not aborted by the game's own
   * reads (they are predictions of those reads, and small); a parked read of a piece in flight waits for it
   * (fetchAhead). Entries whose mask is unknown (learned before masks) are left to the whole-block pass.
   */
  pumpAhead() {
    const L = this.learned; if (!L || L.stop() || this.store?.failed || typeof fetch !== 'function') return;
    const P = BLOCK / CHUNK;
    for (let r = L.pos + 1, lim = Math.min(L.entries.length, L.pos + 1 + AHEAD_WINDOW); r < lim && L.inFlight < (this.net.fast() || this.net.thin() ? AHEAD_REQUESTS : AHEAD_REQUESTS_MID); r++) {
      const e = L.entries[r];
      if (e.ahead || e.seen || !e.mask || this.doneWith(e.path)) continue;
      e.ahead = true;
      if (this.cache.has(`${e.path}#${e.index}`) || this.store?.map.has(`${e.path}#${e.size}#${e.mtime}#${e.index}`)) continue;
      const c0 = e.index * P, pieces = Math.ceil((Math.min(e.size, (e.index + 1) * BLOCK) - e.index * BLOCK) / CHUNK);
      let all = true; for (let i = 0; i < pieces; i++) if (!((e.mask >>> i) & 1)) all = false;
      const want = (i) => ((e.mask >>> i) & 1) === 1 && !this.flights.has(`${e.path}#${c0 + i}`) && !this.hasPiece(e.path, e.size, e.mtime, c0 + i);
      const most = Math.max(1, this.net.backgroundBytes() / CHUNK);
      for (let i = 0; i < pieces; i++) {
        if (!want(i)) continue;
        let j = i; while (j + 1 < pieces && want(j + 1) && j + 1 - i < most) j++;
        // (every piece of the block wanted: the block itself, stored)
        this.fetchPiecesAhead(e, c0 + i, c0 + j, all && i === 0 && j === pieces - 1);
        i = j;
      }
    }
  }
  /** Pieces m0..m1 of a learned entry, fetched ahead (see pumpAhead); `whole`: they are the whole block. */
  fetchPiecesAhead(e, m0, m1, whole) {
    const L = this.learned;
    const start = m0 * CHUNK, stop = Math.min(e.size, (m1 + 1) * CHUNK);
    L.inFlight++;
    this.stats.aheadRequests = (this.stats.aheadRequests ?? 0) + 1;
    const w = {};
    const done = this.fetchBackground(e.path, start, stop, null, false, false, { prio: PRIO.ahead, stop: L.stop, w }).then((d) => {
      if (!(d instanceof Uint8Array) || this.cache.has(`${e.path}#${e.index}`)) return;
      this.stats.aheadBytes = (this.stats.aheadBytes ?? 0) + d.length;
      if (whole) { this.installBlock(e.path, e.index, d, `${e.path}#${e.size}#${e.mtime}#${e.index}`); this.evict(); } else this.addPieces(e.path, m0, m1, d, e);
    }).finally(() => {
      for (let c = m0; c <= m1; c++) if (this.flights.get(`${e.path}#${c}`) === done) this.flights.delete(`${e.path}#${c}`);
      L.inFlight--;
      this.pumpAhead();
    });
    done.w = w;
    for (let c = m0; c <= m1; c++) this.flights.set(`${e.path}#${c}`, done);
  }
  /**
   * Pieces c0..c1 of a file in one background request (after its turn on the link, priority `prio`), registered as on
   * their way (a parked read of one of them waits for it and makes it go first); they join the pieces here (a block
   * whose pieces are all here is installed whole). Resolves to true when they came, undefined for an answer to skip,
   * false when aborted (a synchronous read of the same bytes: try again later), null when the network failed or
   * `stop()` held.
   */
  fetchPartBg(path, size, mtime, c0, c1, prio, stop = () => false, learn = false) {
    const w = {};
    const done = this.fetchBackground(path, c0 * CHUNK, Math.min(size, (c1 + 1) * CHUNK), null, false, learn, { prio, stop, w }).then((d) => {
      if (d === ABORTED) return false;
      if (d === null) return null;
      if (!(d instanceof Uint8Array)) return undefined;
      this.stats.partBytes = (this.stats.partBytes ?? 0) + d.length;
      this.addPieces(path, c0, c1, d, { size, mtime });
      return true;
    }).finally(() => { for (let c = c0; c <= c1; c++) if (this.flights.get(`${path}#${c}`) === done) this.flights.delete(`${path}#${c}`); });
    done.w = w;
    for (let c = c0; c <= c1; c++) this.flights.set(`${path}#${c}`, done);
    return done;
  }
  /**
   * The game opened `path` in this session and holds no handle on it now: what earlier sessions read further in it is
   * not fetched ahead (a movie skipped, a file parsed then closed) until the game opens it again. Nor, on a link that is
   * not fast, a file the game reads as a stream (a movie, music): its next bytes come ahead of its reader (readAhead),
   * and not at all once the game stops reading it — earlier sessions that played a movie through read all of it, this
   * one may skip it.
   */
  doneWith(path) { return this.opened.get(path) === 0 || (this.streams.has(path) && !this.net.fast()); }
  /** `path` is a media file (the tree's `media`, by format: src/vfs/game-tree.js isMediaFile — a movie, music). */
  isMedia(path) { return !!this.lookup(path)?.file?.media; }
  /**
   * Blocks of `path` may be fetched on a guess (the blocks near a missed one, the next ones of a read): not for a media
   * file the game is not streaming now — a movie skipped, a track probed — its bytes come when it is read (readAhead
   * while it is streamed), or with the offline copy, last.
   */
  speculate(path) { return this.streams.has(path) || !this.isMedia(path); }
  /** A handle of the game on `path` closed: when it was the last one, the background requests for the file go away. */
  noteClose(path) {
    const n = (this.opened.get(path) ?? 1) - 1;
    this.opened.set(path, Math.max(0, n));
    if (n <= 0 && !this.net.fast()) this.net.abortOverlap(this.base + path, 0, Infinity);
  }
  /** piece c is here or stored (not read back) */
  pieceHere(path, size, mtime, c) { return this.chunks.has(`${path}#${c}`) || !!this.store?.map.has(this.pieceKey(path, size, mtime, c)); }
  /**
   * The next run of pieces of block `index` to fetch in the background: missing, not on their way, among `mask` (bit i:
   * piece i of the block; 0: all), at most backgroundBytes() — [c0, c1], or null when none.
   */
  missingRun(path, size, mtime, index, mask = 0) {
    const P = BLOCK / CHUNK, c0 = index * P, n = Math.ceil((Math.min(size, (index + 1) * BLOCK) - index * BLOCK) / CHUNK);
    const most = Math.max(1, this.net.backgroundBytes() / CHUNK);
    const need = (i) => (!mask || ((mask >>> i) & 1) === 1) && !this.flights.has(`${path}#${c0 + i}`) && !this.pieceHere(path, size, mtime, c0 + i);
    for (let i = 0; i < n; i++) {
      if (!need(i)) continue;
      let j = i; while (j + 1 < n && need(j + 1) && j + 1 - i < most) j++;
      return [c0 + i, c0 + j];
    }
    return null;
  }
  /**
   * The game read from the network within the last `ms`, waits for an asynchronous read, or a sequential reader's next
   * blocks are on their way: background downloads wait.
   */
  gameBusy(ms) {
    if (!this.link) return this.ownBusy(ms);
    for (const b of this.link) if (b.ownBusy(ms)) return true;
    return false;
  }
  ownBusy(ms) { return this.fgPending > 0 || this.readAheadPending > 0 || performance.now() - (this.lastSyncFetchAt ?? -1e9) < ms; }
  /** The game has read nothing for `ms` (from the network or not), through this backend nor those sharing its link. */
  gameQuiet(ms) {
    const now = performance.now();
    for (const b of this.link ?? [this]) if (b.fgPending > 0 || now - (b.lastReadAt ?? -1e9) < ms) return false;
    return true;
  }

  /**
   * A sequential reader of `path` (a file read whole) is at `end`: when fewer than READ_AHEAD_LOW bytes past it are here
   * (memory cache, store) or on their way, the next blocks up to READ_AHEAD_HIGH past it are fetched asynchronously
   * (consecutive missing blocks in one request). Not aborted by the game's other reads (they are its next reads); a
   * parked read of a block on its way waits for it (fetchAhead). A synchronous read of such a block fetches it again
   * (the worker cannot receive the asynchronous answer while it blocks): the bytes are the same either way.
   */
  readAhead(path, size, mtime, end) {
    if (typeof fetch !== 'function' || end >= size) return;
    if (!this.net.fast()) { this.readAheadParts(path, size, mtime, end); return; }
    const have = (bi) => this.cache.has(`${path}#${bi}`) || this.blockFlights.has(`${path}#${bi}`) || !!this.store?.map.has(`${path}#${size}#${mtime}#${bi}`);
    let covered = end;
    while (covered < size && covered - end < READ_AHEAD_LOW && have(Math.floor(covered / BLOCK))) covered = (Math.floor(covered / BLOCK) + 1) * BLOCK;
    if (covered >= size || covered - end >= READ_AHEAD_LOW) return;
    const last = Math.min(Math.ceil(size / BLOCK), Math.ceil((end + READ_AHEAD_HIGH) / BLOCK)); // (exclusive)
    for (let b = Math.floor(covered / BLOCK); b < last; b++) {
      if (have(b)) continue;
      let e = b; while (e + 1 < last && !have(e + 1)) e++;
      this.fetchBlocksAhead(path, size, mtime, b, e);
      b = e;
    }
  }
  /**
   * readAhead on a link that is not fast: the pieces past the reader, up to what the link carries in READ_AHEAD_SECONDS
   * (at least 128 KiB, at most READ_AHEAD_HIGH), in background requests of the link's size at the read-ahead's priority
   * (the first of the background downloads: the reader comes for them next) — a stream (music, a movie) read while the
   * game plays finds its next bytes here instead of stopping the game a round trip and a transfer at a time.
   */
  readAheadParts(path, size, mtime, end) {
    const want = Math.min(READ_AHEAD_HIGH, Math.max(128 << 10, Math.floor(this.net.secondsFor(1) > 0 ? READ_AHEAD_SECONDS / this.net.secondsFor(1) : READ_AHEAD_HIGH)));
    const last = Math.floor((Math.min(size, end + want) - 1) / CHUNK), most = Math.max(1, this.net.backgroundBytes() / CHUNK);
    let inFlight = 0;
    for (let c = Math.floor(end / CHUNK); c <= last; c++) {
      if (this.flights.has(`${path}#${c}`)) { inFlight++; continue; }
      if (this.peekBlockHere(path, size, mtime, Math.floor(c * CHUNK / BLOCK)) || this.pieceHere(path, size, mtime, c)) continue;
      if (inFlight >= 2) return; // (two requests on their way past the reader at most: the link stays the game's)
      let j = c; while (j + 1 <= last && j + 1 - c < most && Math.floor((j + 1) * CHUNK / BLOCK) === Math.floor(c * CHUNK / BLOCK) && !this.flights.has(`${path}#${j + 1}`) && !this.pieceHere(path, size, mtime, j + 1)) j++;
      this.stats.readAheads = (this.stats.readAheads ?? 0) + 1;
      this.fetchPartBg(path, size, mtime, c, j, PRIO.readAhead, () => false, true);
      inFlight++; c = j;
    }
  }
  /** block `index` is in memory or stored (no read) */
  peekBlockHere(path, size, mtime, index) { return this.cache.has(`${path}#${index}`) || !!this.store?.map.has(`${path}#${size}#${mtime}#${index}`); }

  /**
   * A read of block `index` needs pieces from the network: the read fetches its pieces (the quickest answer), and the
   * whole block is downloaded beside them at once. Games read a block a little here and there (entries of an archive
   * one after the other, a file parsed piece by piece): measured over a 150 ms link, more than half the blocks missed
   * were missed again, up to 16 times, each miss a round trip the game waited for. The background block fill would
   * fetch the block too, but it waits while the game reads and gives way to each of its reads — the block came only
   * once the game had stopped reading it. The reads that follow wait for this download (fetchAhead) rather than each
   * for its own pieces. The bytes are the ones the fill would download anyway; only their priority changes.
   */
  noteMiss(path, size, mtime, index) {
    if (typeof fetch !== 'function' || this.net.thin()) return;
    const k = `${path}#${index}`, guess = this.speculate(path);
    for (let j = Math.max(0, index - NEAR_BLOCKS); guess && j <= index + NEAR_BLOCKS && j * BLOCK < size; j++) {
      const nk = `${path}#${j}`;
      if (j === index || this.near.has(nk) || this.cache.has(nk) || this.store?.map.has(`${path}#${size}#${mtime}#${j}`)) continue;
      this.near.set(nk, { path, size, mtime, index: j });
      if (this.near.size > NEAR_MAX) this.near.delete(this.near.keys().next().value); // (the oldest go)
    }
    // (on a link that is not fast the block waits for the background fill: it would hold the game's next reads up)
    if (!this.net.fast()) return;
    if (this.missFlights >= MISSED_BLOCK_FLIGHTS || this.blockFlights.has(k) || this.cache.has(k) || this.bgCur?.key === k || this.store?.map.has(`${path}#${size}#${mtime}#${index}`)) return;
    this.missFlights++;
    this.stats.missBlocks = (this.stats.missBlocks ?? 0) + 1;
    // (not learned as the game's own read: its pieces are, with the mask of what it read)
    this.fetchBlocksAhead(path, size, mtime, index, index, false).finally(() => { this.missFlights--; });
  }
  /**
   * Blocks b0..b1 of a file fetched ahead of its sequential reader (see readAhead), resolved when done. `learn`: asked as
   * the game's own read (the server learns it for later sessions' prefetch).
   */
  fetchBlocksAhead(path, size, mtime, b0, b1, learn = true) {
    const start = b0 * BLOCK, end = Math.min(size, (b1 + 1) * BLOCK);
    this.readAheadPending++;
    this.stats.readAheads = (this.stats.readAheads ?? 0) + 1;
    // (a sequential reader's next blocks are asked as its own reads: the server learns them for later sessions' prefetch)
    const w = {};
    const done = this.fetchBackground(path, start, end, null, false, learn, { prio: learn ? PRIO.readAhead : PRIO.miss, w }).then((d) => {
      if (!(d instanceof Uint8Array)) return;
      this.stats.readAheadBytes = (this.stats.readAheadBytes ?? 0) + d.length;
      for (let i = b0; i <= b1; i++) if (!this.cache.has(`${path}#${i}`)) this.installBlock(path, i, d.subarray((i - b0) * BLOCK, Math.min(d.length, (i - b0 + 1) * BLOCK)), `${path}#${size}#${mtime}#${i}`);
      this.evict();
    }).finally(() => {
      this.readAheadPending--;
      for (let i = b0; i <= b1; i++) if (this.blockFlights.get(`${path}#${i}`) === done) this.blockFlights.delete(`${path}#${i}`);
    });
    done.w = w;
    for (let i = b0; i <= b1; i++) this.blockFlights.set(`${path}#${i}`, done);
    return done;
  }
  /**
   * The game needs the network: every background download in flight goes away (fetched again later), except the
   * block fill's when a parked read waits for it (`spareWaited`).
   */
  abortBackground(spareWaited = false) {
    if (!this.net.fast()) { this.net.abortLong(); return; }
    if (this.link) { for (const b of this.link) b.abortOwn(spareWaited); } else this.abortOwn(spareWaited);
  }
  abortOwn(spareWaited) {
    for (const ctl of this.bgAborts) {
      if (spareWaited && this.bgCur?.ctl === ctl && this.bgCur.waiters > 0) continue;
      this.bgAborts.delete(ctl); ctl.abort();
    }
  }
  /**
   * [start, end) with fetch(), for the background downloads: the bytes, undefined for an answer to skip, ABORTED when
   * the game needed the network (try again later), null when the network failed. `onStart` gets the AbortController.
   */
  fetchBackground(path, start, end, onStart, abortable = true, learn = false, turn = null) {
    // (its turn on the shared link first: the game's reads come first, see NetLink; `turn`: { prio: [order, quiet ms],
    // stop, w } — w.urgent set meanwhile by a parked read waiting for this download lets it go at once; a turn free
    // now starts the request now)
    if (turn) {
      const quiet = this.net.fast() ? 0 : turn.prio[1], w = turn.w ?? {};
      if (!this.net.tryTurn(quiet, w, end - start)) return this.net.turn(turn.prio[0], quiet, turn.stop, w, end - start).then((go) => (go ? this.fetchBackgroundNow(path, start, end, onStart, abortable, learn) : null));
    }
    return this.fetchBackgroundNow(path, start, end, onStart, abortable, learn);
  }
  async fetchBackgroundNow(path, start, end, onStart, abortable, learn) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctl && abortable) this.bgAborts.add(ctl);
    onStart?.(ctl);
    // (any background request may be aborted by a synchronous read of the same bytes, see NetLink.abortOverlap; only the
    // abortable ones by a demand read elsewhere)
    const tok = this.net.begin('bg', end - start, ctl ? () => ctl.abort() : null, { key: this.base + path, start, end });
    if (!abortable) tok.keep = true;
    let wire = 0, ok = false;
    try {
      const res = await fetch(this.rangeUrl(path, start, end, !learn, learn), { ...(this.encoded ? {} : { headers: { Range: `bytes=${start}-${end - 1}` } }), signal: ctl?.signal });
      this.net.firstByte(tok);
      if (res.status !== 206 && res.status !== 200) return undefined;
      let data = new Uint8Array(await res.arrayBuffer());
      wire = wireOf(data.length, res.headers?.get?.('content-length'));
      if (res.status === 200 && !this.encoded) data = data.subarray(start, end);
      ok = data.length === end - start;
      return ok ? data : undefined;
    } catch { return ctl?.signal.aborted ? ABORTED : null; } finally { if (ctl) this.bgAborts.delete(ctl); this.net.end(tok, wire, end - start, ok); }
  }

  fetchRange(path, start, end) {
    const ap = acct.enter(ACCT.net); // (frame accounting: the game thread waits for the network)
    try { return this.fetchRangeNow(path, start, end); } finally { acct.leave(ap); }
  }
  fetchRangeNow(path, start, end) {
    // (a background download shares the connection: it goes away while the game waits, and is fetched again later — on
    // a fast link; on a slower one only those that would hold the game up long, see NetLink.abortLong)
    this.abortBackground();
    const url = this.rangeUrl(path, start, end);
    for (let attempt = 0; ; attempt++) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.responseType = 'arraybuffer';
      if (!this.encoded) xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
      const t0 = performance.now();
      this.net.abortOverlap(this.base + path, start, end);
      const tok = this.net.begin('demand', end - start);
      let problem = null;
      try { xhr.send(); } catch (e) { problem = e.message; }
      const ms = performance.now() - t0;
      this.lastSyncFetchAt = performance.now(); // (a background download yields to the game's own reads)
      let data = null;
      if (!problem && xhr.status !== 206 && xhr.status !== 200) problem = `status ${xhr.status}`;
      if (!problem) {
        data = new Uint8Array(xhr.response);
        if (xhr.status === 200 && !this.encoded) data = data.subarray(start, end);
        if (data.length !== end - start) problem = `${data.length} bytes of ${end - start}`;
      }
      this.net.end(tok, problem ? 0 : wireOf(xhr.response?.byteLength ?? 0, xhr.getResponseHeader?.('Content-Length')), end - start, !problem);
      if (!problem) {
        this.stats.requests++; this.stats.bytes += data.length; this.stats.ms += ms;
        this.onFetch?.({ url, path, start, end, ms });
        return data;
      }
      this.stats.retries = (this.stats.retries ?? 0) + 1;
      this.onRetry?.({ url, start, end, problem, attempt });
      if (attempt >= this.retryWaits.length) throw new Error(`range request failed (${problem}) ${url} ${start}-${end}`);
      pause(this.retryWaits[attempt]);
    }
  }

  /** Block `index` from the memory cache or the persistent store, or null (no network). */
  peekBlock(path, size, index, mtime = 0) {
    const key = `${path}#${index}`;
    let b = this.cache.get(key);
    if (b) { this.cache.delete(key); this.cache.set(key, b); return b; }
    // persistent store (the key names the file version: size and mtime of the listing)
    const skey = `${path}#${size}#${mtime}#${index}`;
    b = this.store?.get(skey);
    // (a stored block must have the block's length: the whole block, or the file's tail for the last one)
    if (b && b.length === Math.min(BLOCK, size - index * BLOCK)) { this.cache.set(key, b); this.evict(); return b; }
    if (b) this.store.drop?.(skey);
    return null;
  }

  block(path, size, index, readAhead, mtime = 0) {
    const b0 = this.peekBlock(path, size, index, mtime);
    if (b0) return b0;
    const skey = (i) => `${path}#${size}#${mtime}#${i}`;
    // fetch this block plus up to `readAhead` following blocks in one request
    const start = index * BLOCK;
    const n = Math.max(1, Math.min(readAhead, Math.ceil((size - start) / BLOCK)));
    const end = Math.min(size, start + n * BLOCK);
    const data = this.fetchRange(path, start, end);
    for (let i = 0; i < n; i++) this.installBlock(path, index + i, data.subarray(i * BLOCK, Math.min(data.length, (i + 1) * BLOCK)), skey(index + i));
    this.evict();
    // (the block itself, not a cache lookup: a cache smaller than the read-ahead has already evicted it)
    return data.subarray(0, Math.min(data.length, BLOCK));
  }
  /** A whole block arrived: memory cache, persistent store; its pieces and its background request are dropped. */
  installBlock(path, index, bytes, skey) {
    const k = `${path}#${index}`;
    this.cache.set(k, bytes);
    this.store?.put(skey, bytes);
    this.want.delete(k); this.near.delete(k); this.later.delete(k); this.upgrades.delete(k);
    const pk = skey.slice(0, skey.lastIndexOf('#')) + '#c';
    for (let c = (index * BLOCK) / CHUNK, e = c + BLOCK / CHUNK; c < e; c++) {
      const ck = `${path}#${c}`, p = this.chunks.get(ck); if (p) { this.chunks.delete(ck); this.chunkBytes -= p.length; }
      if (this.store?.map.has(pk + c)) this.store.drop?.(pk + c); // (the pieces kept from a slow link: the block replaces them)
    }
  }

  /** key of a 64 KiB piece kept in the persistent store (a slow link fetches pieces, not always whole blocks) */
  pieceKey(path, size, mtime, c) { return `${path}#${size}#${mtime}#c${c}`; }
  /**
   * Piece `c` of a file is here: in memory, or kept in the persistent store by an earlier session (then brought back
   * into memory).
   */
  hasPiece(path, size, mtime, c) {
    const ck = `${path}#${c}`;
    if (this.chunks.has(ck)) return true;
    const st = this.store; if (!st) return false;
    const key = this.pieceKey(path, size, mtime, c);
    if (!st.map.has(key)) return false;
    const b = st.get(key);
    if (!b || b.length !== Math.min(CHUNK, size - c * CHUNK)) { if (b) st.drop?.(key); return false; }
    this.chunks.set(ck, b); this.chunkBytes += b.length;
    this.trimPieces();
    return true;
  }
  trimPieces() { while (this.chunkBytes > MAX_CHUNK_BYTES) { const [k, v] = this.chunks.entries().next().value; this.chunks.delete(k); this.chunkBytes -= v.length; } }
  /** pieces fetched are kept in the persistent store too: on a link that is not fast (whole blocks may never come) */
  keepPieces() { return !!this.store && !this.net.fast(); }
  /** Every piece of block `index` is here: the block is assembled from them and installed (memory, store). */
  assemble(path, size, mtime, index) {
    const k = `${path}#${index}`;
    if (this.cache.has(k)) return;
    const b0 = index * BLOCK, len = Math.min(BLOCK, size - b0), c0 = b0 / CHUNK, n = Math.ceil(len / CHUNK);
    for (let c = c0; c < c0 + n; c++) if (!this.chunks.has(`${path}#${c}`)) return;
    const out = new Uint8Array(len);
    for (let c = c0; c < c0 + n; c++) out.set(this.chunks.get(`${path}#${c}`), (c - c0) * CHUNK);
    this.installBlock(path, index, out, `${path}#${size}#${mtime}#${index}`);
    this.evict();
  }

  /** Pieces m0..m1 of a file from `data` (fetched from piece m0), those not here yet; the piece cache stays bounded. */
  addPieces(path, m0, m1, data, file = null) {
    const keep = file && this.keepPieces();
    for (let c = m0; c <= m1; c++) {
      const ck = `${path}#${c}`, piece = data.subarray((c - m0) * CHUNK, Math.min(data.length, (c - m0 + 1) * CHUNK));
      if (this.chunks.has(ck)) continue;
      if (this.cache.has(`${path}#${Math.floor(c * CHUNK / BLOCK)}`)) continue; // (its block is here whole)
      this.chunks.set(ck, piece); this.chunkBytes += piece.length;
      if (keep) this.store.put(this.pieceKey(path, file.size, file.mtime, c), piece);
    }
    // (a block whose pieces are all here becomes a whole block: kept as such, its background download not needed)
    if (file) {
      const P = BLOCK / CHUNK;
      for (let bi = Math.floor(m0 / P); bi <= Math.floor(m1 / P); bi++) {
        const c0 = bi * P, n = Math.ceil((Math.min(file.size, (bi + 1) * BLOCK) - bi * BLOCK) / CHUNK);
        let all = true; for (let c = c0; c < c0 + n && all; c++) if (!this.hasPiece(path, file.size, file.mtime, c)) all = false;
        if (all) this.assemble(path, file.size, file.mtime ?? 0, bi);
      }
    }
    this.trimPieces();
  }

  /**
   * Bytes [pos, end) of one block that is neither cached nor stored (a random read): the missing 64 KiB pieces are
   * fetched in one request, the whole block is queued for the background.
   */
  readPieces(path, size, mtime, index, pos, end, out, outOff, ahead = 0, extra = 0) {
    const c0 = Math.floor(pos / CHUNK), c1 = Math.floor((end - 1) / CHUNK);
    let m0 = -1, m1 = -1;
    for (let c = c0; c <= c1; c++) if (!this.hasPiece(path, size, mtime, c)) { if (m0 < 0) m0 = c; m1 = c; }
    // (a stream: the request also covers the `extra` bytes that follow, within the block — the window grows with the
    // stream, as few round trips as whole blocks would take for a file read from start to end)
    if (m0 >= 0 && extra > 0) { const last = Math.min(Math.floor((Math.min(size, (index + 1) * BLOCK) - 1) / CHUNK), Math.floor((end - 1 + extra) / CHUNK)); while (m1 < last && !this.hasPiece(path, size, mtime, m1 + 1)) m1++; }
    if (m0 >= 0) {
      this.noteMiss(path, size, mtime, index);
      const start = m0 * CHUNK, stop = Math.min(size, (m1 + 1) * CHUNK);
      const data = this.fetchRange(path, start, stop);
      this.addPieces(path, m0, m1, data, { size, mtime });
      // (all of the block's pieces here: assembled, installed whole)
      const whole = this.cache.get(`${path}#${index}`);
      if (whole) { out.set(whole.subarray(pos - index * BLOCK, end - index * BLOCK), outOff); this.fillBackground(); return true; }
    }
    for (let c = c0; c <= c1; c++) {
      const ck = `${path}#${c}`, piece = this.chunks.get(ck);
      if (!piece) return false; // (evicted at once: a read larger than the piece cache — the caller fetches the block)
      this.chunks.delete(ck); this.chunks.set(ck, piece); // (LRU)
      const a = Math.max(pos, c * CHUNK), b = Math.min(end, c * CHUNK + piece.length);
      out.set(piece.subarray(a - c * CHUNK, b - c * CHUNK), outOff + (a - pos));
    }
    // the block, and for a stream the next ones, in the background (not on a thin link: there the bandwidth goes to
    // what the game reads and what earlier sessions read next — a whole block for a piece read is 16 times the bytes;
    // not the next ones of a media file the game is not streaming: see speculate)
    if (ahead && !this.speculate(path)) ahead = 0;
    for (let i = index; i <= index + ahead && i * BLOCK < size && !this.net.thin(); i++) {
      const wk = `${path}#${i}`;
      if (!this.want.has(wk) && (i === index || !this.peekBlock(path, size, i, mtime))) this.want.set(wk, { path, size, mtime, index: i });
    }
    this.fillBackground();
    return true;
  }

  /**
   * Fetch asynchronously what a read of [pos, end) would fetch (the missing pieces of the blocks it touches, or whole
   * blocks for a bulk read), so that the read that follows finds everything here: the reading guest thread waits
   * parked while the others run (see ReadFile). Resolves when done (failures resolve too: the read then fetches
   * synchronously and reports the error itself).
   */
  async fetchAhead(path, size, mtime, pos, end, bulk, extra = 0) {
    // pieces of the read already on their way (fetched ahead from the learned list): waited for, not asked again
    // (and whole blocks fetched ahead of a sequential reader, see readAhead); one still waiting for its turn on the link
    // goes first now (the game waits for it)
    if (this.flights.size || this.blockFlights.size) {
      const flying = new Set();
      if (this.flights.size) for (let c = Math.floor(pos / CHUNK); c * CHUNK < end; c++) { const f = this.flights.get(`${path}#${c}`); if (f) flying.add(f); }
      if (this.blockFlights.size) for (let bi = Math.floor(pos / BLOCK); bi * BLOCK < end; bi++) { const f = this.blockFlights.get(`${path}#${bi}`); if (f) flying.add(f); }
      for (const f of flying) this.net.promote(f.w);
      if (flying.size) await Promise.all(flying);
    }
    const jobs = [];
    // a block of the read is being downloaded in the background (a stream's read-ahead): wait for it rather than
    // abort it (marked before any fetch below aborts the background downloads)
    const cur = this.bgCur;
    const waited = cur && cur.path === path && cur.index >= Math.floor(pos / BLOCK) && cur.index * BLOCK < end && !this.peekBlock(path, size, cur.index, mtime) ? cur : null;
    if (waited) { waited.waiters++; jobs.push(waited.done); }
    for (let bi = Math.floor(pos / BLOCK); bi * BLOCK < end; bi++) {
      if (this.peekBlock(path, size, bi, mtime)) continue;
      const b0 = bi * BLOCK, b1 = Math.min(size, b0 + BLOCK);
      if (waited?.index === bi) continue;
      if (bulk) {
        // (the blocks the read covers, up to 4, not past one on its way: the reader waits for these only — the ones
        // after them follow asynchronously once it has read, see readAhead)
        let n = 1; while (n < 4 && b0 + n * BLOCK < Math.min(size, end) && !this.blockFlights.has(`${path}#${bi + n}`)) n++;
        const e = Math.min(size, b0 + n * BLOCK);
        jobs.push(this.fetchForeground(path, b0, e).then((d) => { if (d) for (let i = 0; b0 + i * BLOCK < e; i++) if (!this.cache.has(`${path}#${bi + i}`)) this.installBlock(path, bi + i, d.subarray(i * BLOCK, Math.min(d.length, (i + 1) * BLOCK)), `${path}#${size}#${mtime}#${bi + i}`); this.evict(); }));
        break;
      }
      const c0 = Math.floor(Math.max(pos, b0) / CHUNK), c1 = Math.floor((Math.min(end, b1) - 1) / CHUNK);
      let m0 = -1, m1 = -1;
      for (let c = c0; c <= c1; c++) if (!this.hasPiece(path, size, mtime, c)) { if (m0 < 0) m0 = c; m1 = c; }
      if (m0 < 0) continue;
      // (a stream: the `extra` bytes past the read too, within the block, as readPieces does)
      if (extra > 0 && Math.min(end, b1) === end) { const last = Math.min(Math.floor((b1 - 1) / CHUNK), Math.floor((end - 1 + extra) / CHUNK)); while (m1 < last && !this.hasPiece(path, size, mtime, m1 + 1) && !this.flights.has(`${path}#${m1 + 1}`)) m1++; }
      this.noteMiss(path, size, mtime, bi);
      const start = m0 * CHUNK, stop = Math.min(size, (m1 + 1) * CHUNK);
      jobs.push(this.fetchForeground(path, start, stop).then((d) => {
        if (d && !this.cache.has(`${path}#${bi}`)) this.addPieces(path, m0, m1, d, { size, mtime });
      }));
    }
    try { await Promise.all(jobs); } finally { if (waited) waited.waiters--; }
  }
  /** [start, end) with fetch() for a read the game waits for (counted as the game's own reads; not aborted). */
  async fetchForeground(path, start, end) {
    const t0 = performance.now();
    this.abortBackground(true);
    this.fgPending++;
    const tok = this.net.begin('demand', end - start);
    let wire = 0, ok = false;
    try {
      const url = this.rangeUrl(path, start, end);
      const res = await fetch(url, this.encoded ? {} : { headers: { Range: `bytes=${start}-${end - 1}` } });
      this.net.firstByte(tok);
      if (res.status !== 206 && res.status !== 200) return null;
      let data = new Uint8Array(await res.arrayBuffer());
      wire = wireOf(data.length, res.headers?.get?.('content-length'));
      if (res.status === 200 && !this.encoded) data = data.subarray(start, end);
      if (data.length !== end - start) return null;
      ok = true;
      const ms = performance.now() - t0;
      this.stats.requests++; this.stats.bytes += data.length; this.stats.ms += ms; this.stats.asyncReads = (this.stats.asyncReads ?? 0) + 1;
      this.onFetch?.({ url, path, start, end, ms, async: true });
      return data;
    } catch { return null; } finally { this.fgPending--; this.lastSyncFetchAt = performance.now(); this.net.end(tok, wire, end - start, ok); }
  }

  /**
   * The game reads `path` at random as it goes (a streaming archive, a sound bank): all of its blocks wanted, downloaded
   * by the background fill last — after the blocks the game touched and those near them, the link quiet for NEAR_QUIET_MS
   * (not on a thin link: the game's reads alone there).
   */
  wantWhole(path) {
    const r = this.lookup(path); if (!r?.file) return;
    const size = r.file.size, mtime = r.file.mtime ?? 0;
    for (let i = 0; i * BLOCK < size; i++) {
      const k = `${r.path}#${i}`;
      if (!this.cache.has(k) && !this.store?.map.has(`${r.path}#${size}#${mtime}#${i}`)) this.later.set(k, { path: r.path, size, mtime, index: i });
    }
    this.fillBackground();
  }

  /** Every block of `path` is here (memory, store): its reads need no network. */
  isWhole(path) {
    const r = this.lookup(path); if (!r?.file) return false;
    const size = r.file.size, mtime = r.file.mtime ?? 0;
    for (let i = 0; i * BLOCK < size; i++) if (!this.cache.has(`${r.path}#${i}`) && !this.store?.map.has(`${r.path}#${size}#${mtime}#${i}`)) return false;
    return true;
  }

  /**
   * The game read `path`'s light copy (a link that is not fast: src/vfs/data-client.js): the file itself downloaded in
   * the background for its next load, last of all — after every other background download, the link quiet for
   * UPGRADE_QUIET_MS, a thin link too (by pieces) —, the latest files first (the player is near them: loaded again soonest).
   */
  upgrade(path) {
    const r = this.lookup(path); if (!r?.file) return;
    const size = r.file.size, mtime = r.file.mtime ?? 0;
    for (let i = 0; i * BLOCK < size; i++) {
      const k = `${r.path}#${i}`;
      if (this.cache.has(k) || this.store?.map.has(`${r.path}#${size}#${mtime}#${i}`)) continue;
      this.upgrades.delete(k); this.upgrades.set(k, { path: r.path, size, mtime, index: i });
    }
    this.fillBackground();
  }

  /**
   * Bytes of a file kept elsewhere before (a store an earlier page used), from offset `at` (a piece's start), into the
   * store as if downloaded: whole blocks as blocks, the rest as 64 KiB pieces (whole, or the file's tail).
   */
  keep(path, size, mtime, at, bytes) {
    const store = this.store; if (!store || at % CHUNK) return;
    const end = Math.min(size, at + bytes.length);
    for (let pos = at; pos < end;) {
      const bi = Math.floor(pos / BLOCK), bEnd = Math.min(size, (bi + 1) * BLOCK);
      if (pos === bi * BLOCK && end >= bEnd) { store.put(`${path}#${size}#${mtime}#${bi}`, bytes.subarray(pos - at, bEnd - at)); pos = bEnd; continue; }
      const c = pos / CHUNK, cEnd = Math.min(size, pos + CHUNK);
      if (end < cEnd) break; // (a piece cut short: not kept)
      if (!store.map.has(`${path}#${size}#${mtime}#${bi}`)) store.put(this.pieceKey(path, size, mtime, c), bytes.subarray(pos - at, cEnd - at));
      pos = cEnd;
    }
  }

  /** Download the wanted blocks, one at a time, while the game is not reading synchronously. */
  async fillBackground() {
    if (this.filling || typeof fetch !== 'function') return;
    this.filling = true;
    try {
      while (this.want.size || this.near.size || this.later.size || this.upgrades.size) {
        // (the blocks next to missed ones, then those of files wanted whole, after a longer quiet time, then the files
        // whose light copy the game read, after a longer one still)
        const quiet = () => (this.want.size ? 150 : this.near.size || this.later.size ? NEAR_QUIET_MS : 0);
        const queued = () => this.want.size || this.near.size || this.later.size || this.upgrades.size;
        while (queued() && (quiet() ? this.gameBusy(quiet()) : !this.gameQuiet(UPGRADE_QUIET_MS))) await new Promise((res) => setTimeout(res, 50));
        const q = this.want.size ? this.want : this.near.size ? this.near : this.later.size ? this.later : this.upgrades;
        if (!q.size) continue; // (fetched whole meanwhile by a sequential read)
        const [k, w] = q === this.upgrades ? [...q].at(-1) : q.entries().next().value;
        // (here already: fetched whole by a read, or stored by the learned prefetch)
        // (or on its way, fetched ahead of a sequential reader)
        if (this.cache.has(k) || this.blockFlights.has(k) || this.store?.map.has(`${w.path}#${w.size}#${w.mtime}#${w.index}`)) { q.delete(k); continue; }
        // (queued before the link was measured thin — the files whose light copy the game read stay: by pieces, below)
        if (this.net.thin() && q !== this.upgrades) { this.want.clear(); this.near.clear(); this.later.clear(); continue; }
        if (!this.net.fast()) {
          // (a link that is not fast: the block's missing pieces, a background request of the link's size at a time —
          // what came is kept whatever happens next, and the block is installed whole once all its pieces are here)
          const run = this.missingRun(w.path, w.size, w.mtime, w.index);
          if (!run) { if (this.flights.size) await new Promise((res) => setTimeout(res, 50)); else q.delete(k); continue; }
          const r = await this.fetchPartBg(w.path, w.size, w.mtime, run[0], run[1], q === this.want ? PRIO.fill : q === this.near ? PRIO.near : PRIO.offline);
          if (r === null) break; // (network down: the next random read queues it again)
          if (r === false) continue;
          if (r === undefined) q.delete(k);
          if (this.cache.has(k)) this.stats.bgBlocks = (this.stats.bgBlocks ?? 0) + 1;
          continue;
        }
        const start = w.index * BLOCK, end = Math.min(w.size, start + BLOCK);
        const cur = { key: k, path: w.path, index: w.index, ctl: null, done: null, waiters: 0 };
        const pr = this.fetchBackground(w.path, start, end, (ctl) => { cur.ctl = ctl; });
        cur.done = pr.then(() => {});
        this.bgCur = cur;
        const data = await pr;
        this.bgCur = null;
        if (data === ABORTED) continue;
        if (data === null) break; // (network down: the next random read queues it again)
        q.delete(k);
        if (!data) continue;
        this.installBlock(w.path, w.index, data, `${w.path}#${w.size}#${w.mtime}#${w.index}`);
        this.evict();
        this.stats.bgBlocks = (this.stats.bgBlocks ?? 0) + 1;
      }
    } finally { this.filling = false; }
  }
  /**
   * Offline copy: fetch every block of every file of the listing that the store does not hold yet, in the background,
   * yielding to the game's reads (its turn on the link like the other background downloads, after them). The blocks of
   * the learned list `opts.order` ([path, block, ...], the order earlier sessions needed them) come first, then the
   * rest file by file; the media files' blocks (isMedia: movies, music) after all the others, in the same order. Requests carry up to 4 blocks when the game is not running (`opts.alone`: the page downloads the
   * game before playing) or the link is fast, else the link's background size (pieces, assembled into blocks). A
   * download stopped (page closed) resumes where it was: the stored blocks are skipped. `progress` is updated
   * ({ bytes, total, stored (bytes already here at the start), done }); stops at `stop()` or when the store fails (quota).
   */
  async downloadAll(progress, stop = () => false, opts = {}) {
    const store = this.store; if (!store || typeof fetch !== 'function') return;
    const files = [], byPath = new Map();
    const walk = (node, rel) => {
      for (const [n, f] of Object.entries(node.files ?? {})) { const e = { path: rel ? `${rel}/${n}` : n, size: f.size, mtime: f.mtime ?? 0, media: !!f.media }; files.push(e); byPath.set(e.path, e); }
      for (const [n, d] of Object.entries(node.dirs ?? {})) walk(d, rel ? `${rel}/${n}` : n);
    };
    walk(this.tree, '');
    const key = (f, i) => `${f.path}#${f.size}#${f.mtime}#${i}`;
    const blockBytes = (f, i) => Math.min(f.size, (i + 1) * BLOCK) - i * BLOCK;
    // the blocks in download order: learned ones first, then every other one; media files' after all of those
    const main = [], media = [], queued = new Set();
    for (const it of opts.order ?? []) {
      const r = Array.isArray(it) && typeof it[0] === 'string' ? this.lookup(it[0]) : null, f = r?.file ? byPath.get(r.path) : null;
      if (!f || !Number.isInteger(it[1]) || it[1] < 0 || it[1] * BLOCK >= f.size || queued.has(key(f, it[1]))) continue;
      queued.add(key(f, it[1])); (r.file.media ? media : main).push([f, it[1]]);
    }
    for (const f of files) for (let i = 0; i * BLOCK < f.size; i++) if (!queued.has(key(f, i))) (f.media ? media : main).push([f, i]);
    const jobs = main.concat(media);
    progress.total = files.reduce((a, f) => a + f.size, 0); progress.done = false;
    progress.bytes = 0; for (const [f, i] of jobs) if (store.map.has(key(f, i))) progress.bytes += blockBytes(f, i);
    progress.stored = progress.bytes;
    let failures = 0;
    for (let k = 0; k < jobs.length; k++) {
      if (stop() || store.failed) return;
      const [f, b] = jobs[k];
      if (store.map.has(key(f, b))) continue;
      if (!opts.alone) while (this.gameBusy(500)) { if (stop()) return; await new Promise((r) => setTimeout(r, 200)); }
      if (opts.alone || this.net.backgroundBytes() >= BLOCK) {
        // (consecutive missing blocks of the file in one request, up to 4: those next in the order)
        // (alone on a link that is not fast: about ALONE_SECONDS of the link per request, one block until measured — a
        // 4 MiB request takes 50 s at 85 KB/s: the progress would move by jumps, and a pause would lose it)
        let n = 1; const most = this.net.fast() ? 4 : opts.alone ? Math.max(1, Math.min(4, Math.floor((this.net.bw ?? 0) * ALONE_SECONDS / this.net.ratio() / BLOCK))) : Math.max(1, Math.floor(this.net.backgroundBytes() / BLOCK));
        while (n < most && k + n < jobs.length && jobs[k + n][0] === f && jobs[k + n][1] === b + n && !store.map.has(key(f, b + n))) n++;
        const start = b * BLOCK, end = Math.min(f.size, (b + n) * BLOCK);
        const data = await this.fetchBackground(f.path, start, end, null, !opts.alone, false, { prio: PRIO.offline, stop });
        if (data === ABORTED) { k--; continue; }
        if (data === null) { if (stop() || ++failures > 8) return; await new Promise((r) => setTimeout(r, 2000)); k--; continue; }
        failures = 0;
        if (data) for (let i = 0; i < n; i++) store.put(key(f, b + i), data.subarray(i * BLOCK, Math.min(data.length, (i + 1) * BLOCK)));
        progress.bytes += end - start; k += n - 1;
      } else {
        // (a thin link while the game runs: the block by pieces, a background request of the link's size at a time)
        const run = this.missingRun(f.path, f.size, f.mtime, b);
        if (!run) { await new Promise((r) => setTimeout(r, 100)); if (!store.map.has(key(f, b)) && !this.cache.has(`${f.path}#${b}`)) k--; else progress.bytes += blockBytes(f, b); continue; }
        const r = await this.fetchPartBg(f.path, f.size, f.mtime, run[0], run[1], PRIO.offline, stop);
        if (r === null) { if (stop() || ++failures > 8) return; await new Promise((res) => setTimeout(res, 2000)); }
        else failures = 0;
        if (r !== undefined && !store.map.has(key(f, b)) && !this.cache.has(`${f.path}#${b}`)) k--; // (the block's other pieces next)
        else progress.bytes += blockBytes(f, b);
      }
    }
    store.flush(true);
    progress.done = true;
  }
  evict() { while (this.cache.size > this.maxBlocks) { const first = this.cache.keys().next().value; this.cache.delete(first); } }
}

class HttpFile {
  constructor(backend, path, size, mtime) { this.b = backend; this.path = path; this.len = size; this.mtime = mtime; this.lastEnd = -1; this.run = 0; }
  size() { return this.len; }
  /**
   * Debugging (?dbg=ORTHROS_VERIFY_READS=1): the bytes a read returned compared with the same range fetched straight
   * from the server, past every cache; the first difference, or null.
   */
  verify(off, bytes) {
    if (!bytes.length) return null;
    const ref = this.b.fetchRange(this.path, off, off + bytes.length);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== ref[i]) return { at: i, got: bytes[i], want: ref[i] };
    return null;
  }
  /** The blocks of [off, end) are touched: the game's position in the learned prefetch list (see noteBlock). */
  note(off, end) {
    this.b.lastReadAt = performance.now(); // (the game reads: see gameQuiet)
    if (!this.b.learned) return;
    for (let bi = Math.floor(off / BLOCK), e = Math.floor((end - 1) / BLOCK); bi <= e; bi++) if (bi !== this.noted) { this.noted = bi; this.b.noteBlock(this.path, bi); }
  }
  /**
   * A read of [off, off + len) would need the network: a promise fetching it asynchronously (resolved when the data
   * is here), else null. Leaves the read state (sequence detection) alone.
   */
  prepare(off, len) {
    const end = Math.min(off + len, this.len);
    if (off >= end || typeof fetch !== 'function') return null;
    this.note(off, end);
    // (on a link that is not fast a file read whole goes by pieces too, its next bytes fetched past the read by the
    // link's measure: whole blocks of 1-4 MiB would hold the game up for seconds)
    const fast = this.b.net.fast(), sequential = off === this.lastEnd, bulk = fast && sequential && this.run + (end - off) >= STREAM_BYTES;
    let missing = false;
    for (let bi = Math.floor(off / BLOCK); bi * BLOCK < end && !missing; bi++) {
      if (this.b.peekBlock(this.path, this.len, bi, this.mtime)) continue;
      if (bulk) { missing = true; break; }
      for (let c = Math.floor(Math.max(off, bi * BLOCK) / CHUNK), e = Math.floor((Math.min(end, (bi + 1) * BLOCK) - 1) / CHUNK); c <= e; c++) if (!this.b.hasPiece(this.path, this.len, this.mtime, c)) { missing = true; break; }
    }
    const extra = !fast && sequential ? this.b.net.demandExtra(Math.min(this.run + (end - off), BLOCK)) : 0;
    return missing ? this.b.fetchAhead(this.path, this.len, this.mtime, off, end, bulk, extra) : null;
  }
  read(off, len) {
    const ap = acct.enter(ACCT.io); // (frame accounting: a game file read — its network part is `net`)
    try { return this.readNow(off, len); } finally { acct.leave(ap); }
  }
  readNow(off, len) {
    const end = Math.min(off + len, this.len);
    if (off >= end) return new Uint8Array(0);
    this.note(off, end);
    const out = new Uint8Array(end - off);
    const sequential = off === this.lastEnd;
    this.lastEnd = end;
    // bytes read in sequence so far: a bulk read (loading a file whole) fetches whole blocks ahead synchronously; a
    // stream read a little at a time (audio, video while playing) goes by pieces, its next blocks in the background
    this.run = sequential ? this.run + (end - off) : 0;
    // (a stream: many reads in sequence — a movie, music; an archive entry loaded in one go is not, and a read elsewhere
    // in the file ends it)
    this.runReads = sequential ? (this.runReads ?? 0) + 1 : 0;
    if (this.run >= STREAM_SKIP && this.runReads >= STREAM_READS) this.b.streams.add(this.path);
    else if (!sequential && this.b.streams.size) this.b.streams.delete(this.path);
    const fast = this.b.net.fast(), bulk = sequential && this.run >= STREAM_BYTES;
    let pos = off;
    while (pos < end) {
      const bi = Math.floor(pos / BLOCK), bo = pos - bi * BLOCK;
      // a random read of a block not here yet: only its pieces now (the block follows in the background); on a link
      // that is not fast a file read whole too, with what the link carries in a moment past it (see prepare)
      if ((!bulk || !fast) && !this.b.peekBlock(this.path, this.len, bi, this.mtime)) {
        const stop = Math.min(end, (bi + 1) * BLOCK);
        const extra = !sequential ? 0 : fast ? Math.min(this.run, STREAM_WINDOW) : this.b.net.demandExtra(Math.min(this.run, BLOCK));
        if (this.b.readPieces(this.path, this.len, this.mtime, bi, pos, stop, out, pos - off, sequential ? 2 : 0, extra)) { pos = stop; continue; }
      }
      const blk = this.b.block(this.path, this.len, bi, sequential && fast ? 4 : 1, this.mtime);
      const n = Math.min(end - pos, blk.length - bo);
      if (n <= 0) break;
      out.set(blk.subarray(bo, bo + n), pos - off);
      pos += n;
    }
    // (a file read whole: its next blocks on their way before the reader gets there)
    if (pos === end && (bulk || (!fast && sequential && this.run >= CHUNK))) this.b.readAhead(this.path, this.len, this.mtime, end);
    return pos === end ? out : out.subarray(0, pos - off);
  }
  write() { return 0; }
  truncate() {}
  close() { if (this.closed) return; this.closed = true; this.b.noteClose(this.path); }
}
