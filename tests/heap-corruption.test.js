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
