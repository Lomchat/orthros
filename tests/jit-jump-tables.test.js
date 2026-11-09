// opts.jumpTables (translate.js jumpTableOf / Emitter.jumpTable): a `jmp [index*4 + table]` whose table entries were read
// at translation time transfers inside its region when the address it loads is the entry the index selected then, and
// leaves the region otherwise. Randomized switch loops — cases reading the flags set before the jump, an index past the
// entries read (an entry out of the jump's span, one after it), cases rewriting table entries while the loop runs — run
// by the JIT with the option on and off, whole and time-sliced, against the interpreter: every register, the flags and
// memory compared. Also: the region does keep its cases (a local transfer), and does not with the option off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, FAR = CODE + 0x30000, DATA = 0x10000000, TABLE = DATA + 0x400, VALUES = DATA + 0x200;
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

// case bodies: flag readers of the CMP before the jump, flag writers, stores
const body = (cases) => {
  const out = [];
  for (let n = 1 + rnd(3); n--;) {
    switch (rnd(9)) {
      case 0: out.push(0x13, 0xda); break; // adc ebx, edx
      case 1: out.push(0x0f, 0x92, 0xc0, 0x01, 0xc6); break; // setc al ; add esi, eax
      case 2: out.push(0x46); break; // inc esi (CF kept)
      case 3: out.push(0x01, 0xd7); break; // add edi, edx
      case 4: out.push(0x9c, 0x58, 0x25, ...le(0x8d5), 0x01, 0xc6); break; // pushfd ; pop eax ; and eax, 0x8d5 ; add esi, eax
      case 5: out.push(0x89, 0x7d, 0x08); break; // mov [ebp+8], edi
      case 6: out.push(0x19, 0xfb); break; // sbb ebx, edi
      case 7: { const j = rnd(8), k = rnd(cases); out.push(0xc7, 0x05, ...le(TABLE + 4 * j), ...le(k)); out.fix = [...(out.fix ?? []), [out.length - 4, k]]; break; } // a table entry rewritten (to case k)
      default: out.push(0x8d, 0x54, 0x3a, 0x03); // lea edx, [edx+edi+3]
    }
  }
  return out;
};

/** a loop: eax = values[ecx] & 7 ; cmp edx, eax ; jmp [eax*4 + TABLE] ; cases ; next: dec ecx ; jnz loop ; hlt */
function gen() {
  const nc = 2 + rnd(5), out = [];
  out.push(0x8b, 0x04, 0x8d, ...le(VALUES)); // mov eax, [ecx*4 + VALUES]
  out.push(0x83, 0xe0, 0x07); // and eax, 7
  out.push(0x39, 0xc2); // cmp edx, eax
  out.push(0xff, 0x24, 0x85, ...le(TABLE)); // jmp [eax*4 + TABLE]
  const caseAt = [], jmps = [], fixes = [];
  for (let k = 0; k < nc; k++) {
    caseAt.push(CODE + out.length);
    const b = body(nc); for (const [at, c] of b.fix ?? []) fixes.push([out.length + at, c]);
    out.push(...b, 0xe9, 0, 0, 0, 0); jmps.push(out.length - 4);
  }
  const next = out.length;
  out.push(0x49, 0x0f, 0x85, ...le(-(out.length + 7)), 0xf4); // dec ecx ; jnz 0 ; hlt
  for (const at of jmps) out.splice(at, 4, ...le(next - (at + 4)));
  const code = Uint8Array.from(out);
  for (const [at, c] of fixes) new DataView(code.buffer).setUint32(at, caseAt[c], true);
  // the table: cases (some twice), then one entry out of the jump's span (reading stops there) and one more case
  const table = [];
  for (let i = 0; i < 6; i++) table.push(caseAt[rnd(nc)]);
  table.push(FAR, caseAt[0]);
  const far = Uint8Array.from([0x81, 0xc7, ...le(0x55), 0xe9, ...le(CODE + next - (FAR + 11))]); // add edi, 0x55 ; jmp next
  return { code, table, far, end: CODE + next + 7 };
}

function makeExec(jitOpts) {
  const mem = new GuestMemory(); const cpu = new CpuState(mem, THREAD_STATES_BASE); const I = new Interp(mem, cpu);
  const jit = jitOpts ? new Jit(mem, I, { smc: true, ...jitOpts }) : null;
  return {
    mem, cpu,
    load(p, values, regs) {
      cpu.reset(); mem.fill(CODE, 0x10000, 0xcc); mem.fill(DATA, 0x1000, 0); mem.writeBytes(CODE, p.code); mem.writeBytes(FAR, p.far);
      p.table.forEach((t, i) => mem.write32(TABLE + 4 * i, t)); values.forEach((v, i) => mem.write32(VALUES + 4 * i, v));
      cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.ebp = DATA + 0x100;
      [cpu.ecx, cpu.edx, cpu.ebx, cpu.esi, cpu.edi] = regs; cpu.eflags = F.RESERVED1 | F.IF;
    },
    run(stopAt, maxInsns) { if (!jit) return I.run({ stopAt, maxInsns }); jit.cpu = cpu; return jit.run({ stopAt, maxInsns }); },
    jit,
  };
}

test('jumpTables: random switch loops match the interpreter (on and off, whole and time-sliced)', () => {
  for (let t = 0; t < 80; t++) {
    const p = gen();
    const values = Array.from({ length: 32 }, () => rnd(4) ? rnd(8) : (rnd(65536) << 16 | rnd(65536)) >>> 0);
    const regs = [1 + rnd(31), rnd(10), rnd(1000), rnd(1000), rnd(1000)];
    const EI = makeExec(null); EI.load(p, values, regs); const ri = EI.run(p.end, 1e5);
    const snap = (E) => [E.cpu.eax, E.cpu.ecx, E.cpu.edx, E.cpu.ebx, E.cpu.esi, E.cpu.edi, E.cpu.eflags & 0x8d5, E.cpu.eip, E.mem.read32(DATA + 0x108),
      ...Array.from({ length: 8 }, (_, i) => E.mem.read32(TABLE + 4 * i))].map((x) => (x >>> 0).toString(16)).join(' ');
    const a = snap(EI);
    for (const jumpTables of [true, false]) for (const slice of [0, 3, 7, 40]) {
      const EJ = makeExec({ jumpTables }); EJ.load(p, values, regs); let r, k = 0;
      while ((r = EJ.run(p.end, slice || 1e5)) === EXIT.TIMESLICE && ++k < 1e5);
      const what = `program ${t}, jumpTables ${jumpTables}, slices ${slice}: ${Buffer.from(p.code).toString('hex')} table ${p.table.map((x) => x.toString(16)).join(' ')} values ${values.join(',')}`;
      assert.equal(r, ri, what);
      assert.equal(snap(EJ), a, what);
    }
  }
});

test('jumpTables: the cases stay in the region (and leave it with the option off)', () => {
  for (const jumpTables of [true, false]) {
    seed = 99;
    const p = gen();
    const E = makeExec({ jumpTables, profile: true }); E.load(p, Array.from({ length: 32 }, (_, i) => i % 6), [31, 1, 2, 3, 4]);
    E.run(p.end, 1e5);
    const r = E.jit.regionAt(CODE);
    assert.ok(r, 'a region at the loop');
    const local = r.blocks.filter((b) => p.table.slice(0, 6).includes(b.eip)).length;
    if (jumpTables) assert.ok(local >= 1, 'the cases are blocks of the region'); else assert.equal(local, 0);
  }
});
