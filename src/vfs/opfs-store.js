// Persistent block store for the HTTP game backend: file blocks fetched once are kept in the origin
// private file system (OPFS) and read back synchronously on later runs, so a game folder served over the
// network is downloaded once instead of at every launch (and a block needed in the middle of a match is a
// local read, not a synchronous round trip). One append-only data file plus a JSON index, both through
// synchronous access handles (dedicated workers only). Keys carry the file size and mtime of the server
// listing: a changed file simply misses. Any storage error (quota, a second tab holding the handles)
// disables the store; the backend then keeps fetching over HTTP.
/** index format: { v: 2, entries: [[key, offset, length, checksum]] } (1: [[key, offset, length]], no checksum) */
const STORE_FORMAT = 2;

/**
 * A 32-bit checksum of a block (multiply-xor over 32-bit words, then the tail bytes, then the length): ~1 ms for 1 MiB,
 * to catch a stored block that does not read back as written.
 */
export function blockHash(bytes) {
  let h = 0x811c9dc5 ^ bytes.length;
  const words = bytes.byteOffset % 4 === 0 ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 2) : new Uint32Array(bytes.slice(0, bytes.length & ~3).buffer);
  for (let i = 0; i < words.length; i++) { h = Math.imul(h ^ words[i], 0x9e3779b1); h ^= h >>> 15; }
  for (let i = bytes.length & ~3; i < bytes.length; i++) { h = Math.imul(h ^ bytes[i], 0x85ebca6b); h ^= h >>> 13; }
  return (h ^ (h >>> 16)) >>> 0;
}

export class OpfsBlockStore {
  /**
   * @param {FileSystemSyncAccessHandle} data
   * @param {FileSystemSyncAccessHandle} index
   * @param {Map<string, [number, number]>} map key -> [offset, length]
   */
  constructor(data, index, map) {
    this.data = data; this.indexHandle = index; this.map = map;
    this.end = data.getSize();
    this.dirty = 0;
    this.failed = false;
    this.stats = { hits: 0, puts: 0, bytes: 0 };
  }

  /** Open (or create) the store in OPFS directory `name`; null when OPFS or sync handles are unavailable. */
  static async open(name) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(name, { create: true });
      const data = await (await dir.getFileHandle('blocks.bin', { create: true })).createSyncAccessHandle();
      let index;
      try { index = await (await dir.getFileHandle('index.json', { create: true })).createSyncAccessHandle(); } catch (e) { data.close(); throw e; }
      const map = new Map();
      const n = index.getSize();
      let reset = n > 0 ? 'unreadable index' : null;
      if (n > 0) {
        const buf = new Uint8Array(n); index.read(buf, { at: 0 });
        try {
          const j = JSON.parse(new TextDecoder().decode(buf));
          if (j && j.v === STORE_FORMAT && Array.isArray(j.entries)) { for (const [k, off, len, h] of j.entries) map.set(k, [off, len, h]); reset = null; }
          else reset = 'an earlier format without block checksums';
        } catch { map.clear(); }
      }
      // a store of an earlier format (no checksums) or with an unreadable index starts over, its data file emptied
      if (reset) { map.clear(); data.truncate(0); index.truncate(0); }
      // entries past the end of the data file (a write lost before the index flush) are dropped
      const size = data.getSize();
      for (const [k, [off, len]] of map) if (off + len > size) map.delete(k);
      const store = new OpfsBlockStore(data, index, map);
      store.resetReason = reset;
      return store;
    } catch {
      return null;
    }
  }

  /**
   * The stored bytes of `key`, or null. Their checksum is verified: a block that does not match what was written (a
   * damaged or misplaced write, whatever the cause) is dropped and reported (stats.corrupt, onCorrupt), the caller then
   * fetches it again.
   */
  get(key) {
    if (this.failed) return null;
    const e = this.map.get(key);
    if (!e) return null;
    const out = new Uint8Array(e[1]);
    try { if (this.data.read(out, { at: e[0] }) !== e[1]) return null; } catch { this.fail(); return null; }
    if (blockHash(out) !== e[2]) {
      this.map.delete(key); this.dirty++;
      this.stats.corrupt = (this.stats.corrupt ?? 0) + 1;
      this.onCorrupt?.(key);
      return null;
    }
    this.stats.hits++;
    return out;
  }

  /** Append `bytes` under `key` (ignored when the store has failed). */
  put(key, bytes) {
    if (this.failed || this.map.has(key)) return;
    const t0 = performance.now();
    try {
      const n = this.data.write(bytes, { at: this.end });
      if (n !== bytes.length) { this.fail(); return; }
      this.map.set(key, [this.end, n, blockHash(bytes)]);
      this.end += n;
      this.stats.puts++; this.stats.bytes += n;
      if (++this.dirty >= 16) this.flush();
    } catch { this.fail(); }
    this.stats.putMs = (this.stats.putMs ?? 0) + performance.now() - t0;
  }

  /** Persist the index (data first, so every indexed block is on disk). */
  flush() {
    if (this.failed || !this.dirty) return;
    const t0 = performance.now();
    this.stats.flushes = (this.stats.flushes ?? 0) + 1;
    try {
      this.data.flush();
      const json = new TextEncoder().encode(JSON.stringify({ v: STORE_FORMAT, entries: [...this.map].map(([k, [off, len, h]]) => [k, off, len, h]) }));
      this.indexHandle.truncate(0);
      this.indexHandle.write(json, { at: 0 });
      this.indexHandle.flush();
      this.dirty = 0;
    } catch { this.fail(); }
    this.stats.flushMs = (this.stats.flushMs ?? 0) + performance.now() - t0;
  }

  /** Forget `key` (a block found unusable by the reader): fetched and stored again. */
  drop(key) { if (this.map.delete(key)) this.dirty++; }

  fail() { this.failed = true; }

  close() { try { this.flush(); this.data.close(); this.indexHandle.close(); } catch { /* already closed */ } }
}

/**
 * The block store's interface in memory, up to `maxBytes` (then new blocks are dropped): pages without OPFS and
 * harness runs measuring the prefetch without a persistent profile.
 */
export class MemBlockStore {
  constructor(maxBytes = 1 << 30) { this.map = new Map(); this.bytes = 0; this.max = maxBytes; this.failed = false; this.stats = { hits: 0, puts: 0, bytes: 0 }; }
  get(key) { const b = this.map.get(key); if (b) this.stats.hits++; return b ?? null; }
  put(key, bytes) { if (this.map.has(key) || this.bytes + bytes.length > this.max) return; this.map.set(key, bytes.slice()); this.bytes += bytes.length; this.stats.puts++; this.stats.bytes += bytes.length; }
  drop(key) { const b = this.map.get(key); if (b) { this.map.delete(key); this.bytes -= b.length; } }
  flush() {}
  close() {}
}
