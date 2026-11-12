// Tier 2 (src/cpu/jit/tier2.js, ORTHROS_JIT_AB={"tier2":true}): hot guest functions translated once into one module,
// calling each other with WASM calls. Random programs of functions — direct calls, calls through slots, import-stub
// jumps, tail jumps, recursion deeper than the nesting bound, loops, early returns, a callee replacing its return
// address, flags read after a call, x87 and SSE functions — run under the JIT with a profile window that builds tier 2
// in the middle of the run, in time slices: the same registers, flags, stack and data as the reference interpreter.
// Also code written over on a tier-2 page (tier 2 dropped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { depth } from './depth.js';

const CODE = 0x20000000, DATA = 0x10000000, SLOTS = DATA + 0x400;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
let seed = Number(process.env.ORTHROS_TEST_SEED) || 4242;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

class Asm {
  constructor() { this.b = []; this.labels = new Map(); this.fix = []; this.n = 0; }
  raw(...x) { this.b.push(...x); return this; }
  label(n) { this.labels.set(n, this.b.length); return this; }
  fresh() { return 'L' + this.n++; }
  ref(n, abs) { this.fix.push([this.b.length, n, abs]); this.b.push(0, 0, 0, 0); return this; }
  build() {
    for (const [o, n, abs] of this.fix) { const t = this.labels.get(n); if (t === undefined) throw new Error('label ' + n); this.b.splice(o, 4, ...le(abs ? CODE + t : t - (o + 4))); }
    return Uint8Array.from(this.b);
  }
}
const R3 = () => rnd(4); // eax ecx edx ebx
const alu = (a) => {
  switch (rnd(6)) {
    case 0: a.raw(0x01, 0xc0 | (R3() << 3) | R3()); break; // add r, r
    case 1: a.raw(0x83, 0xc0 | (rnd(8) << 3) | R3(), rnd(256)); break; // alu r, imm8
    case 2: a.raw(0x8d, 0x40 | (R3() << 3) | R3(), rnd(128)); break; // lea
    case 3: a.raw(0x89, 0x46 | (R3() << 3), 4 * rnd(8) + 0x40); break; // mov [esi+d8], r
    case 4: a.raw(0x03, 0x46 | (R3() << 3), 4 * rnd(8) + 0x40); break; // add r, [esi+d8]
    default: a.raw(0xd1, 0xe0 | (rnd(2) ? 8 : 0) | R3()); break; // shl / shr r, 1
  }
};

/** functions F0..Fn-1 (Fi calls only Fj, j > i, or itself under the EBP bound), main calling F0 in a loop on EDI */
function gen(smc = false) {
  const a = new Asm(), n = 3 + rnd(4), x87 = rnd(3) === 0 ? 1 + rnd(n - 1) : -1, sse = rnd(3) === 0 ? 1 + rnd(n - 1) : -1;
  const slotOf = (j) => SLOTS + 4 * j;
  // main: L: mov ebp, 56 ; call F0 ; [jc/jo on its flags] ; dec edi ; jnz L ; hlt
  a.label('main'); a.raw(0xbd, ...le(56)); a.raw(0xe8).ref('F0');
  { const s = a.fresh(); a.raw(0x0f, 0x82).ref(s); a.raw(0x83, 0xc3, 3); a.label(s); }
  if (smc) { a.raw(0x50, 0xa1).ref('slot0', true); a.raw(0xa3).ref('slot0', true); a.raw(0x58); } // push eax ; mov eax, [slot0] ; mov [slot0], eax ; pop eax
  a.raw(0x4f, 0x0f, 0x85).ref('main'); a.label('end'); a.raw(0xf4);
  for (let i = 0; i < n; i++) {
    a.label('S' + i); a.raw(0xff, 0x25).ref('slot' + i, true); // (an import stub: jmp [slot])
    a.label('F' + i);
    const pieces = 1 + rnd(3);
    for (let p = 0; p < pieces; p++) {
      const j = i + 1 + rnd(Math.max(1, n - i - 1)), callee = j < n;
      switch (rnd(10)) {
        case 0: alu(a); alu(a); break;
        case 1: alu(a); a.raw(0x27); break; // daa: run by the interpreter (no translation)
        case 2: if (callee) a.raw(0xe8).ref('F' + j); else alu(a); break;
        case 3: if (callee) a.raw(0xff, 0x15, ...le(slotOf(j))); else alu(a); break; // call [slot]
        case 4: if (callee) a.raw(0xe8).ref('S' + j); else alu(a); break; // call stub
        case 5: { const s = a.fresh(); a.raw(0x85, 0xed, 0x7e).raw(0).label(s + 'p'); a.raw(0x4d, 0xe8).ref('F' + i); a.label(s); a.b[a.labels.get(s + 'p') - 1] = a.labels.get(s) - a.labels.get(s + 'p'); break; } // test ebp,ebp ; jle s ; dec ebp ; call Fi ; s:
        case 6: { const l = a.fresh(); a.raw(0xc7, 0x46, 0x20, ...le(2 + rnd(5))); a.label(l); alu(a); a.raw(0xff, 0x4e, 0x20, 0x0f, 0x85).ref(l); break; } // loop on [esi+0x20]
        case 7: { const s = a.fresh(); a.raw(0xa8, 1 << rnd(8), 0x74, 1, 0xc3); void s; break; } // test al, bit ; jz +1 ; ret
        case 8: if (callee) { const s = a.fresh(); a.raw(0x53, 0xe8).ref('R' + j); a.raw(0xe9).ref(s); alu(a); a.label(s); a.raw(0x5b); } else alu(a); break; // push ebx ; call Rj (returns past the jmp) ; jmp s ; <alu> ; s: pop ebx
        default: if (callee) { const s = a.fresh(); a.raw(0xe8).ref('F' + j); a.raw(0x0f, 0x83).ref(s); a.raw(0x83, 0xc1, 7); a.label(s); } else alu(a); break; // call ; jnc (flags of the callee)
      }
    }
    if (i === x87) a.raw(0xd9, 0x46, 0x08, 0xd8, 0x46, 0x0c, 0xd9, 0x5e, 0x08); // fld [esi+8] ; fadd [esi+12] ; fstp [esi+8]
    if (i === sse) a.raw(0xf3, 0x0f, 0x10, 0x46, 0x10, 0xf3, 0x0f, 0x58, 0x46, 0x14, 0xf3, 0x0f, 0x11, 0x46, 0x10); // movss / addss / movss
    if (i + 1 < n && rnd(4) === 0) a.raw(0xe9).ref('F' + (i + 1 + rnd(n - i - 1))); // tail jump
    else a.raw(0xc3);
    // Ri: Fi's entry for callers whose return address it moves past their 5-byte jmp
    a.label('R' + i); a.raw(0x83, 0x04, 0x24, 5, 0xe9).ref('F' + i);
  }
  for (let i = 0; i < n; i++) a.label('slot' + i).raw(...le(0)); // (stub slots in the code page: filled below)
  const code = a.build();
  for (let i = 0; i < n; i++) { const at = a.labels.get('slot' + i); code.set(le(CODE + a.labels.get('F' + i)), at); }
  return { code, end: a.labels.get('end'), fns: Array.from({ length: n }, (_, i) => CODE + a.labels.get('F' + i)), slotsAt: a.labels.get('slot0') };
}

function setup(g) {
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE);
  mem.fill(CODE, 0x4000, 0xcc); mem.writeBytes(CODE, g.code);
  mem.fill(DATA, 0x1000, 0);
  g.fns.forEach((f, i) => mem.write32(SLOTS + 4 * i, f));
  mem.write32(DATA + 0x100 + 8, 0x3f800000); mem.write32(DATA + 0x100 + 12, 0x3e000000); mem.write32(DATA + 0x100 + 16, 0x40000000); mem.write32(DATA + 0x100 + 20, 0x3c000000);
  cpu.reset();
  cpu.eax = 0x1234567; cpu.ecx = 0x89abcdef; cpu.edx = 5; cpu.ebx = 0x7f; cpu.edi = 80; cpu.esi = DATA + 0x100; cpu.esp = DATA + 0xf00; cpu.eip = CODE;
  cpu.eflags = F.RESERVED1 | F.IF;
  return { mem, cpu };
}
function state(r, mem, cpu) {
  return [r, cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.ebp, cpu.edi, cpu.eflags & ARITH, cpu.eip].map((v) => (v >>> 0).toString(16)).join(' ') + ' ' + Buffer.from(mem.bytes(DATA + 0x100, 0x80)).toString('hex') + ' ' + Buffer.from(mem.bytes(DATA + 0xc00, 0x300)).toString('hex');
}
/** under the JIT, tier 2 profiled for `window` instructions then built, in slices of `slice`; `hook(jit, mem)` between slices */
function runJit(g, slice, window, hook = null) {
  const { mem, cpu } = setup(g);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  jit.switchOpts({ tier2: true, tier2Window: window, tier2Share: 0.9 });
  let r, n = 0;
  for (;;) {
    r = jit.run({ stopAt: CODE + g.end, maxInsns: slice });
    if (r === EXIT.SMC) { jit.invalidate(cpu.exitArg >>> 0, 16); continue; }
    if (r !== EXIT.TIMESLICE) break;
    hook?.(jit, mem, cpu);
    if (++n > 1e6) throw new Error('runaway');
  }
  CpuState.foldLazyFlags?.(cpu);
  return { s: state(r, mem, cpu), jit };
}

test('tier 2: random programs of functions match the interpreter, built mid-run, whole slices and short ones', () => {
  let built = 0, x87 = 0;
  for (let t = 0, n = depth(48, 8); t < n; t++) {
    const g = gen();
    const ref = setup(g);
    const r = new Interp(ref.mem, ref.cpu).run({ stopAt: CODE + g.end, maxInsns: 1e8 });
    const want = state(r, ref.mem, ref.cpu);
    for (const slice of [5000, 97, 7]) {
      const { s, jit } = runJit(g, slice, 800);
      assert.equal(s, want, `program ${t} slice ${slice}: ${Buffer.from(g.code).toString('hex')}`);
      if (jit.t2Stats?.built) { built++; x87 += jit.t2Stats.x87Functions; }
    }
  }
  assert.ok(built > depth(48, 8) * 2, `tier 2 built in ${built} runs`);
  assert.ok(x87 > 0, 'x87 functions translated');
});

test('tier 2: a store into a tier-2 page (SMC) drops it, the run still matches the interpreter', () => {
  let dropped = 0;
  for (let t = 0; t < depth(16, 4); t++) {
    const g = gen(true);
    const ref = setup(g);
    const want = state(new Interp(ref.mem, ref.cpu).run({ stopAt: CODE + g.end, maxInsns: 1e8 }), ref.mem, ref.cpu);
    for (const slice of [5000, 13]) {
      const { s, jit } = runJit(g, slice, 500);
      assert.equal(s, want, `program ${t} slice ${slice}`);
      if (jit.t2Stats?.built && jit.t2Stats.dropped >= 1) { assert.equal(jit.t2, null); dropped++; }
    }
  }
  assert.ok(dropped > 0, 'tier 2 built then dropped');
});
