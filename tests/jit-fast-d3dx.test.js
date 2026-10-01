// Pure D3DX math on the dispatcher's WASM fast path (fast-d3dx.js): D3DXMatrixInverse and D3DXVec{2,3,4}CatmullRom
// give the JavaScript handlers' results bit for bit (outputs, determinant, return value, untouched output of a singular
// matrix, outputs aliasing inputs; a NaN's sign and payload aside), without leaving the translated code; the cofactor table is the handler's own text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { defineD3DXMath } from '../src/win32/d3dx9-math.js';
import { d3dxFastId } from '../src/cpu/jit/fast-d3dx.js';

const CODE = 0x20000000, SLOTS = 0x10000100, DATA = 0x10002000, OUTEAX = 0x10001000, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const NAMES = ['D3DXMatrixInverse', 'D3DXVec2CatmullRom', 'D3DXVec3CatmullRom', 'D3DXVec4CatmullRom'];
const ARGC = [3, 6, 6, 6];

const ARGS = 0x10000800;
const envs = new Map();
/** one translated program per function: push its arguments (from ARGS) right to left, call [slot], store eax, hlt */
function env(name) {
  let e = envs.get(name);
  if (e) return e;
  const k = NAMES.indexOf(name), prog = [];
  for (let i = ARGC[k] - 1; i >= 0; i--) prog.push(0xff, 0x35, ...le(ARGS + 4 * i));
  prog.push(0xff, 0x15, ...le(SLOTS + 4 * k), 0xa3, ...le(OUTEAX), 0xf4);
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, Uint8Array.from(prog));
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, now: () => 0 });
  jit.cpu = cpu;
  NAMES.forEach((n, i) => { jit.markFast(i + 1, `d3dx9_27.dll!${n}`, true); mem.write32(SLOTS + 4 * i, THUNK_BASE + (i + 1) * THUNK_SIZE); });
  const ref = new GuestMemory({ sizeBytes: 1 << 29 });
  const X = {}; defineD3DXMath(X, ref);
  envs.set(name, (e = { k, mem, cpu, jit, ref, X }));
  return e;
}
/** run NAME(args) translated (fast path) and through the JavaScript handler, on the same initial data */
function both(name, args, init, dataBytes = 0x400) {
  const { k, mem, cpu, jit, ref, X } = env(name);
  mem.fill(DATA, dataBytes, 0); init(mem);
  args.forEach((a, i) => mem.write32(ARGS + 4 * i, a));
  cpu.eip = CODE; cpu.esp = 0x10009000; cpu.eflags = F.RESERVED1 | F.IF;
  assert.equal(jit.run({ maxInsns: 1e6 }), EXIT.HALT, `${name}: no exit to JavaScript`);
  assert.equal(cpu.esp, 0x10009000, 'stdcall returns');
  const fast = { eax: mem.read32(OUTEAX), data: mem.bytes(DATA, dataBytes).slice() };
  // reference: the handler
  ref.fill(DATA, dataBytes, 0); init(ref);
  const u32 = new Uint32Array(1), f32 = new Float32Array(u32.buffer);
  assert.equal(X[name][0], ARGC[k]);
  const r = X[name][1]({ arg: (i) => args[i] >>> 0, argF32: (i) => { u32[0] = args[i]; return f32[0]; } });
  return { fast, ref: { eax: (r ?? 0) >>> 0, data: ref.bytes(DATA, dataBytes).slice() } };
}

const f32bits = (v) => { const b = new Float32Array([v]); return new Uint32Array(b.buffer)[0]; };
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
const value = () => { const r = rnd(); if (r < 0.05) return 0; if (r < 0.08) return -0; if (r < 0.1) return 1; if (r < 0.12) return [Infinity, -Infinity, NaN, 1e-40, 3e38][Math.floor(rnd() * 5)]; return (rnd() - 0.5) * 10 ** Math.floor(rnd() * 8 - 3); };
const writeF = (mem, a, vals) => vals.forEach((v, i) => mem.writeF32(a + 4 * i, v));
/**
 * Memory as 32-bit words, every f32 NaN as one value: the sign and payload of a NaN an operation produces depend on the
 * operand order the engine's compiler picks (the JavaScript handler itself gives either sign, interpreted or optimized).
 */
const words = (bytes) => Array.from(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2), (w) => ((w & 0x7f800000) === 0x7f800000 && (w & 0x7fffff) ? 'NaN' : w));

test('the cofactor table is d3dx9-math.js inverse() as written', async () => {
  const src = fs.readFileSync(new URL('../src/win32/d3dx9-math.js', import.meta.url), 'utf8');
  const { COFACTORS_FOR_TEST } = await import('../src/cpu/jit/fast-d3dx.js');
  for (let k = 0; k < 16; k++) {
    const m = new RegExp(`inv\\[${k}\\] = ([^;]+);`).exec(src);
    assert.ok(m, `inv[${k}] in the handler`);
    assert.equal(COFACTORS_FOR_TEST[k], m[1], `inv[${k}]`);
  }
});

test('thunk names of every d3dx9_NN.dll map to the fast ids, other DLLs do not', () => {
  assert.equal(d3dxFastId('d3dx9_43.dll!D3DXMatrixInverse'), d3dxFastId('d3dx9_24.dll!D3DXMatrixInverse'));
  assert.ok(d3dxFastId('d3dx9_30.dll!D3DXVec3CatmullRom') > 0);
  assert.equal(d3dxFastId('kernel32.dll!D3DXMatrixInverse'), undefined);
  assert.equal(d3dxFastId('d3dx9_30.dll!D3DXMatrixMultiply'), undefined);
  assert.equal(d3dxFastId('d3dx9_30.dll!toString'), undefined);
});

test('D3DXMatrixInverse: the handler\'s bits (random, singular, non-finite, aliased output, no determinant pointer)', () => {
  const M = DATA, OUT = DATA + 0x100, DET = DATA + 0x200;
  for (let iter = 0; iter < 3000; iter++) {
    const m = Array.from({ length: 16 }, value);
    if (iter % 10 === 1) { for (let i = 0; i < 4; i++) m[4 + i] = m[i]; } // singular
    if (iter % 10 === 2) m.fill(0);
    if (iter % 10 === 3) { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; m[12] = value(); }
    const alias = iter % 4 === 0, noDet = iter % 3 === 0;
    const out = alias ? M : OUT;
    const init = (mem) => { writeF(mem, M, m); for (let i = 0; i < 16; i++) mem.write32(OUT + 4 * i, 0xdeadbeef); mem.write32(DET, 0xcafef00d); };
    const { fast, ref } = both('D3DXMatrixInverse', [out, noDet ? 0 : DET, M], init);
    assert.equal(fast.eax, ref.eax, `return value, case ${iter}`);
    assert.deepEqual(words(fast.data), words(ref.data), `memory, case ${iter}: ${m.join(',')}`);
  }
});

test('D3DXVec{2,3,4}CatmullRom: the handler\'s bits (random points and s, output aliasing each input)', () => {
  const P = [DATA, DATA + 0x20, DATA + 0x40, DATA + 0x60], OUT = DATA + 0x80;
  for (const name of ['D3DXVec2CatmullRom', 'D3DXVec3CatmullRom', 'D3DXVec4CatmullRom']) {
    for (let iter = 0; iter < 1500; iter++) {
      const pts = P.map(() => Array.from({ length: 4 }, value));
      const s = iter % 7 === 0 ? [0, 1, -1, 0.5, NaN, 2][iter % 6] : (rnd() - 0.25) * 2;
      const out = iter % 5 === 4 ? OUT : P[iter % 5];
      const init = (mem) => { pts.forEach((p, i) => writeF(mem, P[i], p)); for (let i = 0; i < 4; i++) mem.write32(OUT + 4 * i, 0xdeadbeef); };
      const { fast, ref } = both(name, [out, P[0], P[1], P[2], P[3], f32bits(s)], init, 0x100);
      assert.equal(fast.eax, ref.eax, `${name} return value`);
      assert.deepEqual(words(fast.data), words(ref.data), `${name} memory, case ${iter}`);
    }
  }
});

test('a pointer outside the WASM memory goes to JavaScript (an exit at the thunk)', () => {
  const prog = [0x68, ...le(0), 0x68, ...le(0), 0x68, ...le(0x7ffffff0), 0xff, 0x15, ...le(SLOTS), 0xf4];
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, Uint8Array.from(prog));
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, now: () => 0 });
  jit.cpu = cpu;
  jit.markFast(1, 'd3dx9_27.dll!D3DXMatrixInverse', true); mem.write32(SLOTS, THUNK_BASE + THUNK_SIZE);
  cpu.eip = CODE; cpu.esp = 0x10009000; cpu.eflags = F.RESERVED1 | F.IF;
  assert.equal(jit.run({ maxInsns: 1e6 }), EXIT.THUNK);
  assert.equal(cpu.eip, THUNK_BASE + THUNK_SIZE);
});
