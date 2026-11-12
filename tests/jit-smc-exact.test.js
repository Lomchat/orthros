// Self-modifying code on a page shared by code and data (a packer's or a protection's writable code section): random
// programs store data of every width around their own code on the same page — next to it, across into the next code
// page —, rewrite a function's immediate and a jump's displacement (real self-modification: the last byte of a block),
// rewrite another function's bytes with the same values, and
// call those functions after every store. Under the JIT, page-granular (Jit opts.smcExact false) and exact (the
// default: Jit.invalidate drops only the regions whose bytes a store overlaps), whole and in small time slices, they must
// end as the reference interpreter ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { depth } from './depth.js';

const P = 0x20000000, F = P + 0x800, G = P + 0x840, H = P + 0x880, F2 = P + 0x1000, INIT = P + 0xc00, STACK = 0x10000800, SLOT = STACK + 0x100;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** the page's code: [lo, hi) ranges a data store must not touch */
const CODE_AT = [[F, F + 6], [G, G + 6], [H, H + 5], [H + 0x20, H + 0x26], [H + 0x40, H + 0x46], [INIT, INIT + 11]];
function program(seed) {
  const R = rng(seed), pick = (m) => Math.floor(R() * m);
  // a data address on the page for a store of `w` bytes: anywhere off the code, often right next to it
  const dataAt = (w) => {
    for (;;) {
      const near = [F - w, F + 6, G - w, G + 6, G + 6 + pick(10)];
      const a = R() < 0.4 ? near[pick(near.length)] : P + 0x300 + pick(0xd00 - w);
      if (CODE_AT.every(([lo, hi]) => a + w <= lo || a >= hi)) return a;
    }
  };
  const main = [];
  const sites = 3 + pick(10); // (odd seeds: F rewritten again at the end, after the code translated since its first rewrite)
  for (let k = 0; k < sites; k++) {
    const kind = k === 0 && !(seed & 1) ? 12 : pick(13); // (even seeds: H's jump rewritten first)
    if (kind < 3) main.push(0xc6, 0x05, ...le(dataAt(1)), pick(256)); // mov byte [a], imm8
    else if (kind < 5) main.push(0x66, 0xc7, 0x05, ...le(dataAt(2)), pick(256), pick(256)); // mov word [a], imm16
    else if (kind < 8) main.push(0xc7, 0x05, ...le(dataAt(4)), ...le((R() * 2 ** 32) >>> 0)); // mov dword [a], imm32
    else if (kind === 8) main.push(0x0f, 0x11, 0x05, ...le(dataAt(16))); // movups [a], xmm0 (16 bytes)
    else if (kind === 9 || (k === sites - 1 && seed & 1)) main.push(0x89, 0x1d, ...le(F + 1), 0x43); // mov [F+1], ebx ; inc ebx: F returns another value from now on
    else if (kind === 10) main.push(0xc7, 0x05, ...le(G + 1), ...le(0x1234567)); // G's immediate rewritten with its own value
    else if (kind === 11) main.push(0xc7, 0x05, ...le(P + 0xffe), pick(256), pick(256), 0x89, 0xc8); // across into F2's page: its first bytes, unchanged
    else main.push(0x88, 0xd8, 0x24, 0x20, 0x0c, 0x1c, 0x88, 0x05, ...le(H + 3)); // mov al, bl ; and al, 0x20 ; or al, 0x1c ; mov [H+3], al: H's branch displacement (0x1c or 0x3c), the last byte of its first block
  }
  const call = (t) => { main.push(0xe8, ...le(t - (P + main.length + 5))); };
  call(F); main.push(0x01, 0xc1); // add ecx, eax
  call(G); main.push(0x01, 0xc1);
  call(F2); main.push(0x01, 0xc2); // add edx, eax
  call(H); main.push(0x01, 0xc2);
  main.push(0x81, 0xc3, ...le((R() * 2 ** 32) >>> 0), 0xc1, 0xc3, 1 + pick(31)); // add ebx, imm ; rol ebx, n
  main.push(0x4e, 0x0f, 0x85, ...le(P - (P + main.length + 7))); // dec esi ; jnz main
  const exit = P + main.length; main.push(0xf4);
  if (main.length > 0x300) throw new Error('program too long');
  return { main: Uint8Array.from(main), exit };
}

function makeExec(useJit, opts = {}) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  if (!useJit) I.cache = { size: 0, get() { return undefined; }, set() {}, delete() {}, clear() {} }; // (the reference: every instruction decoded from the bytes of now)
  const jit = useJit ? new Jit(mem, I, { smc: true, ...opts }) : null;
  return { mem, cpu, jit, I };
}
function load(E, prog, fuel) {
  const { mem, cpu } = E;
  cpu.reset();
  mem.fill(P, 0x2000, 0x90);
  mem.writeBytes(P, prog.main);
  mem.writeBytes(F, Uint8Array.from([0xb8, 7, 0, 0, 0, 0xc3])); // mov eax, 7 ; ret
  mem.writeBytes(G, Uint8Array.from([0xb8, ...le(0x1234567), 0xc3])); // mov eax, 0x1234567 ; ret
  mem.writeBytes(H, Uint8Array.from([0x39, 0xc0, 0x74, 0x1c, 0xf4])); // cmp eax, eax ; jz H+0x20 (or H+0x40) ; hlt ; H+0x20: mov eax, 1 ; ret ; H+0x40: mov eax, 2 ; ret
  mem.writeBytes(H + 0x20, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xc3])); mem.writeBytes(H + 0x40, Uint8Array.from([0xb8, 2, 0, 0, 0, 0xc3]));
  mem.writeBytes(F2, Uint8Array.from([0x89, 0xc8, 0x35, 0x55, 0, 0, 0, 0xc3])); // mov eax, ecx ; xor eax, 0x55 ; ret
  // (a region of its own that stays on the page, whatever the others: mov edi, 5 ; jmp [SLOT] -> P)
  mem.writeBytes(INIT, Uint8Array.from([0xbf, 5, 0, 0, 0, 0xff, 0x25, ...le(SLOT)])); mem.write32(SLOT, P);
  cpu.eip = INIT; cpu.esp = STACK; cpu.esi = fuel; cpu.ebx = 0x9e3779b9;
}
function run(E, exit, slice) {
  if (!E.jit) { E.cpu.exit = EXIT.NONE; return E.I.run({ stopAt: exit, maxInsns: 1e7 }); }
  E.jit.cpu = E.cpu;
  let r, k = 0;
  for (;;) {
    r = E.jit.run({ stopAt: exit, maxInsns: slice });
    if (r === EXIT.SMC) { // as the VM does: the written range invalidated (EXIT_ARG, EXIT_LEN), then on
      const len = E.mem.read32(E.cpu.base + ST.EXIT_LEN) || 16; E.mem.write32(E.cpu.base + ST.EXIT_LEN, 0);
      E.I.invalidate(E.cpu.exitArg, len); E.jit.invalidate(E.cpu.exitArg, len); E.smc = (E.smc ?? 0) + 1;
    } else if (r !== EXIT.TIMESLICE) return r;
    assert.ok(++k < 1e6, 'runaway');
  }
}
const state = (E) => ({ regs: [0, 1, 2, 3, 6, 7].map((k) => E.cpu.reg(k) >>> 0), page: Buffer.from(E.mem.bytes(P, 0x1010)).toString('hex') });

test('stores around code on its own page, real and same-value rewrites: page-granular and exact invalidation match the interpreter', () => {
  const total = { page: { regions: 0 }, exact: { regions: 0, kept: 0 } };
  const seeds = depth(64, 4);
  for (let seed = 1; seed <= seeds; seed++) {
    const prog = program(seed), fuel = 6 + (seed % 4) * 3;
    const EI = makeExec(false); load(EI, prog, fuel);
    assert.equal(run(EI, prog.exit), EXIT.HALT, `seed ${seed}: ${EI.I.lastFault?.message} at ${EI.cpu.eip.toString(16)}`);
    const want = state(EI);
    for (const smcExact of [false, true]) {
      for (const slice of smcExact ? [1e7, 1 + (seed * 37) % 97] : [1e7]) { // (page-granular: the reference for the counts below)
        const EJ = makeExec(true, { smcExact }); load(EJ, prog, fuel);
        assert.equal(run(EJ, prog.exit, slice), EXIT.HALT, `seed ${seed} smcExact ${smcExact} slice ${slice}`);
        assert.deepEqual(state(EJ), want, `seed ${seed} smcExact ${smcExact} slice ${slice}`);
        if (slice !== 1e7) continue;
        const t = total[smcExact ? 'exact' : 'page']; t.regions += EJ.jit.stats.regions; if (smcExact) t.kept += EJ.jit.stats.smcKept;
      }
    }
  }
  if (process.env.SMC_DBG) console.log(JSON.stringify(total));
  // exact invalidation did its work: data stores kept the page's translations
  assert.ok(total.exact.kept > 0, 'data stores on a code page kept its translations');
  assert.ok(total.exact.regions < total.page.regions, `translations exact ${total.exact.regions} vs page-granular ${total.page.regions}`);
});
