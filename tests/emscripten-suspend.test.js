// An Emscripten engine without JSPI made to suspend while it waits for its files (src/vfs/emscripten-suspend.js): a
// small engine built here, with Emscripten's import names, its main loop's iteration calling through invoke_vi (the
// setjmp trampoline JSPI could not suspend through as JavaScript): a read whose bytes are not here suspends the
// iteration (the page's calls and the next iterations put off until it is done), a longjmp through the trampoline is
// caught as Emscripten's own (stack restored, setThrew), anything else thrown reaches the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canSuspend, suspendingEngine } from '../src/vfs/emscripten-suspend.js';

const uleb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const str = (s) => [...uleb(s.length), ...Buffer.from(s)];
const vec = (a) => [...uleb(a.length), ...a.flat()];
const sec = (id, a) => { const b = vec(a); return [id, ...uleb(b.length), ...b]; };
const fn = (body) => { const b = [0x00, ...body, 0x0b]; return [...uleb(b.length), ...b]; };
const I = 0x7f, ft = (p, r) => [0x60, ...vec(p.map((t) => [t])), ...vec(r.map((t) => [t]))];

/** The engine: imports invoke_vi, fd_read, a longjmp, a JavaScript throw, set_main_loop_arg; table [1] read, [2] longjmp, [3] throw, [4] the iteration. */
function engine() {
  const types = [ft([I], []), ft([I, I], []), ft([I, I, I, I], [I]), ft([], [])];
  const imports = [
    [...str('env'), ...str('invoke_vi'), 0x00, 1], [...str('wasi_snapshot_preview1'), ...str('fd_read'), 0x00, 2],
    [...str('env'), ...str('_emscripten_throw_longjmp'), 0x00, 3], [...str('env'), ...str('oops'), 0x00, 3],
    [...str('env'), ...str('emscripten_set_main_loop_arg'), 0x00, 2],
  ];
  const funcs = [1, 0, 0, 0, 0, 3]; // setThrew, read, jump, oops, iterate, start (indices 5…10)
  const globals = [[I, 0x01, 0x41, ...uleb(1000), 0x0b], [I, 0x01, 0x41, 0x00, 0x0b], [I, 0x01, 0x41, 0x00, 0x0b]]; // sp, threw, got
  const exports = [[...str('memory'), 0x02, 0], [...str('__indirect_function_table'), 0x01, 0], [...str('__stack_pointer'), 0x03, 0],
    [...str('setThrew'), 0x00, 5], [...str('threw'), 0x03, 1], [...str('got'), 0x03, 2], [...str('start'), 0x00, 10]];
  const sp = (n) => [0x41, ...uleb(n), 0x24, 0x00];
  const bodies = [
    fn([0x20, 0x00, 0x24, 0x01]), // setThrew(a, b): threw = a
    fn([...sp(512), 0x20, 0x00, 0x41, 16, 0x41, 1, 0x41, 32, 0x10, 1, 0x24, 0x02]), // got = fd_read(fd, iov 16, 1, 32)
    fn([...sp(256), 0x10, 2]), // longjmp
    fn([0x10, 3]), // a JavaScript exception
    fn([0x20, 0x00, 0x41, 5, 0x10, 0]), // iterate(which): invoke_vi(which, 5) — fd 5 for the read
    fn([0x41, 4, 0x41, 1, 0x41, 0, 0x41, 1, 0x10, 4, 0x1a]), // set_main_loop_arg(4, 1, 0, 1)
  ];
  return new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, types), ...sec(2, imports), ...sec(3, funcs.map((t) => [t])),
    ...sec(4, [[0x70, 0x00, 8]]), ...sec(5, [[0x00, 1]]), ...sec(6, globals), ...sec(7, exports),
    ...sec(9, [[0x00, 0x41, 1, 0x0b, ...vec([[6], [7], [8], [9]])]]), ...sec(10, bodies)]));
}

test('a read waiting for its bytes suspends the iteration; longjmp caught as Emscripten does; other throws reach the page', { skip: !canSuspend() && 'no JSPI here' }, async () => {
  const reads = [], errors = [], loops = [];
  let wait = null;
  const stream = { position: 7, node: { orthrosStreamed: { soon: (pos, len) => { reads.push(['soon', pos, len]); return wait; } } } };
  const env = {
    invoke_vi: () => { throw new Error('the JavaScript trampoline'); },
    fd_read: (fd, iov, n, pnum) => { reads.push(['read', fd]); return 42; },
    _emscripten_throw_longjmp: () => { throw Infinity; },
    oops: () => { throw 'boom'; },
    emscripten_set_main_loop_arg: (func, arg) => { loops.push([func, arg]); return 0; },
  };
  const s = suspendingEngine({ wasm: engine(), fs: () => ({ getStream: (fd) => (fd === 5 ? stream : null) }), onError: (e) => errors.push(e), spinMs: 0 });
  const instance = await new Promise((resolve) => s.instantiateWasm({ env, wasi_snapshot_preview1: env }, resolve));
  assert.equal(s.stats.linked, true);
  const x = instance.exports;
  new Uint32Array(x.memory.buffer).set([0, 100], 4); // (the iovec at 16: 100 bytes)
  x.start();
  assert.deepEqual(loops, [[4, 1]]);
  const iterate = () => x.__indirect_function_table.get(loops[0][0]); // (as Emscripten's main loop looks it up)

  // (a read whose bytes are not here: suspended; the next iteration skipped, the page's call put off)
  let land; wait = new Promise((r) => { land = r; });
  iterate()(1);
  assert.equal(s.waiting, true);
  assert.deepEqual(reads, [['soon', 7, 100]]);
  iterate()(1);
  let called = false; s.call(() => { called = true; });
  assert.equal(called, false);
  land(); await s.idle();
  assert.deepEqual(reads, [['soon', 7, 100], ['read', 5]]);
  assert.equal(x.got.value, 42);
  assert.equal(called, true);
  assert.deepEqual([s.stats.suspensions, s.stats.skipped, s.stats.deferred], [1, 1, 1]);

  // (after it, a call of the page's into the engine that reads — no iteration under way —: read at once, the bytes
  // missing or not; suspending there would throw — the page's first run, 2026-11-18)
  wait = new Promise(() => {}); x.got.value = 0; x.__indirect_function_table.get(1)(5);
  assert.equal(x.got.value, 42);

  // (bytes here: read at once, nothing suspended)
  wait = null; x.got.value = 0; iterate()(1); await s.idle();
  assert.equal(x.got.value, 42); assert.equal(s.stats.suspensions, 1);

  // (a longjmp through the trampoline: the stack pointer as at its call, setThrew(1, 0), the iteration goes on)
  x.__stack_pointer.value = 1000;
  iterate()(2); await s.idle();
  assert.deepEqual([x.threw.value, x.__stack_pointer.value, errors.length], [1, 1000, 0]);

  // (anything else thrown through it: the page's error)
  iterate()(3); await s.idle(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(errors, ['boom']);

  // (an iteration that held the page's thread breathMs: a turn for the page at its next read, its bytes here — once)
  const t = suspendingEngine({ wasm: engine(), fs: () => ({ getStream: () => stream }), spinMs: 0, breathMs: 1e-6 });
  const y = (await new Promise((resolve) => t.instantiateWasm({ env, wasi_snapshot_preview1: env }, resolve))).exports;
  new Uint32Array(y.memory.buffer).set([0, 100], 4); y.start();
  y.__indirect_function_table.get(loops[1][0])(1);
  assert.equal(t.waiting, true);
  await t.idle();
  assert.deepEqual([y.got.value, t.stats.breaths, t.stats.suspensions], [42, 1, 0]);
});
