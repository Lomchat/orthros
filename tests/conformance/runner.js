// Conformance runner: replays oracle cases on an executor (interpreter or JIT) and compares
// the resulting state with the native CPU's. Record layouts: tools/oracle/oracle.c.
import fs from 'node:fs';
import path from 'node:path';
import { GuestMemory } from '../../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../../src/cpu/state.js';

export const SCRATCH = 0x10000000;
export const CODE = 0x20000000;
export const MEM_SIZE = 2048;
export const CASE_SIZE = 2688;
export const RESULT_SIZE = 2624;

const REGN = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** 80-bit extended -> f64 (nearest). mant: bigint 64-bit, se: 16-bit sign+exp. */
export function f80ToF64(mant, se) {
  const sign = se & 0x8000 ? -1 : 1;
  const exp = se & 0x7fff;
  if (exp === 0 && mant === 0n) return sign * 0;
  if (exp === 0x7fff) {
    if ((mant & 0x7fffffffffffffffn) === 0n) return sign * Infinity;
    return NaN;
  }
  // value = mant * 2^(exp - 16383 - 63)
  const e = exp - 16383 - 63;
  let m = Number(mant); // rounds to nearest double (53 bits)
  // scale in steps to avoid intermediate overflow/underflow
  let r = m;
  let ee = e;
  while (ee > 1000) { r *= 2 ** 1000; ee -= 1000; }
  while (ee < -1000) { r *= 2 ** -1000; ee += 1000; }
  r *= 2 ** ee;
  return sign * r;
}

/** f64 -> 80-bit extended (exact). Returns [mant bigint, se]. */
export function f64ToF80(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x, true);
  const bits = dv.getBigUint64(0, true);
  const sign = Number(bits >> 63n);
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  if (exp === 0) {
    if (mant === 0n) return [0n, sign << 15];
    let e = -1022;
    while (!(mant & (1n << 52n))) { mant <<= 1n; e--; }
    mant &= (1n << 52n) - 1n;
    return [(1n << 63n) | (mant << 11n), (sign << 15) | (e + 16383)];
  }
  if (exp === 0x7ff) return [(1n << 63n) | (mant << 11n), (sign << 15) | 0x7fff];
  return [(1n << 63n) | (mant << 11n), (sign << 15) | (exp - 1023 + 16383)];
}

export class Conformance {
  /**
   * @param {string} dir generated dir
   * @param {string} suite
   */
  constructor(dir, suite) {
    this.cases = fs.readFileSync(path.join(dir, `${suite}.cases.bin`));
    this.results = fs.readFileSync(path.join(dir, `${suite}.results.bin`));
    this.meta = JSON.parse(fs.readFileSync(path.join(dir, `${suite}.meta.json`), 'utf8'));
    this.count = this.meta.length;
    this.mem = new GuestMemory();
    this.cpu = new CpuState(this.mem, THREAD_STATES_BASE);
  }

  /** Load case i into guest memory + cpu state. */
  load(i) {
    const cv = new DataView(this.cases.buffer, this.cases.byteOffset + i * CASE_SIZE, CASE_SIZE);
    const cu8 = new Uint8Array(this.cases.buffer, this.cases.byteOffset + i * CASE_SIZE, CASE_SIZE);
    const mem = this.mem, cpu = this.cpu;
    cpu.reset();
    for (let r = 0; r < 8; r++) cpu.setReg(r, cv.getUint32(4 + 4 * r, true));
    cpu.eflags = cv.getUint32(36, true) | F.RESERVED1 | F.IF;
    // mirror the oracle's segment selectors (OS-specific values; exported in the result record)
    const rv0 = new DataView(this.results.buffer, this.results.byteOffset + i * RESULT_SIZE, RESULT_SIZE);
    for (let s = 0; s < 6; s++) mem.write16(cpu.base + ST.SEG + 2 * s, rv0.getUint16(2608 + 2 * s, true));
    const codeLen = cv.getUint32(40, true);
    mem.fill(SCRATCH, 0x10000, 0);
    mem.writeBytes(SCRATCH, cu8.subarray(624, 624 + MEM_SIZE));
    mem.fill(CODE, 0x100, 0xcc);
    mem.writeBytes(CODE, cu8.subarray(48, 48 + codeLen));
    // FXRSTOR image
    const fx = 112;
    cpu.fpuCw = cv.getUint16(fx + 0, true);
    const fsw = cv.getUint16(fx + 2, true);
    cpu.fpuSw = fsw & ~0x3800;
    const top = (fsw >> 11) & 7;
    cpu.fpuTop = top;
    cpu.fpuTw = cv.getUint8(fx + 4);
    cpu.mxcsr = cv.getUint32(fx + 24, true);
    for (let k = 0; k < 8; k++) {
      const m = cv.getBigUint64(fx + 32 + 16 * k, true);
      const se = cv.getUint16(fx + 40 + 16 * k, true);
      cpu.setFpr(top + k, f80ToF64(m, se)); // slot k = ST(k)
      // MMX view: low 64 bits
      mem.write64(cpu.mmAddr(k), m);
    }
    for (let k = 0; k < 8; k++) mem.writeBytes(cpu.xmmAddr(k), cu8.subarray(fx + 160 + 16 * k, fx + 176 + 16 * k));
    return { codeLen, end: CODE + codeLen };
  }

  /**
   * Compare current state against the oracle result i. Returns null if equal, else a diff string.
   * @param {number} i
   * @param {number} exit EXIT code from the executor
   */
  compare(i, exit) {
    const rv = new DataView(this.results.buffer, this.results.byteOffset + i * RESULT_SIZE, RESULT_SIZE);
    const ru8 = new Uint8Array(this.results.buffer, this.results.byteOffset + i * RESULT_SIZE, RESULT_SIZE);
    const meta = this.meta[i];
    const cpu = this.cpu, mem = this.mem;
    const diffs = [];
    const fault = rv.getUint32(36, true);
    const h = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
    if (fault) {
      const feip = rv.getUint32(40, true);
      if (exit !== EXIT.FAULT && exit !== EXIT.BREAK) diffs.push(`oracle faulted (sig ${fault}) at ${h(feip)}, we exited ${exit}`);
      else if (cpu.eip !== feip) diffs.push(`fault eip ${h(cpu.eip)} != ${h(feip)}`);
    } else if (exit !== EXIT.HALT) {
      diffs.push(`executor exit ${exit} (expected clean end); eip=${h(cpu.eip)}${this.lastFault ? ' ' + this.lastFault : ''}`);
    }
    for (let r = 0; r < 8; r++) {
      const want = rv.getUint32(4 * r, true);
      if (cpu.reg(r) !== want) diffs.push(`${REGN[r]}: got ${h(cpu.reg(r))} want ${h(want)}`);
    }
    const mask = meta.mask ?? 0xcd5;
    const wantF = rv.getUint32(32, true), gotF = cpu.eflags;
    if ((wantF & mask) !== (gotF & mask)) diffs.push(`eflags: got ${h(gotF & mask)} want ${h(wantF & mask)} (mask ${h(mask)})`);
    // memory (on native faults the kernel wrote a signal frame below ESP: compare from ESP up)
    const got = mem.bytes(SCRATCH, MEM_SIZE);
    let memStart = 0;
    if (fault) {
      const esp = rv.getUint32(16, true);
      memStart = esp >= SCRATCH && esp < SCRATCH + MEM_SIZE ? esp - SCRATCH : MEM_SIZE;
    }
    for (let k = memStart; k < MEM_SIZE; k++) {
      if (got[k] !== ru8[560 + k]) {
        let end = k; while (end < MEM_SIZE && got[end] !== ru8[560 + end]) end++;
        diffs.push(`mem[0x${k.toString(16)}..0x${end.toString(16)}): got ${Buffer.from(got.subarray(k, Math.min(end, k + 16))).toString('hex')} want ${Buffer.from(ru8.subarray(560 + k, 560 + Math.min(end, k + 16))).toString('hex')}`);
        k = end;
        if (diffs.length > 12) break;
      }
    }
    const fx = 48;
    if (meta.fpu) {
      const fsw = rv.getUint16(fx + 2, true);
      const top = (fsw >> 11) & 7;
      const tw = rv.getUint8(fx + 4);
      if (cpu.fpuTop !== top) diffs.push(`fpu top: got ${cpu.fpuTop} want ${top}`);
      if (cpu.fpuTw !== tw) diffs.push(`fpu tags: got ${cpu.fpuTw.toString(2).padStart(8, '0')} want ${tw.toString(2).padStart(8, '0')}`);
      const cw = rv.getUint16(fx + 0, true);
      if (cpu.fpuCw !== cw) diffs.push(`fpu cw: got ${h(cpu.fpuCw)} want ${h(cw)}`);
      if (meta.fpucc) {
        const m = 0x4500; // C0 C2 C3
        if ((cpu.fpuSw & m) !== (fsw & m)) diffs.push(`fpu cc: got ${h(cpu.fpuSw & m)} want ${h(fsw & m)}`);
      }
      if (meta.fpusw) {
        const m = 0x4500;
        if ((cpu.fpuSw & m) !== (fsw & m)) diffs.push(`fpu sw(cc): got ${h(cpu.fpuSw & m)} want ${h(fsw & m)}`);
      }
      for (let k = 0; k < 8; k++) {
        const phys = (top + k) & 7;
        if (!((tw >> phys) & 1)) continue; // empty
        const want = f80ToF64(rv.getBigUint64(fx + 32 + 16 * k, true), rv.getUint16(fx + 40 + 16 * k, true));
        const got = cpu.fpr(phys);
        if (!fpEqual(got, want, meta.tol)) diffs.push(`st(${k}): got ${got} want ${want}`);
      }
    }
    if (meta.xmm) {
      for (let k = 0; k < 8; k++) {
        const g = mem.bytes(cpu.xmmAddr(k), 16);
        const w = ru8.subarray(fx + 160 + 16 * k, fx + 176 + 16 * k);
        for (let b = 0; b < 16; b++) if (g[b] !== w[b]) { diffs.push(`xmm${k}: got ${Buffer.from(g).toString('hex')} want ${Buffer.from(w).toString('hex')}`); break; }
      }
    }
    if (meta.mmx) {
      for (let k = 0; k < 8; k++) {
        const g = mem.read64(cpu.mmAddr(k));
        const w = rv.getBigUint64(fx + 32 + 16 * k, true);
        if (g !== w) diffs.push(`mm${k}: got ${g.toString(16)} want ${w.toString(16)}`);
      }
    }
    return diffs.length ? diffs.join('\n    ') : null;
  }
}

function fpEqual(a, b, tol) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Object.is(a, b)) return true;
  if (a === b) return true; // 0 vs -0 handled below
  if (tol === undefined || tol === null) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const d = Math.abs(a - b);
  return d <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Run a suite through an executor.
 * @param {string} dir
 * @param {string} suite
 * @param {(mem: GuestMemory, cpu: CpuState) => { run: (end: number) => number, lastFault?: any }} makeExec
 * @param {{ maxFailures?: number, verbose?: boolean }} [opts]
 */
export function runSuite(dir, suite, makeExec, opts = {}) {
  const c = new Conformance(dir, suite);
  const exec = makeExec(c.mem, c.cpu);
  const failures = [];
  for (let i = 0; i < c.count; i++) {
    const { end } = c.load(i);
    c.cpu.eip = CODE;
    let exit;
    try {
      exit = exec.run(end);
    } catch (e) {
      failures.push({ i, asm: c.meta[i].asm, diff: `exception: ${e.stack}` });
      continue;
    }
    c.lastFault = exec.lastFault ? exec.lastFault.message : null;
    const d = c.compare(i, exit);
    if (d) failures.push({ i, asm: c.meta[i].asm, diff: d });
  }
  return { total: c.count, failures };
}
