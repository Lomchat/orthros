// The shared memory between a Windows game's emulator worker and its data worker (docs/slow-network.md "The data
// worker of the Windows games"; data-link.js the emulator's side, data-worker.js `w32*` the data worker's): the game
// files' blocks the emulator reads with a plain copy, the reads it answered from them (for the reader's planning), and
// the signals of the requests it made.
//
// Blocks: `slots` slots of BLOCK bytes, each holding one block of one file (a file key: data-link.js fileKey) or the
// 64 KiB pieces of it that are here (a mask, bit i: piece i of the block). One writer (the data worker) and one reader
// (the emulator). A slot's `gen` is odd while the writer gives it to another block (a seqlock): the reader reads gen,
// checks the slot's key and mask, copies, and reads gen again — any change and the copy did not happen (the caller asks
// the data worker). A piece's bytes are written before its mask bit, never changed while the block stays: a reader that
// sees the bit reads the right bytes. The slots are found through an open-addressing table the writer keeps (slot + 1,
// 0 free; a key's home is its hash; deletions shift back). The writer replaces slots by CLOCK: the reader marks the slots
// it reads (`ref`), the writer's hand spares a marked slot once.
// Notes: a ring of the reads the emulator answered itself ([handle, offset, end] as doubles), the data worker's reader
// replays them in order (HttpFile.seen: its sequence detection, read-ahead, the learned order's position) — dropped
// (counted) when the ring is full.
// Signals: `done[seq % DONE]` = seq once an asynchronous read (prepare) is here, `ack[seq % DONE]` = seq once the data
// worker found it needs the network; `sig` counts both (the emulator waits on it a moment); `ans` / `ansN` answer the
// synchronous read (`ansN` bytes in the answer buffer, -1: failed); `beat` the data worker's heartbeat.
// snapshot: no state — host-side transport between two workers, not the machine's
export const BLOCK = 1 << 20, CHUNK = 1 << 16, PIECES = BLOCK / CHUNK;
const MAGIC = 0x4f425331; // 'OBS1'
const H = { magic: 0, slots: 1, table: 2, ring: 3, head: 4, tail: 5, drops: 6, sig: 7, ans: 8, ansN: 9, beat: 10, hits: 11, rxKiB: 12, bw: 13 };
const HEADER = 16, META = 8; // (Int32 words: the header; per slot: gen, file, block, mask, ref)
const M = { gen: 0, file: 1, block: 2, mask: 3, ref: 4 };
export const DONE = 4096;

/** A key's home in a table of `mask + 1` entries. */
function home(file, block, mask) {
  let h = Math.imul(file, 0x9e3779b1) ^ Math.imul(block + 0x632be5ab, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12;
  return h & mask;
}

/**
 * The keys of a mounted version's files (both sides compute them from the same tree): path -> `mount` × 2^22 + its
 * rank in the tree's walk (every directory, then every file, in the tree's order — dot files included).
 */
export function fileKeys(tree, mount) {
  const keys = new Map();
  let n = 0;
  (function walk(node, prefix) {
    for (const [dir, sub] of Object.entries(node.dirs ?? {})) walk(sub, prefix + dir + '/');
    for (const file of Object.keys(node.files ?? {})) keys.set(prefix + file, mount * 4194304 + n++);
  })(tree, '');
  if (n > 4194304 || mount > 500) throw new Error('too many files for the shared block cache');
  return keys;
}

/** The pieces of a block covering [a, b) of it, as a mask. */
export function pieceMask(a, b) {
  const c0 = Math.floor(a / CHUNK), c1 = Math.floor((b - 1) / CHUNK);
  return c1 >= 31 ? -1 : ((1 << (c1 + 1)) - 1) & ~((1 << c0) - 1);
}

export class SharedBlocks {
  /** The buffer for `slots` blocks and a ring of `ring` notes (a power of two). */
  static create(slots, ring = 1 << 16) {
    let table = 1; while (table < slots * 2) table *= 2;
    const words = HEADER + slots * META + table + 2 * DONE;
    const ringAt = Math.ceil((words * 4) / 8) * 8, dataAt = Math.ceil((ringAt + ring * 24) / 4096) * 4096;
    const sab = new SharedArrayBuffer(dataAt + slots * BLOCK);
    const h = new Int32Array(sab, 0, HEADER);
    h[H.magic] = MAGIC; h[H.slots] = slots; h[H.table] = table; h[H.ring] = ring;
    return sab;
  }

  /** @param {SharedArrayBuffer} sab @param {boolean} writer the data worker's side */
  constructor(sab, writer = false) {
    const h0 = new Int32Array(sab, 0, HEADER);
    if (h0[H.magic] !== MAGIC) throw new Error('not a shared block cache');
    const slots = h0[H.slots], table = h0[H.table], ring = h0[H.ring];
    const words = HEADER + slots * META + table + 2 * DONE;
    const ringAt = Math.ceil((words * 4) / 8) * 8, dataAt = Math.ceil((ringAt + ring * 24) / 4096) * 4096;
    this.sab = sab; this.slots = slots; this.tmask = table - 1; this.ringN = ring;
    this.i32 = new Int32Array(sab, 0, words);
    this.h = h0;
    this.meta = new Int32Array(sab, HEADER * 4, slots * META);
    this.table = new Int32Array(sab, (HEADER + slots * META) * 4, table);
    this.done = new Int32Array(sab, (HEADER + slots * META + table) * 4, DONE);
    this.ack = new Int32Array(sab, (HEADER + slots * META + table + DONE) * 4, DONE);
    this.ring = new Float64Array(sab, ringAt, ring * 3);
    this.data = new Uint8Array(sab, dataAt, slots * BLOCK);
    /** the reader's last slot (its key and gen): the reads that follow one another inside a block skip the table */
    this.memo = { file: -1, block: -1, slot: -1 };
    /** the producer's ring position, the consumer's last known (re-read only when the ring looks full) */
    this.head = Atomics.load(h0, H.head); this.tailSeen = Atomics.load(h0, H.tail);
    if (writer) {
      /** the writer's own index: key -> slot; per slot its key (the table's deletions rehash them) */
      this.index = new Map(); this.fileOf = new Int32Array(slots).fill(-1); this.blockOf = new Int32Array(slots).fill(-1);
      this.hand = 0; this.used = 0;
      this.stats = { published: 0, pieces: 0, evicted: 0 };
    }
    this.stats ??= { hits: 0, misses: 0, torn: 0 };
  }

  // ---------------------------------------------------------------- the reader (the emulator)

  /** The slot holding block `block` of `file` (its gen unchecked), or -1. */
  find(file, block) {
    const { table, meta } = this, m = this.tmask;
    for (let i = home(file, block, m), n = 0; n <= m; n++, i = (i + 1) & m) {
      const v = Atomics.load(table, i);
      if (v === 0) return -1;
      const s = v - 1, o = s * META;
      if (meta[o + M.file] === file && meta[o + M.block] === block) return s;
    }
    return -1;
  }

  /**
   * Bytes [a, b) of block `block` of `file` copied into `out` at `at` when every piece of them is here: true; false
   * otherwise (nothing to trust in `out` there — the caller asks the data worker).
   */
  copy(file, block, a, b, out, at) {
    const mm = this.memo, meta = this.meta;
    let s = mm.file === file && mm.block === block ? mm.slot : -1;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (s < 0) { s = this.find(file, block); if (s < 0) return false; }
      const o = s * META, g = Atomics.load(meta, o + M.gen);
      if ((g & 1) || meta[o + M.file] !== file || meta[o + M.block] !== block) { s = -1; continue; }
      const need = pieceMask(a, b);
      if ((Atomics.load(meta, o + M.mask) & need) !== need) return false;
      const base = s * BLOCK;
      if (b - a === 1) out[at] = this.data[base + a]; else out.set(this.data.subarray(base + a, base + b), at);
      // (gen again: a slot given to another block meanwhile — the copy is torn. An atomic read-modify-write orders
      // the copy's reads before it on every architecture)
      if (Atomics.add(meta, o + M.gen, 0) !== g) { this.stats.torn++; return false; }
      if (meta[o + M.ref] === 0) meta[o + M.ref] = 1;
      mm.file = file; mm.block = block; mm.slot = s;
      return true;
    }
    return false;
  }

  /** Every piece of [a, b) of the block is here (no copy). */
  here(file, block, a, b) {
    const s = this.find(file, block); if (s < 0) return false;
    const o = s * META, need = pieceMask(a, b);
    return (Atomics.load(this.meta, o + M.gen) & 1) === 0 && this.meta[o + M.file] === file && this.meta[o + M.block] === block && (Atomics.load(this.meta, o + M.mask) & need) === need;
  }

  /** A read the reader answered (handle, [off, end)), for the data worker to replay; false when the ring is full. */
  note(h, off, end) {
    const n = this.ringN;
    if (((this.head - this.tailSeen) | 0) >= n) { this.tailSeen = Atomics.load(this.h, H.tail); if (((this.head - this.tailSeen) | 0) >= n) { Atomics.add(this.h, H.drops, 1); return false; } }
    const i = (this.head & (n - 1)) * 3, r = this.ring;
    r[i] = h; r[i + 1] = off; r[i + 2] = end;
    this.head = (this.head + 1) | 0;
    Atomics.store(this.h, H.head, this.head);
    return true;
  }

  // ---------------------------------------------------------------- the writer (the data worker)

  /**
   * The ring's notes, in order, to `fn(h, off, end)` — which returns false for a note it cannot take yet (its handle
   * unknown: the open's message not here yet): left in the ring for the next drain.
   */
  drain(fn) {
    const n = this.ringN, r = this.ring;
    let tail = Atomics.load(this.h, H.tail), count = 0;
    const head = Atomics.load(this.h, H.head);
    while (tail !== head) {
      const i = (tail & (n - 1)) * 3;
      if (fn(r[i], r[i + 1], r[i + 2]) === false) break;
      tail = (tail + 1) | 0; count++;
    }
    if (count) Atomics.store(this.h, H.tail, tail);
    return count;
  }

  /** The notes dropped (the ring full) so far. */
  get drops() { return Atomics.load(this.h, H.drops); }

  /** The writer's slot of a block, or -1. */
  slotOf(file, block) { return this.index.get(file * 2097152 + block) ?? -1; }

  /** The pieces of a block here (writer's view), as a mask (0: none). */
  maskOf(file, block) { const s = this.slotOf(file, block); return s < 0 ? 0 : Atomics.load(this.meta, s * META + M.mask); }

  /**
   * Bytes of block `block` of `file` from offset `at` in it (piece-aligned) published: every whole piece of them — and
   * the last one, short, when it ends the block (`blockLen` bytes) — not here yet. Slots replaced as needed.
   */
  publish(file, block, at, bytes, blockLen) {
    if (at % CHUNK || at >= blockLen) return;
    const end = Math.min(blockLen, at + bytes.length), c0 = at / CHUNK;
    let c1 = Math.floor(end / CHUNK) - 1; // (the last whole piece)
    if (end === blockLen && end % CHUNK) c1++; // (the block's short last piece)
    if (c1 < c0) return;
    let s = this.slotOf(file, block);
    if (s < 0) s = this.take(file, block);
    const o = s * META, meta = this.meta;
    let mask = Atomics.load(meta, o + M.mask);
    const want = pieceMask(c0 * CHUNK, Math.min(blockLen, (c1 + 1) * CHUNK));
    if ((mask & want) === want) return;
    const base = s * BLOCK;
    for (let c = c0; c <= c1; c++) {
      const bit = 1 << c; if (mask & bit) continue;
      const a = c * CHUNK, b = Math.min(blockLen, a + CHUNK);
      this.data.set(bytes.subarray(a - at, b - at), base + a);
      mask |= bit; this.stats.pieces++;
    }
    Atomics.store(meta, o + M.mask, mask); // (after the bytes: a reader that sees the bit reads them)
    this.stats.published++;
  }

  /** A slot for a new block: a free one, else the CLOCK hand's (its block forgotten). */
  take(file, block) {
    const meta = this.meta;
    let s;
    if (this.used < this.slots) s = this.used++;
    else {
      for (let n = 0; ; n++) {
        s = this.hand; this.hand = (this.hand + 1) % this.slots;
        if (n < 2 * this.slots && meta[s * META + M.ref]) { meta[s * META + M.ref] = 0; continue; }
        break;
      }
      this.stats.evicted++;
    }
    const o = s * META;
    Atomics.add(meta, o + M.gen, 1); // (odd: the reader's copies of it fail from now)
    if (this.fileOf[s] >= 0) { this.unlist(s); this.index.delete(this.fileOf[s] * 2097152 + this.blockOf[s]); }
    Atomics.store(meta, o + M.mask, 0);
    meta[o + M.file] = file; meta[o + M.block] = block; meta[o + M.ref] = 1;
    this.fileOf[s] = file; this.blockOf[s] = block;
    Atomics.add(meta, o + M.gen, 1); // (even: its new block, no piece yet)
    const m = this.tmask;
    let i = home(file, block, m); while (this.table[i] !== 0) i = (i + 1) & m;
    Atomics.store(this.table, i, s + 1);
    this.index.set(file * 2097152 + block, s);
    return s;
  }

  /** Slot `s` out of the table (backward-shift deletion: no tombstones, every key still reachable from its home). */
  unlist(s) {
    const t = this.table, m = this.tmask;
    let i = home(this.fileOf[s], this.blockOf[s], m);
    while (t[i] !== s + 1) { if (t[i] === 0) return; i = (i + 1) & m; }
    Atomics.store(t, i, 0);
    for (let j = (i + 1) & m; t[j] !== 0; j = (j + 1) & m) {
      const q = t[j] - 1, k = home(this.fileOf[q], this.blockOf[q], m);
      // (entry j may move to the hole at i when its home is not in (i, j], cyclically)
      if ((j > i && (k <= i || k > j)) || (j < i && k <= i && k > j)) { Atomics.store(t, i, t[j]); Atomics.store(t, j, 0); i = j; }
    }
  }

  // ---------------------------------------------------------------- signals

  /** (writer) the asynchronous read `seq` needs the network / is here */
  acked(seq) { Atomics.store(this.ack, seq & (DONE - 1), seq); Atomics.add(this.h, H.sig, 1); Atomics.notify(this.h, H.sig); }
  finished(seq) { Atomics.store(this.done, seq & (DONE - 1), seq); Atomics.add(this.h, H.sig, 1); Atomics.notify(this.h, H.sig); }
  /** (reader) */
  isDone(seq) { return Atomics.load(this.done, seq & (DONE - 1)) === seq; }
  isAcked(seq) { return Atomics.load(this.ack, seq & (DONE - 1)) === seq; }
  /** (reader) waits up to `ms` for the asynchronous read `seq` to be here or to need the network: 'done', 'net' or 'late' */
  settle(seq, ms) {
    const t0 = performance.now();
    for (;;) {
      const v = Atomics.load(this.h, H.sig);
      if (this.isDone(seq)) return 'done';
      if (this.isAcked(seq)) return 'net';
      const left = ms - (performance.now() - t0);
      if (left <= 0) return 'late';
      Atomics.wait(this.h, H.sig, v, left);
    }
  }
  /** (writer) the synchronous read `gen` answered: `n` bytes in the answer buffer, -1 failed */
  answer(gen, n) { Atomics.store(this.h, H.ansN, n); Atomics.store(this.h, H.ans, gen); Atomics.notify(this.h, H.ans); }
  /** (reader) the synchronous read `gen`'s answer (bytes, -1 failed) once here; null after `ms` */
  waitAnswer(gen, ms) {
    const v = Atomics.load(this.h, H.ans);
    if (v === gen) return Atomics.load(this.h, H.ansN);
    Atomics.wait(this.h, H.ans, v, ms);
    return Atomics.load(this.h, H.ans) === gen ? Atomics.load(this.h, H.ansN) : null;
  }
  /** (reader) the signal word (read before looking at done / ack: waitSignal on it misses no signal) */
  get signal() { return Atomics.load(this.h, H.sig); }
  /** (reader) Atomics.waitAsync until the signal word is no longer `v` (`{ async, value }`: a promise when it waits) */
  waitSignal(v, ms) { return Atomics.waitAsync(this.h, H.sig, v, ms); }
  /** (writer) alive; `rx` bytes received from the link so far and its rate `bw` (bytes/s), for a reader that waits long */
  beat(rx = 0, bw = 0) { Atomics.store(this.h, H.rxKiB, Math.min(0x7fffffff, Math.round(rx / 1024))); Atomics.store(this.h, H.bw, Math.min(0x7fffffff, Math.round(bw) || 0)); Atomics.add(this.h, H.beat, 1); }
  get beats() { return Atomics.load(this.h, H.beat); }
  get rx() { return Atomics.load(this.h, H.rxKiB) * 1024; }
  get bw() { return Atomics.load(this.h, H.bw); }
}
