// Persistent block store for the HTTP game backend: file blocks fetched once are kept in the origin
// private file system (OPFS) and read back synchronously on later runs, so a game folder served over the
// network is downloaded once instead of at every launch (and a block needed in the middle of a match is a
// local read, not a synchronous round trip). One append-only data file plus an append-only index log, both through
// synchronous access handles (dedicated workers only). Keys carry the file size and mtime of the server
// listing: a changed file simply misses. Any storage error (quota, a second tab holding the handles)
// disables the store; the backend then keeps fetching over HTTP.
//
// Index format 3 (index.bin): an 8-byte header ('OBSI', u32 3) then records, each
//   u16 key length, u8 kind (1: block stored, 2: block dropped), u8 0, u32 offset low, u32 offset high, u32 length,
//   u32 block checksum, the key's UTF-8 bytes, u32 checksum of the record's previous bytes
// (little-endian). A later record of a key replaces the earlier one. Records are appended, never rewritten: the earlier
// format (index.json, { v: 2, entries: [[key, offset, length, checksum]] }) rewrote and synced the whole index every 16
// blocks — 2.7 s of the game thread over a BFME2 first launch. Records wait in memory and are written (and the index
// flushed) at a sync point: once >= 2 s passed since the last one or >= 256 records wait, and when the caller forces it
// (prefetch end, stop, close). A crash loses at most the records of the last sync interval: those blocks are fetched
// again. Reading stops at the first incomplete or damaged record (the log is cut there).
// The data file is flushed only at close: its flush writes back every block written since the last one (~150 ms of the
// game thread per 50 MiB, 2.2 s over a first launch's prefetch, whatever the cadence). An indexed block whose bytes a
// crash lost is caught by its checksum at read (or lies past the end of the data file) and fetched again.
const INDEX_MAGIC = 0x4953424f; // 'OBSI'
const INDEX_VERSION = 3;
const HEADER_BYTES = 8, RECORD_FIXED = 20;
const REC_PUT = 1, REC_DROP = 2;
/** sync cadence of the index: at most every SYNC_MS (unless forced), sooner once SYNC_BLOCKS records wait */
export const SYNC_MS = 2000, SYNC_BLOCKS = 256;

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

const enc = new TextEncoder(), dec = new TextDecoder();

/** The index log's bytes for `records` ([kind, key, offset, length, checksum]), preceded by the header when `header`. */
export function encodeIndex(records, header = false) {
  const keys = records.map((r) => enc.encode(r[1]));
  let n = header ? HEADER_BYTES : 0;
  for (const k of keys) n += RECORD_FIXED + k.length + 4;
  const out = new Uint8Array(n), dv = new DataView(out.buffer);
  let p = 0;
  if (header) { dv.setUint32(0, INDEX_MAGIC, true); dv.setUint32(4, INDEX_VERSION, true); p = HEADER_BYTES; }
  for (let i = 0; i < records.length; i++) {
    const [kind, , off, len, h] = records[i], k = keys[i], at = p;
    dv.setUint16(p, k.length, true); out[p + 2] = kind; out[p + 3] = 0;
    dv.setUint32(p + 4, off >>> 0, true); dv.setUint32(p + 8, Math.floor(off / 0x100000000), true);
    dv.setUint32(p + 12, len >>> 0, true); dv.setUint32(p + 16, h >>> 0, true);
    out.set(k, p + RECORD_FIXED); p += RECORD_FIXED + k.length;
    dv.setUint32(p, blockHash(out.subarray(at, p)), true); p += 4;
  }
  return out;
}

/**
 * Replay an index log into `map` (key -> [offset, length, checksum]). Returns the byte length of its valid part (up to
 * the last complete, undamaged record), or -1 when the header is not this format's.
 */
export function decodeIndex(buf, map) {
  if (buf.length < HEADER_BYTES) return -1;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  if (dv.getUint32(0, true) !== INDEX_MAGIC || dv.getUint32(4, true) !== INDEX_VERSION) return -1;
  let p = HEADER_BYTES;
  while (p + RECORD_FIXED + 4 <= buf.length) {
    const kl = dv.getUint16(p, true), kind = buf[p + 2], end = p + RECORD_FIXED + kl;
    if (end + 4 > buf.length) break;
    if (dv.getUint32(end, true) !== blockHash(buf.subarray(p, end))) break;
    const key = dec.decode(buf.subarray(p + RECORD_FIXED, end));
    if (kind === REC_PUT) map.set(key, [dv.getUint32(p + 4, true) + dv.getUint32(p + 8, true) * 0x100000000, dv.getUint32(p + 12, true), dv.getUint32(p + 16, true)]);
    else if (kind === REC_DROP) map.delete(key);
    else break;
    p = end + 4;
  }
  return p;
}

export class OpfsBlockStore {
  /**
   * @param {FileSystemSyncAccessHandle} data
   * @param {FileSystemSyncAccessHandle} index the index log (format 3), its valid part `indexEnd` bytes long
   * @param {Map<string, [number, number, number]>} map key -> [offset, length, checksum]
   */
  constructor(data, index, map, indexEnd = index.getSize()) {
    this.data = data; this.indexHandle = index; this.map = map;
    this.end = data.getSize();
    this.indexEnd = indexEnd;
    /** @type {Array<[number, string, number, number, number]>} index records not written yet */
    this.pending = [];
    this.lastSync = performance.now();
    this.failed = false;
    this.stats = { hits: 0, puts: 0, bytes: 0 };
  }

  /** Index records waiting for the next sync point. */
  get dirty() { return this.pending.length; }

  /** Open (or create) the store in OPFS directory `name`; null when OPFS or sync handles are unavailable. */
  static async open(name) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(name, { create: true });
      const data = await (await dir.getFileHandle('blocks.bin', { create: true })).createSyncAccessHandle();
      let index;
      try { index = await (await dir.getFileHandle('index.bin', { create: true })).createSyncAccessHandle(); } catch (e) { data.close(); throw e; }
      try {
        const map = new Map();
        let reset = null, migrated = false, end = -1, cut = 0;
        // an index of the earlier format (index.json): read once (when there is no log yet), rewritten as a log, removed
        let old = null;
        try { old = await dir.getFileHandle('index.json'); } catch { /* none */ }
        const n = index.getSize();
        if (n > 0) {
          const buf = new Uint8Array(n); index.read(buf, { at: 0 });
          end = decodeIndex(buf, map);
          if (end < 0) reset = 'unreadable index'; else cut = n - end;
        } else if (old) {
          const h = await old.createSyncAccessHandle();
          try {
            const m = h.getSize();
            const buf = new Uint8Array(m); if (m) h.read(buf, { at: 0 });
            if (!m) { if (data.getSize() > 0) reset = 'no index'; } // (created, never written)
            else try {
              const j = JSON.parse(dec.decode(buf));
              if (j && j.v === 2 && Array.isArray(j.entries)) { for (const [k, off, len, hh] of j.entries) map.set(k, [off, len, hh]); migrated = true; }
              else reset = 'an earlier format without block checksums';
            } catch { reset = 'unreadable index'; }
          } finally { h.close(); }
        } else if (data.getSize() > 0) reset = 'no index';
        // a store of an earlier format (no checksums) or with an unreadable index starts over, its data file emptied
        if (reset) { map.clear(); data.truncate(0); }
        // entries past the end of the data file (a write lost before the index sync) are dropped
        const size = data.getSize();
        for (const [k, [off, len]] of map) if (off + len > size) map.delete(k);
        if (end < 0 || reset || migrated) {
          // a new log: the header and, migrating, every entry, as one write
          const bytes = encodeIndex([...map].map(([k, [off, len, h]]) => [REC_PUT, k, off, len, h]), true);
          index.truncate(0); index.write(bytes, { at: 0 }); index.flush(); end = bytes.length;
        } else if (cut > 0) { index.truncate(end); index.flush(); } // (an incomplete or damaged tail: the log is cut there)
        if (old) { try { await dir.removeEntry('index.json'); } catch { /* left behind: ignored once the log exists */ } }
        const store = new OpfsBlockStore(data, index, map, end);
        store.resetReason = reset;
        store.migrated = migrated;
        store.indexCut = cut;
        return store;
      } catch (e) { data.close(); index.close(); throw e; }
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
      this.drop(key);
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
      const h = blockHash(bytes);
      this.map.set(key, [this.end, n, h]);
      this.pending.push([REC_PUT, key, this.end, n, h]);
      this.end += n;
      this.stats.puts++; this.stats.bytes += n;
      this.flush();
    } catch { this.fail(); }
    this.stats.putMs = (this.stats.putMs ?? 0) + performance.now() - t0;
  }

  /**
   * A sync point: the waiting index records appended and the index flushed — when `force`, once SYNC_MS passed since the
   * last one, or once SYNC_BLOCKS records wait; otherwise nothing (cheap to call often). The data file is not flushed
   * (see the top of this file).
   */
  flush(force = false) {
    if (this.failed || !this.pending.length) return;
    const t0 = performance.now();
    if (!force && this.pending.length < SYNC_BLOCKS && t0 - this.lastSync < SYNC_MS) return;
    this.stats.flushes = (this.stats.flushes ?? 0) + 1;
    try {
      const bytes = encodeIndex(this.pending);
      if (this.indexHandle.write(bytes, { at: this.indexEnd }) !== bytes.length) this.fail();
      else {
        this.indexHandle.flush();
        this.indexEnd += bytes.length;
        this.pending = [];
      }
    } catch { this.fail(); }
    this.lastSync = performance.now();
    this.stats.flushMs = (this.stats.flushMs ?? 0) + this.lastSync - t0;
  }

  /** Forget `key` (a block found unusable by the reader): fetched and stored again. */
  drop(key) {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.pending.push([REC_DROP, key, e[0], e[1], e[2]]);
  }

  fail() { this.failed = true; }

  close() { try { this.data.flush(); this.flush(true); this.data.close(); this.indexHandle.close(); } catch { /* already closed */ } }
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
