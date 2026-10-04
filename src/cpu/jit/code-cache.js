// Translated code kept across sessions (the background translator's persistent cache): a known game translates
// nothing again at its later launches. An entry is the WebAssembly body of one region with what its translation was
// a function of, all compared before it is reused:
//  - the translator itself and its options: the cache's `key` (a hash of the translator's sources, closure of their
//    imports, and the options; another key empties the cache);
//  - the region's entry and the x87 mode it was asked for;
//  - its extent (blocks, as a discovery pass finds them now — the code heat's only effect on discovery, cold exits)
//    and the code bytes there, compared byte for byte;
//  - the blocks given a visit flag (translate.js: those the heat did not know to have run): the heat of now must know
//    every other block of the entry to have run (the caller's `accept`); a flagged block the heat now knows has its
//    flag store sent to a byte nobody reads (bg-translate.js relocateVisits);
//  - the import slots holding a fast API's thunk it runs inline (slot, thunk, fast id: `deps`);
//  - its table index, the one place a body depends on it, rewritten (patchAltSlot), and its visit flags' addresses
//    (`visits`: [block, end, body offsets]), this session's, rewritten (patchVisitSlots).
// Storage: one file per game (a `store`: synchronous size/read/write/truncate/flush, an OPFS sync access handle in the
// browser): a header (magic, key length, session number, state, key), then records [u32 length][u32 meta length]
// [u32 last session that used it, 0: unused][u32 index length][binary index (indexBytes): read at load][meta JSON:
// read at a hit][snapshot][body], appended; a damaged tail is cut. The code heat
// grows over a game's first sessions and reshapes regions: a translation of the same code under a new shape
// supersedes the earlier one (marked unused in place); a full file evicts the entries no session used for longest and
// is compacted in place.

const MAGIC = 0x324a434f; // 'OCJ2'
/** header bytes before the key; record header bytes */
const HEAD = 16, REC = 16, IDX = 20;
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

/**
 * A record's binary index (what a lookup compares first, read at load without the meta JSON): entry u32, x87 mode i32
 * (-1: any), snapshot length, block count n, dependency count d, then n pairs [block, end) and d dependencies (u32).
 */
function indexBytes(eip, fpcIn, snapLen, blocks, deps) {
  const b = new Uint8Array(IDX + 8 * blocks.length + 4 * deps.length), v = new DataView(b.buffer);
  v.setUint32(0, eip >>> 0, true); v.setInt32(4, fpcIn ?? -1, true); v.setUint32(8, snapLen, true); v.setUint32(12, blocks.length, true); v.setUint32(16, deps.length, true);
  let o = IDX;
  for (const x of blocks) { v.setUint32(o, x.eip >>> 0, true); v.setUint32(o + 4, x.end >>> 0, true); o += 8; }
  for (const d of deps) { v.setUint32(o, d >>> 0, true); o += 4; }
  return b;
}
/** the index entry of the record at `at` (`hv`: its first REC + ilen bytes), or null when they do not hold together */
function indexEntry(hv, at, len, ilen, mlen, used) {
  const eip = hv.getUint32(REC, true), fpc = hv.getInt32(REC + 4, true), snapLen = hv.getUint32(REC + 8, true), nb = hv.getUint32(REC + 12, true), nd = hv.getUint32(REC + 16, true);
  if (IDX + 8 * nb + 4 * nd !== ilen || REC + ilen + mlen + snapLen > len) return null;
  const ext = new Uint32Array(2 * nb), deps = new Uint32Array(nd);
  let o = REC + IDX;
  for (let i = 0; i < 2 * nb; i++, o += 4) ext[i] = hv.getUint32(o, true);
  for (let i = 0; i < nd; i++, o += 4) deps[i] = hv.getUint32(o, true);
  const mo = REC + ilen;
  return { k: `${eip}:${fpc < 0 ? 'g' : fpc}`, ext, deps, at, len, mo, so: mo + mlen, snapLen, used };
}

/** a span moved at once by a compaction (bytes) */
const MOVE_SPAN = 4 << 20;
/** entries kept per entry address and x87 mode for other code there (another program at that address) */
export const VARIANTS = 4;

export class CodeCache {
  /**
   * `store` (see MemStore), `key` (translator and options), `maxBytes`: the file's bound (additions past it wait for an
   * idle moment to make room, up to 9/8 of it).
   */
  constructor(store, key, maxBytes = 256 * 1024 * 1024) {
    this.store = store; this.key = key; this.maxBytes = maxBytes;
    this.map = new Map(); // "eip:fpcIn" -> [entry]
    this.end = 0; this.flushedAt = 0;
    this.session = 1; // (this session's number: an entry's `used` is the last session that added or reused it)
    this.live = 0; // (bytes of the records indexed: what a compaction keeps)
    this.stale = null; // (the entries the last lookup found translating the code of now under another shape)
    this.full = false; // (no room made any more in this session: see makeRoom)
    this.pending = false; // (past the bound: room to make at the next idle moment, see maintain)
    this.stats = { loaded: 0, hits: 0, misses: 0, missNew: 0, missExtent: 0, missDeps: 0, missBytes: 0, missHeat: 0, added: 0, bytes: 0, dead: 0, loadMs: 0, reset: '', superseded: 0, evicted: 0, compactions: 0, compactMs: 0, session: 0, supersededAge: {} };
    this.load();
  }
  /** the file's header: magic, key length, session, state (1: a compaction under way), key; returns its length */
  writeHead(state) {
    const k = enc.encode(this.key), h = new Uint8Array(HEAD + k.length), v = new DataView(h.buffer);
    v.setUint32(0, MAGIC, true); v.setUint32(4, k.length, true); v.setUint32(8, this.session, true); v.setUint32(12, state, true); h.set(k, HEAD);
    this.store.write(0, h);
    return h.length;
  }
  writeU32(at, x) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x, true); this.store.write(at, b); }
  load() {
    const t0 = performance.now(), st = this.store, size = st.size();
    const head = st.read(0, Math.min(size, 4096));
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let ok = head.length >= HEAD && dv.getUint32(0, true) === MAGIC;
    const klen = ok ? dv.getUint32(4, true) : 0;
    ok = ok && HEAD + klen <= head.length && dec.decode(head.subarray(HEAD, HEAD + klen)) === this.key;
    // (a compaction cut short — the tab closed meanwhile —: records half moved, a new start)
    const interrupted = ok && (dv.getUint32(12, true) & 1) !== 0;
    if (!ok || interrupted) {
      this.stats.reset = interrupted ? 'a compaction was interrupted' : size ? 'another translator or options' : '';
      this.session = 1;
      st.truncate(0); this.end = this.headLen = this.writeHead(0); st.flush();
    } else {
      this.session = (dv.getUint32(8, true) + 1) >>> 0 || 1;
      this.headLen = this.writeHead(0);
      // (the index only: each record's header and binary index, in one read; the meta, code bytes and body stay in the
      // file until a hit)
      let at = this.headLen;
      while (at + REC <= size) {
        let h = st.read(at, Math.min(size - at, 1024));
        let hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
        const len = hv.getUint32(0, true), mlen = hv.getUint32(4, true), used = hv.getUint32(8, true), ilen = hv.getUint32(12, true);
        if (len < REC + ilen + mlen || ilen < IDX || at + len > size) break; // (a record cut short: the tail is dropped)
        if (REC + ilen > h.length) { h = st.read(at, REC + ilen); hv = new DataView(h.buffer, h.byteOffset, h.byteLength); }
        const e = indexEntry(hv, at, len, ilen, mlen, used);
        if (!e) break;
        if (used === 0) this.stats.dead += len; // (superseded or evicted: its room comes back at the next compaction)
        else { this.put(e); this.live += len; this.stats.loaded++; }
        at += len;
      }
      if (at !== size) { st.truncate(at); st.flush(); }
      this.end = at;
    }
    this.stats.bytes = this.end; this.stats.session = this.session; this.stats.loadMs = performance.now() - t0;
  }
  put(e) { const l = this.map.get(e.k); if (l) l.push(e); else this.map.set(e.k, [e]); }
  /** the entry leaves the index, its record marked unused in the file (its room comes back at a compaction) */
  drop(e, why) {
    const l = this.map.get(e.k), i = l ? l.indexOf(e) : -1;
    if (i < 0) return;
    l.splice(i, 1); if (!l.length) this.map.delete(e.k);
    this.writeU32(e.at + 8, 0);
    this.live -= e.len; this.stats.dead += e.len; this.stats[why]++;
    // (diagnostics: how many sessions ago a superseded entry was last used — 1: reshaped since the last session)
    if (why === 'superseded') { const age = Math.min(4, this.session - e.used); this.stats.supersededAge[age] = (this.stats.supersededAge[age] ?? 0) + 1; }
  }
  /** reused or added in this session (the least recently used go first when room is needed) */
  touch(e) { if (e.used !== this.session) { e.used = this.session; this.writeU32(e.at + 8, this.session); } }
  /** does memory (`u8`) hold the code the entry was translated from, over the entry's own extent? */
  sameCode(e, u8) {
    const snap = this.store.read(e.at + e.so, e.snapLen);
    if (snap.length !== e.snapLen) return false;
    let o = 0;
    for (let i = 0; i < e.ext.length; i += 2) {
      const lo = e.ext[i], hi = e.ext[i + 1];
      if (hi < lo || hi > u8.length || o + hi - lo > snap.length) return false;
      for (let a = lo; a < hi; a++) if (u8[a] !== snap[o++]) return false;
    }
    return o === snap.length;
  }
  /**
   * An entry for this region as discovered now (extent [{eip, end}], code bytes `snap`, inline deps) that `accept(meta)`
   * takes (if given: the heat of now gives its visit flags), or null: the record read back, { fpcOut, altAt, blocks:
   * [[eip, end, index]], stats, hints, visits, code }. With `u8` (guest memory) the entries found translating the code
   * there now under another shape (another extent, or blocks left unflagged that the heat does not know: an earlier
   * heat's) are noted: the translation added next for this region supersedes them (see add). `count`: false, not
   * counted in the stats (the background worker's refresh passes).
   */
  lookup(eip, fpcIn, extent, snap, deps, accept = null, u8 = null, count = true) {
    const k = `${eip}:${fpcIn ?? 'g'}`, l = this.map.get(k);
    let why = 'missNew', stale = null; // (miss reasons, the closest candidate's: diagnostics)
    this.stale = null;
    if (l) {
      for (const e of l) {
        let same = e.ext.length === 2 * extent.length && e.snapLen === snap.length;
        for (let i = 0; same && i < extent.length; i++) same = e.ext[2 * i] === extent[i].eip && e.ext[2 * i + 1] === extent[i].end;
        if (!same) { if (why === 'missNew') why = 'missExtent'; if (u8 && this.sameCode(e, u8)) (stale ??= []).push(e); continue; }
        same = e.deps.length === deps.length;
        for (let i = 0; same && i < deps.length; i++) same = e.deps[i] === deps[i] >>> 0;
        if (!same) { if (why !== 'missBytes') why = 'missDeps'; continue; }
        const rec = this.store.read(e.at, e.len);
        if (rec.length !== e.len || !sameBytes(rec.subarray(e.so, e.so + e.snapLen), snap)) { why = 'missBytes'; continue; }
        let meta; try { meta = JSON.parse(dec.decode(rec.subarray(e.mo, e.so))); } catch { continue; }
        if (accept && !accept(meta)) { why = 'missHeat'; if (u8) (stale ??= []).push(e); continue; }
        if (count) this.stats.hits++;
        this.touch(e);
        return { ...meta, code: rec.slice(e.so + e.snapLen) };
      }
    }
    if (count) { this.stats.misses++; this.stats[why]++; }
    if (stale) this.stale = { k, list: stale };
    return null;
  }
  /**
   * A new translation: { eip, fpcIn, fpcOut, altAt, blocks: [{eip, end, index}], deps, stats, hints, visits, snap, code }
   * (visits: [block, end, [body offsets]]). It supersedes the entries its lookup found translating the same code under
   * another shape (the heat grew: they would not serve again); other code at the same address keeps VARIANTS entries,
   * the least recently used dropped. Appended to the store, indexed in memory; false when no room is left (makeRoom).
   */
  add(t) {
    const meta = { fpcOut: t.fpcOut ?? null, altAt: t.altAt ?? -1, blocks: t.blocks.map((b) => [b.eip, b.end, b.index]), stats: t.stats, hints: t.hints ?? [], visits: t.visits ?? [] };
    const ib = indexBytes(t.eip, t.fpcIn, t.snap.length, t.blocks, t.deps), mb = enc.encode(JSON.stringify(meta));
    const len = REC + ib.length + mb.length + t.snap.length + t.code.length;
    const k = `${t.eip}:${t.fpcIn ?? 'g'}`;
    if (this.stale?.k === k) for (const e of this.stale.list) this.drop(e, 'superseded');
    this.stale = null;
    for (let l = this.map.get(k); l && l.length >= VARIANTS; l = this.map.get(k)) this.drop(l.reduce((a, b) => (b.used < a.used || (b.used === a.used && b.at < a.at) ? b : a)), 'evicted');
    // (past the bound: room made at the next idle moment (maintain), or now past 9/8 of it; none once this session's
    // own entries fill it)
    if (this.end + len > this.maxBytes) {
      if (this.full) return false;
      if (this.end + len <= this.maxBytes + (this.maxBytes >> 3)) this.pending = true;
      else if (!this.makeRoom(len)) return false;
    }
    const rec = new Uint8Array(len), v = new DataView(rec.buffer);
    v.setUint32(0, len, true); v.setUint32(4, mb.length, true); v.setUint32(8, this.session, true); v.setUint32(12, ib.length, true);
    rec.set(ib, REC); rec.set(mb, REC + ib.length); rec.set(t.snap, REC + ib.length + mb.length); rec.set(t.code, REC + ib.length + mb.length + t.snap.length);
    this.store.write(this.end, rec);
    this.put(indexEntry(new DataView(rec.buffer), this.end, len, ib.length, mb.length, this.session));
    this.end += len; this.live += len; this.stats.bytes = this.end; this.stats.added++;
    return true;
  }
  /** At an idle moment (no translation asked for a while): the room the additions past the bound asked for. */
  maintain() {
    if (!this.pending) return false;
    this.pending = false;
    this.makeRoom(0);
    return true;
  }
  /**
   * Room for a record of `len` bytes in a full file: the entries no session used for longest are evicted (never this
   * session's) down to 3/4 of the bound, and the file compacted (the live records moved over the dead ones). When this
   * session's own entries leave no room, or a compaction freed less than 1/8 of the bound, no other compaction is
   * tried in this session (further additions past the bound are refused).
   */
  makeRoom(len) {
    this.pending = false;
    if (this.full) return false;
    const target = Math.floor(this.maxBytes * 3 / 4) - this.headLen - len;
    if (this.live > target) {
      const old = [];
      for (const l of this.map.values()) for (const e of l) if (e.used !== this.session) old.push(e);
      old.sort((a, b) => a.used - b.used || a.at - b.at);
      for (const e of old) { if (this.live <= target) break; this.drop(e, 'evicted'); }
    }
    if (this.headLen + this.live + len > this.maxBytes) { this.full = true; return false; }
    this.compact();
    if (this.maxBytes - this.end < this.maxBytes / 8) this.full = true;
    return this.end + len <= this.maxBytes;
  }
  /**
   * The live records moved toward the start over the dead ones, in file order (a move never overwrites a record not
   * moved yet), the file cut after them. The header says a compaction is under way until it is done: one cut short is
   * found at the next load, which starts the cache over.
   */
  compact() {
    const t0 = performance.now(), st = this.store;
    this.writeHead(1); st.flush();
    const all = [];
    for (const l of this.map.values()) all.push(...l);
    all.sort((a, b) => a.at - b.at);
    let w = this.headLen;
    for (let i = 0; i < all.length;) {
      const from = all[i].at;
      let j = i, to = from + all[i].len;
      while (j + 1 < all.length && all[j + 1].at === to && to - from < MOVE_SPAN) to += all[++j].len;
      if (from !== w) st.write(w, st.read(from, to - from));
      for (let n = i; n <= j; n++) all[n].at = w + (all[n].at - from);
      w += to - from; i = j + 1;
    }
    st.truncate(w); st.flush();
    this.end = w; this.live = w - this.headLen; this.stats.dead = 0; this.stats.bytes = w;
    this.writeHead(0); st.flush();
    this.stats.compactions++; this.stats.compactMs += performance.now() - t0;
  }
  flush() { this.store.flush(); }
}

