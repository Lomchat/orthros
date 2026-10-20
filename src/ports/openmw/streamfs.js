// The OpenMW engine page's file streaming, in place of the engine release's own streamfs.js (src/host/openmw.js swaps
// the script; same interface: StreamFS.init, mount, mountLocal, mountBlob, setUrl, stats, window.__streamfsStats).
// The engine reads its game files synchronously on the page's thread (a few KB at a time, through its own 8 KB buffers);
// the files are on the server. Each read is served from 64 KB blocks kept here; a block missing is asked of a worker
// (streamfs-worker.js), and the page's thread waits for it on shared memory — the worker keeps a copy of every block it
// got in the browser's private files (OPFS), fetches the others compressed (src/host/openmw.js, openmwSpans), and
// decides how much to fetch at once: a small file whole, an archive's record whole, more and more ahead of a file read
// in order. The upstream fetched 2 MB per miss, raw, and kept nothing of the base game between sessions.
(() => {
  'use strict';
  const BLOCK = 65536, SPAN = 16 << 20, PER_FILE = 2 ** 21;   // (a block's key: file id × PER_FILE + block)
  const S = { worker: null, ctrl: null, data: null, files: new Map(), next: 1, cache: new Map(), held: 0, budget: 0, gen: 0, used: [] };
  const ST = { hits: 0, misses: 0, stallMs: 0, evictions: 0, bytes: 0 };

  /** The bytes [position, position + length) of a file into the engine's buffer. */
  function read(f, buffer, offset, length, position) {
    const end = Math.min(f.size, position + length);
    if (!(end > position)) return 0;
    // (in order: this read starts about where the last one ended — the run's length is how far the worker reads ahead)
    f.run = position >= f.last - BLOCK && position <= f.last + 2 * BLOCK ? f.run + (end - position) : 0;
    f.last = end;
    let pos = position, out = offset;
    while (pos < end) {
      const b = Math.floor(pos / BLOCK), key = f.id * PER_FILE + b;
      let blk = S.cache.get(key);
      if (blk) { S.cache.delete(key); S.cache.set(key, blk); ST.hits++; }
      else { load(f, b, end); blk = S.cache.get(key); if (!blk) throw new Error('streamfs: block missing ' + f.path + '@' + b * BLOCK); }
      // (a block's first use: told the worker, which tells the server the order the engine needed them in)
      if (blk.fresh) { blk.fresh = false; S.used.push(key); }
      const within = pos - b * BLOCK, n = Math.min(end - pos, blk.length - within);
      buffer.set(blk.subarray(within, within + n), out);
      pos += n; out += n;
    }
    return end - position;
  }

  /** Blocks from b on, at least through byte `need`, from the worker: the page's thread waits for them. */
  function load(f, b, need) {
    const start = b * BLOCK;
    // (the worker may read on, up to the next block kept here)
    let limit = Math.min(f.size, start + SPAN);
    for (let k = b + 1; k * BLOCK < limit; k++) if (S.cache.has(f.id * PER_FILE + k)) { limit = k * BLOCK; break; }
    const gen = ++S.gen;
    Atomics.store(S.ctrl, 0, 0);
    S.worker.postMessage({ gen, id: f.id, start, end: Math.min(need, start + SPAN), run: f.run, limit, used: S.used.splice(0) });
    const t0 = performance.now();
    let seen = -1, since = t0;
    while (Atomics.load(S.ctrl, 0) !== gen) {
      // (no time limit while bytes arrive: a slow link is not a failure; a minute and a half without any is)
      const got = Atomics.load(S.ctrl, 2), now = performance.now();
      if (got !== seen) { seen = got; since = now; } else if (now - since > 90000) throw new Error('streamfs: no data for 90 s ' + f.path + '@' + start);
    }
    ST.misses++; ST.stallMs += performance.now() - t0;
    const n = S.ctrl[1];
    if (n < 0) throw new Error('streamfs: read failed ' + f.path + '@' + start);
    for (let at = 0; at < n; at += BLOCK) {
      const len = Math.min(BLOCK, n - at);
      if (len < BLOCK && start + at + len !== f.size) break;   // (a whole block, or the file's last)
      const key = f.id * PER_FILE + b + at / BLOCK;
      if (S.cache.has(key)) continue;
      const blk = S.data.slice(at, at + len); blk.fresh = true;
      S.cache.set(key, blk); S.held += len; ST.bytes += len;
    }
    while (S.held > S.budget && S.cache.size > 1) {
      const [key, blk] = S.cache.entries().next().value;
      S.cache.delete(key); S.held -= blk.length; ST.evictions++;
    }
  }

  function makeNode(path, f) {
    const name = path.substring(path.lastIndexOf('/') + 1), dir = path.substring(0, path.lastIndexOf('/')) || '/';
    const node = FS.createFile(dir, name, {}, true, false);
    node.usedBytes = f.size;
    const getattr = node.node_ops.getattr;
    node.node_ops = Object.assign({}, node.node_ops, { getattr(n) { const a = getattr(n); a.size = f.size; return a; } });
    node.stream_ops = Object.assign({}, node.stream_ops, {
      llseek(stream, off, whence) {
        let p = off;
        if (whence === 1) p += stream.position; else if (whence === 2) p += f.size;
        if (p < 0) throw new FS.ErrnoError(28);
        return p;
      },
      read(stream, buffer, offset, length, position) { return read(f, buffer, offset, length, position); },
      write() { throw new FS.ErrnoError(63); },
      mmap() { throw new FS.ErrnoError(52); },
    });
    return node;
  }

  function add(path, size, source) {
    const f = { id: S.next++, path, size, run: 0, last: -1 };
    S.files.set(path, f);
    S.worker.postMessage({ mount: { id: f.id, size, ...source } });
    return makeNode(path, f);
  }

  window.StreamFS = {
    stats() { return Object.assign({ cached: S.cache.size, lruMax: Math.floor(S.budget / BLOCK) }, ST); },
    init() {
      if (S.worker) return;
      if (!self.crossOriginIsolated) throw new Error('streamfs needs crossOriginIsolated (COOP/COEP)');
      // (the page's memory tier: the upstream's slots were "about 1 MB each")
      S.budget = ((window.__omwLruDefault | 0) || 128) * 1048576;
      S.ctrl = new Int32Array(new SharedArrayBuffer(32));   // (4, 5: the step's KB there and to come, for the indicator)
      S.data = new Uint8Array(new SharedArrayBuffer(SPAN));
      S.worker = new Worker('/src/ports/openmw/streamfs-worker.js');
      S.worker.postMessage({ init: { ctrl: S.ctrl.buffer, data: S.data.buffer, page: location.pathname } });
      setInterval(() => { if (S.used.length) S.worker.postMessage({ used: S.used.splice(0) }); }, 2000);
      window.orthrosStreamMeter?.attach?.(S.ctrl.buffer);
      // (how far the files fetched ahead are: for the Orthros page around the engine)
      S.worker.onmessage = (e) => { if (e.data?.ahead && window.parent !== window) window.parent.postMessage({ type: 'orthros-ahead', ...e.data.ahead }, location.origin); };
      try { Object.defineProperty(window, '__streamfsStats', { configurable: true, get: () => window.StreamFS.stats() }); } catch { /* defined */ }
    },
    /** A file of the server at `url`, `size` bytes (`mtime`: its date, when the server tells it — part of its copy's name). */
    mount(path, url, size, mtime) { return add(path, size, { url: new URL(url, location.href).href, mtime: mtime || 0 }); },
    /** A new address for a mounted file (signed addresses expire): its kept copy stays. */
    setUrl(path, url) { const f = S.files.get(path); if (f) S.worker.postMessage({ setUrl: { id: f.id, url: new URL(url, location.href).href } }); },
    /** A file the player picked (FileSystemFileHandle): read from the disk. */
    mountLocal(path, handle, size) { return add(path, size, { handle }); },
    /** A Blob (a file the page keeps in the browser's Cache API). */
    mountBlob(path, blob, size) { return add(path, size, { blob }); },
  };
})();
