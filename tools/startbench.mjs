#!/usr/bin/env node
// Startup benchmark (Node, headless, no rendering): runs a manifest from a fresh user profile until the first call of
// an API (the end of a phase: --until-api, default CreateProcessA) and reports the wall time, the CPU time of the
// process (less sensitive than wall time to other load on a shared machine) and the guest instructions executed.
// Compares JIT variants: `ORTHROS_JIT_OPTS='{"nestLoops":true}' node tools/startbench.mjs <manifest.json>`.
//   node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600] [--bg | --cold] [--save <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vm } from '../src/core/vm.js';
import { normalizeWin } from '../src/vfs/vfs.js';
import { RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Registry } from '../src/win32/registry.js';
import { loadManifest, makeVfs } from '../src/host/cli.js';
import { decode, fmtInsn } from '../src/cpu/decoder.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!target) { console.error('usage: node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600]'); process.exit(2); }
const untilApi = opt('until-api', 'CreateProcessA'), limit = Number(opt('limit', 600));
const { manifest, dir } = loadManifest(target);
// (a fresh profile: the first-launch path; --save <dir>: that empty directory, kept afterwards — the files the game wrote
// compared between variants)
const keepDir = opt('save');
if (keepDir) fs.mkdirSync(keepDir, { recursive: true });
const saveDir = keepDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-startbench-'));
const vfs = makeVfs(manifest, dir, saveDir);
const clock = new RealClock();
const host = new HeadlessHost({ clock, width: manifest.display.width, height: manifest.display.height });
// --bg: the background translator in a worker thread (shared guest memory), its regions installed between slices;
// --cold: with the JIT's cold tier (Jit.runCold) — what the browser worker does
const bgWanted = args.includes('--bg') || args.includes('--cold');
const vm = new Vm({ vfs, clock, host, logKinds: ['crash'], sharedMemory: bgWanted });
if (bgWanted && vm.jit) {
  const { Worker, MessageChannel, receiveMessageOnPort } = await import('node:worker_threads');
  const ch = new MessageChannel();
  const w = new Worker(`import { workerData } from 'node:worker_threads'; import { handleMessage } from ${JSON.stringify(new URL('../src/cpu/jit/bg-translate.js', import.meta.url).href)};
    workerData.port.on('message', (m) => handleMessage(m, (r) => workerData.port.postMessage(r)));`, { eval: true, workerData: { port: ch.port2 }, transferList: [ch.port2] });
  w.unref();
  vm.jit.attachBackground({ postMessage: (m) => ch.port1.postMessage(m) });
  vm.jit.coldTier = args.includes('--cold');
  const sliceEnd = vm.sliceEnd.bind(vm);
  vm.sliceEnd = (t, o) => {
    if (vm.jit.coldQueue.length) vm.jit.flushCold();
    for (let m; (m = receiveMessageOnPort(ch.port1)); ) vm.jit.bgInstall(m.message);
    return sliceEnd(t, o);
  };
}
if (process.env.ORTHROS_JIT_OPTS && vm.jit) Object.assign(vm.jit.opts, JSON.parse(process.env.ORTHROS_JIT_OPTS));
if (process.env.ORTHROS_JIT_STATS && vm.jit) {
  vm.jit.stepHist = new Map();
  // a few samples per address: control word, ST(0), the memory operand (m64) and the interpreter's result
  const samples = new Map();
  vm.jit.stepSample = (cpu) => {
    const a = cpu.eip >>> 0, list = samples.get(a) ?? []; if (list.length >= 3 || Math.random() > 0.001) return;
    let mem = null; try { const insn = decode(vm.mem, a); const o = insn.ops.find((x) => x.t === 2); if (o) { const ea = ((o.base >= 0 ? cpu.reg(o.base) : 0) + (o.index >= 0 ? cpu.reg(o.index) << o.scale : 0) + o.disp) >>> 0; mem = vm.mem.readF64(ea); } } catch { /* */ }
    list.push(`cw=${cpu.fpuCw.toString(16)} st0=${cpu.st(0)} m64=${mem}`); samples.set(a, list);
  };
  vm.jit.stepSamples = samples;
}
vm.registry = new Registry();
vm.registry.seed(manifest.registry);
const t0 = performance.now(), c0 = process.cpuUsage();
const report = (why) => {
  const wall = (performance.now() - t0) / 1000, cpu = process.cpuUsage(c0).user / 1e6, minsns = vm.slices * 0.1;
  if (process.env.ORTHROS_JIT_STATS) {
    const j = vm.jit?.stats ?? {}; console.log(Object.entries(j).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${Math.round(v)}`).join(' '));
    // the instructions the regions leave to the interpreter (EXIT_STEP), by address, with the x87 control word then
    if (vm.jit?.stepHist) for (const [a, n] of [...vm.jit.stepHist].sort((x, y) => y[1] - x[1]).slice(0, 12)) { let d = '?'; try { d = fmtInsn(decode(vm.mem, a)); } catch { /* */ } console.log(`  step ${n} x ${vm.proc.symbolize(a)}  ${d}  ${(vm.jit.stepSamples?.get(a) ?? []).join(' | ')}`); }
  }
  console.log(`${why}: wall ${wall.toFixed(1)} s, CPU ${cpu.toFixed(1)} s, ~${minsns.toFixed(0)} M guest instructions (${(minsns / cpu).toFixed(0)} MIPS per CPU second), ${vm.jit?.stats.regions ?? 0} regions, translation ${(vm.jit?.stats.translateMs ?? 0).toFixed(0)} ms`);
};
const dispatch = vm.dispatchThunk.bind(vm);
vm.dispatchThunk = (t, i) => {
  const th = vm.api.thunk(i);
  if (th?.name === untilApi) { report(`${untilApi} reached`); if (!keepDir) fs.rmSync(saveDir, { recursive: true, force: true }); process.exit(0); }
  if (performance.now() - t0 > limit * 1000) { report('time limit'); process.exit(1); }
  return dispatch(t, i);
};
vm.host.waitEvent = (ms) => clock.sleep(Math.min(ms, 50));
vm.createProcess({ exePath: normalizeWin(manifest.mount + '\\' + manifest.exe), args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides });
try { vm.run(); report('exited'); } catch (e) { report(`stopped (${String(e.message ?? e).split('\n')[0].slice(0, 120)})`); }
if (!keepDir) fs.rmSync(saveDir, { recursive: true, force: true });
