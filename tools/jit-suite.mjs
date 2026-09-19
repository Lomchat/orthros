#!/usr/bin/env node
// Run one generated conformance suite through the JIT and report native/fallback statistics.
//
//   node tools/jit-suite.mjs <suite> [--modules a.js,b.js] [--only REGEX] [--show N]
//
// Same harness as tests/cpu-jit.test.js (tests/conformance/runner.js runSuite, one region per
// case bounded at `end`, maxInsns 100000, x87 stack-fault cases skipped). `--modules` imports
// extra ES modules before running (e.g. a translator module registering HANDLERS that is not
// yet wired into jit.js). `--only` keeps only the cases whose asm matches the regex. Prints the
// total, the failures (up to --show N, default 20), jit.stats native/fallback/fallbackSteps and
// the interpreter-fallback histogram by mnemonic.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSuite, isStackFaultCase } from '../tests/conformance/runner.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { OP_NAMES } from '../src/cpu/decoder.js';

const DIR = new URL('../tests/generated/', import.meta.url).pathname;

function parseArgs(argv) {
  const o = { suite: null, modules: [], only: null, show: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--modules') o.modules = argv[++i].split(',').filter(Boolean);
    else if (a === '--only') o.only = new RegExp(argv[++i]);
    else if (a === '--show') o.show = +argv[++i];
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else if (!o.suite) o.suite = a;
    else { console.error(`unexpected argument ${a}`); process.exit(2); }
  }
  if (!o.suite) { console.error('usage: node tools/jit-suite.mjs <suite> [--modules a.js,b.js] [--only REGEX] [--show N]'); process.exit(2); }
  return o;
}

const args = parseArgs(process.argv.slice(2));
for (const m of args.modules) {
  const url = pathToFileURL(path.resolve(process.cwd(), m)).href;
  await import(url);
}

let jit;
const t0 = performance.now();
const res = runSuite(DIR, args.suite, (mem, cpu) => {
  const I = new Interp(mem, cpu);
  jit = new Jit(mem, I, { fallbackHist: true });
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
}, {
  skip: (i, c) => isStackFaultCase(i, c) || (args.only !== null && !args.only.test(c.meta[i].asm)),
});
const ms = performance.now() - t0;

const s = jit.stats;
console.log(`${args.suite}: ${res.total} cases, ${res.failures.length} failures, ${res.skipped} skipped, ${ms.toFixed(0)} ms`);
console.log(`jit stats: regions ${s.regions} blocks ${s.blocks} native ${s.native} fallback ${s.fallback} fallbackSteps ${s.fallbackSteps}`);
const hist = [...jit.fallbackHist.entries()].sort((a, b) => b[1] - a[1]);
console.log(`fallback histogram (${hist.length} mnemonics): ${hist.map(([op, n]) => `${OP_NAMES[op]} ${n}`).join(', ') || '(none)'}`);
if (res.failures.length) {
  console.log(`failures (showing ${Math.min(args.show, res.failures.length)} of ${res.failures.length}):`);
  for (const f of res.failures.slice(0, args.show)) console.log(`#${f.i} ${f.asm}\n    ${f.diff}`);
}
process.exit(res.failures.length ? 1 : 0);
