#!/usr/bin/env node
// Startup benchmark (Node, headless, no rendering): runs a manifest from a fresh user profile until the first call of
// an API (the end of a phase: --until-api, default CreateProcessA) and reports the wall time, the CPU time of the
// process (less sensitive than wall time to other load on a shared machine) and the guest instructions executed.
// Compares JIT variants: `ORTHROS_JIT_OPTS='{"nestLoops":true}' node tools/startbench.mjs <manifest.json>`.
//   node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600] [--bg | --cold] [--save <dir>] [--until-insns <M>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vm } from '../src/core/vm.js';
import { normalizeWin } from '../src/vfs/vfs.js';
import { RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Registry } from '../src/win32/registry.js';
import { loadManifest, makeVfs } from '../src/host/cli.js';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { decode, fmtInsn } from '../src/cpu/decoder.js';
import { listRegion } from '../src/cpu/jit/listing.js';
import { jitMix, jitShape } from './jit-mix.mjs';
import { acct, C as ACCT, catsObject } from '../src/core/frame-acct.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!target) { console.error('usage: node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600]'); process.exit(2); }
const untilApi = opt('until-api', 'CreateProcessA'), limit = Number(opt('limit', 600));
// --until-insns <M>: stop after that many million guest instructions (a fixed amount of guest work: under
// `perf stat -e instructions:u`, the host instructions per guest instruction of a JIT variant, insensitive to the load)
const untilInsns = Number(opt('until-insns', 0)) * 1e6;
const win = opt('window') ? { a: Number(opt('window').split(':')[0]) * 1e6, b: Number(opt('window').split(':')[1]) * 1e6, c0: null, g0: 0, t0: 0 } : null;
// --games-dir <dir>: `target` is a manifest id of that game catalog (e.g. bfme2 = BFME2 1.09), as the harness takes it
const { manifest, dir } = opt('games-dir') ? (() => { const m = loadGameCatalog(opt('games-dir')).get(target); if (!m) throw new Error(`no manifest ${target}`); return { manifest: m, dir: m.folder }; })() : loadManifest(target);
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
// --jit-profile: profiling translations (transitions by kind, chained transitions counted), printed with the report
if (args.includes('--jit-profile')) globalThis.ORTHROS_JIT_PROFILE = true;
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
globalThis.__vm = vm; // (wrappers: tools reading the VM after the run)
if (process.env.ORTHROS_JIT_OPTS && vm.jit) Object.assign(vm.jit.opts, JSON.parse(process.env.ORTHROS_JIT_OPTS));
// --mix: translations count their blocks' executions; the report adds the dynamic instruction mix (tools/jit-mix.mjs)
if (args.includes('--mix') && vm.jit) vm.jit.opts.blockCounts = true;
if (opt('jit-opts') && vm.jit) Object.assign(vm.jit.opts, JSON.parse(opt('jit-opts'))); // (the same, as an option)
if (vm.jit?.opts.consolidateEvery) vm.jit.consolidateEvery = vm.jit.opts.consolidateEvery; // (read by the constructor)
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
  const wall = (performance.now() - t0) / 1000, cpu = process.cpuUsage(c0).user / 1e6, minsns = vm.guestInsns / 1e6;
  if (process.env.ORTHROS_JIT_STATS) {
    const j = vm.jit?.stats ?? {}; console.log(Object.entries(j).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${Math.round(v)}`).join(' '));
    // the instructions the regions leave to the interpreter (EXIT_STEP), by address, with the x87 control word then
    if (vm.jit?.stepHist) for (const [a, n] of [...vm.jit.stepHist].sort((x, y) => y[1] - x[1]).slice(0, 12)) { let d = '?'; try { d = fmtInsn(decode(vm.mem, a)); } catch { /* */ } console.log(`  step ${n} x ${vm.proc.symbolize(a)}  ${d}  ${(vm.jit.stepSamples?.get(a) ?? []).join(' | ')}`); }
  }
  // --list <hex eip,...>: the translation listing of the live regions holding these addresses (with block counts when
  // translated with them: --jit-opts '{"blockCounts":true}'), as the harness's jitlist:<eip>; --list-brief: counts only
  for (const a of (opt('list', '') || '').split(',').filter(Boolean)) {
    const r = vm.jit?.regionAt(parseInt(a, 16));
    if (!r) { console.log(`list ${a}: no live region`); continue; }
    try { console.log(listRegion(vm.mem, r.entry, { ...vm.jit.translateOpts(r.fnIdx, r.fpc), blockCounts: false }, { counts: vm.jit.blockCounts(r), ops: !args.includes('--list-brief') }).text); } catch (e) { console.log(`list ${a}: ${e.message}`); }
  }
  if (args.includes('--mix') && vm.jit) { console.log(jitMix(vm.jit)); console.log(jitShape(vm.jit, listRegion)); const st = vm.jit.stats; console.log(`[mix] chained transitions ${(st.chained / 1e6).toFixed(1)} M, misses ${st.misses}, fallback steps ${st.fallbackSteps}, interpreter steps ${st.steps}`); }
  if (args.includes('--jit-profile') && vm.jit) { for (const t of vm.proc?.threads ?? []) vm.jit.harvest(t.cpu.b4); console.log(`[jitprof] ${Object.entries(vm.jit.stats.prof ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)}M`).join(', ')}; chained ${(vm.jit.stats.chained / 1e6).toFixed(1)}M`); }
  if (apiHist) console.log(`[api] ${[...apiHist].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)}M`).join(', ')}`);
  console.log(`${why}: wall ${wall.toFixed(1)} s, CPU ${cpu.toFixed(1)} s, ~${minsns.toFixed(0)} M guest instructions (${(minsns / cpu).toFixed(0)} MIPS per CPU second), ${vm.jit?.stats.regions ?? 0} regions, translation ${(vm.jit?.stats.translateMs ?? 0).toFixed(0)} ms`);
};
// --api-hist: the API calls dispatched to JavaScript (the WASM fast paths not counted), most frequent first, with the report
const apiHist = args.includes('--api-hist') ? new Map() : null;
const dispatch = vm.dispatchThunk.bind(vm);
vm.dispatchThunk = (t, i) => {
  const th = vm.api.thunk(i);
  if (apiHist && th) apiHist.set(th.name, (apiHist.get(th.name) ?? 0) + 1);
  if (th?.name === untilApi) { report(`${untilApi} reached`); if (!keepDir) fs.rmSync(saveDir, { recursive: true, force: true }); process.exit(0); }
  if (performance.now() - t0 > limit * 1000) { report('time limit'); process.exit(1); }
  // --window <a>:<b> (millions of guest instructions): the CPU time per guest instruction between the two points only
  // (a phase of steady guest code, the startup's loading left out), then stop
  if (win) {
    if (!win.c0 && vm.guestInsns >= win.a) { win.c0 = process.cpuUsage(); win.g0 = vm.guestInsns; win.t0 = performance.now(); acct.frame(); }
    else if (win.c0 && vm.guestInsns >= win.b) {
      const cpu = process.cpuUsage(win.c0).user / 1e6, g = vm.guestInsns - win.g0;
      // (the frame accounting's guest category over the window — translated code, the dispatcher, thread switches — with
      // the untimed API calls' estimated time taken out, as the browser's phase reports compute guestMsPerMInsn)
      const cats = acct.frame();
      console.log(`window ${win.a / 1e6}-${win.b / 1e6} M: ${(g / 1e6).toFixed(0)} M guest instructions, CPU ${cpu.toFixed(2)} s, wall ${((performance.now() - win.t0) / 1000).toFixed(2)} s: ${(cpu * 1e9 / g).toFixed(3)} ns per instruction; guest ${(cats[ACCT.guest] * 1e6 / g).toFixed(3)} ns per instruction (${Object.entries(catsObject(cats, 0.1, 6, 1e-3)).map(([k, v]) => `${k} ${v} s`).join(', ')})`);
      report('window end'); process.exit(0);
    }
  }
  if (untilInsns && vm.guestInsns >= untilInsns) { report(`${(vm.guestInsns / 1e6).toFixed(0)} M guest instructions`); process.exit(0); }
  return dispatch(t, i);
};
vm.host.waitEvent = (ms) => { const p = acct.enter(ACCT.wait); try { return clock.sleep(Math.min(ms, 50)); } finally { acct.leave(p); } }; // (pacing: not guest time)
// --stop-on <text>: stop once a log message of any kind contains that text (as the harness's --stop-on), e.g. the end of
// a game's first-launch computation
const stopOn = opt('stop-on', null);
if (stopOn) { const log = vm.log.bind(vm); vm.log = (kind, msg) => { if (typeof msg === 'string' && msg.includes(stopOn)) { report(`"${stopOn}" logged`); fs.rmSync(saveDir, { recursive: true, force: true }); process.exit(0); } log(kind, msg); }; }
vm.createProcess({ exePath: normalizeWin(manifest.mount + '\\' + manifest.exe), args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides });
acct.enter(ACCT.guest); // (as the browser worker's slices: the VM's own sections enter their categories)
try { vm.run(); report('exited'); } catch (e) { report(`stopped (${String(e.message ?? e).split('\n')[0].slice(0, 120)})`); }
if (!keepDir) fs.rmSync(saveDir, { recursive: true, force: true });
