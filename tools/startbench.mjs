#!/usr/bin/env node
// Startup benchmark (Node, headless, no rendering): runs a manifest from a fresh user profile until the first call of
// an API (the end of a phase: --until-api, default CreateProcessA) and reports the wall time, the CPU time of the
// process (less sensitive than wall time to other load on a shared machine) and the guest instructions executed.
// Compares JIT variants: `ORTHROS_JIT_OPTS='{"nestLoops":true}' node tools/startbench.mjs manifests/x.json`.
//   node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vm } from '../src/core/vm.js';
import { normalizeWin } from '../src/vfs/vfs.js';
import { RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Registry } from '../src/win32/registry.js';
import { loadManifest, makeVfs } from '../src/host/cli.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!target) { console.error('usage: node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600]'); process.exit(2); }
const untilApi = opt('until-api', 'CreateProcessA'), limit = Number(opt('limit', 600));
const { manifest, dir } = loadManifest(target);
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-startbench-')); // (a fresh profile: the first-launch path)
const vfs = makeVfs(manifest, dir, saveDir);
const clock = new RealClock();
const host = new HeadlessHost({ clock, width: manifest.display.width, height: manifest.display.height });
const vm = new Vm({ vfs, clock, host, logKinds: ['crash'] });
if (process.env.ORTHROS_JIT_OPTS && vm.jit) Object.assign(vm.jit.opts, JSON.parse(process.env.ORTHROS_JIT_OPTS));
vm.registry = new Registry();
vm.registry.seed(manifest.registry);
const t0 = performance.now(), c0 = process.cpuUsage();
const report = (why) => {
  const wall = (performance.now() - t0) / 1000, cpu = process.cpuUsage(c0).user / 1e6, minsns = vm.slices * 0.1;
  console.log(`${why}: wall ${wall.toFixed(1)} s, CPU ${cpu.toFixed(1)} s, ~${minsns.toFixed(0)} M guest instructions (${(minsns / cpu).toFixed(0)} MIPS per CPU second), ${vm.jit?.stats.regions ?? 0} regions, translation ${(vm.jit?.stats.translateMs ?? 0).toFixed(0)} ms`);
};
const dispatch = vm.dispatchThunk.bind(vm);
vm.dispatchThunk = (t, i) => {
  const th = vm.api.thunk(i);
  if (th?.name === untilApi) { report(`${untilApi} reached`); fs.rmSync(saveDir, { recursive: true, force: true }); process.exit(0); }
  if (performance.now() - t0 > limit * 1000) { report('time limit'); process.exit(1); }
  return dispatch(t, i);
};
vm.host.waitEvent = (ms) => clock.sleep(Math.min(ms, 50));
vm.createProcess({ exePath: normalizeWin(manifest.mount + '\\' + manifest.exe), args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides });
try { vm.run(); report('exited'); } catch (e) { report(`stopped (${String(e.message ?? e).split('\n')[0].slice(0, 120)})`); }
fs.rmSync(saveDir, { recursive: true, force: true });
