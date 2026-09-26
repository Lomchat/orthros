// Address space allocator: first fit from the bottom is kept with the free-granule hint (holes left by releases are
// reused, a hole too small is skipped and found again for a smaller request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VMem } from '../src/win32/vmem.js';

test('first fit with the free hint: holes reused after release, small holes kept for small requests', () => {
  const vm = new VMem();
  const G = 0x10000;
  const a = vm.alloc(G), b = vm.alloc(3 * G), c = vm.alloc(G), d = vm.alloc(G);
  assert.equal(b, a + G); assert.equal(c, b + 3 * G); assert.equal(d, c + G);
  assert.ok(vm.release(b));
  const e = vm.alloc(4 * G); // does not fit in the 3-granule hole
  assert.equal(e, d + G);
  const f = vm.alloc(2 * G); // fits in the hole
  assert.equal(f, b);
  const g = vm.alloc(G); // the rest of the hole
  assert.equal(g, b + 2 * G);
  const h = vm.alloc(G); // after everything
  assert.equal(h, e + 4 * G);
  assert.ok(vm.release(a));
  assert.equal(vm.alloc(G), a, 'the lowest hole again');
});
