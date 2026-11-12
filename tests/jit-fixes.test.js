// Targeted translation fixes (docs/jit-code-shape.md "Targeted fixes", 2026-11-12), each a JIT option, against the
// reference interpreter: random programs run with the option on and off, whole and time-sliced, the VM's SMC handling
// (an SMC exit invalidates the written range and resumes), every register, the flags, memory and the x87 / MMX state
// compared.
// - divFast: 32-bit DIV / IDIV with a dividend that fits 32 bits (cdq ; idiv, xor edx, edx ; div) divided in 32 bits,
//   the general case once in 64 bits; #DE for a zero divisor, a quotient that does not fit, -2^31 / -1 and -2^63 / -1.
// - strSmcOne: a MOVS / STOS without REP checks the one page it wrote (DF clear or set), stores into the code that
//   follows in the same block included.
// - mmxTopOnce: the x87 TOP / tag word side effect of MMX accesses emitted once per block, with x87 pushes and pops,
//   EMMS and interpreter fallbacks between MMX instructions.
// - smcGroup: stores through the same address registers share one SMC check (at the group's first store, on the range
//   of the whole group); stores into code ahead in the block, into the page after, into the null page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { listRegion } from '../src/cpu/jit/listing.js';
import { depth, FULL } from './depth.js';

const CODE = 0x20000000, DATA = 0x10000000;
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, '0')).join('');

function makeExec(jitOpts) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  // (no interpreter decodes cached, the reference's nor the JIT's steps: the VM invalidates that cache, not the stores)
  I.cache = new (class extends Map { set() { return this; } })();
  const jit = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  if (jit) jit.cpu = cpu;
  return { mem, cpu, jit, I };
}
/** Run to `end` (HLT) or a fault, `slice` instructions at a time (0: whole); SMC exits handled as the VM does. */
function runTo(E, end, slice) {
  let r, k = 0;
  for (;;) {
    r = E.jit ? E.jit.run({ stopAt: end, maxInsns: slice || 1e6 }) : E.I.run({ stopAt: end, maxInsns: 1e6 });
    if (r === EXIT.SMC) { const len = E.mem.read32(E.cpu.base + ST.EXIT_LEN) || 16; E.mem.write32(E.cpu.base + ST.EXIT_LEN, 0); E.jit.invalidate(E.cpu.exitArg, len); continue; }
    if (r === EXIT.TIMESLICE && ++k < (E.jit ? 1e6 : 100)) continue; // (the reference: at most 10^8 instructions)
    return r;
  }
}
function snap(E, code, r) {
  const { cpu, mem } = E;
  // (at a fault the flags are left out: a read-modify-write into the null page faults with its own flags already
  // computed, a documented inexactness of the JIT, translate.js NC_RMW_SMC)
  return [cpu.eax, cpu.ecx, cpu.edx, cpu.ebx, cpu.esp, cpu.ebp, cpu.esi, cpu.edi, cpu.eip, r === EXIT.FAULT ? 0 : cpu.eflags & 0xcd5].map((x) => (x >>> 0).toString(16)).join(' ') +
    ' | fpu ' + hex(mem.bytes(cpu.base + ST.FPU_CW, 8)) + ' ' + hex(mem.bytes(cpu.base + ST.FPR, 64)) + ' mm ' + hex(mem.bytes(cpu.base + ST.MM, 64)) +
    ' | data ' + hex(mem.bytes(DATA, 0x200)) + ' | code ' + hex(mem.bytes(CODE, code.length));
}
/** The program against the interpreter under every option value and slice size. */
// (the quick depth: the option on only, three slice sizes; tests/depth.js FULL: off as well, four)
function check(name, code, setup, opt, values = FULL ? [true, false] : [true], slices = FULL ? [0, 3, 7, 29] : [0, 3, 29]) {
  const end = CODE + code.length - 1;
  const load = (E) => { E.cpu.reset(); E.mem.fill(CODE, 0x3000, 0xcc); E.mem.fill(DATA, 0x2000, 0); E.mem.writeBytes(CODE, code); E.cpu.eip = CODE; setup(E); };
  const EI = makeExec(null); load(EI); const ri = runTo(EI, end, 0); const a = snap(EI, code, ri);
  if (ri === EXIT.TIMESLICE) return ri; // (a program whose stores made it loop for ever: the reference gave up, nothing to compare)
  for (const v of values) for (const slice of slices) {
    const EJ = makeExec({ [opt]: v }); load(EJ); const r = runTo(EJ, end, slice);
    const what = `${name}, ${opt} ${v}, slices ${slice}: ${hex(code)}`;
    assert.equal(r, ri, what);
    assert.equal(snap(EJ, code, r), a, what);
  }
  return ri;
}
/** Blocks of random instructions in a counted loop (ECX), joined by forward Jcc / JMP: dec ecx ; jnz ; hlt. */
function loopOf(nb, body) {
  const out = [], fix = [], start = [];
  for (let i = 0; i < nb; i++) {
    start[i] = out.length; out.push(...body());
    const t = rnd(4);
    if (i < nb - 1 && t < 2) { const tgt = i + 1 + rnd(nb - i - 1); if (t === 0) out.push(0xe9); else out.push(0x0f, 0x80 + rnd(16)); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); }
  }
  start[nb] = out.length; out.push(0x49, 0x0f, 0x85, ...le(-(out.length + 7)), 0xf4);
  for (const [at, tgt] of fix) out.splice(at, 4, ...le(start[tgt] - (at + 4)));
  return Uint8Array.from(out);
}
const V = [0, 1, 2, 3, 7, 0x7f, 0x80, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0x80000001, 0xffffffff, 0xfffffffe, 0x12345678, 0xdeadbeef];
const val = () => rnd(3) ? V[rnd(V.length)] : (rnd(65536) << 16 | rnd(65536)) >>> 0;

test('divFast: random DIV / IDIV programs match the interpreter (#DE included)', () => {
  // divisors and dividends from two tables indexed by the loop counter (ebp: divisors, ebp+0x100: values)
  const body = () => {
    const out = [];
    for (let n = 1 + rnd(3); n--;) {
      out.push(0x8b, 0x5c, 0x8d, 0x00); // mov ebx, [ebp+ecx*4]
      out.push(0x8b, 0x84, 0x8d, ...le(0x100)); // mov eax, [ebp+ecx*4+0x100]
      // (each form divides without #DE for the tables' values but the planted ones, so that programs run long; the
      // rare forms at the end fault more often)
      const k = rnd(40);
      if (k < 12) out.push(0x99, 0xf7, 0xfb); // cdq ; idiv ebx
      else if (k < 20) out.push(0x31, 0xd2, 0xf7, 0xf3); // xor edx, edx ; div ebx
      else if (k < 24) out.push(0x99, 0xf7, 0x7c, 0x8d, 0x00); // cdq ; idiv dword [ebp+ecx*4]
      else if (k < 28) out.push(0x89, 0xfa, 0x81, 0xe2, ...le(0x3ff), 0x81, 0xcb, ...le(0x400), 0xf7, 0xf3); // mov edx, edi ; and edx, 0x3ff ; or ebx, 0x400 ; div ebx (64-bit)
      else if (k < 32) out.push(0x89, 0xfa, 0x81, 0xca, ...le(0xfffffc00), 0x81, 0xe3, ...le(0x7fffffff), 0x81, 0xcb, ...le(0x40000000), 0xf7, 0xfb); // mov edx, edi ; or edx, -1024 ; and ebx, 0x7fffffff ; or ebx, 2^30 ; idiv ebx (negative 64-bit)
      else if (k < 36) out.push(0x31, 0xd2, 0x81, 0xe3, ...le(0x7fffffff), 0x83, 0xcb, 0x02, 0xf7, 0xfb); // xor edx, edx ; and ebx, 0x7fffffff ; or ebx, 2 ; idiv ebx (EAX above 2^31: EDX not its extension)
      else if (k < 37) out.push(0x83, 0xe3, 0x0f, 0x83, 0xcb, 0x01, 0x99, 0xf7, 0xfb); // and ebx, 15 ; or ebx, 1 ; cdq ; idiv ebx
      else if (k < 38) out.push(0x89, 0xfa, 0xf7, 0xfb); // mov edx, edi ; idiv ebx (any EDX: #DE likely)
      else if (k < 39) out.push(0xba, ...le(val()), 0xf7, 0xf3); // mov edx, imm ; div ebx
      else out.push(0x99, 0xf7, 0xf3); // cdq ; div ebx (#DE for a negative EAX)
      out.push(0x01, 0xc6, 0x31, 0xd7); // add esi, eax ; xor edi, edx
    }
    return out;
  };
  for (let t = 0, n = depth(160, 12); t < n; t++) {
    const code = loopOf(2 + rnd(4), body), iters = 1 + rnd(30);
    const divs = Array.from({ length: 64 }, () => (rnd(2) ? val() || 3 : (rnd(2) ? 1 + rnd(20) : -1 - rnd(20))) >>> 0);
    const nums = Array.from({ length: 64 }, () => rnd(4) ? val() : rnd(1000));
    for (let i = 0; i < 64; i++) if (nums[i] === 0x80000000 && divs[i] === 0xffffffff) divs[i] = 7;
    // a planted #DE in half the programs: a zero divisor, or -2^31 / -1
    if (rnd(2)) { const at = 1 + rnd(iters); if (rnd(2)) divs[at] = 0; else { divs[at] = 0xffffffff; nums[at] = 0x80000000; } }
    const s0 = seed, edi = rnd(2) ? 0x80000000 : val();
    check(`div program ${t} (seed ${s0})`, code, (E) => {
      E.cpu.ecx = iters; E.cpu.ebp = DATA; E.cpu.edi = edi; E.cpu.esi = 0; E.cpu.esp = DATA + 0x1800;
      E.cpu.eflags = F.RESERVED1 | F.IF;
      divs.forEach((d, i) => E.mem.write32(DATA + 4 * i, d)); nums.forEach((d, i) => E.mem.write32(DATA + 0x100 + 4 * i, d));
    }, 'divFast');
    seed = s0 + 1;
  }
});

test('divFast: the edge cases, each its own program', () => {
  // [edx, eax, divisor, signed]
  const cases = [[0, 7, 2, 0], [0xffffffff, 0x80000000, 0xffffffff, 1], [0, 0x80000000, 0xffffffff, 1], [0x80000000, 0, 0xffffffff, 1],
    [0xffffffff, 0xffffffff, 0xffffffff, 1], [0, 0xffffffff, 0xffffffff, 0], [1, 0, 2, 0], [1, 0, 1, 0], [0, 5, 0, 0], [0, 5, 0, 1],
    [0x3fffffff, 0xffffffff, 0x7fffffff, 1], [0x40000000, 0, 0x7fffffff, 1], [0xc0000000, 0, 0x80000000, 1], [0xffffffff, 0x7fffffff, 0xffffffff, 1]];
  for (const [edx, eax, d, signed] of cases) {
    const code = Uint8Array.from([0xf7, signed ? 0xfb : 0xf3, 0xf4]);
    check(`${signed ? 'idiv' : 'div'} ${edx.toString(16)}:${eax.toString(16)} / ${d.toString(16)}`, code, (E) => {
      E.cpu.edx = edx; E.cpu.eax = eax; E.cpu.ebx = d; E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF;
    }, 'divFast', [true, false], [0]);
  }
  // one 32-bit division where the dividend fits, the 64-bit one kept for the general case
  const mem = new GuestMemory();
  mem.writeBytes(CODE, Uint8Array.from([0x99, 0xf7, 0xfb, 0xc3]));
  const t = listRegion(mem, CODE, { divFast: true }).text;
  assert.match(t, /^\s+div_s$/m); assert.match(t, /^\s+i64div_s$/m); assert.doesNotMatch(t, /rem_s/);
});

test('strSmcOne: random single MOVS / STOS programs, stores into the following code included', () => {
  const body = () => {
    const out = [];
    for (let n = 1 + rnd(4); n--;) {
      switch (rnd(10)) {
        case 0: out.push(0xfd); break; // std
        case 1: out.push(0xfc); break; // cld
        case 2: out.push(0xa5); break; // movsd
        case 3: out.push(0xa4); break; // movsb
        case 4: out.push(0x66, 0xa5); break; // movsw
        case 5: out.push(0xab); break; // stosd
        case 6: out.push(0xaa); break; // stosb
        case 7: out.push(0x66, 0xab); break; // stosw
        case 8: out.push(0x05, ...le(val())); break; // add eax, imm
        default: out.push(0x8d, 0x7c, 0x3e, rnd(16)); // lea edi, [esi+edi+k] (wanders)
      }
    }
    out.push(0x81, 0xe7, ...le(0x1ff), 0x81, 0xcf, ...le(DATA), 0x81, 0xe6, ...le(0x1ff), 0x81, 0xce, ...le(DATA)); // keep edi / esi in the data
    return out;
  };
  for (let t = 0, n = depth(80, 8); t < n; t++) {
    const code = loopOf(2 + rnd(4), body), iters = 1 + rnd(20), s0 = seed;
    const esi = DATA + rnd(0x100), edi = DATA + rnd(0x100), eax = val(), data = Array.from({ length: 0x80 }, val);
    check(`string program ${t} (seed ${s0})`, code, (E) => {
      E.cpu.ecx = iters; E.cpu.esi = esi; E.cpu.edi = edi; E.cpu.eax = eax; E.cpu.esp = DATA + 0x1800;
      E.cpu.eflags = F.RESERVED1 | F.IF;
      data.forEach((v, i) => E.mem.write32(DATA + 4 * i, v));
    }, 'strSmcOne');
    seed = s0 + 1;
  }
  // STOSD / MOVSB into the immediate of an instruction later in the same block (DF clear and set), and into the bytes
  // right before a code page (crossing into it, and ending before it)
  for (const [pre, op, len] of [[[0xfc], [0xab], 4], [[0xfd], [0xab], 4], [[0xfc], [0xa4], 1], [[0xfd], [0x66, 0xab], 2]]) {
    // mov edi, X ; mov eax, 0x22 ; mov esi, DATA ; <pre> ; <op> ; mov ebx, 0x11111111 (X: its imm32) ; hlt
    const head = [0xbe, ...le(DATA), 0xb8, ...le(0x22), ...pre, ...op];
    const at = 5 + head.length + 1;
    const code = Uint8Array.from([0xbf, ...le(CODE + at), ...head, 0xbb, ...le(0x11111111), 0xf4]);
    check(`store into the next instruction (${hex(pre)} ${hex(op)})`, code, (E) => { E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF; E.mem.write32(DATA, 0x99887766); }, 'strSmcOne', [true, false], [0, 2]);
    void len;
  }
  for (const k of [1, 2, 3, 4, 6]) {
    // a callee at CODE + 0x1000 (its own page) run, then a STOSD at its page's start - k, then the callee again
    const fn = [0xb8, 1, 0, 0, 0, 0xc3];
    const main = [0xe8, ...le(0x1000 - 5), 0x89, 0xc3, 0xbf, ...le(CODE + 0x1000 - k), 0xb8, ...le(0xc3c3c3c3 >>> 0), 0xab, 0xe8];
    main.push(...le(0x1000 - (main.length + 4)), 0xf4);
    const code = Uint8Array.from(main);
    check(`stosd ${k} bytes before a code page`, code, (E) => { E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF; E.mem.writeBytes(CODE + 0x1000, Uint8Array.from(fn)); }, 'strSmcOne', [true, false], [0]);
  }
});

test('mmxTopOnce: random MMX blocks with x87 pushes, pops, EMMS and fallbacks match the interpreter', () => {
  const body = () => {
    const out = [];
    for (let n = 2 + rnd(6); n--;) {
      const r = rnd(4), s = rnd(4);
      switch (rnd(14)) {
        case 0: out.push(0x0f, 0x6f, 0x45 | (r << 3), 8 * rnd(8)); break; // movq mmR, [ebp+8k]
        case 1: out.push(0x0f, 0x7f, 0x45 | (r << 3), 8 * rnd(8)); break; // movq [ebp+8k], mmR
        case 2: out.push(0x0f, 0xfd, 0xc0 | (r << 3) | s); break; // paddw mmR, mmS
        case 3: out.push(0x0f, 0xef, 0xc0 | (r << 3) | s); break; // pxor mmR, mmS
        case 4: out.push(0x0f, 0xd5, 0xc0 | (r << 3) | s); break; // pmullw mmR, mmS
        case 5: out.push(0x0f, 0x7e, 0xc0 | (r << 3)); break; // movd eax, mmR
        case 6: out.push(0x0f, 0x6e, 0xc0 | (r << 3) | 3); break; // movd mmR, ebx
        // x87 between MMX instructions, each from EMMS (an empty stack: no overflow or underflow, whose edge cases are
        // not what this test is about): TOP moves away from 0, the tags change, an interpreter fallback (FXTRACT)
        case 7: out.push(0x0f, 0x77, 0xd9, 0x45, 0x40 + 4 * rnd(8)); break; // emms ; fld dword [ebp+0x40+4k]
        case 8: out.push(0x0f, 0x77, 0xd9, 0x45, 0x40 + 4 * rnd(8), 0xd9, 0x45, 0x40 + 4 * rnd(8), 0xde, 0xc1); break; // emms ; fld ; fld ; faddp
        case 9: out.push(0x0f, 0x77, 0xd9, 0xee, 0xdd, 0x5d, 0x60 + 8 * rnd(4)); break; // emms ; fldz ; fstp qword [ebp+0x60+8k]
        case 10: out.push(0x0f, 0x77); break; // emms
        case 11: out.push(0x0f, 0x77, 0xd9, 0x45, 0x40 + 4 * rnd(8), 0xd9, 0xf4); break; // emms ; fld ; fxtract (an interpreter fallback)
        case 12: out.push(0x0f, 0x77, 0xd9, 0x45, 0x40 + 4 * rnd(8), 0xdd, 0x5d, 0x60 + 8 * rnd(4)); break; // emms ; fld ; fstp (TOP back to 0)
        default: out.push(0x0f, 0x60, 0xc0 | (r << 3) | s); // punpcklbw
      }
    }
    // (a block entered from another that left TOP elsewhere: ends with x87 one time in two, starts with an MM access)
    if (rnd(2)) out.push(0x0f, 0x77, 0xd9, 0x45, 0x40 + 4 * rnd(8));
    out.push(0x01, 0xc3); // add ebx, eax
    return [0x0f, 0xfd, 0xc0 | (rnd(4) << 3) | rnd(4), ...out];
  };
  for (let t = 0, n = depth(120, 10); t < n; t++) {
    const code = loopOf(2 + rnd(4), body), iters = 1 + rnd(12), s0 = seed;
    const ebx = val(), ints = Array.from({ length: 16 }, val), floats = Float32Array.from({ length: 8 }, () => (rnd(2000) - 1000) / 7);
    check(`mmx program ${t} (seed ${s0})`, code, (E) => {
      E.cpu.ecx = iters; E.cpu.ebp = DATA; E.cpu.ebx = ebx; E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF;
      ints.forEach((v, i) => E.mem.write32(DATA + 4 * i, v));
      new Uint32Array(floats.buffer).forEach((v, i) => E.mem.write32(DATA + 0x40 + 4 * i, v));
    }, 'mmxTopOnce');
    seed = s0 + 1;
  }
});

test('mmxTopOnce: a block entered with another TOP than the block emitted before it left', () => {
  // A: test ebx, ebx ; jz X        X / Y in both orders, one ending with an MM access (TOP 0, every tag set), the other
  // with emms ; fld (TOP 7) — whichever the layout emits just before C, C is entered from both
  // C: paddw mm0, mm1 ; movq [ebp+8], mm0 ; fstp qword [ebp+0x60] ; hlt
  const mmx = [0x0f, 0xfd, 0xc1], x87 = [0x0f, 0x77, 0xd9, 0x45, 0x40];
  const C = [0x0f, 0xfd, 0xc1, 0x0f, 0x7f, 0x45, 0x08, 0xdd, 0x5d, 0x60, 0xf4];
  for (const [first, second] of [[mmx, x87], [x87, mmx]]) for (const ebx of [0, 1]) {
    // A ; first ; jmp C ; second ; C
    const code = Uint8Array.from([0x85, 0xdb, 0x74, first.length + 2, ...first, 0xeb, second.length, ...second, ...C]);
    check(`${first === mmx ? 'MMX' : 'x87'} block first, ebx ${ebx}`, code, (E) => {
      E.cpu.ebp = DATA; E.cpu.ebx = ebx; E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF;
      E.mem.write32(DATA + 0x40, 0x3fc00000);
    }, 'mmxTopOnce', [true, false], [0]);
  }
});

test('smcGroup: random groups of stores into data, the code ahead in the block, across a code page, the null page', () => {
  // Stores through [ebx + d] (ebx from a table, per iteration) of bytes that are all one-byte INC / DEC of eax, edx, esi,
  // edi (0x40 0x42 0x46 0x47 0x48 0x4a 0x4e 0x4f; OR 0x08 / AND 0xf7 keep a byte in that set), so that stores into the
  // sled of `inc esi` that follows them in the block change what it computes; the loop starts 0x30 bytes before a page
  // boundary (the sled crosses it). Pointers into the data, the sled, the page boundary, the null page's two edges.
  const OK = [0x40, 0x42, 0x46, 0x47, 0x48, 0x4a, 0x4e, 0x4f], ob = () => OK[rnd(OK.length)];
  const SLED = 64;
  const store = () => {
    const d = rnd(28);
    switch (rnd(7)) {
      case 0: return [0xc6, 0x43, d, ob()]; // mov byte [ebx+d], imm8
      case 1: return [0x66, 0xc7, 0x43, d, ob(), ob()]; // mov word [ebx+d], imm16
      case 2: return [0x80, 0x4b, d, 0x08]; // or byte [ebx+d], 8
      case 3: return [0x80, 0x63, d, 0xf7]; // and byte [ebx+d], 0xf7
      case 4: return [0xc7, 0x43, d, ob(), ob(), ob(), ob()]; // (a register store would carry the sled's counts: an immediate)
      default: return [0xc7, 0x43, d, ob(), ob(), ob(), ob()]; // mov dword [ebx+d], imm32
    }
  };
  for (let t = 0, n = depth(120, 10); t < n; t++) {
    const s0 = seed, pre = [], post = [];
    for (let k = 1 + rnd(5); k--;) pre.push(...store());
    for (let k = rnd(3); k--;) post.push(...store());
    // L: mov ebx, [ebp+ecx*4] ; <stores> ; sled ; <stores> ; call FN ; mov edi, 0x4f4e4847 ; dec ecx ; jnz L ; hlt
    // FN (CODE + 0x3000, after a page without code): a sled of `inc edx` and RET; stores from the page before reach it
    // while their group's first store does not (the group's span checked, not only its first store)
    const START = 0x1000 - 4 - pre.length - 8 - rnd(32); // (the sled starts 8 to 40 bytes before a page boundary)
    const body = [0x8b, 0x5c, 0x8d, 0x00, ...pre, ...new Array(SLED).fill(0x46), ...post];
    body.push(0xe8, ...le(0x3000 - (START + body.length + 5)), 0xbf, ...le(0x4f4e4847), 0x49);
    body.push(0x0f, 0x85, ...le(-(body.length + 6)), 0xf4);
    const code = Uint8Array.from([0xe9, ...le(START - 5), ...new Array(START - 5).fill(0xcc), ...body]);
    const sled = CODE + START + 4 + pre.length;
    const iters = 1 + rnd(12);
    const ptrs = Array.from({ length: iters + 1 }, () => {
      switch (rnd(8)) {
        case 0: case 1: return DATA + rnd(0x100);
        case 2: case 3: case 4: return sled + rnd(SLED - 31); // the sled ahead (each store within it), across the page boundary
        case 5: return rnd(2) ? CODE + START - 32 - rnd(16) : CODE + 0x3000 - 1 - rnd(28); // the padding before the loop, on its page; the page before FN
        case 6: return rnd(4) ? DATA + 0x800 : 0x10000 - 1 - rnd(28); // the null page's lower edge (rarely: a fault)
        default: return rnd(4) ? DATA + 0x900 : 0x7fff0000 - 1 - rnd(28); // and its upper edge
      }
    });
    check(`smc group program ${t} (seed ${s0})`, code, (E) => {
      E.cpu.ecx = iters; E.cpu.ebp = DATA + 0x1000; E.cpu.esp = DATA + 0x1800; E.cpu.edi = 0x46474a4e; E.cpu.eflags = F.RESERVED1 | F.IF;
      E.mem.fill(DATA, 0x1000, 0x46); E.mem.fill(CODE + 0x3000, 32, 0x42); E.mem.write8(CODE + 0x3020, 0xc3);
      ptrs.forEach((p, i) => E.mem.write32(DATA + 0x1000 + 4 * i, p));
    }, 'smcGroup');
    seed = s0 + 1;
  }
});

test('smcGroup: a store of the group reaches code its first store does not (span checked from its lowest page)', () => {
  // call FN ; mov ebx, P ; <leader> ; <member> ; call FN ; hlt — FN: a sled of `inc edx` (0x42) that the member's store
  // rewrites (0x47: inc edi), its leader's own store on a page without code
  const FN = CODE + 0x3000, FN2 = CODE + 0x3ff0;
  const cases = [
    // leader on the page before FN's (no code there, SMC_NEXT only), the member into FN: the span crosses into FN's page
    ['span crossing into the next page', FN, FN - 12, [0xc6, 0x43, 8, 0x46], [0xc6, 0x43, 16, 0x47]],
    // leader on the page after FN2's (no code there nor after: its map byte is 0), the member (the group's lowest
    // displacement) into FN2 at the end of its page: the first page tested is the span's, not the leader's
    ['lowest displacement on the code page', FN2, FN2 + 4, [0xc6, 0x43, 12, 0x46], [0xc6, 0x43, 0, 0x47]],
  ];
  for (const [name, fn, p, leader, member] of cases) {
    const main = [0xe8, ...le(fn - (CODE + 5)), 0xbb, ...le(p), ...leader, ...member];
    main.push(0xe8, ...le(fn - (CODE + main.length + 5)), 0xf4);
    check(name, Uint8Array.from(main), (E) => {
      E.cpu.esp = DATA + 0x1800; E.cpu.eflags = F.RESERVED1 | F.IF;
      // FN: 32 x inc edx ; ret      FN2 (0x3ff0): 14 x inc edx ; jmp short to a RET at 0x3fd0
      E.mem.fill(FN, 32, 0x42); E.mem.write8(FN + 32, 0xc3);
      E.mem.write8(CODE + 0x3fd0, 0xc3); E.mem.fill(FN2, 14, 0x42); E.mem.write8(FN2 + 14, 0xeb); E.mem.write8(FN2 + 15, (0x3fd0 - 0x4000) & 0xff);
    }, 'smcGroup', [true, false], [0]);
  }
});

test('apiInline: calls through registers, vtables and import stubs to fast-path thunks match the dispatcher', () => {
  // the reference: the same JIT without apiInline (the dispatcher runs runtime.js fastApi); slot calls not inlined in
  // either (inlineApi off), so that every call reaches a thunk through a register, a table or a stub's `jmp eax` /
  // `jmp [slot]`; TlsGetValue(70) is not handled by the fast path: the JavaScript handler's part done here
  const APIS = ['SetLastError', 'GetLastError', 'TlsGetValue', 'InterlockedIncrement', 'InterlockedExchangeAdd', 'GetCurrentThreadId'];
  const TBL = DATA + 0x100, TEB = DATA + 0x2000, CNT = DATA + 0x300, STUB = CODE + 0x800, OUT = DATA + 0x400;
  const thunk = (k) => THUNK_BASE + (k + 1) * 16;
  // one call: its arguments pushed, the call, the result folded into esi / stored
  const call = () => {
    const k = rnd(APIS.length), how = rnd(4), out = [];
    switch (APIS[k]) {
      case 'SetLastError': out.push(0x6a, rnd(100)); break;
      case 'TlsGetValue': out.push(0x6a, rnd(4) ? rnd(64) : 70); break;
      case 'InterlockedIncrement': out.push(0x68, ...le(CNT)); break;
      case 'InterlockedExchangeAdd': out.push(0x6a, rnd(9), 0x68, ...le(CNT)); break;
    }
    if (how === 0) out.push(0x8b, 0x43, 4 * k, 0xff, 0xd0); // mov eax, [ebx+4k] ; call eax
    else if (how === 1) out.push(0xff, 0x53, 4 * k); // call [ebx+4k] (a vtable)
    else out.push(0xe8, 0, 0, 0, 0, 0x100 + 16 * k + (how === 3 ? 8 : 0)); // call STUB_k (patched below; marker byte dropped)
    out.push(0x01, 0xc6, 0x89, 0x47, 4 * rnd(16)); // add esi, eax ; mov [edi+4j], eax
    return out;
  };
  for (let t = 0, n = depth(60, 6); t < n; t++) {
    const s0 = seed, body = [];
    for (let k = 1 + rnd(5); k--;) body.push(...call());
    // patch the stub calls: [e8 0 0 0 0 marker] -> e8 rel32 to STUB + (marker - 0x100)
    const code = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 0xe8 && body[i + 1] === 0 && body[i + 2] === 0 && body[i + 3] === 0 && body[i + 4] === 0 && body[i + 5] >= 0x100) {
        const at = CODE + code.length + 5, to = STUB + body[i + 5] - 0x100;
        code.push(0xe8, ...le(to - at)); i += 5;
      } else code.push(body[i]);
    }
    code.push(0x49, 0x0f, 0x85, ...le(-(code.length + 7)), 0xf4);
    const iters = 1 + rnd(6);
    const runOnce = (apiInline, slice) => {
      const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE), I = new Interp(mem, cpu);
      const jit = new Jit(mem, I, { smc: true, inlineApi: false, apiInline }); jit.cpu = cpu;
      cpu.reset(); mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, Uint8Array.from(code));
      APIS.forEach((nm, k) => {
        jit.markFast(k + 1, `kernel32.dll!${nm}`, true); mem.write32(TBL + 4 * k, thunk(k)); mem.write32(TBL + 0x40 + 4 * k, thunk(k));
        mem.writeBytes(STUB + 16 * k, Uint8Array.from([0xb8, ...le(thunk(k)), 0xff, 0xe0])); // mov eax, thunk ; jmp eax
        mem.writeBytes(STUB + 16 * k + 8, Uint8Array.from([0xff, 0x25, ...le(TBL + 0x40 + 4 * k)])); // jmp [slot]
      });
      mem.write32(TEB + 0x24, 0x800); for (let i = 0; i < 64; i++) mem.write32(TEB + 0xe10 + 4 * i, 0x1000 + i);
      mem.write32(CNT, 13);
      cpu.fsBase = TEB; cpu.eip = CODE; cpu.ecx = iters; cpu.ebx = TBL; cpu.edi = OUT; cpu.esp = DATA + 0x1800; cpu.eflags = F.RESERVED1 | F.IF;
      let r, k = 0, js = 0;
      for (;;) {
        r = jit.run({ stopAt: CODE + code.length - 1, maxInsns: slice });
        if (r === EXIT.TIMESLICE && ++k < 1e5) continue;
        if (r === EXIT.THUNK) { // (TlsGetValue(70): the JavaScript handler's part)
          assert.equal(cpu.eip, thunk(2)); cpu.eax = 0xabcd; cpu.eip = mem.read32(cpu.esp); cpu.esp = cpu.esp + 8; js++;
          continue;
        }
        break;
      }
      return { s: [r, js, cpu.eax, cpu.ecx, cpu.esi, cpu.esp, cpu.eip, cpu.eflags & 0x8d5, mem.read32(CNT), mem.read32(TEB + 0x34), hex(mem.bytes(OUT, 64))].join(' '), inl: jit.stats.prof ?? null };
    };
    const want = runOnce(false, 1e6).s;
    for (const slice of [1e6, 5, 2]) assert.equal(runOnce(true, slice).s, want, `api program ${t} (seed ${s0}), slices ${slice}: ${hex(code)}`);
    seed = s0 + 1;
  }
  // the fast path does run from the region: a translation of `call eax` names the runtime's fastApi
  const mem = new GuestMemory(); mem.writeBytes(CODE, Uint8Array.from([0xff, 0xd0, 0xc3]));
  assert.match(listRegion(mem, CODE, { apiInline: true }).text, /^\s+call 19$/m); assert.doesNotMatch(listRegion(mem, CODE, { apiInline: false }).text, /^\s+call 19$/m);
});
