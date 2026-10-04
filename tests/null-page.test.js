// The null page (src/cpu/nullpage.js): guest reads and writes in the first 64 KiB fault as on Windows — an access
// violation at the instruction, nothing of it done, with the address and the read/write flag — in the reference
// interpreter and in the JIT alike. Hand-written forms (every kind of memory operand the rule names), then random
// programs (null, small, valid pointers through loads, stores, read-modify-writes, string instructions, null tests and
// if-converted arms) run in time slices, against the interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { decode } from '../src/cpu/decoder.js';
import { nullChecks } from '../src/cpu/nullpage.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import '../src/cpu/jit/translate-sse-float.js';
import '../src/cpu/jit/translate-sse-int.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x10000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);
const bytesOf = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }

/** an executor: the interpreter, or the JIT with translator options */
function makeExec(jitOpts, mode = true) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  I.nullPage = mode; // (nullpage.js nullPageMode: true reads and writes, 'writes', false)
  const jit = jitOpts ? new Jit(mem, I, { smc: true, nullPage: mode, ...jitOpts }) : null;
  return {
    mem, cpu, I, jit,
    /** run from CODE to `end` in slices of `slice` instructions; the exit code */
    run(end, slice = 1e6, total = 2e6) {
      I.cache.clear();
      if (jit) { jit.reset(); jit.boundaries = new Set([end]); jit.cpu = cpu; }
      for (let left = total; left > 0; left -= slice) {
        const r = jit ? jit.run({ stopAt: end, maxInsns: slice }) : I.run({ stopAt: end, maxInsns: slice });
        if (r !== EXIT.TIMESLICE && !(r === EXIT.NONE && !jit)) return r;
        if (!jit && cpu.exit !== EXIT.NONE && cpu.exit !== EXIT.TIMESLICE) return cpu.exit;
      }
      return EXIT.TIMESLICE;
    },
    get fault() { return jit ? jit.lastFault : I.lastFault; },
  };
}

// (zero, as in a process: nothing can store there — the JIT clears what a plain store wrote before leaving, see NC_STORE_SMC)
const NULL_FILL = 0;
/** identical start state: code at CODE, a pattern in the null page and DATA, registers */
function load(E, code, regs, seed = 1) {
  const { mem, cpu } = E, r = prng(seed);
  cpu.reset();
  mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code);
  mem.fill(0, 0x10000, NULL_FILL);
  for (let i = 0; i < DATA_SIZE; i += 4) mem.write32(DATA + i, r());
  for (let k = 0; k < 8; k++) cpu.setReg(k, 0);
  cpu.esp = DATA + DATA_SIZE - 0x100;
  cpu.eflags = F.RESERVED1 | F.IF;
  cpu.fsBase = DATA + 0x8000; cpu.gsBase = 0;
  mem.u8[SMC_MAP_BASE + (CODE >>> 12)] = 0;
  for (const [k, v] of Object.entries(regs)) cpu[k] = v >>> 0;
  cpu.eip = CODE;
}
function nullPageIntact(mem) { const b = mem.bytes(0, 0x10000); for (let i = 0; i < b.length; i++) if (b[i] !== NULL_FILL) return `byte ${hex(i)} = ${hex(b[i])}`; return 'intact'; }
function snapshot(E) {
  const { mem, cpu } = E;
  const s = { eip: hex(cpu.eip), eflags: hex(cpu.eflags & ARITH), regs: [], xmm: [], top: cpu.fpuTop, tw: cpu.fpuTw, nullPage: nullPageIntact(mem), data: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('base64') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(cpu.reg(k)));
  for (let k = 0; k < 8; k++) s.xmm.push(Buffer.from(mem.bytes(cpu.xmmAddr(k), 16)).toString('hex'));
  return s;
}

// [form, code (hex), registers, offset of the faulting instruction in the code, fault address, write] — or no fault
const P = DATA + 0x400; // a valid pointer
const FORMS = [
  ['mov eax,[ecx+8]', '8b4108', { ecx: 0 }, 0, 8, false],
  ['mov [ecx+0x7ffc],eax', '8981fc7f0000', { ecx: 0, eax: 0x1234 }, 0, 0x7ffc, true],
  ['add dword [ecx],1 (read first)', '830101', { ecx: 0 }, 0, 0, false],
  ['call [ecx+0x10] (null vtable)', 'ff5110', { ecx: 0 }, 0, 0x10, false],
  ['push dword [ecx+4]', 'ff7104', { ecx: 0 }, 0, 4, false],
  ['pop dword [ecx+0xc] (ESP unchanged)', '8f410c', { ecx: 0 }, 0, 0xc, true],
  ['movzx eax,byte [ecx+0xffff]', '0fb681ffff0000', { ecx: 0 }, 0, 0xffff, false],
  ['mov eax,[ecx+0x10000]: the first mapped address', '8b8100000100', { ecx: 0 }, -1],
  ['mov eax,[ecx-4] at 0xffff', '8b41fc', { ecx: 0x10003 }, 0, 0xffff, false],
  ['mov eax,[ecx-4] at 0x10000', '8b41fc', { ecx: 0x10004 }, -1],
  ['mov eax,[ecx-4], ECX null: past the user address space', '8b41fc', { ecx: 0 }, 0, 0xfffffffc, false],
  ['mov eax,[ecx+0x7ffe0000] (KUSER_SHARED_DATA)', '8b810000fe7f', { ecx: 0 }, -1],
  ['mov eax,[ecx+0x7fff0000]', '8b810000ff7f', { ecx: 0 }, 0, 0x7fff0000, false],
  ['lea eax,[ecx+8]: no access', '8d4108', { ecx: 0 }, -1],
  ['nop dword [ecx]: no access', '0f1f01', { ecx: 0 }, -1],
  ['prefetcht0 [ecx]: no access', '0f1809', { ecx: 0 }, -1],
  ['rep movsd from null (ECX kept)', 'f3a5', { esi: 0, edi: P, ecx: 4 }, 0, 0, false],
  ['rep movsd to null', 'f3a5', { esi: P, edi: 0x100, ecx: 4 }, 0, 0x100, true],
  ['rep stosd, zero count: no access', 'f3ab', { edi: 0, ecx: 0 }, -1],
  ['stosb', 'aa', { edi: 0x20, eax: 0x41 }, 0, 0x20, true],
  ['lodsd', 'ad', { esi: 0x30 }, 0, 0x30, false],
  ['repe cmpsb', 'f3a6', { esi: P, edi: 0, ecx: 3 }, 0, 0, false],
  ['xlatb', 'd7', { ebx: 0, eax: 0x41 }, 0, 0x41, false],
  ['bt [ecx],edx: bit string in the null page', '0fa311', { ecx: 0, edx: 8 }, 0, 0, false],
  ['bt [ecx],edx: bit string past it', '0fa311', { ecx: 0, edx: 0x80000 }, -1],
  ['bt [ecx],edx: bit string back into it', '0fa311', { ecx: 0x10000, edx: 0xffffffe0 }, 0, 0xfffc, false],
  ['bts [ecx],3', '0fba2903', { ecx: 0 }, 0, 0, false],
  ['cmpxchg [ecx],edx', '0fb111', { ecx: 0 }, 0, 0, false],
  ['xchg [ecx],eax', '8701', { ecx: 0 }, 0, 0, false],
  ['sete [ecx+1]', '0f944101', { ecx: 0 }, 0, 1, true],
  ['cmove eax,[ecx], condition false (still read)', '0f4401', { ecx: 0 }, 0, 0, false],
  ['fld dword [edx]', 'd902', { edx: 0x40 }, 0, 0x40, false],
  ['fld1 ; fstp qword [edx] (the stack kept)', 'd9e8dd1a', { edx: 0x48 }, 2, 0x48, true],
  ['fld1 ; fistp dword [edx] (the stack kept)', 'd9e8db1a', { edx: 0x48 }, 2, 0x48, true],
  ['fld1 ; fstp tbyte [edx] (the stack kept)', 'd9e8db3a', { edx: 0x40 }, 2, 0x40, true],
  ['fldz ; fst dword [edx+0x10]', 'd9eed95210', { edx: 0x40 }, 2, 0x50, true],
  ['movups [edx],xmm0', '0f1102', { edx: 0x50 }, 0, 0x50, true],
  ['movaps xmm1,[edx]', '0f280a', { edx: 0x60 }, 0, 0x60, false],
  ['mov eax,[0x1234] (absolute)', 'a134120000', {}, 0, 0x1234, false],
  ['mov eax,fs:[0x18]: TEB-relative', '64a118000000', {}, -1],
  ['mov eax,[esp+4]: the stack', '8b442404', {}, -1],
  ['mov eax,[bx+si] (16-bit addressing: always below 64 KiB)', '678b00', { ebx: P, esi: 0x10 }, 0, (P + 0x10) & 0xffff, false],
  ['cmpxchg8b [esi]', '0fc70e', { esi: 0 }, 0, 0, false],
  ['movsd from null', 'a5', { esi: 0, edi: P }, 0, 0, false],
  ['movsd from and to null (the source first)', 'a5', { esi: 0x10, edi: 0x20 }, 0, 0x10, false],
  ['fnstcw [ecx+2]', 'd97902', { ecx: 0 }, 0, 2, true],
  ['inc dword [ecx+0x20]', 'ff4120', { ecx: 0 }, 0, 0x20, false],
  ['mov ebx,5 ; add eax,ebx ; mov [ecx],eax (mid-block, earlier effects kept)', 'bb0500000001d88901', { ecx: 0, eax: 3 }, 7, 0, true],
  ['mov eax,[esi+eax*4+0x20]', '8b448620', { esi: 0, eax: 0x10 }, 0, 0x60, false],
  ['mov dword [edi+ecx*2],7', 'c7044f07000000', { edi: 0x100, ecx: 0x10 }, 0, 0x120, true],
  ['sub eax,[ebp-8] (EBP is checked)', '2b45f8', { ebp: 8 }, 0, 0, false],
  // (two operands through different registers — [edi+ecx*4] and [edx*4]: each its own check, not one group)
  ['mov eax,[edi+ecx*4] ; mov ebx,[edx*4]', '8b048f8b1c9500000000', { edi: P, ecx: 0, edx: 0 }, 3, 0, false],
  ['xchg [edi+ecx*4],eax ; xchg [edx*4],ebx', '87048f871c9500000000', { edi: P, ecx: 0, edx: 0, ebx: 0x2222 }, 3, 0, false],
];

for (const mode of [true, 'writes']) for (const [jitName, jitOpts] of [['jit', {}], ['jit, if-conversion everywhere', { ifcvt: 'all' }]]) {
  test(`null-page accesses fault before the instruction, as on Windows (${mode === true ? 'reads and writes' : 'writes only, the default'}; interpreter, ${jitName})`, () => {
    const EI = makeExec(null, mode), EJ = makeExec(jitOpts, mode);
    for (const [name, code, regs, at0, addr, write] of FORMS) {
      const c = bytesOf(code), end = CODE + c.length;
      // (writes only: the forms whose faulting instruction writes the operand fault the same; the others run on in both
      // executors alike — a read of the null page gives zeros, as before)
      let at = at0;
      if (mode === 'writes' && at >= 0) { load(EI, c, regs); if (!write && !nullChecks(decode(EI.mem, CODE + at)).some((k) => k.writes && !k.str)) at = -2; }
      for (const slice of [1e6, 1]) {
        for (const E of [EI, EJ]) load(E, c, regs);
        const before = EJ.jit.stats.native;
        const ri = EI.run(end, slice), rj = EJ.run(end, slice);
        const si = snapshot(EI), sj = snapshot(EJ);
        if (at === -2) assert.equal(rj, ri, `${name}: jit ${rj}, interpreter ${ri}`);
        else if (at < 0) {
          assert.equal(ri, EXIT.HALT, `${name}: interpreter ${ri} ${EI.fault?.message ?? ''}`);
          assert.equal(rj, EXIT.HALT, `${name}: jit ${rj} ${EJ.fault?.message ?? ''}`);
        } else {
          for (const [E, r, s, who] of [[EI, ri, si, 'interpreter'], [EJ, rj, sj, 'jit']]) {
            assert.equal(r, EXIT.FAULT, `${name}: ${who} exit ${r}`);
            assert.equal(E.cpu.exitArg, 14, `${name}: ${who} vector`);
            assert.equal(s.eip, hex(CODE + at), `${name}: ${who} EIP at the instruction`);
            assert.equal(E.fault.faultAddr, addr, `${name}: ${who} fault address`);
            assert.equal(E.fault.write, write, `${name}: ${who} read/write`);
          }
        }
        // (writes only: a read-modify-write's flags at its fault are the instruction's own in the JIT, see NC_RMW_SMC)
        assert.deepEqual(mode === 'writes' && ri === EXIT.FAULT ? { ...sj, eflags: si.eflags } : sj, si, `${name} (slice ${slice}): jit state differs from the interpreter`);
        assert.equal(si.nullPage, 'intact', `${name}: the null page written`);
        if (slice > 1 && !/^cmpxchg8b/.test(name)) assert.ok(EJ.jit.stats.native > before, `${name}: translated natively`); // (CMPXCHG8B: an interpreter fallback)
      }
    }
  });
}

test('a repeated string instruction walking into the null page faults at that element in the interpreter (the JIT checks the start)', () => {
  // std ; rep stosd ; cld — EDI 0x10004, 0x10000, then 0xfffc: two elements stored, ECX and EDI at the third
  const EI = makeExec(null), c = bytesOf('fdf3abfc');
  load(EI, c, { edi: 0x10004, ecx: 3, eax: 0x11223344 });
  assert.equal(EI.run(CODE + c.length), EXIT.FAULT);
  assert.equal(EI.cpu.eip, CODE + 1); assert.equal(EI.cpu.ecx, 1); assert.equal(EI.cpu.edi, 0xfffc);
  assert.equal(EI.fault.faultAddr, 0xfffc); assert.equal(EI.fault.write, true);
  assert.equal(EI.mem.read32(0x10000), 0x11223344); assert.equal(nullPageIntact(EI.mem), 'intact');
});

test('with the check off (ORTHROS_NULL_PAGE_OPEN), the null page is plain memory again — what the test above would miss', () => {
  const EI = makeExec(null), EJ = makeExec({ nullPage: false });
  EI.I.nullPage = false;
  const c = bytesOf('8981fc7f0000'), end = CODE + c.length;
  for (const E of [EI, EJ]) { load(E, c, { ecx: 0, eax: 0x1234 }); assert.equal(E.run(end), EXIT.HALT); assert.equal(E.mem.read32(0x7ffc), 0x1234); }
});

// ---------------------------------------------------------------- random programs
const REGS = [0, 1, 2, 3, 6, 7]; // eax ecx edx ebx esi edi (EBP: the loop counter, ESP: the stack)
const modrm = (mod, reg, rm) => (mod << 6) | (reg << 3) | rm;
/** [reg + disp8] operand bytes (no SIB: rm 4 is ESP, excluded; EBP base needs a displacement anyway) */
const mem8 = (reg, base, disp) => [modrm(1, reg, base), disp & 0xff];
function randomProgram(r, nInsns, nulls, negDisp = true) {
  const pick = (a) => a[r() % a.length];
  const out = [];
  const body = [];
  for (let i = 0; i < nInsns; i++) {
    const d = pick(REGS), b = pick(REGS), disp = r() % 4 === 0 && negDisp ? 0x100 - (r() % 8) * 4 : (r() % 32) * 4;
    switch (r() % 14) {
      case 0: case 1: body.push([0x8b, ...mem8(d, b, disp)]); break; // mov d,[b+disp]
      case 2: body.push([0x89, ...mem8(d, b, disp)]); break; // mov [b+disp],d
      case 3: body.push([0x01, ...mem8(d, b, disp)]); break; // add [b+disp],d
      case 4: body.push([0x3b, ...mem8(d, b, disp)]); break; // cmp d,[b+disp] (no pointer sums: past 2 GiB, see NC_STORE_SMC)
      case 5: body.push([0x8d, ...mem8(d, b, disp & 0x7c)]); break; // lea d,[b+disp] (not below: a register past 2 GiB, see NC_STORE_SMC)
      case 6: if (nulls) body.push([0x31, modrm(3, d, d)]); else body.push([0x89, modrm(3, b, d)]); break; // xor d,d (a null pointer)
      case 7: body.push([0x83, modrm(3, 0, d), (r() % 16) * 4]); break; // add d,imm8
      case 8: body.push([0x89, modrm(3, b, d)]); break; // mov d,b
      case 9: { // test b,b ; jz/jnz over a load through b (a null test, its mirror: the arm loads through null)
        const ld = [0x8b, ...mem8(d === b ? pick(REGS.filter((x) => x !== b)) : d, b, disp)];
        body.push([0x85, modrm(3, b, b), r() & 1 ? 0x74 : 0x75, ld.length, ...ld]); break;
      }
      case 10: body.push([0x0f, 0xb6, ...mem8(d, b, disp)]); break; // movzx d,byte [b+disp]
      case 11: body.push([0xff, ...mem8(6, b, disp)]); break; // push [b+disp]
      case 12: body.push([0x58 + pick([0, 1, 2, 3])]); break; // pop (balances the pushes)
      default: { // a string instruction (DF clear): movsd / stosd / lodsd, sometimes repeated a few times
        const op = pick([0xa5, 0xab, 0xad]);
        if (r() & 1) body.push([0xb9, r() % 3, 0, 0, 0, 0xf3, op]); else body.push([op]);
      }
    }
  }
  // mov ebp,K ; body ; dec ebp ; jnz body (a loop: the JIT region's back edge)
  out.push(0xbd, 3 + (r() % 4), 0, 0, 0);
  const flat = body.flat();
  out.push(...flat, 0x4d);
  const back = -(flat.length + 1 + 6);
  out.push(0x0f, 0x85, back & 0xff, (back >> 8) & 0xff, (back >> 16) & 0xff, (back >> 24) & 0xff);
  return Uint8Array.from(out);
}

for (const mode of [true, 'writes']) test(`random programs through null, small and valid pointers: the JIT faults where the interpreter does, sliced and not (${mode === true ? 'reads and writes' : 'writes only'})`, () => {
  const EI = makeExec(null, mode);
  const EJs = [makeExec({}, mode), makeExec({ ifcvt: 'all' }, mode)];
  const r = prng(mode === true ? 0x6e756c6c : 0x77726974);
  let faults = 0, clean = 0, skipped = 0;
  for (let n = 0; n < 300; n++) {
    // a third of the programs without null pointers (those reach the end), the others with rare or frequent ones
    const pNull = [0, 1 / 64, 1 / 4][n % 3 === 0 ? 0 : 1 + (r() % 2)];
    // (writes only: no negative displacements — an unchecked load from [null - 8] runs past the guest memory, where the
    // interpreter reads undefined bytes and the JIT traps: not this test's subject)
    const code = randomProgram(r, 6 + (r() % 10), pNull > 0, mode === true), end = CODE + code.length;
    // pointers: null, small (in the null page), at its end, valid; DATA holds such pointers too (what loads bring)
    const bad = [0, 0x10 + (r() % 0x100) * 4, 0xff00], good = [DATA + 0x100 + (r() % 0x800) * 4, DATA + 0x2000, DATA + 0x4000 + (r() % 0x100) * 4];
    const ptr = (q) => (q() / 2 ** 32 < pNull ? bad[q() % bad.length] : good[q() % good.length]);
    const regs = {}; for (const k of ['eax', 'ecx', 'edx', 'ebx', 'esi', 'edi']) regs[k] = ptr(r);
    const seed = r();
    const fillPtrs = (E) => { const q = prng(seed); for (let i = 0; i < DATA_SIZE; i += 4) E.mem.write32(DATA + i, ptr(q)); };
    const slice = [1e6, 1 + (r() % 7), 37][n % 3];
    load(EI, code, regs); fillPtrs(EI);
    const ri = EI.run(end, slice);
    const si = snapshot(EI);
    // (writes only: an unchecked load past the guest memory — [null - 4] — is a WebAssembly trap in the JIT, an
    // imprecise fault, as before the null page was checked: not compared)
    if (ri === EXIT.FAULT && !EI.fault.nullPage) { skipped++; continue; }
    if (ri === EXIT.FAULT) faults++; else clean++;
    for (const EJ of EJs) {
      load(EJ, code, regs); fillPtrs(EJ);
      const rj = EJ.run(end, slice);
      // (a plain store past the guest memory — [null - 4] — traps in the JIT, an imprecise fault: see NC_STORE_SMC)
      if (ri === EXIT.FAULT && EI.fault.faultAddr >= 0x80000000 && EI.fault.write && rj === EXIT.FAULT && !EJ.fault?.nullPage) continue;
      const label = `program ${n} (slice ${slice}, ${EJ.jit.opts.ifcvt ? 'ifcvt' : 'default'}): ${Buffer.from(code).toString('hex')} regs ${JSON.stringify(regs)}`;
      assert.equal(rj, ri, `${label}: exit ${rj}, interpreter ${ri} (${EI.fault?.message ?? ''} / ${EJ.fault?.message ?? ''})`);
      if (ri === EXIT.FAULT) { assert.equal(EJ.fault.faultAddr, EI.fault.faultAddr, label); assert.equal(EJ.fault.write, EI.fault.write, label); }
      // (at a fault, the arithmetic flags no later instruction reads before writing them may be an older instruction's in
      // the JIT: dead flags are not computed — what an exception handler could see in its CONTEXT, as for every fault in
      // translated code; see Emitter.deadFlagsExit)
      const sj = snapshot(EJ);
      assert.deepEqual(ri === EXIT.FAULT ? { ...sj, eflags: si.eflags } : sj, si, `${label}: state differs`);
    }
    assert.equal(si.nullPage, 'intact');
  }
  assert.ok(faults > 40 && clean > 40 && skipped < 60, `both outcomes exercised (${faults} faults, ${clean} clean, ${skipped} not compared)`);
});
