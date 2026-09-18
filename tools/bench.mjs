// CPU benchmark harness: runs build/pe/bench.exe under the interpreter and under the JIT and
// reports host wall time per phase. Usage: node tools/bench.mjs [interp|jit|both]
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const which = process.argv[2] ?? 'both';
const PE = new URL('../build/pe/bench.exe', import.meta.url).pathname;

function runOnce(useJit) {
  const vfs = new Vfs();
  const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', t);
  t.open('bench.exe', { create: true }).write(0, fs.readFileSync(PE));
  const clock = new RealClock();
  const host = new HeadlessHost({ clock });
  const vm = new Vm({ vfs, clock, host, jit: useJit, logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\bench.exe' });
  const lines = [];
  vm.onStdout = (s) => lines.push(s);
  const t0 = performance.now();
  vm.run();
  const total = performance.now() - t0;
  const out = lines.join('');
  const ms = [...out.matchAll(/ms 0x([0-9a-f]+)/g)].map((m) => parseInt(m[1], 16));
  const sums = [...out.matchAll(/^(\w+) 0x([0-9a-f]+)$/gm)].filter((m) => m[1] !== 'ms').map((m) => `${m[1]}=${m[2]}`);
  return { total, ms, sums, stats: useJit ? vm.jit.stats : null, icount: vm.interp.icount };
}

const results = {};
if (which !== 'jit') { results.interp = runOnce(false); console.log('interp:', Math.round(results.interp.total), 'ms; phases', results.interp.ms.join('/'), 'ms;', results.interp.sums.join(' ')); }
if (which !== 'interp') { results.jit = runOnce(true); console.log('jit   :', Math.round(results.jit.total), 'ms; phases', results.jit.ms.join('/'), 'ms;', results.jit.sums.join(' ')); console.log('jit stats:', JSON.stringify(results.jit.stats)); }
if (results.interp && results.jit) {
  const names = ['int', 'sieve', 'memory', 'string', 'fpu'];
  console.log('speedup total: ' + (results.interp.total / results.jit.total).toFixed(1) + 'x; per phase: ' + names.map((n, i) => `${n} ${(results.interp.ms[i] / Math.max(results.jit.ms[i], 1)).toFixed(1)}x`).join(', '));
  if (results.interp.sums.join() !== results.jit.sums.join()) console.log('CHECKSUM MISMATCH');
}
