// Library kernels (src/cpu/jit/libkernels.js): each kernel against the reference interpreter running the library's own
// code, on randomized inputs — the argument (integers, fractions, signed zeros, denormals, huge values, infinities,
// NaNs), the x87 control word (any 16-bit value: rounding, precision, unmasked exceptions), status word, stack top, tags
// (stacks a push would overflow) and physical registers, the general registers and flags, the library's feature flag
// and control-word constant — with the DLL at its preferred base and relocated, with and without chaining. Every
// register, the materialized flags, the whole x87 state, the stack around the frame, the library's data and the
// instructions charged compared; the kernel taken exactly when its path applies (else the exact way: EXIT_STEP).
// Also: a write to the code the kernel depends on drops it (and the changed code is not recognised again); code
// outside a library (opts.libScope) is never recognised. Needs the C runtime's DLL from a game folder (skipped without).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { PeImage, mapImage } from '../src/loader/pe.js';
import { LIB_KERNELS } from '../src/cpu/jit/libkernels.js';
import { depth } from './depth.js';

const root = new URL('..', import.meta.url).pathname;
const DLL = [process.env.ORTHROS_MSVCR71, ...['rotwk', 'bfme2', 'bfme1'].flatMap((g) => [`${root}data/games/${g}/base/msvcr71.dll`, `/srv/orthros/data/games/${g}/base/msvcr71.dll`])].find((f) => f && fs.existsSync(f));
const skip = !DLL && 'msvcr71.dll not found (a game folder under data/games, or ORTHROS_MSVCR71)';

const STACK = 0x00200000, RET = 0x00300000;
let seed = 0x5eed;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const r32 = () => ((rnd(0x10000) << 16) | rnd(0x10000)) >>> 0;
const f64bits = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return [b.getUint32(0, true), b.getUint32(4, true)]; };

/** an argument: [low word, high word] */
function arg() {
  const k = rnd(12);
  const pick = (l) => l[rnd(l.length)];
  switch (k) {
    case 0: return f64bits(rnd(2000) - 1000); // integers
    case 1: return f64bits((rnd(20000) - 10000) / 8); // halves, quarters...
    case 2: return f64bits(pick([0, -0, 0.5, -0.5, 1.5, -1.5, 2 ** 52 + 0.5, 2 ** 52, -(2 ** 53), 4503599627370495.5, 1e300, -1e-300, 5e-324, -5e-324, 2.2250738585072014e-308]));
    case 3: return [rnd(4) ? 0 : r32(), pick([0x7ff00000, 0xfff00000, 0x7ff80000, 0xfff80000, 0x7ff00001, 0x7ff40000])]; // infinities, NaNs
    case 4: return [r32(), r32() & 0x800fffff]; // denormals
    default: return f64bits((rnd(2000001) / 1e6 - 1) * 2 ** (rnd(80) - 20));
  }
}

function machine(img, base, jitOpts) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  const vmem = { isFree: () => true, reserve: (size, b) => b, commit() {}, protect() {} };
  const mod = mapImage(img, mem, vmem, { name: 'msvcr71.dll', path: DLL, preferredBase: base });
  const jit = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  if (jit) jit.cpu = cpu;
  return { mem, cpu, I, mod, jit };
}

/** the case's machine state (the same in both machines) */
function setup(M, entry, c) {
  const { mem, cpu } = M;
  cpu.reset();
  mem.fill(STACK - 0x2000, 0x3000, 0);
  for (let i = 0; i < 0x200; i += 4) mem.write32(c.esp - 0x100 + i, c.garbage[i >> 2]);
  mem.write32(c.esp, RET); mem.write32(c.esp + 4, c.x[0]); mem.write32(c.esp + 8, c.x[1]);
  c.regs.forEach((v, i) => cpu.setReg(i, v)); cpu.esp = c.esp; cpu.eip = entry;
  cpu.eflags = c.eflags;
  mem.write16(cpu.base + ST.FPU_CW, c.cw); mem.write16(cpu.base + ST.FPU_SW, c.sw); mem.write16(cpu.base + ST.FPU_TW, c.tw); mem.write8(cpu.base + ST.FPU_TOP, c.top);
  c.fpr.forEach((v, i) => { mem.write32(cpu.base + ST.FPR + 8 * i, v[0]); mem.write32(cpu.base + ST.FPR + 8 * i + 4, v[1]); });
  mem.write32(c.sse2Addr, c.sse2); mem.write32(c.cwgAddr, c.cwg);
}
function snapshot(M, c, data) {
  const { mem, cpu } = M;
  return {
    regs: Array.from({ length: 8 }, (_, i) => cpu.reg(i)), eip: cpu.eip, eflags: cpu.eflags & 0x8d5,
    x87: [ST.FPU_CW, ST.FPU_SW, ST.FPU_TW].map((o) => mem.read16(cpu.base + o)).concat(mem.read8(cpu.base + ST.FPU_TOP)),
    fpr: Array.from(mem.u8.subarray(cpu.base + ST.FPR, cpu.base + ST.FPR + 64)),
    stack: Buffer.from(mem.u8.subarray(c.esp - 0x100, c.esp + 0x100)).toString('hex'),
    data: Buffer.from(mem.u8.subarray(data[0], data[1])).toString('base64'),
  };
}

test('library kernels: floor, ceil, fabs against the interpreter running msvcr71', { skip }, () => {
  const img = new PeImage(new Uint8Array(fs.readFileSync(DLL)));
  const dataSec = img.sections.find((s) => s.name === '.data');
  const n = depth(800, 100);
  for (const [base, jitOpts] of [[img.imageBase, {}], [0x10000000, { chain: false }]]) {
    // A the interpreter, B the JIT with the kernels, D without (the reference off the kernels' paths: what the JIT did)
    const A = machine(img, base, null), B = machine(img, base, jitOpts), D = machine(img, base, { ...jitOpts, libKernels: false });
    const data = [B.mod.base + dataSec.rva, B.mod.base + dataSec.rva + dataSec.virtualSize];
    for (const def of LIB_KERNELS) {
      const [, fn] = def.name.split('!');
      const entry = B.mod.exports.get(fn);
      assert.ok(entry !== undefined, fn);
      const k = def.k, sse2Addr = k.sse2 !== undefined ? entry + k.sse2 : data[0] + 0x100, cwgAddr = k.cwg !== undefined ? entry + k.cwg : data[0] + 0x104;
      const cwg0 = A.mem.read32(cwgAddr);
      let expectFallbacks = 0, fallbacks0 = B.jit.stats.libFallbacks;
      for (let i = 0; i < n; i++) {
        const top = rnd(8), below = (1 << ((top - 1) & 7)) | (1 << ((top - 2) & 7)); // (the registers the code pushes into)
        const c = {
          x: arg(), esp: STACK - 0x400 + 4 * rnd(64), regs: Array.from({ length: 8 }, r32), eflags: (r32() & 0x8d5) | 2,
          cw: rnd(3) ? (0x27f | (rnd(4) << 10) | (rnd(2) ? 0 : 0x300)) & ~(rnd(4) ? 0 : 0x20) : rnd(0x10000), sw: r32() & 0xc7ff, top,
          tw: rnd(6) ? r32() & 0xff & ~below : r32() & 0xff, fpr: Array.from({ length: 8 }, () => [r32(), r32()]), garbage: Array.from({ length: 0x80 }, r32),
          sse2: rnd(10) ? 0 : 1, sse2Addr, cwg: rnd(10) ? cwg0 : rnd(2) ? 0x133f : r32() & 0xffff, cwgAddr,
        };
        setup(A, entry, c); setup(B, entry, c); setup(D, entry, c);
        const ra = A.I.run({ stopAt: RET, maxInsns: 20000 }); const na = 20000 - A.I.remaining() - 1;
        const rb = B.jit.run({ stopAt: RET, maxInsns: 20000 }); const nb = 20000 - B.jit.remaining();
        const rd = D.jit.run({ stopAt: RET, maxInsns: 20000 }); const nd = 20000 - D.jit.remaining();
        const what = `${def.name} @${base.toString(16)} case ${i}: ${JSON.stringify({ ...c, garbage: undefined, fpr: undefined })}`;
        const sb = snapshot(B, c, data);
        assert.equal(rb, rd, what); assert.deepEqual(sb, snapshot(D, c, data), what); assert.equal(nb, nd, `${what}: instructions`);
        // the path the kernel takes (else the exact way)
        const hi = c.x[1], finite = (hi & 0x7ff00000) !== 0x7ff00000;
        const t = c.top, pushes = def.kind === 'round' ? 2 : 1;
        let free = true; for (let p = 1; p <= pushes; p++) if (c.tw & (1 << ((t - p) & 7))) free = false;
        let path = finite && free;
        if (def.kind === 'round') {
          const lo = c.x[0], dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, lo, true); dv.setUint32(4, hi, true);
          const x = dv.getFloat64(0, true), r = k.rc === 1 ? Math.floor(x) : Math.ceil(x);
          path = path && c.sse2 === 0 && (c.cwg & 0xc00) === (k.rc << 10) && (r === x || (c.cw & 0x20) !== 0);
        }
        if (!path) { expectFallbacks++; continue; }
        assert.equal(rb, ra, what); assert.deepEqual(sb, snapshot(A, c, data), what); assert.equal(nb, na, `${what}: instructions`);
      }
      assert.ok(B.jit.libLive?.has(entry), `${def.name}: recognised`);
      assert.equal(B.jit.stats.libFallbacks - fallbacks0, expectFallbacks, `${def.name}: kernel taken exactly on its path`);
      assert.ok(expectFallbacks < 0.7 * n, `${def.name}: enough cases take the kernel path (${expectFallbacks} of ${n} off it)`);
    }
    // a write to the code a kernel depends on drops it; the changed code is not recognised again and runs translated
    const def = LIB_KERNELS[0], entry = B.mod.exports.get(def.name.split('!')[1]);
    const at = entry + def.ranges[1][0] + 0x42; // (in the error path: the result of the common path stays the same)
    for (const M of [A, B, D]) M.mem.write8(at, M.mem.read8(at) ^ 0x10);
    B.jit.invalidate(at, 1);
    assert.ok(!B.jit.libLive.has(entry), 'dropped');
    const c = { x: f64bits(-2.5), esp: STACK - 0x400, regs: Array(8).fill(0x11223344), eflags: 2, cw: 0x27f, sw: 0, top: 0, tw: 0, fpr: Array(8).fill([0, 0]), garbage: Array(0x80).fill(0), sse2: 0, sse2Addr: entry + def.k.sse2, cwg: A.mem.read32(entry + def.k.cwg), cwgAddr: entry + def.k.cwg };
    setup(A, entry, c); setup(B, entry, c);
    A.I.run({ stopAt: RET, maxInsns: 100000 }); B.jit.run({ stopAt: RET, maxInsns: 100000 });
    assert.deepEqual(snapshot(B, c, data), snapshot(A, c, data));
    assert.ok(!B.jit.libLive.has(entry), 'changed code not recognised');
  }
  // never outside a library
  const C = machine(img, img.imageBase, { libScope: () => false }), entry = C.mod.exports.get('floor');
  C.cpu.esp = STACK - 0x400; C.mem.write32(C.cpu.esp, RET); C.cpu.eip = entry;
  C.jit.run({ stopAt: RET, maxInsns: 100000 });
  assert.ok(!C.jit.libLive?.size, 'not recognised outside a library');
});
