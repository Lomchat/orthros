// Persistent block store for the HTTP game backend: file blocks fetched once are kept in the origin
// private file system (OPFS) and read back synchronously on later runs, so a game folder served over the
// network is downloaded once instead of at every launch (and a block needed in the middle of a match is a
// local read, not a synchronous round trip). One append-only data file plus a JSON index, both through
// synchronous access handles (dedicated workers only). Keys carry the file size and mtime of the server
// listing: a changed file simply misses. Any storage error (quota, a second tab holding the handles)
// disables the store; the backend then keeps fetching over HTTP.
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
      if (n > 0) {
        const buf = new Uint8Array(n); index.read(buf, { at: 0 });
        try { for (const [k, off, len] of JSON.parse(new TextDecoder().decode(buf))) map.set(k, [off, len]); } catch { map.clear(); }
      }
      // entries past the end of the data file (a write lost before the index flush) are dropped
      const size = data.getSize();
      for (const [k, [off, len]] of map) if (off + len > size) map.delete(k);
      return new OpfsBlockStore(data, index, map);
    } catch {
      return null;
    }
  }

  /** The stored bytes of `key`, or null. */
  get(key) {
    if (this.failed) return null;
    const e = this.map.get(key);
    if (!e) return null;
    const out = new Uint8Array(e[1]);
    try { if (this.data.read(out, { at: e[0] }) !== e[1]) return null; } catch { this.fail(); return null; }
    this.stats.hits++;
    return out;
  }

  /** Append `bytes` under `key` (ignored when the store has failed). */
  put(key, bytes) {
    if (this.failed || this.map.has(key)) return;
    try {
      const n = this.data.write(bytes, { at: this.end });
      if (n !== bytes.length) { this.fail(); return; }
      this.map.set(key, [this.end, n]);
      this.end += n;
      this.stats.puts++; this.stats.bytes += n;
      if (++this.dirty >= 16) this.flush();
    } catch { this.fail(); }
  }

  /** Persist the index (data first, so every indexed block is on disk). */
  flush() {
    if (this.failed || !this.dirty) return;
    try {
      this.data.flush();
      const json = new TextEncoder().encode(JSON.stringify([...this.map].map(([k, [off, len]]) => [k, off, len])));
      this.indexHandle.truncate(0);
      this.indexHandle.write(json, { at: 0 });
      this.indexHandle.flush();
      this.dirty = 0;
    } catch { this.fail(); }
  }

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
  flush() {}
  close() {}
}
