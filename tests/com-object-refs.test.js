// COM objects share one class (src/win32/com.js ComObject): the reference count lives in guest memory, read and written
// through accessors on the prototype. Guest-side changes (the JIT's AddRef / Release fast path writes the word directly)
// are seen by JavaScript and the other way round; objects never share state; dispose runs at the last release only.
// StateTable.watchKeys: a group's counter moves at every set of a watched key and only then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { Com } from '../src/win32/com.js';
import { StateTable } from '../src/win32/state-table.js';

function env() {
  const mem = new GuestMemory({ sizeBytes: 16 << 20 });
  let top = 0x100000; const freed = [];
  const processHeap = { alloc: (n) => { const a = top; top += (n + 15) & ~15; return a; }, free_: (p) => freed.push(p) };
  const proc = { mem, processHeap, symbolize: () => '?' };
  const defs = new Map(); let nextThunk = 0x7000;
  const api = { lookup: (dll, n) => defs.get(n), define: (dll, d) => { for (const k of Object.keys(d)) defs.set(k, d[k]); }, thunkFor: () => (nextThunk += 4) };
  const vm = { mem, api, warn() {}, log() {}, logFn() {} };
  const com = new Com(vm);
  com.interface('ITest', '11111111-2222-3333-4444-555555555555', 'IUnknown', [['Foo', 1]]);
  return { mem, com, proc, freed };
}

test('COM objects: the reference count is the guest word, through prototype accessors; objects independent', () => {
  const { mem, com, proc, freed } = env();
  const destroyed = [];
  const objs = [];
  for (let i = 0; i < 50; i++) {
    const impl = { destroy: () => destroyed.push(i) };
    const ptr = com.create(proc, 'ITest', impl);
    const o = com.objectAt(ptr);
    assert.equal(o.refs, 1); assert.equal(o.ptr, ptr); assert.equal(impl.comObject, o);
    assert.ok(!Object.getOwnPropertyDescriptor(o, 'refs'), 'refs is not an own property (one shape for every object)');
    objs.push({ ptr, o, impl, n: 1 });
  }
  assert.equal(new Set(objs.map((x) => Object.getPrototypeOf(x.o))).size, 1);
  let s = 7; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) + 0x3c6ef372) >>> 0; return s % n; };
  for (let step = 0; step < 5000; step++) {
    const live = objs.filter((x) => x.n > 0); if (!live.length) break;
    const x = live[rnd(live.length)], r = rnd(4);
    if (r === 0) { x.n++; assert.equal(com.addRef(x.o), x.n); }
    else if (r === 1) { x.n++; mem.write32(x.ptr + 16, x.n); } // (the guest's fast path: the count word written directly)
    else if (r === 2 && x.n > 1) { x.n--; mem.write32(x.ptr + 16, x.n); }
    else { x.n--; assert.equal(com.release(x.o), x.n); }
    for (const y of objs) if (y.n > 0) { assert.equal(y.o.refs, y.n); assert.equal(mem.read32(y.ptr + 16), y.n); }
    if (x.n === 0) { assert.equal(com.objectAt(x.ptr), null); assert.ok(freed.includes(x.ptr)); }
  }
  assert.equal(destroyed.length, objs.filter((x) => x.n === 0).length);
  // (a count stored past 2^31 reads back signed, as before: `| 0`)
  const live = objs.find((x) => x.n > 0);
  if (live) { live.o.refs = 0x80000001; assert.equal(mem.read32(live.ptr + 16), 0x80000001); assert.equal(live.o.refs, -0x7fffffff); }
});

test('StateTable.watchKeys: a group counter moves at every set of one of its keys, only then', () => {
  const t = new StateTable(256);
  t.set(7, 1); // (before watching: not counted)
  t.watchKeys(0, [7, 8, 300, -1]); t.watchKeys(3, [8, 9]);
  assert.equal(t.wv[0], 0); assert.equal(t.wv[3], 0);
  const exp = new Uint32Array(8);
  let s = 3; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s % n; };
  for (let i = 0; i < 10000; i++) {
    const k = [7, 8, 9, 10, 255, 300, -1][rnd(7)];
    t.set(k, rnd(3)); // (a set of the same value counts too: the consumer re-derives, it does not miss a change)
    if (k === 7 || k === 8) exp[0]++;
    if (k === 8 || k === 9) exp[3]++;
    assert.deepEqual([...t.wv], [...exp]);
  }
});
