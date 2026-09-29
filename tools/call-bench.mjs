#!/usr/bin/env node
// CALL / RET microbenchmark: ns per iteration of small loops calling functions. In the first cases the callees are
// separate regions (their entries are region boundaries, as a function reached from several regions, through a
// pointer or past the caller's region size is in real code), so every call and every return is a region-to-region
// transition; in the last ones the callees are part of the caller's region (calls are jumps, returns compare the
// return address with the region's call sites, see translate.js regionRetSites):
//   1 site      one call site, one leaf callee (chain-bench's loop)
//   8 sites     one leaf callee called from 8 sites of one loop body (its returns go to 8 places in turn)
//   random site one of 8 call sites chosen by a pseudo-random number (the return target is unpredictable)
//   indirect    call [table + index] among 4 leaf functions chosen pseudo-randomly
//   nested      a callee calling a second-level leaf twice (calls two deep)
//   recursion   recursive function, depth 40 per iteration
//   20 inlined  20 calls of a leaf included in the caller's region (the returns are local jumps)
//   helpers     a function called through a pointer, calling two helpers of its region 5 times each
//   4x5 helpers the same with four helpers (20 call sites in the region)
// Usage: node tools/call-bench.mjs [iterations] [--runs 7] [--src <dir with cpu/>] [--case <substring>] [--opts <json>]
//   --src: import the emulator from another source tree (a checkout of the previous commit: before/after in one session)
//   --opts: extra Jit options (JSON, e.g. '{"countChains":false}' as in the VM)
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = +(args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? 2e6);
const RUNS = +argOf('--runs', 7);
const SRC = path.resolve(argOf('--src', new URL('../src', import.meta.url).pathname));
const ONLY = argOf('--case', null);
const JOPTS = JSON.parse(argOf('--opts', '{}'));
const imp = (p) => import(pathToFileURL(path.join(SRC, p)).href);
const { GuestMemory } = await imp('cpu/memory.js');
const { CpuState, THREAD_STATES_BASE, EXIT, F } = await imp('cpu/state.js');
const { Interp } = await imp('cpu/interp.js');
await imp('cpu/interp-x87.js');
const { Jit } = await imp('cpu/jit/jit.js');

const CODE = 0x20000000, DATA = 0x10000000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

/** Minimal assembler: raw bytes, labels, rel32 fixups; `fn` marks a label as a region boundary. */
class Asm {
  constructor() { this.b = []; this.labels = new Map(); this.fix = []; this.bounds = []; }
  get pc() { return this.b.length; }
  raw(...x) { this.b.push(...x); return this; }
  label(n) { this.labels.set(n, this.pc); return this; }
  fn(n) { while (this.pc % 16) this.b.push(0x90); this.bounds.push(n); return this.label(n); }
  rel(op, n) { this.b.push(...op); this.fix.push([this.pc, n]); this.b.push(0, 0, 0, 0); return this; }
  call(n) { return this.rel([0xe8], n); }
  jmp(n) { return this.rel([0xe9], n); }
  jnz(n) { return this.rel([0x0f, 0x85], n); }
  jz(n) { return this.rel([0x0f, 0x84], n); }
  abs(n) { this.fix.push([this.pc, n, true]); this.b.push(0, 0, 0, 0); return this; }
  // edx = edx * 1103515245 + 12345 (a pseudo-random sequence; its high bits pick the call site / function)
  lcg() { return this.raw(0x69, 0xd2, ...le(1103515245), 0x81, 0xc2, ...le(12345)); }
  build() {
    for (const [at, n, abs] of this.fix) {
      const t = this.labels.get(n); if (t === undefined) throw new Error('label ' + n);
      const v = abs ? CODE + t : t - (at + 4);
      this.b.splice(at, 4, ...le(v >>> 0));
    }
    return { bytes: Uint8Array.from(this.b), bounds: this.bounds.map((n) => CODE + this.labels.get(n)), end: CODE + this.labels.get('end') };
  }
}
const leaf = (a, n) => a.fn(n).raw(0x83, 0xc0, 0x01, 0xc3); // add eax, 1 ; ret
const loopHead = (a) => a.raw(0xb9, ...le(N)).label('L'); // mov ecx, N ; L:
const loopTail = (a) => a.raw(0x49).jnz('L').label('end').raw(0xf4); // dec ecx ; jnz L ; end: hlt

/** main: L: mov eax, F ; call eax ; dec ecx ; jnz L       F: 5 x (call G0 ; ... ; call G<n-1>) ; ret     Gk: add eax, k+1 ; ret */
function helpers(a, n) {
  loopHead(a); a.raw(0xb8).abs('F').raw(0xff, 0xd0); loopTail(a);
  a.label('F'); for (let r = 0; r < 5; r++) for (let k = 0; k < n; k++) a.call('G' + k);
  a.raw(0xc3);
  for (let k = 0; k < n; k++) a.label('G' + k).raw(0x83, 0xc0, k + 1, 0xc3);
}

const CASES = {
  '1 site': (a) => { loopHead(a); a.call('F'); loopTail(a); leaf(a, 'F'); },
  '8 sites': (a) => { loopHead(a); for (let k = 0; k < 8; k++) a.call('F'); loopTail(a); leaf(a, 'F'); },
  'random site': (a) => {
    // L: lcg ; test edx, 1<<31 ; jz A ; test edx, 1<<30 ; jz B ; ... a 3-level tree down to 8 `call F ; jmp N`
    loopHead(a); a.lcg();
    const tree = (lvl, id) => {
      if (lvl === 3) { a.label('s' + id).call('F').jmp('N'); return; }
      a.raw(0xf7, 0xc2, ...le((1 << (31 - lvl)) >>> 0)).jz(`t${lvl}_${id}`);
      tree(lvl + 1, id * 2 + 1);
      a.label(`t${lvl}_${id}`); tree(lvl + 1, id * 2);
    };
    tree(0, 0);
    a.label('N'); loopTail(a); leaf(a, 'F');
  },
  indirect: (a) => {
    // L: lcg ; mov esi, edx ; shr esi, 30 ; call [T + esi*4] ; dec ecx ; jnz L
    loopHead(a); a.lcg(); a.raw(0x89, 0xd6, 0xc1, 0xee, 0x1e, 0xff, 0x14, 0xb5).abs('T'); loopTail(a);
    for (let k = 0; k < 4; k++) leaf(a, 'F' + k);
    a.fn('T'); for (let k = 0; k < 4; k++) a.abs('F' + k);
  },
  nested: (a) => { loopHead(a); a.call('F'); loopTail(a); a.fn('F').call('G').call('G').raw(0xc3); leaf(a, 'G'); },
  recursion: (a) => {
    // L: mov ebx, 40 ; call R ; dec ecx ; jnz L      R: dec ebx ; jz done ; call R ; done: add eax, 1 ; ret
    a.raw(0xb9, ...le(N)).label('L').raw(0xbb, ...le(40)).call('R'); loopTail(a);
    a.fn('R').raw(0x4b).jz('Rd').call('R').label('Rd').raw(0x83, 0xc0, 0x01, 0xc3);
  },
  // the callee in the caller's region (inlined at region formation): the returns stay in the region
  '20 inlined': (a) => { loopHead(a); for (let k = 0; k < 20; k++) a.call('G'); loopTail(a); a.label('G').raw(0x83, 0xc0, 0x01, 0xc3); },
  // a function reached through a pointer (its own region) calling small helpers included in its region: 2 helpers x 5
  // calls, 4 helpers x 5 calls (20 call sites), then returning to its caller in the other region
  helpers: (a) => helpers(a, 2),
  '4x5 helpers': (a) => helpers(a, 4),
};

async function once(p) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, p.bytes);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, ...JOPTS });
  jit.cpu = cpu; jit.boundaries = new Set(p.bounds);
  const reset = () => { cpu.eip = CODE; cpu.esp = DATA + 0x10000; cpu.eax = 0; cpu.edx = 1; cpu.eflags = F.RESERVED1 | F.IF; };
  const go = () => { let r; do r = jit.run({ stopAt: p.end, maxInsns: 2e9 }); while (r === EXIT.TIMESLICE); if (r !== EXIT.HALT) throw new Error('exit ' + r); };
  reset(); go(); // warm-up: translation, then V8's background tier-up of the regions
  await new Promise((res) => setTimeout(res, 100));
  reset();
  const t0 = performance.now();
  go();
  const ms = performance.now() - t0;
  if (cpu.ecx !== 0 || cpu.esp !== DATA + 0x10000) throw new Error('did not run to the end');
  return { ns: (ms * 1e6) / N, eax: cpu.eax };
}

for (const [name, gen] of Object.entries(CASES)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const a = new Asm(); gen(a); const p = a.build();
  const t = [];
  let eax;
  for (let r = 0; r < RUNS; r++) { const o = await once(p); t.push(o.ns); eax = o.eax; }
  t.sort((x, y) => x - y);
  console.log(`${name.padEnd(12)} ${t[t.length >> 1].toFixed(2).padStart(7)} ns/iter  (min ${t[0].toFixed(2)}, max ${t[t.length - 1].toFixed(2)}; eax ${eax >>> 0})`);
}
