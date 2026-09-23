// CPU conformance for the JIT: same oracle suites as the interpreter, executed through
// translated WebAssembly regions (with interpreter fallback for untranslated instructions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSuite, isStackFaultCase } from './conformance/runner.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const DIR = new URL('./generated/', import.meta.url).pathname;
const SUITES = ['alu', 'stack', 'branch', 'string', 'x87', 'sse', 'verify_float', 'verify_int', 'verify_mech', 'verify_trans', 'verify_trans2', 'corpus'];
const SHOW = +(process.env.SHOW_FAILURES || 8);

for (const suite of SUITES) {
  test(`jit conformance: ${suite}`, { skip: !fs.existsSync(`${DIR}${suite}.results.bin`) && 'run make gen' }, () => {
    let jit;
    const res = runSuite(DIR, suite, (mem, cpu) => {
      const I = new Interp(mem, cpu);
      jit = new Jit(mem, I);
      return {
        run(end) {
          jit.reset();
          I.cache.clear();
          jit.boundaries = new Set([end]);
          jit.cpu = cpu;
          const r = jit.run({ stopAt: end, maxInsns: 100000 });
          this.lastFault = jit.lastFault;
          return r;
        },
      };
    }, { skip: isStackFaultCase });
    if (res.failures.length) {
      const msg = res.failures.slice(0, SHOW).map((f) => `#${f.i} ${f.asm}\n    ${f.diff}`).join('\n');
      console.log(`${suite}: ${res.failures.length}/${res.total} failures, ${res.skipped} skipped (jit stats ${JSON.stringify(jit.stats)})\n${msg}`);
    }
    assert.equal(res.failures.length, 0, `${res.failures.length}/${res.total} mismatches in ${suite}`);
  });
}
