// Heap chunk lookup (Heap.chunkOf through the granule map) and allocation walk: the same chunk as the linear scan for
// any address, and the same blocks, in the same order, as the linear-scan heap it replaced — free lists overwritten
// by the program included (which block a game gets back decides its reuse patterns, see docs/thread-scheduling.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { VMem } from '../src/win32/vmem.js';
import { Heap } from '../src/win32/heap.js';

const MAGIC_FREE = 0x46524855;
/** seeded 32-bit generator (mulberry32: every bit usable, unlike a power-of-two LCG's low bits) */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
};

/** the heap before the granule map: linear chunk scan, the allocation walk as it was (reads through read32) */
class LinearHeap extends Heap {
  chunkOf(addr) { return this.chunkScan(addr); }
  alloc(size, zero = false) {
    const alignUp = (x, a) => Math.ceil(x / a) * a;
    size = Math.max(16, alignUp(size >>> 0, 8));
    if (size > 0x7fffffff) return 0;
    const m = this.mem;
    const classIndex = (s) => { if (s <= 512) return s >> 3; let c = 65; for (let k = 1024; k < s && c < 127; k <<= 1) c++; return c; };
    const plausible = (p) => p === 0 || (p >= 0x10000 && p < 0x7eb00000 && (p & 7) === 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let c = classIndex(size); c < 128; c++) {
        let b = this.heads[c], prev = 0, mark = b, steps = 0, span = 1;
        while (b) {
          const bs = m.read32(b - 8);
          if (!this.freeBlockOk(b, bs)) { if (prev) m.write32(prev, 0); else this.heads[c] = 0; this.stats.brokenLists = (this.stats.brokenLists ?? 0) + 1; break; }
          if (bs >= size) {
            this.unlink(b, c);
            const rem = bs - size;
            if (rem >= 32) { m.write32(b - 8, size); m.write32(b + size, size); this.setFree(b + size + 16, rem - 16); }
            m.write32(b - 4, 0x4f524855);
            if (zero) m.fill(b, m.read32(b - 8), 0);
            return b;
          }
          prev = b; b = m.read32(b);
          if (!plausible(b)) break;
          // (the cut of a looping list, which the walk did not have: without it such a program never ends)
          if (b === mark) { this.cutLoop(c, mark); break; }
          if (++steps === span) { mark = b; span *= 2; steps = 0; }
        }
      }
      if (!this.grow(size + 48)) return 0;
    }
    return 0;
  }
}

test('heap: chunkOf through the granule map finds the chunk the linear scan finds, for any address', () => {
  const mem = new GuestMemory(), vmem = new VMem(), rnd = rng(11);
  // two heaps growing in turn: their chunks interleave in the address space, some larger than the 1 MB growth
  const a = new Heap({ mem, vmem, tag: 'a' }), b = new Heap({ mem, vmem, tag: 'b' });
  const probe = (h) => {
    const addrs = [-1, -8, 0, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 2 ** 32 + 0x1000, 2 ** 32 + h.chunks[0].base + 64];
    for (const c of [...a.chunks, ...b.chunks]) for (const d of [-16, -8, -1, 0, 1, 8, 16, 23, 24, 25, 0x8000, 0xffff, 0x10000]) addrs.push(c.base + d, c.base + c.size + d - 8, c.base + c.size + d);
    for (let i = 0; i < 20000; i++) addrs.push(rnd() >>> 1, rnd());
    for (const x of addrs) assert.equal(h.chunkOf(x), h.chunkScan(x), `chunkOf(0x${x.toString(16)}) in heap ${h.tag} (${h.chunks.length} chunks)`);
  };
  for (let i = 0; i < 40; i++) {
    for (const h of [a, b]) assert.ok(h.alloc(i % 5 === 0 ? 0x180000 + (rnd() % 0x80000) : 0xa0000 + (rnd() % 0x60000)));
    if (i % 3 === 0) { probe(a); probe(b); }
  }
  assert.ok(a.gmap && b.gmap, 'the granule maps are in use');
  probe(a); probe(b);
  a.destroy();
  assert.equal(a.chunkOf(b.chunks[3].base + 64), null);
  assert.equal(b.chunkOf(b.chunks[3].base + 64), b.chunks[3]);
});

test('heap: chunks sharing a granule (not 64 KB aligned) are found by the scan', () => {
  // (VMem hands out 64 KB granules; a heap given unaligned chunks all the same looks them up correctly)
  const mem = new GuestMemory();
  let next = 0x200000 + 0x8000;
  const vmem = { alloc: (size) => { const p = next; next += size + 0x4000; return p; }, release: () => true };
  const h = new Heap({ mem, vmem }), rnd = rng(5);
  for (let i = 0; i < 30; i++) assert.ok(h.alloc(0xc0000));
  assert.ok(h.gmap);
  for (const c of h.chunks) for (let d = -0x10008; d <= c.size + 0x10008; d += 4) assert.equal(h.chunkOf(c.base + d), h.chunkScan(c.base + d));
  for (let i = 0; i < 20000; i++) { const x = 0x200000 + (rnd() % (next - 0x200000)); assert.equal(h.chunkOf(x), h.chunkScan(x)); }
});

/**
 * The same random program on the heap and on the linear-scan heap, each in its own guest memory: the same results, the
 * same memory, the same free lists. The program frees blocks twice, frees addresses that are no block, writes into
 * freed blocks (links into the other heap, into nothing, implausible; sizes) and past the end of its blocks.
 */
function differential(seed, ops) {
  const run = (HeapClass) => {
    const mem = new GuestMemory(), vmem = new VMem(), rnd = rng(seed);
    const heap = new HeapClass({ mem, vmem, tag: 'user' }), other = new HeapClass({ mem, vmem, tag: 'other' });
    const live = [], freed = [], out = [];
    const pick = (arr) => arr[rnd() % arr.length];
    const recent = (arr) => arr[arr.length - 1 - rnd() % Math.min(arr.length, 12)]; // (blocks likely still free)
    for (let i = 0; i < ops; i++) {
      const r = rnd() % 100, h = rnd() % 4 === 0 ? other : heap;
      if (r < 40 || !live.length) {
        const big = rnd() % 50 === 0, size = big ? 0x40000 + (rnd() % 0x180000) : rnd() % 4 === 0 ? 513 + (rnd() % 6000) : 1 + (rnd() % 600);
        const p = h.alloc(size, rnd() % 3 === 0);
        out.push(p); if (p) live.push([h, p]);
      } else if (r < 75) {
        const k = rnd() % live.length, [lh, p] = live[k];
        live.splice(k, 1); freed.push([lh, p]);
        out.push(lh.free_(p));
      } else if (r < 85) {
        const k = rnd() % live.length, [lh, p] = live[k];
        const n = lh.realloc(p, rnd() % 3000, rnd() % 2 === 0, rnd() % 4 === 0);
        out.push(n); if (n) live[k] = [lh, n];
      } else if (r < 88 && freed.length) {
        const [fh, p] = pick(freed); out.push(fh.free_(p)); // (double free)
      } else if (r < 90) {
        out.push(h.free_((rnd() & 0x7ffffff8) >>> 0), h.size(rnd() >>> 1)); // (no block)
      } else if (r < 93 && freed.length) {
        // writes into a freed block (still free or reused since): its next / prev links or its header's size
        const [, p] = recent(freed), w = rnd() % 9;
        const target = w === 0 && live.length ? pick(live)[1] : w === 1 ? pick(freed)[1] : w === 2 ? 0x90000000 : w === 3 ? (p + 8 + (rnd() % 64) * 8)
          : w === 4 ? rnd() >>> 0 : w === 5 ? rnd() % 0x10000 : w === 6 ? 0x7eb00000 + (rnd() % 0x1000) * 8 : (rnd() & 0x7ffffff8) >>> 0;
        if (w === 8) mem.write32(p - 8, rnd() % 4096); else mem.write32(p + (rnd() % 2) * 4, target);
      } else if (r < 95 && freed.length) {
        // a link to a fake free block (header, magic, footer as the program left them): inside the freed block, or ending
        // at its chunk's end sentinel; with sizes small, unaligned, aligned
        const [fh, p] = recent(freed), ch = fh.chunkScan(p);
        const fs = [8, 12, 20, 36, 4 + 8 * (rnd() % 40), 16 + 8 * (rnd() % 40)][rnd() % 6];
        const q = ch && rnd() % 2 ? ch.base + ch.size - 8 - fs : p + 16 + (rnd() % 8) * 8;
        if (q + fs < 0x7f000000) {
          mem.write32(q - 8, fs); mem.write32(q - 4, rnd() % 5 ? MAGIC_FREE : 0x4f524855); mem.write32(q + fs, rnd() % 5 ? fs : fs + 8);
          mem.write32(p, q);
        }
      } else if (live.length) {
        // writes past the end of a live block: its footer, the next block's header
        const [lh, p] = pick(live), s = lh.size(p);
        if (s >= 0 && p + s < 0x7f000000) mem.write32(p + s + (rnd() % 4) * 4, rnd() % 3 === 0 ? MAGIC_FREE : rnd() % 512);
      }
    }
    const blocks = [];
    for (const h of [heap, other]) { h.walk((u, s, used) => blocks.push(u, s, used)); }
    const chunks = [heap, other].map((h) => h.chunks.map((c) => [c.base, c.size]));
    const stats = [heap, other].map((h) => JSON.stringify(h.stats));
    const heads = [heap, other].map((h) => Array.from(h.heads));
    return { mem, out, blocks, chunks, stats, heads, maps: [heap.gmap !== null, other.gmap !== null] };
  };
  const x = run(Heap), y = run(LinearHeap);
  assert.deepEqual(x.out, y.out, 'same results');
  assert.deepEqual(x.chunks, y.chunks, 'same chunks');
  assert.deepEqual(x.heads, y.heads, 'same free-list heads');
  assert.deepEqual(x.stats, y.stats, 'same counters (lists cut, boundary tags)');
  assert.deepEqual(x.blocks, y.blocks, 'same blocks');
  for (const cs of x.chunks) for (const [base, size] of cs) assert.equal(Buffer.compare(x.mem.bytes(base, size), y.mem.bytes(base, size)), 0, `chunk ${base.toString(16)} same bytes`);
  return x;
}

test('heap: allocations, frees and reallocations identical to the linear-scan heap (random programs, damaged lists)', () => {
  let maps = 0, cut = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const x = differential(seed, 6000);
    maps += x.maps.filter(Boolean).length;
    cut += x.stats.filter((s) => s.includes('brokenLists')).length;
  }
  assert.ok(maps >= 6, `the granule map took over in the grown heaps (${maps})`);
  assert.ok(cut >= 3, `damaged lists were met and cut (${cut})`);
});
