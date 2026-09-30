// Read-only VFS backend over HTTP range requests (synchronous XHR: the guest's ReadFile is
// synchronous and the emulator runs in a worker). The directory tree comes from the server's
// JSON listing so stat/readdir never hit the network; file data is fetched in blocks kept in a
// bounded LRU cache with read-ahead for sequential access.
export const BLOCK = 1 << 20; // 1 MiB
/**
 * A random read that misses fetches only the 64 KiB pieces it covers (a round trip plus 64 KiB instead of a whole
 * block: ~10x less waiting over the Internet while the game waits); the whole block follows in the background.
 */
export const CHUNK = 1 << 16;
const MAX_CHUNK_BYTES = 64 << 20;
/** sequential bytes after which a file is being read whole (whole blocks ahead) rather than streamed */
const STREAM_BYTES = 1 << 20;
/** at most this many bytes fetched ahead of a stream's read while the game waits (the rest comes in the background) */
const STREAM_WINDOW = 256 << 10; // pieces kept in memory (the blocks fetched behind them replace them)
const DEFAULT_CACHE_BLOCKS = 256; // 256 MiB
/** learned pieces fetched ahead of the game (see pumpAhead): requests in flight at most, entries past its position */
const AHEAD_REQUESTS = 3, AHEAD_WINDOW = 32;
const RETRY_WAITS = [250, 1000, 2000, 4000, 8000]; // ms before each new attempt of a failed range request
/** fetchBackground's answer for a download aborted because the game needed the network (fetched again later) */
const ABORTED = Symbol('aborted');

/** Block the calling worker for `ms` (the reads are synchronous: nothing else can run meanwhile anyway). */
function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = performance.now() + ms; while (performance.now() < t) { /* no Atomics.wait here */ } }
}

export class HttpBackend {
  /**
   * @param {string} baseUrl e.g. "/game/bfme-vanilla/"
   * @param {{ dirs: Record<string, any>, files: Record<string, {size: number, mtime: number}> }} tree
   * @param {{ cacheBlocks?: number, store?: import('./opfs-store.js').OpfsBlockStore | null, onFetch?: (info: {url: string, start: number, end: number, ms: number}) => void, onRetry?: (info: {url: string, start: number, end: number, problem: string, attempt: number}) => void, retryWaits?: number[], encoded?: boolean, session?: string }} [opts]
   *   store: persistent block store (OPFS) consulted before the network and filled with every fetched block
   */
  constructor(baseUrl, tree, opts = {}) {
    this.base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.tree = tree;
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
    /** the background downloads in flight (prefetch, block fill): their AbortControllers, aborted when the game
     * needs the network (see abortBackground) */
    this.bgAborts = new Set();
    /** the block fill's download in flight: { key, path, index, ctl, done, waiters } (waiters: parked reads waiting for it) */
    this.bgCur = null;
    /** asynchronous reads the game waits for, in flight (the background downloads wait for them to end) */
    this.fgPending = 0;
    /** learned pieces being fetched ahead of the game: "path#chunk" -> promise (see fetchPiecesAhead) */
    this.flights = new Map();
    /** the learned prefetch list and the game's position in it (see prefetch, noteBlock) */
    this.learned = null;
  }

  /** Walk the tree case-insensitively; returns { node, dirNode, name, path } or null. */
  lookup(rel) {
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
  rangeUrl(path, start, end, background = false) {
    const rel = path.split('/').map(encodeURIComponent).join('/');
    return this.encoded ? `${this.base.replace(/\/game\//, '/gamez/')}${rel}?r=${start}-${end}${background ? '&p=1' : this.session ? '&s=' + this.session : ''}` : this.base + rel;
  }

  /**
   * Background prefetch: download the listed blocks ([path, block index, pieces mask?], in the order earlier sessions
   * first needed them) that the store does not hold yet, one request at a time (two consecutive blocks at most),
   * yielding while the game reads from the network (its reads come first). The list is followed from the game's
   * position in it (see noteBlock): the blocks just past the last listed block the game touched first, then the rest
   * from the start — sessions of different speeds (and menu times) interleave phases in the learned order, so the head
   * of the list is often a phase this session has not reached, or has passed without needing it. Meanwhile the learned
   * pieces of the entries just past the game's position are fetched ahead (see pumpAhead). `progress` gets
   * { bytes, blocks, done, k }.
   */
  async prefetch(list, progress, stop = () => false) {
    const store = this.store; if (!store || typeof fetch !== 'function') return;
    progress.bytes = 0; progress.blocks = 0; progress.done = false;
    /** @type {{path: string, size: number, mtime: number, index: number, mask: number, seen?: boolean, ahead?: boolean, skip?: boolean}[]} */
    const entries = [], rankOf = new Map();
    for (const [p, b, mask] of list) {
      const r = this.lookup(p); if (!r || !r.file || !(b * BLOCK < r.file.size)) continue;
      const k = `${r.path}#${b}`; if (rankOf.has(k)) continue;
      rankOf.set(k, entries.length);
      entries.push({ path: r.path, size: r.file.size, mtime: r.file.mtime ?? 0, index: b, mask: typeof mask === 'number' ? mask & 0xffff : 0 });
    }
    const L = this.learned = { entries, rankOf, pos: -1, inFlight: 0, stop };
    const skey = (e, i = e.index) => `${e.path}#${e.size}#${e.mtime}#${i}`;
    const stored = (e) => e.skip || store.map.has(skey(e)) || this.cache.has(`${e.path}#${e.index}`);
    // (the block the fill is downloading is left to it: it stores it too)
    const todo = (e) => !stored(e) && this.bgCur?.key !== `${e.path}#${e.index}`;
    // the entry to download next: the first one past the game's position not stored yet, else the first one
    const next = () => {
      for (let r = L.pos + 1; r < entries.length; r++) if (todo(entries[r])) return r;
      for (let r = 0; r <= L.pos && r < entries.length; r++) if (todo(entries[r])) return r;
      return -1;
    };
    for (;;) {
      if (stop() || store.failed) return;
      // (the game's own reads first; the block fill, when it has blocks to fetch, runs beside this pass rather than
      // before it: a session whose game keeps touching new blocks keeps the fill busy for good, and waiting for it
      // starved this pass for whole sessions)
      while (this.gameBusy(300)) { if (stop()) return; await new Promise((res) => setTimeout(res, 100)); }
      const k = next(); progress.k = k;
      if (k < 0) break;
      const e = entries[k], f = entries[k + 1];
      const n = f && f.path === e.path && f.index === e.index + 1 && todo(f) ? 2 : 1;
      const start = e.index * BLOCK, end = Math.min(e.size, (e.index + n) * BLOCK);
      const data = await this.fetchBackground(e.path, start, end);
      if (data === ABORTED) continue;
      if (data === null) return;
      if (!data) { e.skip = true; continue; } // (an answer to skip: not asked again this session)
      for (let i = 0; i < n; i++) store.put(skey(e, e.index + i), data.subarray(i * BLOCK, Math.min(data.length, (i + 1) * BLOCK)));
      // (done with, stored or not: a full store drops blocks silently, and the pass would fetch them again forever)
      e.skip = true; if (n === 2) f.skip = true;
      progress.bytes += data.length; progress.blocks += n;
    }
    store.flush?.();
    progress.done = true;
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
    for (let r = L.pos + 1, lim = Math.min(L.entries.length, L.pos + 1 + AHEAD_WINDOW); r < lim && L.inFlight < AHEAD_REQUESTS; r++) {
      const e = L.entries[r];
      if (e.ahead || e.seen || !e.mask) continue;
      e.ahead = true;
      if (this.cache.has(`${e.path}#${e.index}`) || this.store?.map.has(`${e.path}#${e.size}#${e.mtime}#${e.index}`)) continue;
      const c0 = e.index * P, pieces = Math.ceil((Math.min(e.size, (e.index + 1) * BLOCK) - e.index * BLOCK) / CHUNK);
      let all = true; for (let i = 0; i < pieces; i++) if (!((e.mask >>> i) & 1)) all = false;
      const want = (i) => ((e.mask >>> i) & 1) === 1 && !this.chunks.has(`${e.path}#${c0 + i}`) && !this.flights.has(`${e.path}#${c0 + i}`);
      for (let i = 0; i < pieces; i++) {
        if (!want(i)) continue;
        let j = i; while (j + 1 < pieces && want(j + 1)) j++;
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
    const done = this.fetchBackground(e.path, start, stop, null, false).then((d) => {
      if (!(d instanceof Uint8Array) || this.cache.has(`${e.path}#${e.index}`)) return;
      this.stats.aheadBytes = (this.stats.aheadBytes ?? 0) + d.length;
      if (whole) { this.installBlock(e.path, e.index, d, `${e.path}#${e.size}#${e.mtime}#${e.index}`); this.evict(); } else this.addPieces(e.path, m0, m1, d);
    }).finally(() => {
      for (let c = m0; c <= m1; c++) if (this.flights.get(`${e.path}#${c}`) === done) this.flights.delete(`${e.path}#${c}`);
      L.inFlight--;
      this.pumpAhead();
    });
    for (let c = m0; c <= m1; c++) this.flights.set(`${e.path}#${c}`, done);
  }
  /** The game read from the network within the last `ms`, or waits for an asynchronous read: background downloads wait. */
  gameBusy(ms) { return this.fgPending > 0 || performance.now() - (this.lastSyncFetchAt ?? -1e9) < ms; }
  /**
   * The game needs the network: every background download in flight goes away (fetched again later), except the
   * block fill's when a parked read waits for it (`spareWaited`).
   */
  abortBackground(spareWaited = false) {
    for (const ctl of this.bgAborts) {
      if (spareWaited && this.bgCur?.ctl === ctl && this.bgCur.waiters > 0) continue;
      this.bgAborts.delete(ctl); ctl.abort();
    }
  }
  /**
   * [start, end) with fetch(), for the background downloads: the bytes, undefined for an answer to skip, ABORTED when
   * the game needed the network (try again later), null when the network failed. `onStart` gets the AbortController.
   */
  async fetchBackground(path, start, end, onStart, abortable = true) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctl && abortable) this.bgAborts.add(ctl);
    onStart?.(ctl);
    try {
      const res = await fetch(this.rangeUrl(path, start, end, true), { ...(this.encoded ? {} : { headers: { Range: `bytes=${start}-${end - 1}` } }), signal: ctl?.signal });
      if (res.status !== 206 && res.status !== 200) return undefined;
      let data = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200 && !this.encoded) data = data.subarray(start, end);
      return data.length === end - start ? data : undefined;
    } catch { return ctl?.signal.aborted ? ABORTED : null; } finally { if (ctl) this.bgAborts.delete(ctl); }
  }

  fetchRange(path, start, end) {
    // (a background download shares the connection: it goes away while the game waits, and is fetched again later)
    this.abortBackground();
    const url = this.rangeUrl(path, start, end);
    for (let attempt = 0; ; attempt++) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.responseType = 'arraybuffer';
      if (!this.encoded) xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
      const t0 = performance.now();
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
    this.want.delete(k);
    for (let c = (index * BLOCK) / CHUNK, e = c + BLOCK / CHUNK; c < e; c++) { const ck = `${path}#${c}`, p = this.chunks.get(ck); if (p) { this.chunks.delete(ck); this.chunkBytes -= p.length; } }
  }

  /** Pieces m0..m1 of a file from `data` (fetched from piece m0), those not here yet; the piece cache stays bounded. */
  addPieces(path, m0, m1, data) {
    for (let c = m0; c <= m1; c++) {
      const ck = `${path}#${c}`, piece = data.subarray((c - m0) * CHUNK, Math.min(data.length, (c - m0 + 1) * CHUNK));
      if (this.chunks.has(ck)) continue;
      this.chunks.set(ck, piece); this.chunkBytes += piece.length;
    }
    while (this.chunkBytes > MAX_CHUNK_BYTES) { const [k, v] = this.chunks.entries().next().value; this.chunks.delete(k); this.chunkBytes -= v.length; }
  }

  /**
   * Bytes [pos, end) of one block that is neither cached nor stored (a random read): the missing 64 KiB pieces are
   * fetched in one request, the whole block is queued for the background.
   */
  readPieces(path, size, mtime, index, pos, end, out, outOff, ahead = 0, extra = 0) {
    const c0 = Math.floor(pos / CHUNK), c1 = Math.floor((end - 1) / CHUNK);
    let m0 = -1, m1 = -1;
    for (let c = c0; c <= c1; c++) if (!this.chunks.has(`${path}#${c}`)) { if (m0 < 0) m0 = c; m1 = c; }
    // (a stream: the request also covers the `extra` bytes that follow, within the block — the window grows with the
    // stream, as few round trips as whole blocks would take for a file read from start to end)
    if (m0 >= 0 && extra > 0) { const last = Math.min(Math.floor((Math.min(size, (index + 1) * BLOCK) - 1) / CHUNK), Math.floor((end - 1 + extra) / CHUNK)); while (m1 < last && !this.chunks.has(`${path}#${m1 + 1}`)) m1++; }
    if (m0 >= 0) {
      const start = m0 * CHUNK, stop = Math.min(size, (m1 + 1) * CHUNK);
      const data = this.fetchRange(path, start, stop);
      this.addPieces(path, m0, m1, data);
    }
    for (let c = c0; c <= c1; c++) {
      const ck = `${path}#${c}`, piece = this.chunks.get(ck);
      if (!piece) return false; // (evicted at once: a read larger than the piece cache — the caller fetches the block)
      this.chunks.delete(ck); this.chunks.set(ck, piece); // (LRU)
      const a = Math.max(pos, c * CHUNK), b = Math.min(end, c * CHUNK + piece.length);
      out.set(piece.subarray(a - c * CHUNK, b - c * CHUNK), outOff + (a - pos));
    }
    // the block, and for a stream the next ones, in the background
    for (let i = index; i <= index + ahead && i * BLOCK < size; i++) {
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
  async fetchAhead(path, size, mtime, pos, end, bulk) {
    // pieces of the read already on their way (fetched ahead from the learned list): waited for, not asked again
    if (this.flights.size) {
      const flying = new Set();
      for (let c = Math.floor(pos / CHUNK); c * CHUNK < end; c++) { const f = this.flights.get(`${path}#${c}`); if (f) flying.add(f); }
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
        const e = Math.min(size, b0 + 4 * BLOCK);
        jobs.push(this.fetchForeground(path, b0, e).then((d) => { if (d) for (let i = 0; b0 + i * BLOCK < e; i++) if (!this.cache.has(`${path}#${bi + i}`)) this.installBlock(path, bi + i, d.subarray(i * BLOCK, Math.min(d.length, (i + 1) * BLOCK)), `${path}#${size}#${mtime}#${bi + i}`); this.evict(); }));
        break;
      }
      const c0 = Math.floor(Math.max(pos, b0) / CHUNK), c1 = Math.floor((Math.min(end, b1) - 1) / CHUNK);
      let m0 = -1, m1 = -1;
      for (let c = c0; c <= c1; c++) if (!this.chunks.has(`${path}#${c}`)) { if (m0 < 0) m0 = c; m1 = c; }
      if (m0 < 0) continue;
      const start = m0 * CHUNK, stop = Math.min(size, (m1 + 1) * CHUNK);
      jobs.push(this.fetchForeground(path, start, stop).then((d) => {
        if (d && !this.cache.has(`${path}#${bi}`)) this.addPieces(path, m0, m1, d);
      }));
    }
    try { await Promise.all(jobs); } finally { if (waited) waited.waiters--; }
  }
  /** [start, end) with fetch() for a read the game waits for (counted as the game's own reads; not aborted). */
  async fetchForeground(path, start, end) {
    const t0 = performance.now();
    this.abortBackground(true);
    this.fgPending++;
    try {
      const url = this.rangeUrl(path, start, end);
      const res = await fetch(url, this.encoded ? {} : { headers: { Range: `bytes=${start}-${end - 1}` } });
      if (res.status !== 206 && res.status !== 200) return null;
      let data = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200 && !this.encoded) data = data.subarray(start, end);
      if (data.length !== end - start) return null;
      const ms = performance.now() - t0;
      this.stats.requests++; this.stats.bytes += data.length; this.stats.ms += ms; this.stats.asyncReads = (this.stats.asyncReads ?? 0) + 1;
      this.onFetch?.({ url, path, start, end, ms, async: true });
      return data;
    } catch { return null; } finally { this.fgPending--; this.lastSyncFetchAt = performance.now(); }
  }

  /** Download the wanted blocks, one at a time, while the game is not reading synchronously. */
  async fillBackground() {
    if (this.filling || typeof fetch !== 'function') return;
    this.filling = true;
    try {
      while (this.want.size) {
        while (this.gameBusy(150)) await new Promise((res) => setTimeout(res, 50));
        if (!this.want.size) break; // (fetched whole meanwhile by a sequential read)
        const [k, w] = this.want.entries().next().value;
        // (here already: fetched whole by a read, or stored by the learned prefetch)
        if (this.cache.has(k) || this.store?.map.has(`${w.path}#${w.size}#${w.mtime}#${w.index}`)) { this.want.delete(k); continue; }
        const start = w.index * BLOCK, end = Math.min(w.size, start + BLOCK);
        const cur = { key: k, path: w.path, index: w.index, ctl: null, done: null, waiters: 0 };
        const pr = this.fetchBackground(w.path, start, end, (ctl) => { cur.ctl = ctl; });
        cur.done = pr.then(() => {});
        this.bgCur = cur;
        const data = await pr;
        this.bgCur = null;
        if (data === ABORTED) continue;
        if (data === null) break; // (network down: the next random read queues it again)
        this.want.delete(k);
        if (!data) continue;
        this.installBlock(w.path, w.index, data, `${w.path}#${w.size}#${w.mtime}#${w.index}`);
        this.evict();
        this.stats.bgBlocks = (this.stats.bgBlocks ?? 0) + 1;
      }
    } finally { this.filling = false; }
  }
  /**
   * Offline copy: fetch every block of every file of the listing that the store does not hold yet, in the
   * background (4 MiB requests, one at a time), pausing while the game reads synchronously. `progress` is updated
   * ({ bytes, total, done }); stops at `stop()` or when the store fails (quota).
   */
  async downloadAll(progress, stop = () => false) {
    const store = this.store; if (!store || typeof fetch !== 'function') return;
    const files = [];
    const walk = (node, rel) => {
      for (const [n, f] of Object.entries(node.files ?? {})) files.push({ path: rel ? `${rel}/${n}` : n, size: f.size, mtime: f.mtime ?? 0 });
      for (const [n, d] of Object.entries(node.dirs ?? {})) walk(d, rel ? `${rel}/${n}` : n);
    };
    walk(this.tree, '');
    progress.total = files.reduce((a, f) => a + f.size, 0); progress.bytes = 0; progress.done = false;
    const PER_REQUEST = 4;
    for (const f of files) {
      const blocks = Math.ceil(f.size / BLOCK);
      for (let b = 0; b < blocks; b += PER_REQUEST) {
        if (stop() || store.failed) return;
        const n = Math.min(PER_REQUEST, blocks - b), key = (i) => `${f.path}#${f.size}#${f.mtime}#${i}`;
        let missing = false; for (let i = b; i < b + n; i++) if (!store.map.has(key(i))) missing = true;
        const bytes = Math.min(f.size, (b + n) * BLOCK) - b * BLOCK;
        if (missing) {
          while (this.gameBusy(500)) await new Promise((r) => setTimeout(r, 200));
          const url = this.rangeUrl(f.path, b * BLOCK, b * BLOCK + bytes);
          let data;
          try { const r = await fetch(url, this.encoded ? {} : { headers: { Range: `bytes=${b * BLOCK}-${b * BLOCK + bytes - 1}` } }); if (r.status !== 206 && r.status !== 200) return; data = new Uint8Array(await r.arrayBuffer()); if (r.status === 200 && !this.encoded) data = data.subarray(b * BLOCK, b * BLOCK + bytes); if (data.length !== bytes) return; } catch { return; }
          for (let i = b; i < b + n; i++) store.put(key(i), data.subarray((i - b) * BLOCK, Math.min(data.length, (i - b + 1) * BLOCK)));
        }
        progress.bytes += bytes;
      }
    }
    store.flush();
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
    const sequential = off === this.lastEnd, bulk = sequential && this.run + (end - off) >= STREAM_BYTES;
    let missing = false;
    for (let bi = Math.floor(off / BLOCK); bi * BLOCK < end && !missing; bi++) {
      if (this.b.peekBlock(this.path, this.len, bi, this.mtime)) continue;
      if (bulk) { missing = true; break; }
      for (let c = Math.floor(Math.max(off, bi * BLOCK) / CHUNK), e = Math.floor((Math.min(end, (bi + 1) * BLOCK) - 1) / CHUNK); c <= e; c++) if (!this.b.chunks.has(`${this.path}#${c}`)) { missing = true; break; }
    }
    return missing ? this.b.fetchAhead(this.path, this.len, this.mtime, off, end, bulk) : null;
  }
  read(off, len) {
    const end = Math.min(off + len, this.len);
    if (off >= end) return new Uint8Array(0);
    this.note(off, end);
    const out = new Uint8Array(end - off);
    const sequential = off === this.lastEnd;
    this.lastEnd = end;
    // bytes read in sequence so far: a bulk read (loading a file whole) fetches whole blocks ahead synchronously; a
    // stream read a little at a time (audio, video while playing) goes by pieces, its next blocks in the background
    this.run = sequential ? this.run + (end - off) : 0;
    const bulk = sequential && this.run >= STREAM_BYTES;
    let pos = off;
    while (pos < end) {
      const bi = Math.floor(pos / BLOCK), bo = pos - bi * BLOCK;
      // a random read of a block not here yet: only its pieces now (the block follows in the background)
      if (!bulk && !this.b.peekBlock(this.path, this.len, bi, this.mtime)) {
        const stop = Math.min(end, (bi + 1) * BLOCK);
        if (this.b.readPieces(this.path, this.len, this.mtime, bi, pos, stop, out, pos - off, sequential ? 2 : 0, sequential ? Math.min(this.run, STREAM_WINDOW) : 0)) { pos = stop; continue; }
      }
      const blk = this.b.block(this.path, this.len, bi, sequential ? 4 : 1, this.mtime);
      const n = Math.min(end - pos, blk.length - bo);
      if (n <= 0) break;
      out.set(blk.subarray(bo, bo + n), pos - off);
      pos += n;
    }
    return pos === end ? out : out.subarray(0, pos - off);
  }
  write() { return 0; }
  truncate() {}
  close() {}
}
