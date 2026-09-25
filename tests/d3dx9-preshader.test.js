import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreshader, compilePreshader } from '../src/win32/d3dx9-preshader.js';

// a small deterministic generator (the same programs every run)
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const OPS = [0x1000, 0x1010, 0x1030, 0x1040, 0x1050, 0x1060, 0x1070, 0x1080, 0x1090, 0x10a0, 0x10b0, 0x10c0, 0x2000, 0x2010, 0x2020, 0x2030, 0x2040, 0x2050, 0x2060, 0x2080, 0xa040, 0xa050, 0x3000, 0x3010, 0x5000];
const inputsFor = (op) => (op >= 0x5000 ? 2 : op >= 0x3000 ? 3 : (op & 0xf000) === 0x1000 ? 1 : 2);

function randomProgram(r) {
  const literals = Array.from({ length: 8 }, () => (r() - 0.5) * 8);
  const insns = [];
  for (let i = 0; i < 24; i++) {
    const op = OPS[Math.floor(r() * OPS.length)], n = 1 + Math.floor(r() * 4);
    const operand = () => {
      const table = [1, 2, 2, 7, 4][Math.floor(r() * 5)];
      const o = { table, offset: 4 * Math.floor(r() * 4), index: null };
      if (table !== 1 && r() < 0.1) o.index = { table: 2, offset: 0 }; // relative addressing through input 0
      return o;
    };
    insns.push({ op, n, ins: Array.from({ length: inputsFor(op) }, operand), out: { table: r() < 0.5 ? 4 : 7, offset: 4 * Math.floor(r() * 4), index: null } });
  }
  return { literals, insns, temps: 16, inputs: [], outRanges: [] };
}

test('compiled preshaders compute what the interpreter computes', () => {
  const r = rng(7);
  for (let p = 0; p < 200; p++) {
    const prog = randomProgram(r);
    const inputs = Float64Array.from({ length: 16 }, () => (r() - 0.5) * 6);
    inputs[0] = Math.floor(r() * 3); // (the relative index)
    const a = new Float32Array(1024), b = new Float32Array(1024);
    runPreshader(prog, inputs, a);
    compilePreshader(prog, inputs.length)(inputs, b);
    for (let i = 0; i < 64; i++) assert.ok(Object.is(a[i], b[i]) || (Number.isNaN(a[i]) && Number.isNaN(b[i])), `program ${p} out[${i}]: ${a[i]} vs ${b[i]}`);
  }
});

test('compiled preshaders start each run with cleared temporaries', () => {
  // t0.x = t0.x + 1 ; o0.x = t0.x: 1 at every run
  const prog = { literals: [1], temps: 4, inputs: [], outRanges: [], insns: [
    { op: 0x2040, n: 1, ins: [{ table: 7, offset: 0, index: null }, { table: 1, offset: 0, index: null }], out: { table: 7, offset: 0, index: null } },
    { op: 0x1000, n: 1, ins: [{ table: 7, offset: 0, index: null }], out: { table: 4, offset: 0, index: null } }] };
  const f = compilePreshader(prog, 0), out = new Float32Array(1024);
  f(new Float64Array(0), out); f(new Float64Array(0), out);
  assert.equal(out[0], 1);
});
