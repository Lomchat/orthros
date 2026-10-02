// Translated code kept across sessions (the background translator's persistent cache): a known game translates
// nothing again at its later launches. An entry is the WebAssembly body of one region with what its translation was
// a function of, all compared before it is reused:
//  - the translator itself and its options: the cache's `key` (a hash of the translator's sources, closure of their
//    imports, and the options; another key empties the cache);
//  - the region's entry and the x87 mode it was asked for;
//  - its extent (blocks, as a discovery pass finds them now) and the code bytes there, compared byte for byte;
//  - the import slots holding a fast API's thunk it runs inline (slot, thunk, fast id: `deps`);
//  - its table index, the one place a body depends on it, rewritten (patchAltSlot).
// Storage: one append-only file per game (a `store`: synchronous size/read/write/truncate/flush, an OPFS sync access
// handle in the browser), records [u32 length][meta JSON length u32][meta JSON][snapshot][body]; a damaged tail is cut.

const MAGIC = 0x314a434f; // 'OCJ1'
const enc = new TextEncoder(), dec = new TextDecoder();

/** 2x32-bit FNV-1a over strings, hex (the cache key) */
export function hashText(parts) {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  for (const s of parts) {
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 13); }
    h1 = Math.imul(h1 ^ 0xff, 0x01000193); h2 = Math.imul(h2 ^ 0xff, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * The text of a module and of every module it imports (relative specifiers, recursively), fetched with `get(url)`
 * (in the browser: fetch, revalidated like the modules themselves), in a fixed order — what the translator is.
 */
export async function moduleClosureText(roots, get) {
  const seen = new Map(), queue = roots.map((u) => String(u));
  while (queue.length) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    let text;
    try { text = await get(u); } catch (e) { if (roots.some((r) => String(r) === u)) throw e; text = '\0missing'; } // (a specifier the scan found in a comment)
    seen.set(u, text);
    for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(new URL(m[1], u).href);
    for (const m of text.matchAll(/(?:^|[\s;])import\s*['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(new URL(m[1], u).href);
  }
  return [...seen].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([u, t]) => `${u.replace(/^.*\/src\//, 'src/')}\n${t}`);
}

/** In-memory store (tests; a session without OPFS keeps nothing across sessions anyway). */
export class MemStore {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  size() { return this.n; }
  read(at, len) { return this.buf.slice(at, Math.min(this.n, at + len)); }
  write(at, bytes) {
    if (at + bytes.length > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, at + bytes.length)); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
    this.buf.set(bytes, at); this.n = Math.max(this.n, at + bytes.length);
  }
  truncate(n) { this.n = Math.min(this.n, n); }
  flush() {}
}

/** An OPFS file as a store (dedicated workers only: FileSystemSyncAccessHandle; exclusive — another tab gets none). */
export async function openOpfsStore(dirName, fileName) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirName, { create: true });
  const fh = await dir.getFileHandle(fileName, { create: true });
  const h = await fh.createSyncAccessHandle();
  return {
    size: () => h.getSize(),
    read: (at, len) => { const b = new Uint8Array(Math.max(0, Math.min(len, h.getSize() - at))); h.read(b, { at }); return b; },
    write: (at, bytes) => { h.write(bytes, { at }); },
    truncate: (n) => h.truncate(n),
    flush: () => h.flush(),
    close: () => h.close(),
  };
}

const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/** The inline-API dependencies of discovered blocks: [slot, thunk, fid, ...] in block and instruction order. */
export function inlineDeps(blocks) {
  const out = [];
  for (const b of blocks) for (const i of b.insns ?? []) if (i.inlineApi) out.push(i.inlineApi.slot >>> 0, i.inlineApi.thunk >>> 0, i.inlineApi.fid);
  return out;
}

export class CodeCache {
  /** `store` (see MemStore), `key` (translator and options), `maxBytes`: no more entries past that size. */
  constructor(store, key, maxBytes = 256 * 1024 * 1024) {
    this.store = store; this.key = key; this.maxBytes = maxBytes;
    this.map = new Map(); // "eip:fpcIn" -> [entry]
    this.end = 0; this.stats = { loaded: 0, hits: 0, misses: 0, added: 0, bytes: 0, loadMs: 0, reset: '' };
    this.load();
  }
  load() {
    const t0 = performance.now(), st = this.store, size = st.size();
    const head = st.read(0, Math.min(size, 4096));
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let ok = head.length >= 8 && dv.getUint32(0, true) === MAGIC;
    const klen = ok ? dv.getUint32(4, true) : 0;
    ok = ok && 8 + klen <= head.length && dec.decode(head.subarray(8, 8 + klen)) === this.key;
    if (!ok) {
      this.stats.reset = size ? 'another translator or options' : '';
      const k = enc.encode(this.key), h = new Uint8Array(8 + k.length);
      new DataView(h.buffer).setUint32(0, MAGIC, true); new DataView(h.buffer).setUint32(4, k.length, true); h.set(k, 8);
      st.truncate(0); st.write(0, h); st.flush();
      this.end = h.length;
    } else {
      // (the index only: each record's header and meta; bodies and code bytes stay in the file until a hit)
      let at = 8 + klen;
      while (at + 8 <= size) {
        const hv = new DataView(st.read(at, 8).buffer), len = hv.getUint32(0, true), mlen = hv.getUint32(4, true);
        if (len < 8 + mlen || at + len > size) break; // (a record cut short: the tail is dropped)
        let meta; try { meta = JSON.parse(dec.decode(st.read(at + 8, mlen))); } catch { break; }
        if (8 + mlen + meta.snapLen > len) break;
        this.put(this.indexOf(meta, at, len, mlen));
        at += len; this.stats.loaded++;
      }
      if (at !== size) { st.truncate(at); st.flush(); }
      this.end = at;
    }
    this.stats.bytes = this.end; this.stats.loadMs = performance.now() - t0;
  }
  /** what a lookup compares first (and where the record is) */
  indexOf(meta, at, len, mlen) {
    const ext = new Uint32Array(2 * meta.blocks.length);
    meta.blocks.forEach((b, i) => { ext[2 * i] = b[0]; ext[2 * i + 1] = b[1]; });
    return { eip: meta.eip, fpcIn: meta.fpcIn, ext, deps: Uint32Array.from(meta.deps), at, len, mlen, snapLen: meta.snapLen };
  }
  put(e) { const k = `${e.eip}:${e.fpcIn ?? 'g'}`; const l = this.map.get(k); if (l) l.push(e); else this.map.set(k, [e]); }
  /**
   * An entry for this region as discovered now (extent [{eip, end}], code bytes `snap`, inline deps), or null: the
   * record read back, { fpcOut, altAt, blocks: [[eip, end, index]], stats, hints, code }.
   */
  lookup(eip, fpcIn, extent, snap, deps) {
    const l = this.map.get(`${eip}:${fpcIn ?? 'g'}`);
    if (l) {
      for (const e of l) {
        if (e.ext.length !== 2 * extent.length || e.deps.length !== deps.length || e.snapLen !== snap.length) continue;
        let same = true;
        for (let i = 0; same && i < extent.length; i++) same = e.ext[2 * i] === extent[i].eip && e.ext[2 * i + 1] === extent[i].end;
        for (let i = 0; same && i < deps.length; i++) same = e.deps[i] === deps[i] >>> 0;
        if (!same) continue;
        const rec = this.store.read(e.at, e.len);
        if (rec.length !== e.len || !sameBytes(rec.subarray(8 + e.mlen, 8 + e.mlen + e.snapLen), snap)) continue;
        let meta; try { meta = JSON.parse(dec.decode(rec.subarray(8, 8 + e.mlen))); } catch { continue; }
        this.stats.hits++;
        return { ...meta, code: rec.slice(8 + e.mlen + e.snapLen) };
      }
    }
    this.stats.misses++;
    return null;
  }
  /**
   * A new translation: { eip, fpcIn, fpcOut, altAt, blocks: [{eip, end, index}], deps, stats, hints, snap, code }.
   * Appended to the store (not past maxBytes), indexed in memory.
   */
  add(t) {
    const meta = { eip: t.eip, fpcIn: t.fpcIn ?? null, fpcOut: t.fpcOut ?? null, altAt: t.altAt ?? -1, blocks: t.blocks.map((b) => [b.eip, b.end, b.index]), deps: t.deps, stats: t.stats, hints: t.hints ?? [], snapLen: t.snap.length };
    const mb = enc.encode(JSON.stringify(meta)), len = 8 + mb.length + t.snap.length + t.code.length;
    if (this.end + len > this.maxBytes) return false;
    const rec = new Uint8Array(len), v = new DataView(rec.buffer);
    v.setUint32(0, len, true); v.setUint32(4, mb.length, true);
    rec.set(mb, 8); rec.set(t.snap, 8 + mb.length); rec.set(t.code, 8 + mb.length + t.snap.length);
    this.store.write(this.end, rec);
    this.put(this.indexOf(meta, this.end, len, mb.length));
    this.end += len; this.stats.bytes = this.end; this.stats.added++;
    return true;
  }
  flush() { this.store.flush(); }
}
