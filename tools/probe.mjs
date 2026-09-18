// Conformance probe: runs one generated suite through the interpreter (default) or the JIT
// (--jit) with per-case timing and prints failures.
// Usage: node tools/probe.mjs <suite> [showN] [onlyIndex] [--jit]
import { Conformance, CODE, isStackFaultCase } from '../tests/conformance/runner.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const args = process.argv.slice(2);
const useJit = args.includes('--jit');
const pos = args.filter((a) => !a.startsWith('--'));
const suite = pos[0];
const show = +(pos[1] || 15);
const only = pos[2] !== undefined ? +pos[2] : -1;
const dir = new URL('../tests/generated/', import.meta.url).pathname;
const c = new Conformance(dir, suite);
const I = new Interp(c.mem, c.cpu);
const jit = useJit ? new Jit(c.mem, I) : null;
let fails = 0;
const t0 = Date.now();
const kinds = new Map();
for (let i = 0; i < c.count; i++) {
  if (only >= 0 && i !== only) continue;
  if (jit && isStackFaultCase(i, c)) continue;
  const { end } = c.load(i);
  c.cpu.eip = CODE;
  I.cache.clear();
  let exit;
  const t = Date.now();
  try {
    if (jit) { jit.reset(); jit.boundaries = new Set([end]); jit.cpu = c.cpu; exit = jit.run({ stopAt: end, maxInsns: 100000 }); c.lastFault = jit.lastFault ? jit.lastFault.message : null; }
    else { exit = I.run({ stopAt: end, maxInsns: 100000 }); c.lastFault = I.lastFault ? I.lastFault.message : null; }
  } catch (e) {
    fails++; if (fails <= show) console.log(`#${i} ${c.meta[i].asm}\n    exception: ${e.stack.split('\n').slice(0, 4).join('\n    ')}`); continue;
  }
  const dt = Date.now() - t;
  if (dt > 500) console.log(`SLOW #${i} ${c.meta[i].asm} ${dt}ms`);
  const d = c.compare(i, exit);
  if (d) {
    fails++;
    const k = c.meta[i].asm.split(' ')[0];
    kinds.set(k, (kinds.get(k) || 0) + 1);
    if (fails <= show) console.log(`#${i} ${c.meta[i].asm}\n    ${d}`);
  }
}
console.log(`${suite}${jit ? ' [jit]' : ''}: ${fails}/${c.count} failures in ${Date.now() - t0}ms` + (fails ? ` — by mnemonic: ${[...kinds].map(([k, v]) => `${k}:${v}`).join(' ')}` : '') + (jit ? ` stats=${JSON.stringify(jit.stats)}` : ''));
