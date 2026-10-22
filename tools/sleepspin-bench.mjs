#!/usr/bin/env node
// Frame-limiter microbenchmark: runs build/pe/sleepspin.exe (tools/pe/sleepspin.c: per 16 ms frame a little work, then
// Sleep(0) + timeGetTime until the next frame, beside a thread looping on Sleep(1)) under the JIT and reports what the
// emulator spends on that pacing — process CPU time per frame (Atomics.wait sleeps cost none), Sleep(0) calls and
// scheduling decisions per frame, throttled parks — and whether pacing stayed the same (frame interval mean / p99 / max).
// Usage: node tools/sleepspin-bench.mjs [--runs 5] [--src <dir with core/, cpu/...>] [--dbg NAME=value,...]
//   --src: import the emulator from another source tree (a checkout of the previous commit: before/after)
//   --dbg: globals set before the run (the page's ?dbg= switches, e.g. ORTHROS_SLEEP0_KEEP_STREAK=0)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RUNS = +argOf('--runs', 5);
for (const kv of (argOf('--dbg', '') || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); globalThis[k] = v; }
const SRC = path.resolve(argOf('--src', new URL('../src', import.meta.url).pathname));
const imp = (p) => import(pathToFileURL(path.join(SRC, p)).href);
const { Vm } = await imp('core/vm.js');
const { Vfs, MemBackend } = await imp('vfs/vfs.js');
const { RealClock } = await imp('core/clock.js');
const { HeadlessHost } = await imp('host/display.js');
const PE = new URL('../build/pe/sleepspin.exe', import.meta.url).pathname;

function runOnce() {
  const vfs = new Vfs();
  const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', t);
  t.open('sleepspin.exe', { create: true }).write(0, fs.readFileSync(PE));
  const clock = new RealClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock }), jit: true, logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\sleepspin.exe' });
  const marks = [], frames = [];
  let cpu0 = null, cpu1 = null, picks0 = 0, picks1 = 0, st0 = null, st1 = null;
  const main = () => vm.proc.threads[0], snap = () => ({ ...(main().sleepStats ?? { zero: 0, throttled: 0 }) });
  const dispatch = vm.dispatchThunk.bind(vm);
  vm.dispatchThunk = (th, i) => {
    const n = vm.api.thunk(i)?.name;
    if (n === 'GetVersion') frames.push(performance.now());
    else if (n === 'GetCommandLineA') {
      marks.push(performance.now());
      if (marks.length === 1) { cpu0 = process.cpuUsage(); picks0 = vm.sched.picks; st0 = snap(); }
      else { cpu1 = process.cpuUsage(cpu0); picks1 = vm.sched.picks; st1 = snap(); }
    }
    return dispatch(th, i);
  };
  const code = vm.run();
  if (code !== 0 || marks.length !== 2) throw new Error(`sleepspin.exe: exit code ${code}, ${marks.length} marks`);
  const n = frames.length, iv = frames.slice(1).map((x, k) => x - frames[k]).sort((a, b) => a - b);
  return {
    cpu: (cpu1.user + cpu1.system) / 1000 / n, // ms of process CPU per frame
    wall: (marks[1] - marks[0]) / n,
    zero: (st1.zero - st0.zero) / n, throttled: (st1.throttled - st0.throttled) / n, picks: (picks1 - picks0) / n,
    mean: iv.reduce((a, b) => a + b, 0) / iv.length, p50: iv[iv.length >> 1], p90: iv[Math.floor(iv.length * 0.9)], p99: iv[Math.floor(iv.length * 0.99)], max: iv[iv.length - 1],
  };
}

const res = [];
for (let r = 0; r < RUNS; r++) res.push(runOnce());
const stat = (k, d = 2) => { const v = res.map((x) => x[k]).sort((a, b) => a - b); return `${v[v.length >> 1].toFixed(d)} (min ${v[0].toFixed(d)}, max ${v[v.length - 1].toFixed(d)})`; };
console.log(`per frame (median of ${RUNS} runs): CPU ${stat('cpu')} ms, wall ${stat('wall')} ms`);
console.log(`  Sleep(0) ${stat('zero', 1)}, throttled ${stat('throttled', 1)}, scheduling decisions ${stat('picks', 1)}`);
console.log(`  frame interval: mean ${stat('mean')} ms, p50 ${stat('p50')} ms, p90 ${stat('p90')} ms, p99 ${stat('p99')} ms, max ${stat('max')} ms`);
