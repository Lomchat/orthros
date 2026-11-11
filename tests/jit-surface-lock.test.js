// IDirect3DSurface8/9::LockRect / UnlockRect on the dispatcher's fast path (runtime.js FID_SURF_LOCK / FID_SURF_UNLOCK):
// a random sequence of locks and unlocks of texture levels — rectangles inside, across and outside the surface, null
// outputs, double locks, unlocks of unlocked surfaces, read-only locks, DXT and plain formats — run by translated code
// with the fast path (its queued unlocks replayed in order as Vm.drainDeferred does), against the same calls made to
// the JavaScript handlers alone: the same results, pointers and pitches, and, wherever JavaScript looks (a call it
// handles), the same lock state, dirty flags and dirty rectangles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { COM_MARKER, DEFER_QUEUE } from '../src/cpu/jit/runtime.js';
import { d3dEnv } from './d3d-random.js';
import { depth } from './depth.js';

const CODE = 0x2000000, SLOTS = 0x2010000, THUNK_SIZE = 16, LOCK = 9, UNLOCK = 10, LOOK = 11;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];
const call = (idx) => [0xff, 0x15, ...le(SLOTS + 4 * idx)];
const storeEax = (a) => [0xa3, ...le(a)];

/** a device with a few textures; their level surfaces (COM pointers) */
function setup() {
  const E = d3dEnv(null, false, null), { mem, ctx, com } = E;
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const surfaces = [];
  for (const [w, h, fmt, pool] of [[64, 32, 21, 1], [32, 32, 0x31545844, 1], [17, 9, 23, 2], [16, 16, 0x35545844, 1]]) {
    assert.equal(dev.CreateTexture(ctx([devPtr, w, h, 2, 0, fmt, pool, out, 0])), 0);
    const tex = mem.read32(out), t = com.implAt(tex);
    for (let l = 0; l < 2; l++) { assert.equal(t.GetSurfaceLevel(ctx([tex, l, out])), 0); const p = mem.read32(out); mem.write32(p + 4, COM_MARKER); surfaces.push(p); }
  }
  return { E, surfaces };
}

test('surface locks: the fast path does what the JavaScript handlers do', () => {
  for (let seed = 1; seed <= depth(24, 4); seed++) {
    let s = seed; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; return (s >>> 0) % n; };
    const A = setup(), B = setup(); // (A: JavaScript alone; B: translated code with the fast path)
    const scratchA = A.E.alloc(0x4000), scratchB = B.E.alloc(0x4000);
    assert.equal(scratchA, scratchB);
    const outs = scratchA, rects = scratchA + 0x1000, results = scratchA + 0x3000;
    // the program: [kind, surface index, args...]
    const ops = []; let prev = 0;
    for (let i = 0; i < 160; i++) {
      const k = rnd(10), si = i && rnd(2) ? prev : rnd(A.surfaces.length); prev = si; // (often the same surface again)
      if (k < 4) {
        const sp = A.E.com.implAt(A.surfaces[si]), w = sp.width, h = sp.height;
        const rk = rnd(6), r = rk === 0 ? null : rk === 1 ? [-2, 0, 4, 4] : rk === 2 ? [0, 0, w + 4, h] : [rnd(w), rnd(h), 0, 0];
        if (r && rk >= 3) { r[2] = r[0] + 1 + rnd(w - r[0]); r[3] = r[1] + 1 + rnd(h - r[1]); }
        ops.push(['lock', si, rnd(12) === 0 ? 0 : outs + 8 * ops.length, r, rnd(4) === 0 ? 0x10 : rnd(3) === 0 ? 0x2000 : 0]);
        if (rnd(3)) ops.push(['unlock', si]); // (mostly a pair: a run of them on one surface between two looks)
      } else if (k < 8) ops.push(['unlock', si]);
      else if (k === 9) ops.push(['look']);
    }
    ops.push(['look']);
    for (const E of [A.E, B.E]) ops.forEach((o, i) => { if (o[0] === 'lock' && o[3]) o[3].forEach((v, j) => E.mem.write32(rects + 16 * i + 4 * j, v)); });
    // (what JavaScript sees; then the surfaces count as uploaded, as a backend's upload leaves them: each look sees the marks since the last)
    const stateOf = (E, surfaces) => surfaces.map((p) => { const x = E.com.implAt(p), st = [x.locked, x.dirty, JSON.stringify(x.dirtyRect)]; x.dirty = false; return st; });
    // A: the handlers, called directly
    const looksA = [];
    ops.forEach((o, i) => {
      const { mem, com, ctx } = A.E;
      let r = 0;
      if (o[0] === 'lock') r = com.implAt(A.surfaces[o[1]]).LockRect(ctx([A.surfaces[o[1]], o[2], o[3] ? rects + 16 * i : 0, o[4]]));
      else if (o[0] === 'unlock') r = com.implAt(A.surfaces[o[1]]).UnlockRect(ctx([A.surfaces[o[1]]]));
      else looksA.push(stateOf(A.E, A.surfaces));
      mem.write32(results + 4 * i, r >>> 0);
    });
    // B: guest code calling them through thunks, every result stored
    const { mem, com, ctx } = B.E;
    const code = ops.flatMap((o, i) => o[0] === 'lock' ? [...push(o[4]), ...push(o[3] ? rects + 16 * i : 0), ...push(o[2]), ...push(B.surfaces[o[1]]), ...call(LOCK), ...storeEax(results + 4 * i)]
      : o[0] === 'unlock' ? [...push(B.surfaces[o[1]]), ...call(UNLOCK), ...storeEax(results + 4 * i)] : [...call(LOOK), ...storeEax(results + 4 * i)]);
    mem.writeBytes(CODE, Uint8Array.from([...code, 0xf4]));
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    cpu.reset();
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
    jit.cpu = cpu;
    jit.markFast(LOCK, 'com.dll!IDirect3DSurface9::LockRect', true);
    jit.markFast(UNLOCK, 'com.dll!IDirect3DSurface9::UnlockRect', true);
    for (const idx of [LOCK, UNLOCK, LOOK]) mem.write32(SLOTS + 4 * idx, THUNK_BASE + idx * THUNK_SIZE);
    cpu.eip = CODE; cpu.esp = 0x3f09000; cpu.eflags = F.RESERVED1 | F.IF;
    // (Vm.drainDeferred: the queued unlocks replayed, in order)
    const drain = () => {
      const n = mem.read32(DEFER_QUEUE); mem.write32(DEFER_QUEUE, 0); mem.write32(DEFER_QUEUE + 12, 0);
      for (let p = DEFER_QUEUE + 16; p < DEFER_QUEUE + 16 + n; p += 12) { assert.equal(mem.read32(p + 4), 1); const self = mem.read32(p + 8); com.implAt(self).UnlockRect(ctx([self])); }
      return n / 12;
    };
    const looksB = [];
    let r, toJs = 0, queued = 0;
    for (let n = 0; n < 2000; n++) {
      r = jit.run({ maxInsns: 1e7 });
      if (r !== EXIT.THUNK) break;
      queued += drain();
      const idx = cpu.exitArg, sp = cpu.esp, self = mem.read32(sp + 4);
      let res = 0, argc = 0;
      if (idx === LOCK) { argc = 4; res = com.implAt(self).LockRect(ctx([self, mem.read32(sp + 8), mem.read32(sp + 12), mem.read32(sp + 16)])); toJs++; }
      else if (idx === UNLOCK) { argc = 1; res = com.implAt(self).UnlockRect(ctx([self])); toJs++; }
      else looksB.push(stateOf(B.E, B.surfaces));
      cpu.eip = mem.read32(sp); cpu.esp = sp + 4 + 4 * argc; cpu.eax = res >>> 0;
    }
    assert.equal(r, EXIT.HALT);
    assert.equal(cpu.esp, 0x3f09000, 'stdcall returns');
    assert.ok(queued > 0 && toJs < ops.length - looksA.length, `the fast path took part (seed ${seed}: ${queued} queued unlocks, ${toJs} calls in JavaScript)`);
    // the same results, pointers (as offsets from each surface's memory) and pitches
    ops.forEach((o, i) => {
      assert.equal(mem.read32(results + 4 * i), A.E.mem.read32(results + 4 * i), `seed ${seed} op ${i} ${o[0]} result`);
      if (o[0] === 'lock' && o[2] && A.E.mem.read32(results + 4 * i) === 0) {
        const ma = A.E.com.implAt(A.surfaces[o[1]]).mem, mb = com.implAt(B.surfaces[o[1]]).mem;
        assert.equal(mem.read32(o[2]), A.E.mem.read32(o[2]), `seed ${seed} op ${i} pitch`);
        assert.equal(mem.read32(o[2] + 4) - mb, A.E.mem.read32(o[2] + 4) - ma, `seed ${seed} op ${i} pointer`);
      }
    });
    assert.deepEqual(looksB, looksA, `seed ${seed}: the state JavaScript sees`);
  }
});
