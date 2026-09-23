// CPU conformance: reference interpreter vs native oracle (tests/generated/*, built by `make gen`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSuite } from './conformance/runner.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';

const DIR = new URL('./generated/', import.meta.url).pathname;
const SUITES = ['alu', 'stack', 'branch', 'string', 'x87', 'sse', 'verify_float', 'verify_int', 'verify_mech', 'verify_trans'];
const SHOW = +(process.env.SHOW_FAILURES || 8);

for (const suite of SUITES) {
  test(`interp conformance: ${suite}`, { skip: !fs.existsSync(`${DIR}${suite}.results.bin`) && 'run make gen' }, () => {
    const res = runSuite(DIR, suite, (mem, cpu) => {
      const I = new Interp(mem, cpu);
      return {
        run(end) { I.cache.clear(); const r = I.run({ stopAt: end, maxInsns: 100000 }); this.lastFault = I.lastFault; return r; },
      };
    });
    if (res.failures.length) {
      const msg = res.failures.slice(0, SHOW).map((f) => `#${f.i} ${f.asm}\n    ${f.diff}`).join('\n');
      console.log(`${suite}: ${res.failures.length}/${res.total} failures\n${msg}`);
    }
    assert.equal(res.failures.length, 0, `${res.failures.length}/${res.total} mismatches in ${suite}`);
  });
}
