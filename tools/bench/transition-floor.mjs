#!/usr/bin/env node
// What a region-to-region transition costs in V8 by itself, apart from the translator: two WASM functions of the
// region signature (16 i32 parameters, one result), each in its own module sharing one funcref table, handing control
// to each other N times — ns per transition for several shapes of the handover:
//   bare      return_call_indirect to a constant table index (the floor of a chained tail call between modules)
//   checks    + the chained exit's checks as translate.js emitChain emits them (budget, address range, stop address,
//             one hash probe hitting, EIP store, transition counter, table index and block from the hash entry)
//   nocheck   + the budget and the hash probe only (no range / stop test, no counter)
//   cache     a per-site cache (target, table index, block) compared with the target instead of the hash probe
//   cacheb    cache + the EIP store
//   linked    the table index and block as constants of the code, the cache only compared (a predicted branch)
//   shadow    cache entry found through a depth word loaded first (a return-address stack's two dependent loads)
//   direct    return_call to a function of the same module (no table, no signature check)
//   nested    call_indirect + return (the callee returns at once): a call / return pair per two transitions, the
//             registers reloaded from memory after the return (14 loads) as a nested region call would
// Usage: node tools/bench/transition-floor.mjs [transitions]
import './node-wasm-flags.mjs';
import { ModuleBuilder, Code, T } from '../../src/cpu/jit/wasm.js';

const N = +(process.argv[2] ?? 2e7);
const P = Array(16).fill(T.i32);
const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
const table = new WebAssembly.Table({ initial: 8, element: 'anyfunc' });
const HASH = 1024, CACHE = 2048, STATE = 0; // (a 16-byte hash entry at HASH + slot * 16: eip, fnIdx, block)

/** one region-like function: counts down param 15 (the budget); `next` emits the handover */
function region(kind, self, other, otherIdx) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 1, 1, false);
  m.importTable('env', 'table', 8, undefined);
  const ty = m.type(P, [T.i32]);
  const c = new Code();
  // body: budget -= 1; if budget <= 0 return 0
  c.get(15).i32(1).sub().set(15);
  c.get(15).i32(0).le_s(); { c.if_(); c.i32(0).return_(); c.end(); }
  const target = 0x401000 + other * 16;
  const regs = () => { for (let i = 1; i < 16; i++) c.get(i); };
  if (kind === 'bare') { c.i32(0); regs(); c.i32(otherIdx).return_call_indirect(ty, 0); }
  else if (kind === 'checks' || kind === 'nocheck') {
    const L_TV = 16, L_TA = 17;
    c.i32(target).set(L_TV);
    const noChain = c.block();
    if (kind === 'checks') {
      c.get(L_TV).i32(1).sub().i32(0x7fb00000 - 1).ge_u().br_if(noChain);
      c.get(L_TV).get(1).i32load(0x1c4).eq().br_if(noChain);
    }
    const found = c.block();
    c.get(L_TV).i32(0x9e3779b1 | 0).mul().i32(32 - 6).shr_u().i32(16).mul().tee(L_TA);
    c.i32load(HASH).get(L_TV).eq().br_if(found);
    c.br(noChain);
    c.end();
    if (kind === 'checks') {
      c.get(1).get(L_TV).i32store(0x20);
      c.get(1).get(1).i32load(0x1c8).i32(1).add().i32store(0x1c8);
    }
    c.get(L_TA).i32load(HASH + 8);
    regs();
    c.get(L_TA).i32load(HASH + 4).return_call_indirect(ty, 0);
    c.end();
    c.i32(-1).return_();
  } else if (kind === 'linked') {
    // the table index and block constants of the code, validated by a load and a compare (a predicted branch)
    const L_TV = 16;
    c.i32(target).set(L_TV);
    const miss = c.block();
    c.i32(0).i32load(CACHE + self * 16).get(L_TV).ne().br_if(miss);
    c.i32(0);
    regs();
    c.i32(otherIdx).return_call_indirect(ty, 0);
    c.end();
    c.i32(-1).return_();
  } else if (kind === 'shadow') {
    // the table index from a stack in memory whose depth is loaded first (two dependent loads)
    const L_TV = 16, L_TA = 17;
    c.i32(target).set(L_TV);
    const miss = c.block();
    c.get(1).i32load(0x2d0).i32(2).shl().set(L_TA);
    c.get(L_TA).i32load(CACHE + self * 16).get(L_TV).ne().br_if(miss);
    c.get(L_TA).i32load(CACHE + self * 16 + 8);
    regs();
    c.get(L_TA).i32load(CACHE + self * 16 + 4).return_call_indirect(ty, 0);
    c.end();
    c.i32(-1).return_();
  } else if (kind === 'cache' || kind === 'cacheb') {
    // a per-site cache (CACHE + self * 16: target, table index, block) compared with the target; `cacheb`: + EIP store
    const L_TV = 16, L_TA = 17;
    c.i32(target).set(L_TV);
    const miss = c.block();
    c.i32(0).i32load(CACHE + self * 16).get(L_TV).ne().br_if(miss);
    if (kind === 'cacheb') c.get(1).get(L_TV).i32store(0x20);
    c.i32(0).i32load(CACHE + self * 16 + 8);
    regs();
    c.i32(0).i32load(CACHE + self * 16 + 4).return_call_indirect(ty, 0);
    c.end();
    c.i32(-1).return_();
  } else if (kind === 'nested') {
    // call the other function (which returns at once after its own decrement), reload 14 values, loop
    const lp = c.loop();
    c.i32(1); regs(); c.i32(otherIdx).call_indirect(ty, 0); c.drop();
    for (let i = 2; i < 16; i++) c.get(1).i32load(4 * i).set(i);
    c.get(15).i32(2).sub().tee(15).i32(0).gt_s().br_if(lp);
    c.end();
    c.i32(0).return_();
  }
  if (kind !== 'nested') c.unreachable();
  m.func(P, [T.i32], kind === 'checks' || kind === 'nocheck' || kind.startsWith('cache') || kind === 'linked' || kind === 'shadow' ? [T.i32, T.i32] : [], c, 'f');
  m.exportFunc('f', 0);
  return new WebAssembly.Instance(new WebAssembly.Module(m.build()), { env: { memory, table } }).exports.f;
}
/** the callee of `nested`: stores 14 values and returns */
function leaf() {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 1, 1, false);
  m.importTable('env', 'table', 8, undefined);
  const c = new Code();
  for (let i = 2; i < 16; i++) c.get(1).get(i).i32store(4 * i);
  c.i32(0);
  m.func(P, [T.i32], [], c, 'f');
  m.exportFunc('f', 0);
  return new WebAssembly.Instance(new WebAssembly.Module(m.build()), { env: { memory, table } }).exports.f;
}
/** both functions in one module, tail-calling each other directly */
function directPair() {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 1, 1, false);
  m.importTable('env', 'table', 8, undefined);
  for (let k = 0; k < 2; k++) {
    const c = new Code();
    c.get(15).i32(1).sub().set(15);
    c.get(15).i32(0).le_s(); { c.if_(); c.i32(0).return_(); c.end(); }
    c.i32(0); for (let i = 1; i < 16; i++) c.get(i);
    c.return_call(1 - k);
    m.func(P, [T.i32], [], c, 'f' + k);
  }
  m.exportFunc('f0', 0);
  return new WebAssembly.Instance(new WebAssembly.Module(m.build()), { env: { memory, table } }).exports.f0;
}

const u32 = new Uint32Array(memory.buffer);
for (let k = 0; k < 2; k++) { const s = (((0x401000 + k * 16) * 0x9e3779b1) >>> 26) * 16; u32[(HASH + s) >> 2] = 0x401000 + k * 16; u32[(HASH + s + 4) >> 2] = k; u32[(HASH + s + 8) >> 2] = 0; }
u32[0x1c4 >> 2] = 0xffffffff;
for (let k = 0; k < 2; k++) { u32[(CACHE + k * 16) >> 2] = 0x401000 + (1 - k) * 16; u32[(CACHE + k * 16 + 4) >> 2] = 1 - k; }
for (const kind of ['bare', 'checks', 'nocheck', 'cache', 'cacheb', 'linked', 'shadow', 'direct', 'nested']) {
  let f;
  if (kind === 'direct') f = directPair();
  else if (kind === 'nested') { table.set(1, leaf()); f = region('nested', 0, 1, 1); }
  else { table.set(0, region(kind, 0, 1, 1)); table.set(1, region(kind, 1, 0, 0)); f = table.get(0); }
  let best = Infinity;
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    f(0, STATE, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, N);
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`${kind.padEnd(8)} ${(best * 1e6 / N).toFixed(2)} ns per transition`);
}
