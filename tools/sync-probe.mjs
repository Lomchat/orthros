#!/usr/bin/env node
// Diagnostic: runs build/pe/sync.exe (tests/pe.test.js) under the JIT with the given translation options and prints the
// WaitForSingleObject / ReleaseMutex calls handled in JavaScript, with their return addresses (which section of the
// program took the slow path). Usage: node tools/sync-probe.mjs ['{"layout":true}']
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const vfs = new Vfs(), test = new MemBackend();
vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', test);
test.open('sync.exe', { create: true }).write(0, fs.readFileSync(PE_DIR + 'sync.exe'));
const clock = new VirtualClock();
const host = new HeadlessHost({ clock, width: 800, height: 600 });
const vm = new Vm({ vfs, clock, host, jit: true, apiHist: true, logKinds: ['warn', 'crash'] });
if (process.argv[2]) Object.assign(vm.jit.opts, JSON.parse(process.argv[2]));
vm.createProcess({ exePath: 'C:\\Test\\sync.exe' });
const sites = new Map(), seq = [];
const dispatch = vm.dispatchThunk.bind(vm);
vm.dispatchThunk = (t, i) => {
  const th = vm.api.thunk(i);
  if (process.env.SYNC_TRACE && seq.length < 80 && th) seq.push(`t${t.id}:${th.name}@${(vm.mem.read32(t.cpu.esp >>> 0) >>> 0).toString(16)}`);
  if (th && (th.name === 'WaitForSingleObject' || th.name === 'ReleaseMutex')) { const k = `${th.name} t${t.id} ret ${(vm.mem.read32(t.cpu.esp >>> 0) >>> 0).toString(16)}`; sites.set(k, (sites.get(k) ?? 0) + 1); }
  return dispatch(t, i);
};
const code = vm.run();
console.log(vm.stdout.join('').trim().replace(/\n/g, ' '), 'exit', code, 'guest instructions', vm.guestInsns);
if (seq.length) console.log(seq.join(' '));
for (const [k, v] of [...sites].sort((a, b) => b[1] - a[1])) console.log(`  ${v} ${k}`);
