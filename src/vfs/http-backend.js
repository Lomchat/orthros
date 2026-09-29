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
const RETRY_WAITS = [250, 1000, 2000, 4000, 8000]; // ms before each new attempt of a failed range request

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
    /** the background download in flight (aborted when the game needs the network synchronously) */
    this.bgAbort = null;
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
   * Background prefetch: download the listed blocks ([path, block index], in the order earlier sessions needed them)
   * that the store does not hold yet, one request at a time (two consecutive blocks at most), yielding while the game
   * reads synchronously (its reads come first). `progress` gets { bytes, blocks, done }.
   */
  async prefetch(list, progress, stop = () => false) {
    const store = this.store; if (!store || typeof fetch !== 'function') return;
    progress.bytes = 0; progress.blocks = 0; progress.done = false;
    for (let k = 0; k < list.length; k++) {
      if (stop() || store.failed) return;
      const [p, b] = list[k];
      const r = this.lookup(p); if (!r || !r.file) continue;
      const size = r.file.size, mtime = r.file.mtime ?? 0, key = (i) => `${r.path}#${size}#${mtime}#${i}`;
      if (b * BLOCK >= size || store.map.has(key(b))) continue;
      const n = k + 1 < list.length && list[k + 1][0] === p && list[k + 1][1] === b + 1 && (b + 1) * BLOCK < size && !store.map.has(key(b + 1)) ? 2 : 1;
      if (n === 2) k++;
      // (the game's own reads first, then the blocks its random reads touched)
      while (performance.now() - (this.lastSyncFetchAt ?? -1e9) < 300 || this.filling) { if (stop()) return; await new Promise((res) => setTimeout(res, 100)); }
      const start = b * BLOCK, end = Math.min(size, (b + n) * BLOCK);
      const data = await this.fetchBackground(r.path, start, end);
      if (data === null) { if (this.aborted) { this.aborted = false; k -= n; continue; } return; }
      if (!data) continue;
      for (let i = 0; i < n; i++) store.put(key(b + i), data.subarray(i * BLOCK, Math.min(data.length, (i + 1) * BLOCK)));
      progress.bytes += data.length; progress.blocks += n;
    }
    store.flush?.();
    progress.done = true;
  }
  /**
   * [start, end) with fetch(), for the background downloads: the bytes, undefined for an answer to skip, null when the
   * network failed or the download was aborted (this.aborted set: the game needed the network, try again later).
   */
  async fetchBackground(path, start, end) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    this.bgAbort = ctl;
    try {
      const res = await fetch(this.rangeUrl(path, start, end, true), { ...(this.encoded ? {} : { headers: { Range: `bytes=${start}-${end - 1}` } }), signal: ctl?.signal });
      if (res.status !== 206 && res.status !== 200) return undefined;
      let data = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200 && !this.encoded) data = data.subarray(start, end);
      return data.length === end - start ? data : undefined;
    } catch { return null; } finally { if (this.bgAbort === ctl) this.bgAbort = null; }
  }

  fetchRange(path, start, end) {
    // (a background download shares the connection: it goes away while the game waits, and is fetched again later)
    if (this.bgAbort) { this.aborted = true; this.bgAbort.abort(); this.bgAbort = null; }
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
        this.onFetch?.({ url, start, end, ms });
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
    return this.cache.get(`${path}#${index}`);
  }
  /** A whole block arrived: memory cache, persistent store; its pieces and its background request are dropped. */
  installBlock(path, index, bytes, skey) {
    const k = `${path}#${index}`;
    this.cache.set(k, bytes);
    this.store?.put(skey, bytes);
    this.want.delete(k);
    for (let c = (index * BLOCK) / CHUNK, e = c + BLOCK / CHUNK; c < e; c++) { const ck = `${path}#${c}`, p = this.chunks.get(ck); if (p) { this.chunks.delete(ck); this.chunkBytes -= p.length; } }
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
      for (let c = m0; c <= m1; c++) {
        const ck = `${path}#${c}`, piece = data.subarray((c - m0) * CHUNK, Math.min(data.length, (c - m0 + 1) * CHUNK));
        if (this.chunks.has(ck)) continue;
        this.chunks.set(ck, piece); this.chunkBytes += piece.length;
      }
      while (this.chunkBytes > MAX_CHUNK_BYTES) { const [k, v] = this.chunks.entries().next().value; this.chunks.delete(k); this.chunkBytes -= v.length; }
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
    const jobs = [];
    for (let bi = Math.floor(pos / BLOCK); bi * BLOCK < end; bi++) {
      if (this.peekBlock(path, size, bi, mtime)) continue;
      const b0 = bi * BLOCK, b1 = Math.min(size, b0 + BLOCK);
      // the block is being downloaded in the background (a stream's read-ahead): wait for it rather than abort it
      if (this.bgCur?.key === `${path}#${bi}`) { this.keepBg = true; jobs.push(this.bgCur.done); continue; }
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
        if (!d) return;
        for (let c = m0; c <= m1; c++) { const ck = `${path}#${c}`; if (this.chunks.has(ck) || this.cache.has(`${path}#${bi}`)) continue; const piece = d.subarray((c - m0) * CHUNK, Math.min(d.length, (c - m0 + 1) * CHUNK)); this.chunks.set(ck, piece); this.chunkBytes += piece.length; }
      }));
    }
    try { await Promise.all(jobs); } finally { this.keepBg = false; }
  }
  /** [start, end) with fetch() for a read the game waits for (counted as the game's own reads; not aborted). */
  async fetchForeground(path, start, end) {
    const t0 = performance.now();
    if (this.bgAbort && !this.keepBg) { this.aborted = true; this.bgAbort.abort(); this.bgAbort = null; }
    try {
      const url = this.rangeUrl(path, start, end);
      const res = await fetch(url, this.encoded ? {} : { headers: { Range: `bytes=${start}-${end - 1}` } });
      if (res.status !== 206 && res.status !== 200) return null;
      let data = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200 && !this.encoded) data = data.subarray(start, end);
      if (data.length !== end - start) return null;
      const ms = performance.now() - t0;
      this.stats.requests++; this.stats.bytes += data.length; this.stats.ms += ms; this.stats.asyncReads = (this.stats.asyncReads ?? 0) + 1;
      this.onFetch?.({ url, start, end, ms });
      return data;
    } catch { return null; } finally { this.lastSyncFetchAt = performance.now(); }
  }

  /** Download the wanted blocks, one at a time, while the game is not reading synchronously. */
  async fillBackground() {
    if (this.filling || typeof fetch !== 'function') return;
    this.filling = true;
    try {
      while (this.want.size) {
        while (performance.now() - (this.lastSyncFetchAt ?? -1e9) < 150) await new Promise((res) => setTimeout(res, 50));
        if (!this.want.size) break; // (fetched whole meanwhile by a sequential read)
        const [k, w] = this.want.entries().next().value;
        if (this.cache.has(k)) { this.want.delete(k); continue; }
        const start = w.index * BLOCK, end = Math.min(w.size, start + BLOCK);
        const pr = this.fetchBackground(w.path, start, end);
        this.bgCur = { key: k, done: pr.then(() => {}) };
        const data = await pr;
        this.bgCur = null;
        if (data === null) { if (this.aborted) { this.aborted = false; continue; } break; } // (network down: the next random read queues it again)
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
          while (performance.now() - (this.lastSyncFetchAt ?? -1e9) < 500) await new Promise((r) => setTimeout(r, 200));
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
   * A read of [off, off + len) would need the network: a promise fetching it asynchronously (resolved when the data
   * is here), else null. Leaves the read state (sequence detection) alone.
   */
  prepare(off, len) {
    const end = Math.min(off + len, this.len);
    if (off >= end || typeof fetch !== 'function') return null;
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
