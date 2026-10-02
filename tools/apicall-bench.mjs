#!/usr/bin/env node
// API dispatch microbenchmark: runs build/pe/apibench.exe (tools/pe/apibench.c) under the JIT and reports the time
// per API call handled in JavaScript (guest code -> region exit -> dispatcher -> handler -> back into translated
// code), a round trip play-time code pays tens of thousands of times per second.
// Usage: node tools/apicall-bench.mjs [--runs 5] [--src <dir with core/, cpu/...>]
//   --src: import the emulator from another source tree (e.g. a checkout of the previous commit: before/after)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RUNS = +argOf('--runs', 5);
const SRC = path.resolve(argOf('--src', new URL('../src', import.meta.url).pathname));
const imp = (p) => import(pathToFileURL(path.join(SRC, p)).href);
const { Vm } = await imp('core/vm.js');
const { Vfs, MemBackend } = await imp('vfs/vfs.js');
const { RealClock } = await imp('core/clock.js');
const { HeadlessHost } = await imp('host/display.js');
const PE = new URL('../build/pe/apibench.exe', import.meta.url).pathname;
const CALLS = 1000000;

function runOnce() {
  const vfs = new Vfs();
  const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', t);
  t.open('apibench.exe', { create: true }).write(0, fs.readFileSync(PE));
  const clock = new RealClock();
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock }), jit: true, logKinds: ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\apibench.exe' });
  const marks = [];
  const dispatch = vm.dispatchThunk.bind(vm);
  vm.dispatchThunk = (th, i) => { if (vm.api.thunk(i)?.name === 'GetCommandLineA') marks.push(performance.now()); return dispatch(th, i); };
  const code = vm.run();
  if (code !== 0 || marks.length !== 2) throw new Error(`apibench.exe: exit code ${code}, ${marks.length} marks`);
  return { call: (marks[1] - marks[0]) * 1e6 / CALLS };
}

const res = [];
for (let r = 0; r < RUNS; r++) res.push(runOnce());
const stat = (k) => { const v = res.map((x) => x[k]).sort((a, b) => a - b); return `${v[v.length >> 1].toFixed(0)} ns (min ${v[0].toFixed(0)}, max ${v[v.length - 1].toFixed(0)})`; };
console.log(`API call handled in JavaScript: ${stat('call')}`);
