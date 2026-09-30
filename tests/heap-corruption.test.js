// A program writing past its block overwrites the next boundary tag (our footer; on Windows, the next header — which
// its heap rarely checks): freeing the blocks around it must neither throw (a footer read as a huge size once sent
// the emulator out of the address space: BFME2 on a player's machine) nor merge blocks through inconsistent tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { VMem } from '../src/win32/vmem.js';
import { Heap } from '../src/win32/heap.js';

test('heap: frees next to an overwritten footer or free-list link stay inside the heap', () => {
  const mem = new GuestMemory();
  const heap = new Heap({ mem, vmem: new VMem() });
  const a = heap.alloc(24), b = heap.alloc(24), c = heap.alloc(24);
  assert.equal(heap.free_(a), true);
  mem.write32(a + 24, (b - 12 + 0x10000000) >>> 0); // (a's footer, 4 bytes past its 24: a size sending b's backward merge past 2 GB)
  assert.equal(heap.free_(b), true, 'the backward merge of b reads the damaged footer');
  mem.write32(b, 0x90000000); mem.write32(b + 4, 0xfffffff8); // (links of a freed block overwritten)
  assert.equal(heap.free_(c), true);
  for (let i = 0; i < 200; i++) assert.ok(heap.alloc(8 + (i % 40)), 'allocations go on');
  assert.equal(heap.free_(0x7ffffff0), false);
});

test('heap: every block 8-aligned (HeapAlloc on Windows), through splits, frees and merges', () => {
  const mem = new GuestMemory();
  const heap = new Heap({ mem, vmem: new VMem() });
  const live = [];
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  for (let i = 0; i < 5000; i++) {
    if (live.length && rnd(3) === 0) { const k = rnd(live.length); assert.equal(heap.free_(live[k]), true); live.splice(k, 1); continue; }
    const p = heap.alloc(1 + rnd(300)); assert.ok(p); assert.equal(p & 7, 0, `block ${p.toString(16)} 8-aligned`); live.push(p);
  }
});

// A block the program keeps writing after freeing it: its free-list link then points anywhere — into another heap, just
// below a thread's stack — where the "size" read is garbage (0xffffffff). Handing that out gave a 2 MiB buffer that ran
// over the main thread's stack (BFME2's first launch, the player's crash). The list is cut there instead.
test('heap: a free-list link overwritten after free never hands out memory outside the heap', () => {
  const mem = new GuestMemory(), vmem = new VMem();
  const other = new Heap({ mem, vmem, tag: 'other' }), heap = new Heap({ mem, vmem, tag: 'user' });
  const victim = other.alloc(64);
  mem.write32(victim - 8, 0xffffffff); // (what the stray link's target reads as a size)
  const a = heap.alloc(4000);
  assert.equal(heap.free_(a), true);
  mem.write32(a, victim); // (the program writes into the freed block: its "next" link now leads into the other heap)
  const inHeap = (p, n) => heap.chunks.some((c) => p >= c.base && p + n <= c.base + c.size);
  for (const n of [4000, 2 << 20, 64]) {
    const p = heap.alloc(n);
    assert.ok(p, `alloc(${n}) succeeds`);
    assert.ok(inHeap(p, n), `alloc(${n}) = ${p.toString(16)} lies inside the heap`);
    assert.notEqual(p, victim);
  }
});
