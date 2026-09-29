// x87 regions whose in-region branches leave values pushed or popped (translate.js x87EntryPlan): blocks entered with
// a planned non-zero shift of the stack locals, in-region transfers rotating only by the difference to the target's
// plan, region entries into a planned block (time slices re-entering a loop, another x87 mode's version) loading the
// locals for its plan in the prologue. Generated programs (x87 pushes / pops / arithmetic on values kept across JCCs,
// JMPs and loops, the C-runtime shape `fld ; jcc ; ... fstp`, interpreter fallbacks the static plan does or does not
// foresee) run under the JIT at every time slice and must leave the whole x87 state (the 8 physical registers, TOP,
// tags, condition codes), the registers and memory as the interpreter does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { translateRegion } from '../src/cpu/jit/translate.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x1000;
const MEMOP = DATA + 0x100; // esi: base of the [esi+disp8] operands
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const SW_CC = (1 << 8) | (1 << 9) | (1 << 10) | (1 << 14);
const hex = (v) => '0x' + (v >>> 0).toString(16);

function makeExec(jit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const J = jit ? new Jit(mem, I, { smc: true }) : null;
  return {
    mem, cpu, I, J,
    run(end, slice = 1e6) {
      I.cache.clear();
      if (!J) return I.run({ stopAt: end, maxInsns: 1e7 });
      J.reset(); J.cpu = cpu; J.boundaries = new Set([end]);
      let r, n = 0;
      do r = J.run({ stopAt: end, maxInsns: slice }); while (r === EXIT.TIMESLICE && ++n < 1e6);
      return r;
    },
  };
}
const EI = makeExec(false), EJ = makeExec(true);

function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }

function snapshot(E) {
  const { mem, cpu: c } = E;
  const s = { eip: hex(c.eip), eflags: hex(c.eflags & ARITH), regs: [], top: c.fpuTop, tw: c.fpuTw.toString(2).padStart(8, '0'), cc: hex(c.fpuSw & SW_CC), fpr: [], mem: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(c.reg(k)));
  for (let k = 0; k < 8; k++) s.fpr.push(Object.is(c.fpr(k), -0) ? '-0' : String(c.fpr(k)));
  return s;
}

function runBoth(code, seed, label, slice, init) {
  for (const E of [EI, EJ]) {
    const { mem, cpu } = E;
    cpu.reset();
    mem.fill(DATA, DATA_SIZE, 0);
    mem.fill(CODE - 0x100, 0x3000, 0xcc);
    mem.writeBytes(CODE, code);
    mem.u8[SMC_MAP_BASE + (CODE >>> 12)] = 0;
    const r = prng(seed);
    for (let i = 0; i < 0x100; i += 8) mem.writeF64(MEMOP + i, ((r() % 2000) - 1000) / 64);
    for (let k = 0; k < 8; k++) cpu.setReg(k, r());
    cpu.esi = MEMOP; cpu.esp = DATA + 0xf00;
    cpu.eflags = F.RESERVED1 | F.IF | (r() & ARITH);
    init?.(E);
    cpu.eip = CODE;
  }
  const end = CODE + code.length;
  const ri = EI.run(end), rj = EJ.run(end, slice);
  assert.equal(ri, EXIT.HALT, `${label}: interpreter exit ${ri}`);
  assert.equal(rj, EXIT.HALT, `${label}: jit exit ${rj}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI), `${label}: jit state differs from the interpreter`);
}

// ---------------------------------------------------------------- program generator
// x87 operations with a known stack effect, chosen so that the stack never under- or overflows on any path (the depth
// is the same at every join: a JCC only skips a balanced group, a loop body is balanced)
const md = (r) => (r() % 0x20) * 8; // [esi + disp8]
function push(r, d) {
  const k = r() % 4;
  if (k === 0) return [0xdd, 0x46, md(r)]; // fld qword [esi+d]
  if (k === 1) return [0xd9, 0xe8]; // fld1
  if (k === 2 && d > 0) return (r() & 3) ? [0xd9, 0xc0 + (r() % d)] : [0xd9, 0xf4]; // fld st(i) / fxtract (an interpreter fallback)
  return [0xd9, 0x46, md(r)]; // fld dword [esi+d]
}
function pop(r, d) {
  const k = r() % 4;
  if (k === 0 && d >= 2) return [0xde, 0xc1]; // faddp
  if (k === 1 && d >= 2) return [0xde, 0xc9]; // fmulp
  if (k === 2 && d >= 2) return [0xdd, 0xd9]; // fstp st(1)
  return [0xdd, 0x5e, md(r)]; // fstp qword [esi+d]
}
function neutral(r, d) {
  const k = r() % 8;
  if (k === 0 && d >= 2) return [0xd9, 0xc8 + 1 + (r() % (d - 1))]; // fxch st(i)
  if (k === 1 && d >= 1) return [0xd8, 0xc0 + (r() % d)]; // fadd st0, st(i)
  if (k === 2 && d >= 1) return [0xdc, 0x4e, md(r)]; // fmul qword [esi+d]
  if (k === 3 && d >= 1) return [0xdd, 0x56, md(r)]; // fst qword [esi+d]
  if (k === 4 && d >= 1) return [0xd9, 0xe0]; // fchs
  if (k === 5) return [[0x01, 0xd3], [0x29, 0xd3], [0x83, 0xf9, 0x40], [0xf7, 0xc3, 1, 0, 0, 0]][r() % 4]; // add ebx,edx / sub ebx,edx / cmp ecx,0x40 / test ebx,1 (ecx is a loop counter)
  if (k === 6) return [0x83, 0xe3, 0x1f, 0x0f, 0xa3, 0x1e]; // and ebx, 31 ; bt [esi], ebx (a fallback the plan does not foresee)
  return [0x42]; // inc edx
}
/** A balanced group: push ; neutral ; pop (or nothing at a full stack). */
function balanced(r, d) { return d < 7 ? [...push(r, d), ...neutral(r, d + 1), ...pop(r, d + 1)] : [...neutral(r, d)]; }

function program(seed, n = 30) {
  const r = prng(seed);
  const out = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const k = r() % 10;
    if (k < 3 && d < 6) { out.push(...push(r, d)); d++; }
    else if (k < 5 && d > 0) { out.push(...pop(r, d)); d--; }
    else if (k < 6) out.push(...neutral(r, d));
    else if (k < 8) { const g = balanced(r, d); out.push(0x70 + (r() & 15), g.length, ...g); } // jcc over a balanced group
    else if (k < 9) out.push(0xeb, 0x00); // jmp +0: a block boundary with the pending shift
    else { // a loop entered with values pushed: mov ecx, n ; L: <balanced> ; dec ecx ; jnz L
      const body = [...balanced(r, d), ...(r() & 1 ? balanced(r, d) : [])];
      out.push(0xb9, 2 + (r() % 4), 0, 0, 0, ...body, 0x49, 0x75, (-(body.length + 3)) & 0xff);
    }
  }
  while (d-- > 0) out.push(0xdd, 0x5e, 0x80 + 8 * (d & 7)); // leave the values in memory: fstp qword [esi-0x80+8k]
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- tests
test('the C-runtime shape: an argument pushed before a JCC, a result pushed before a JMP to the common store', () => {
  //    mov ecx, 30
  // L: fld qword [esi] ; cmp ecx, 7 ; jb tiny ; fmul qword [esi+16] ;
  //    fstp qword [esi+24] ; fld qword [esi+24] ; fadd st0, st0 ; jmp store
  // tiny: fld1 ; faddp
  // store: fstp qword [esi+32] ; fld qword [esi+32] ; fstp qword [esi] ; dec ecx ; jnz L
  const L = [0xdd, 0x06, 0x83, 0xf9, 0x07];
  const body = [0xdc, 0x4e, 0x10, 0xdd, 0x5e, 0x18, 0xdd, 0x46, 0x18, 0xd8, 0xc0];
  const tiny = [0xd9, 0xe8, 0xde, 0xc1];
  const store = [0xdd, 0x5e, 0x20, 0xdd, 0x46, 0x20, 0xdd, 0x1e, 0x49];
  const loop = [...L, 0x72, body.length + 2, ...body, 0xeb, tiny.length, ...tiny, ...store];
  const code = Uint8Array.from([0xb9, 30, 0, 0, 0, ...loop, 0x75, (-(loop.length + 2)) & 0xff]);
  for (const slice of [1e6, 13, 5, 3, 2, 1]) runBoth(code, 5, `slice ${slice}`, slice);
  // the region is translated with planned entry shifts: the blocks after the JB (both paths) and the store
  const mem = new GuestMemory(); mem.writeBytes(CODE, code);
  assert.ok(translateRegion(mem, CODE, { smc: true }).stats.x87Planned >= 3);
});

test('a loop entered with a value pushed: its header is planned, time slices re-enter it through the dispatcher', () => {
  //    fld1 ; mov ecx, 40 ; L: fld qword [esi+8] ; faddp ; fld st0 ; fmul qword [esi] ; fstp qword [esi+16] ; dec ecx ;
  //    jnz L ; fstp qword [esi+24]
  const body = [0xdd, 0x46, 0x08, 0xde, 0xc1, 0xd9, 0xc0, 0xdc, 0x0e, 0xdd, 0x5e, 0x10, 0x49];
  const code = Uint8Array.from([0xd9, 0xe8, 0xb9, 40, 0, 0, 0, ...body, 0x75, (-(body.length + 2)) & 0xff, 0xdd, 0x5e, 0x18]);
  for (const slice of [1e6, 7, 4, 3, 2, 1]) runBoth(code, 9, `slice ${slice}`, slice);
  const mem = new GuestMemory(); mem.writeBytes(CODE, code);
  assert.ok(translateRegion(mem, CODE, { smc: true }).stats.x87Planned >= 1); // (the loop header, through its back edge)
});

test('a planned loop header re-entered under another x87 mode (the entry check reloads at shift 0 and leaves)', () => {
  //    fld1 ; mov ecx, 12 ; L: fld qword [esi+8] ; faddp ; mov eax, ecx ; and eax, 1 ; fldcw [esi+eax*8+0x40] ;
  //    fld st0 ; fmul qword [esi] ; fstp qword [esi+16] ; dec ecx ; jnz L ; fstp qword [esi+24]
  // (the control word alternates between 53-bit and 24-bit precision: every back edge leaves the region, whose
  // version for the other mode is entered at the loop header)
  const body = [0xdd, 0x46, 0x08, 0xde, 0xc1, 0x89, 0xc8, 0x83, 0xe0, 0x01, 0xd9, 0x6c, 0xc6, 0x40,
    0xd9, 0xc0, 0xdc, 0x0e, 0xdd, 0x5e, 0x10, 0x49];
  const code = Uint8Array.from([0xd9, 0xe8, 0xb9, 12, 0, 0, 0, ...body, 0x75, (-(body.length + 2)) & 0xff, 0xdd, 0x5e, 0x18]);
  const init = (E) => { E.mem.write32(MEMOP + 0x40, 0x027f); E.mem.write32(MEMOP + 0x48, 0x007f); E.mem.writeF64(MEMOP, 1 / 3); };
  for (const slice of [1e6, 5, 2, 1]) runBoth(code, 21, `slice ${slice}`, slice, init);
});

test('joins reached with different shifts rotate by the difference', () => {
  // cmp ecx, edx ; jb A ; fld1 ; fld1 ; jmp J ; A: fldz ; J: fstp qword [esi] ; test edx, 1 ; jz K ; fld1 ; K: fld1 ;
  // fstp qword [esi+8] ; fninit (J and K are reached with shifts differing by one; the stack never under- or overflows)
  const code = Uint8Array.from([0x39, 0xd1, 0x72, 0x06, 0xd9, 0xe8, 0xd9, 0xe8, 0xeb, 0x02, 0xd9, 0xee, 0xdd, 0x1e,
    0xf7, 0xc2, 1, 0, 0, 0, 0x74, 0x02, 0xd9, 0xe8, 0xd9, 0xe8, 0xdd, 0x5e, 0x08, 0xdb, 0xe3]);
  for (let seed = 1; seed <= 16; seed++) for (const slice of [1e6, 2, 1]) runBoth(code, seed, `seed ${seed} slice ${slice}`, slice);
});

test('generated programs keeping x87 values across branches and loops match the interpreter', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const code = program(seed * 6007 + 1);
    runBoth(code, seed, `seed ${seed} (${Buffer.from(code).toString('hex')})`);
  }
});

test('generated programs survive time slices at every instruction (dispatcher entries into planned blocks)', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const code = program(seed * 7703 + 2, 20);
    runBoth(code, seed + 500, `slice seed ${seed} (${Buffer.from(code).toString('hex')})`, 1 + (seed % 4));
  }
});
