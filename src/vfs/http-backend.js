// Read-only VFS backend over HTTP range requests (synchronous XHR: the guest's ReadFile is
// synchronous and the emulator runs in a worker). The directory tree comes from the server's
// JSON listing so stat/readdir never hit the network; file data is fetched in blocks kept in a
// bounded LRU cache with read-ahead for sequential access.
const BLOCK = 1 << 20; // 1 MiB
const DEFAULT_CACHE_BLOCKS = 256; // 256 MiB

export class HttpBackend {
  /**
   * @param {string} baseUrl e.g. "/game/bfme-vanilla/"
   * @param {{ dirs: Record<string, any>, files: Record<string, {size: number, mtime: number}> }} tree
   * @param {{ cacheBlocks?: number, store?: import('./opfs-store.js').OpfsBlockStore | null, onFetch?: (info: {url: string, start: number, end: number, ms: number}) => void }} [opts]
   *   store: persistent block store (OPFS) consulted before the network and filled with every fetched block
   */
  constructor(baseUrl, tree, opts = {}) {
    this.base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.tree = tree;
    this.cache = new Map(); // key "path#block" -> Uint8Array (insertion order = LRU)
    this.maxBlocks = opts.cacheBlocks ?? DEFAULT_CACHE_BLOCKS;
    this.onFetch = opts.onFetch ?? null;
    this.store = opts.store ?? null;
    this.stats = { requests: 0, bytes: 0, ms: 0 };
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

  /** Fetch [start, end) of a file synchronously. */
  fetchRange(path, start, end) {
    const url = this.base + path.split('/').map(encodeURIComponent).join('/');
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
    const t0 = performance.now();
    xhr.send();
    const ms = performance.now() - t0;
    if (xhr.status !== 206 && xhr.status !== 200) throw new Error(`range request failed: ${xhr.status} ${url}`);
    const data = new Uint8Array(xhr.response);
    this.stats.requests++; this.stats.bytes += data.length; this.stats.ms += ms;
    this.onFetch?.({ url, start, end, ms });
    return xhr.status === 200 ? data.subarray(start, end) : data;
  }

  block(path, size, index, readAhead, mtime = 0) {
    const key = `${path}#${index}`;
    let b = this.cache.get(key);
    if (b) { this.cache.delete(key); this.cache.set(key, b); return b; }
    // persistent store (the key names the file version: size and mtime of the listing)
    const skey = (i) => `${path}#${size}#${mtime}#${i}`;
    b = this.store?.get(skey(index));
    if (b) { this.cache.set(key, b); this.evict(); return b; }
    // fetch this block plus up to `readAhead` following blocks in one request
    const start = index * BLOCK;
    const n = Math.max(1, Math.min(readAhead, Math.ceil((size - start) / BLOCK)));
    const end = Math.min(size, start + n * BLOCK);
    const data = this.fetchRange(path, start, end);
    for (let i = 0; i < n; i++) {
      const k = `${path}#${index + i}`;
      const slice = data.subarray(i * BLOCK, Math.min(data.length, (i + 1) * BLOCK));
      this.cache.set(k, slice);
      this.store?.put(skey(index + i), slice);
    }
    this.evict();
    return this.cache.get(key);
  }
  evict() { while (this.cache.size > this.maxBlocks) { const first = this.cache.keys().next().value; this.cache.delete(first); } }
}

class HttpFile {
  constructor(backend, path, size, mtime) { this.b = backend; this.path = path; this.len = size; this.mtime = mtime; this.lastEnd = -1; }
  size() { return this.len; }
  read(off, len) {
    const end = Math.min(off + len, this.len);
    if (off >= end) return new Uint8Array(0);
    const out = new Uint8Array(end - off);
    const sequential = off === this.lastEnd;
    this.lastEnd = end;
    let pos = off;
    while (pos < end) {
      const bi = Math.floor(pos / BLOCK), bo = pos - bi * BLOCK;
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
