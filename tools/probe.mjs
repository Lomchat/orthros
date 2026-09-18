// Conformance probe: runs one generated suite through the interpreter with per-case timing and
// prints failures. Usage: node tools/probe.mjs <suite> [showN]
import { Conformance, CODE } from '../tests/conformance/runner.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';

const suite = process.argv[2];
const show = +(process.argv[3] || 15);
const only = process.argv[4] !== undefined ? +process.argv[4] : -1;
const dir = new URL('../tests/generated/', import.meta.url).pathname;
const c = new Conformance(dir, suite);
const I = new Interp(c.mem, c.cpu);
let fails = 0;
const t0 = Date.now();
const kinds = new Map();
for (let i = 0; i < c.count; i++) {
  if (only >= 0 && i !== only) continue;
  const { end } = c.load(i);
  c.cpu.eip = CODE;
  I.cache.clear();
  const t = Date.now();
  const exit = I.run({ stopAt: end, maxInsns: 100000 });
  const dt = Date.now() - t;
  if (dt > 500) console.log(`SLOW #${i} ${c.meta[i].asm} ${dt}ms`);
  c.lastFault = I.lastFault ? I.lastFault.message : null;
  const d = c.compare(i, exit);
  if (d) {
    fails++;
    const k = c.meta[i].asm.split(' ')[0];
    kinds.set(k, (kinds.get(k) || 0) + 1);
    if (fails <= show) console.log(`#${i} ${c.meta[i].asm}\n    ${d}`);
  }
}
console.log(`${suite}: ${fails}/${c.count} failures in ${Date.now() - t0}ms` + (fails ? ` — by mnemonic: ${[...kinds].map(([k, v]) => `${k}:${v}`).join(' ')}` : ''));
