// Lazy flag state predicted at block entries (translate.js regionLazyPrediction / pushCondDynamic): a block reading
// flags it did not set tests the run-time lazy op against the one its in-region predecessors leave, evaluates the
// condition inline when it matches and takes the full dispatch otherwise. Checked against the interpreter for every
// condition after every flag writer, entering the reading block both through its predicted predecessor and from
// elsewhere (an indirect jump: another lazy op than predicted); and no flags helper call is left in integer regions
// (SHL's CF/OF are now computed inline by the dispatch as well).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { translateRegion, IMP_FLAGS } from '../src/cpu/jit/translate.js';

const CODE = 0x20000000, DATA = 0x10000000;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

function makeExec(useJit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true }) : null;
  return {
    mem, cpu,
    load(code) {
      cpu.reset();
      mem.fill(CODE, 0x10000, 0xcc); mem.fill(DATA, 0x400, 0);
      mem.writeBytes(CODE, code);
      cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.ebx = 0; cpu.edi = 0;
      cpu.eflags = F.RESERVED1 | F.IF;
    },
    run(stopAt, maxInsns = 1e6) {
      if (!jit) return I.run({ stopAt, maxInsns });
      jit.cpu = cpu;
      return jit.run({ stopAt, maxInsns });
    },
  };
}

// flag writers on eax (ecx = 3: second operand / shift count), every lazy kind and size (SHL: counts below, equal to
// and above the operand size)
const WRITERS = [[0x40], [0x48], [0xfe, 0xc0], [0x66, 0x48], [0xf7, 0xd8], [0xf6, 0xd8], [0x83, 0xc0, 0x01], [0x83, 0xe8, 0x01], [0x04, 0x01],
  [0x66, 0x2d, 0x01, 0x00], [0x83, 0xd0, 0x00], [0x83, 0xd8, 0x00], [0x01, 0xc8], [0x29, 0xc8], [0x85, 0xc0], [0x84, 0xc0], [0xd1, 0xe8], [0xd1, 0xf8],
  [0xd1, 0xe0], [0xc0, 0xe0, 0x03], [0xc0, 0xe0, 0x08], [0xc0, 0xe0, 0x0a], [0x66, 0xc1, 0xe0, 0x10], [0x66, 0xc1, 0xe0, 0x11], [0x66, 0xc1, 0xe0, 0x0f], [0xc1, 0xe0, 0x1f], [0xd2, 0xe0], [0xc1, 0xe8, 0x03], [0xc0, 0xf8, 0x03], [0xd3, 0xe8],
  [0x0f, 0xa4, 0xc8, 0x03], [0x3c, 0x80], [0x66, 0x3d, 0x00, 0x80], [0x3b, 0xc1]];
const EDGE = [0, 1, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x80000001];
/** readers at the head of block B, then accumulated into ebx: setcc cc ; or: dec edi / inc edi (CF kept) then setc / setcc */
const READERS = [];
for (let cc = 0; cc < 16; cc++) READERS.push([0x0f, 0x90 + cc, 0xc1]); // setcc cl
READERS.push([0x4f, 0x0f, 0x92, 0xc1], [0x47, 0x0f, 0x96, 0xc1], [0x4f, 0x0f, 0x9c, 0xc1]); // dec edi ; setb cl / inc edi ; setbe cl / dec edi ; setl cl

/**
 * One case per value and reader: A: mov eax, v ; mov ecx, 3 ; stc|clc ; <writer> ; then either `jmp P` (predicted
 * path) or `jecxz P ; mov edx, B ; jmp edx` (B entered with the writer's lazy op, P never runs; the untaken JECXZ,
 * which leaves the flags alone, puts P and B in the region); P: <predictor> ; jmp B ; B: <reader> ;
 * mov [DATA + case], cl ; next case. P is B's only in-region predecessor: B's predicted lazy op is the predictor's
 * (a 32-bit CMP, or the writer itself).
 */
function program(w, values, viaPredictor, predictor) {
  const bytes = [];
  let n = 0;
  for (const v of values) for (let k = 0; k < READERS.length; k++, n++) {
    bytes.push(0xb8, ...le(v), 0xb9, 3, 0, 0, 0, n & 1 ? 0xf9 : 0xf8, ...w);
    let fix, abs;
    if (viaPredictor) { bytes.push(0xe9); fix = bytes.length; bytes.push(0, 0, 0, 0); } else {
      bytes.push(0xe3, 7, 0xba); abs = bytes.length; bytes.push(0, 0, 0, 0, 0xff, 0xe2);
    }
    const P = bytes.length;
    bytes.push(...predictor, 0xe9, 0, 0, 0, 0); // P: predictor ; jmp B (rel 0: B follows)
    const B = bytes.length;
    bytes.push(...READERS[k], 0x88, 0x0d, ...le(DATA + n)); // reader ; mov [DATA + n], cl
    if (fix !== undefined) bytes.splice(fix, 4, ...le(P - (fix + 4))); else bytes.splice(abs, 4, ...le(CODE + B));
  }
  bytes.push(0xf4);
  return { code: Uint8Array.from(bytes), cases: n };
}
function check(w, values, via, predictor, what, slices = [0]) {
  const { code, cases } = program(w, values, via, predictor), end = CODE + code.length - 1;
  const EI = makeExec(false); EI.load(code); assert.equal(EI.run(end), EXIT.HALT);
  const want = Buffer.from(EI.mem.bytes(DATA, cases)).toString('hex');
  for (const slice of slices) {
    const EJ = makeExec(true); EJ.load(code);
    let r, k = 0;
    while ((r = EJ.run(end, slice || 1e6)) === EXIT.TIMESLICE) assert.ok(++k < 1e6, 'runaway');
    assert.equal(r, EXIT.HALT);
    const at = `writer ${w.map((b) => b.toString(16)).join(' ')}, ${what}${slice ? `, slices of ${slice}` : ''}`;
    assert.equal(Buffer.from(EJ.mem.bytes(DATA, cases)).toString('hex'), want, at);
    assert.equal(EJ.cpu.edi, EI.cpu.edi, at);
  }
}

test('lazy op predicted at a block entry: every condition after every writer, predicted path and mispredicted entries, match the interpreter', () => {
  for (const w of WRITERS) {
    for (const via of [true, false]) {
      check(w, EDGE, via, [0x39, 0xc8], `predictor cmp, ${via ? 'through it' : 'indirect entry'}`); // cmp eax, ecx (SUB 32)
      check(w, EDGE, via, w, `predictor = writer, ${via ? 'through it' : 'indirect entry'}`); // (the prediction holds on both paths)
    }
  }
});

test('lazy op prediction: time-sliced runs (entries by the dispatcher at every block) match the interpreter', () => {
  for (const w of WRITERS) check(w, [0x80, 0xffffffff], true, [0x39, 0xc8], 'predictor cmp', [1, 3, 7]);
});

test('no flags helper call for conditions read at a block entry (JCC after JCC, DEC at a block head, after SHL)', () => {
  const mem = new GuestMemory();
  // L: shl eax, 3 ; cmp eax, edx ; je X ; jb Y ; Y: dec ecx ; jnz L ; X: hlt       (JB, then DEC's preserved CF: block entries)
  // + a block after `shl eax, 3` alone ending in a jump, read by the next block's JL / DEC
  const code = [0xc1, 0xe0, 0x03, 0x39, 0xd0, 0x74, 0x0f, 0x72, 0x00, 0x49, 0x75, 0xf3, 0xc1, 0xe0, 0x03, 0xeb, 0x00, 0x7c, 0x00, 0x4a, 0x75, 0xe9, 0xf4];
  mem.fill(CODE, 0x100, 0xcc);
  mem.writeBytes(CODE, Uint8Array.from(code));
  const { stats } = translateRegion(mem, CODE, {});
  const flagsCalls = [];
  for (let i = 0; i < (stats.calls ?? []).length; i += 2) if (stats.calls[i] === IMP_FLAGS) flagsCalls.push(stats.calls[i + 1]);
  assert.deepEqual(flagsCalls, []);
});
