#!/usr/bin/env node
// Startup benchmark (Node, headless, no rendering): runs a manifest from a fresh user profile until the first call of
// an API (the end of a phase: --until-api, default CreateProcessA) and reports the wall time, the CPU time of the
// process (less sensitive than wall time to other load on a shared machine) and the guest instructions executed.
// Compares JIT variants: `ORTHROS_JIT_OPTS='{"nestLoops":true}' node tools/startbench.mjs <manifest.json>`.
//   node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600] [--bg | --cold] [--save <dir>] [--until-insns <M>]
//     [--input <scenario> [--coords W,H] | --bench <bench name>]
import './node-wasm-flags.mjs'; // (branch hints honoured, as in Chrome)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vm } from '../src/core/vm.js';
import { normalizeWin } from '../src/vfs/vfs.js';
import { RealClock, VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Registry } from '../src/win32/registry.js';
import { loadManifest, makeVfs } from '../src/host/cli.js';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { decode, fmtInsn } from '../src/cpu/decoder.js';
import { listRegion } from '../src/cpu/jit/listing.js';
import { PROF_OPS_BASE, NOCHAIN_PROF, SITE_PROF } from '../src/cpu/jit/translate.js';
import { FAST_PROF, FAST_NAMES } from '../src/cpu/jit/runtime.js';
import { jitMix, jitShape } from './jit-mix.mjs';
import { NodeScenario } from './node-scenario.mjs';
import { installNodeGfx, programsLine } from './node-gfx.mjs';
import { LearnedHeat, RangeHeat } from '../src/cpu/jit/heat.js';
import { acct, C as ACCT, catsObject } from '../src/core/frame-acct.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!target) { console.error('usage: node tools/startbench.mjs <manifest.json> [--until-api CreateProcessA] [--limit 600]'); process.exit(2); }
const untilApi = opt('until-api', 'CreateProcessA'), limit = Number(opt('limit', 600));
// --dbg NAME=value,...: debug globals set before the run (the page's ?dbg= switches, e.g. ORTHROS_HOST_TIMER_Q=15.625)
for (const kv of (opt('dbg', '') || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); globalThis[k] = Number.isNaN(Number(v)) ? v : Number(v); }
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
// --virtual: a virtual clock (time advances with the guest's slices and sleeps) and the scenario timed on it — a run that
// repeats itself exactly (thread interleavings included) as long as nothing else varies (no --bg / --cold)
// --timescale <x>: guest milliseconds per real millisecond (as the page's ?timescale: above 1 the guest sees a slower machine)
const clock = args.includes('--virtual') ? new VirtualClock() : new RealClock(Number(opt('timescale', 1)));
// --jitter <seed>: with --virtual, the clock jumps now and then at the end of a slice (seeded xorshift: 1 slice in 64, 1 to
// 40 ms) as when the host deschedules the emulator — other interleavings of the guest's timed threads, each seed exactly
// repeatable
if (args.includes('--virtual') && opt('jitter')) {
  let x = Number(opt('jitter')) >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const tick = clock.tick.bind(clock);
  clock.tick = (ms) => { tick(ms); if ((rnd() & 63) === 0) tick(1 + (rnd() % 40)); };
}
const host = new HeadlessHost({ clock, width: manifest.display.width, height: manifest.display.height });
// --gfx recorder|backend: the Direct3D work goes to the render worker's recorder (commands dropped: the emulator thread's
// share of the default browser path) or to the in-thread WebGL backend over a no-op context (tools/node-gfx.mjs, as
// framebench); --programs <programs2-<manifest>.json>: learned GL programs compiled ahead (backend). Default: neither
// (the device's own bookkeeping only).
const gfx = opt('gfx') ? installNodeGfx(host, opt('gfx'), { programs: opt('programs'), log: (l) => console.log(l) }) : null;
// --bg: the background translator in a worker thread (shared guest memory), its regions installed between slices;
// --cold: with the JIT's cold tier (Jit.runCold) — what the browser worker does
const bgWanted = args.includes('--bg') || args.includes('--cold');
// --jit-profile: profiling translations (transitions by kind, chained transitions counted), printed with the report
if (args.includes('--jit-profile')) globalThis.ORTHROS_JIT_PROFILE = true;
// --jit-sites: every region exit site (indirect calls and jumps, returns leaving the region, static exits) counts its
// executions and target changes (translate.js siteProf); the report lists them by kind and the hottest sites
if (args.includes('--jit-sites')) globalThis.ORTHROS_SITE_PROF = true;
const siteReport = () => {
  const by = new Map();
  for (const [addr, kind, a] of SITE_PROF) {
    const k = kind + ':' + addr, n = vm.mem.read32(a) >>> 0, ch = vm.mem.read32(a + 8) >>> 0;
    const e = by.get(k) ?? { addr, kind, n: 0, ch: 0, last: 0 }; e.n += n; e.ch += ch; if (n) e.last = vm.mem.read32(a + 4) >>> 0; by.set(k, e);
  }
  const kinds = new Map();
  for (const e of by.values()) {
    const s = kinds.get(e.kind) ?? { n: 0, ch: 0, sites: 0, mono: 0 }; s.n += e.n; s.ch += e.ch; if (e.n) s.sites++; if (e.ch * 20 <= e.n) s.mono += e.n; kinds.set(e.kind, s);
  }
  console.log(`[sites] ${[...kinds].map(([k, s]) => `${k} ${(s.n / 1e6).toFixed(1)}M at ${s.sites} sites, target changes ${(s.ch / 1e6).toFixed(1)}M, at sites changing <5%: ${(100 * s.mono / Math.max(1, s.n)).toFixed(0)}%`).join('; ')}`);
  const all = [...by.values()].sort((x, y) => y.n - x.n);
  const tot = all.reduce((t, e) => t + e.n, 0); let acc = 0, k90 = 0; for (const e of all) { acc += e.n; k90++; if (acc >= 0.9 * tot) break; }
  console.log(`[sites] ${(tot / 1e6).toFixed(1)}M exits, 90% at ${k90} sites`);
  const sym = (a) => { try { return vm.proc.symbolize(a); } catch { return a.toString(16); } };
  for (const e of all.slice(0, Number(opt('jit-sites-top', 40)))) console.log(`  ${e.kind} ${sym(e.addr)} ${(e.n / 1e6).toFixed(2)}M changes ${(100 * e.ch / Math.max(1, e.n)).toFixed(1)}% last ${sym(e.last)}`);
};
// --log <kinds>: the emulator log kinds printed (default crash; e.g. crash,warn — null-page faults are warnings)
const vm = new Vm({ vfs, clock, host, logKinds: (opt('log') ?? 'crash').split(','), sharedMemory: bgWanted });
if (bgWanted && vm.jit) {
  const { Worker, MessageChannel, receiveMessageOnPort } = await import('node:worker_threads');
  const ch = new MessageChannel();
  const w = new Worker(`import { workerData } from 'node:worker_threads'; import { handleMessage } from ${JSON.stringify(new URL('../src/cpu/jit/bg-translate.js', import.meta.url).href)};
    workerData.port.on('message', (m) => handleMessage(m, (r) => workerData.port.postMessage(r)));`, { eval: true, workerData: { port: ch.port2 }, transferList: [ch.port2] });
  w.unref();
  vm.jit.attachBackground({ postMessage: (m) => ch.port1.postMessage(m) });
  vm.jit.coldTier = args.includes('--cold');
  // --regions <file>: learned region entries (the server's regions-<manifest>.json) translated ahead in the background
  // worker as the page worker does (feedBackground), in their order of first use
  const learnedRegions = opt('regions') ? JSON.parse(fs.readFileSync(opt('regions'), 'utf8')).sort((x, y) => x[1] - y[1]).map(([k]) => { const [m, rva, fpc] = k.split(':'); return [m, Number(rva), fpc === '' ? null : Number(fpc)]; }) : null;
  let regionPos = 0, regionMods = -1, modMap = null;
  const sliceEnd = vm.sliceEnd.bind(vm);
  vm.sliceEnd = (t, o) => {
    if (learnedRegions && vm.proc) {
      if (regionMods !== vm.proc.moduleList.length) { regionMods = vm.proc.moduleList.length; modMap = new Map(vm.proc.moduleList.map((x) => [x.name.toLowerCase(), x])); regionPos = 0; }
      while (vm.jit.bgPending() < 2 && regionPos < learnedRegions.length) {
        const list = [];
        while (list.length < 48 && regionPos < learnedRegions.length) { const [m, rva, fpc] = learnedRegions[regionPos++]; const mod = modMap.get(m); if (mod && rva < mod.size) list.push([mod.base + rva, fpc]); }
        if (list.length) vm.jit.bgPrewarm(list);
      }
    }
    if (vm.jit.coldQueue.length) vm.jit.flushCold();
    for (let m; (m = receiveMessageOnPort(ch.port1)); ) vm.jit.bgInstall(m.message);
    return sliceEnd(t, o);
  };
}
globalThis.__vm = vm; // (wrappers: tools reading the VM after the run)
// --d3dx-prof: D3DX image work timed by kind of operation (d3dx9.js prof, as the harness's --api-times), printed with
// the surface lock patterns at each scenario mark ([d3dx] lines); a clock read per API call
if (args.includes('--d3dx-prof')) vm.apiTimes = new Map();
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
// --heat <file>: learned code heat ({ module: [rva, length, ...] }, as the server's heat-<manifest>.json), applied as the
// modules load (the regions leave out what never ran, see src/cpu/jit/heat.js); --heat-out <file>: the translations'
// visit flags harvested at the end, merged into that file
const learnedHeat = opt('heat') && vm.jit ? new LearnedHeat(JSON.parse(fs.readFileSync(opt('heat'), 'utf8'))) : null;
let heatModules = 0;
if (opt('heat-out') && vm.jit) vm.jit.opts.visit = true;
const writeHeat = () => {
  const f = opt('heat-out'); if (!f || !vm.jit) return;
  const pairs = vm.jit.harvestVisits(), byMod = new Map();
  let old = {}; try { old = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* new */ }
  for (const [mod, l] of Object.entries(old)) { const h = new RangeHeat(); for (let i = 0; i + 1 < l.length; i += 2) h.add(l[i], l[i] + l[i + 1]); byMod.set(mod, h); }
  for (let i = 0; i < pairs.length; i += 2) {
    const m = vm.proc.moduleByAddr(pairs[i]); if (!m || pairs[i + 1] > m.base + m.size) continue;
    const k = m.name.toLowerCase(); if (!byMod.has(k)) byMod.set(k, new RangeHeat());
    byMod.get(k).add(pairs[i] - m.base, pairs[i + 1] - m.base);
  }
  const out = {}; let n = 0;
  for (const [k, h] of byMod) { const p = h.pairs(), l = []; for (let i = 0; i < p.length; i += 2) l.push(p[i], p[i + 1] - p[i]); out[k] = l; n += p.length / 2; }
  fs.writeFileSync(f, JSON.stringify(out));
  console.log(`[heat] ${pairs.length / 2} blocks visited, ${n} ranges in ${f}`);
};
const t0 = performance.now(), c0 = process.cpuUsage();
const report = (why) => {
  writeHeat();
  if (gfx?.kind === 'backend') { const l = programsLine(gfx); if (l) console.log(l); }
  const wall = (performance.now() - t0) / 1000, cpu = process.cpuUsage(c0).user / 1e6, minsns = vm.guestInsns / 1e6;
  if (process.env.ORTHROS_JIT_STATS) {
    const j = vm.jit?.stats ?? {}; console.log(Object.entries(j).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${Math.round(v)}`).join(' '));
    // the instructions the regions leave to the interpreter (EXIT_STEP), by address, with the x87 control word then
    if (vm.jit?.stepHist) for (const [a, n] of [...vm.jit.stepHist].sort((x, y) => y[1] - x[1]).slice(0, 12)) { let d = '?'; try { d = fmtInsn(decode(vm.mem, a)); } catch { /* */ } console.log(`  step ${n} x ${vm.proc.symbolize(a)}  ${d}  ${(vm.jit.stepSamples?.get(a) ?? []).join(' | ')}`); }
  }
  // --list <hex eip,...>: the translation listing of the live regions holding these addresses (with block counts when
  // translated with them: --jit-opts '{"blockCounts":true}'), as the harness's jitlist:<eip>; --list-brief: counts only
  // --counts-out <file>: every live region's counted guest instructions (translations with block counters), as JSON
  // --blocks-out <file>: every live counted region's blocks [entry, fnIdx, x87 mode, [[eip, end, count]...]] (how often each
  // guest block ran in which region: the duplication of hot code across regions)
  if (opt('blocks-out') && vm.jit) fs.writeFileSync(opt('blocks-out'), JSON.stringify(vm.jit.regions.filter((r) => r.counters >= 0).map((r) => { const cs = vm.jit.blockCounts(r); return [r.entry, r.fnIdx, r.fpc ?? null, r.blocks.map((b) => [b.eip, b.end, cs[b.index]])]; })));
  if (opt('counts-out') && vm.jit) fs.writeFileSync(opt('counts-out'), JSON.stringify(vm.jit.regions.filter((r) => r.counters >= 0).map((r) => [r.entry.toString(16), ((cs) => r.blocks.reduce((n, b) => n + cs[b.index] * (b.end - b.eip), 0))(vm.jit.blockCounts(r))])));
  // --list-top <n>: the n regions that ran the most counted guest instructions (translations with block counters)
  const top = Number(opt('list-top', 0)) && vm.jit ? vm.jit.regions.filter((r) => r.counters >= 0).map((r) => [r, ((cs) => r.blocks.reduce((n, b) => n + cs[b.index] * (b.end - b.eip), 0))(vm.jit.blockCounts(r))]).sort((x, y) => y[1] - x[1]).slice(0, Number(opt('list-top'))).map(([r]) => r) : [];
  // (--list-top lists the counted regions themselves — an x87-mode version included —, with their x87 mode)
  for (const a of [...(opt('list', '') || '').split(',').filter(Boolean), ...top]) {
    const r = typeof a === 'string' ? vm.jit?.regionAt(parseInt(a, 16)) : a;
    if (!r) { console.log(`list ${a}: no live region`); continue; }
    if (typeof a !== 'string') console.log(`list ${r.entry.toString(16)}: x87 mode ${r.fpc === null || r.fpc === undefined ? 'generic' : '0x' + r.fpc.toString(16)}${r.first ? ' (a version)' : ''}`);
    try { console.log(listRegion(vm.mem, r.entry, { ...vm.jit.translateOpts(r.fnIdx, r.fpc), blockCounts: false }, { counts: vm.jit.blockCounts(r), ops: !args.includes('--list-brief') }).text); } catch (e) { console.log(`list ${a}: ${e.message}`); }
  }
  // --x87-modes: the live regions by x87 mode (generic, or precision / rounding control bits: 0x000 24-bit nearest,
  // 0xc00 24-bit toward zero, 0x200 53-bit, 0x300 64-bit...) — which arithmetic paths a session's code runs
  if (args.includes('--x87-modes') && vm.jit) {
    const h = new Map(); for (const r of vm.jit.regions) { const k = r.fpc === null || r.fpc === undefined ? 'none' : '0x' + (r.fpc & 0xf00).toString(16); h.set(k, (h.get(k) ?? 0) + 1); }
    console.log(`[x87modes] live regions by x87 mode: ${[...h].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  if (args.includes('--mix') && vm.jit) { console.log(jitMix(vm.jit)); console.log(jitShape(vm.jit, listRegion)); const st = vm.jit.stats; console.log(`[mix] chained transitions ${(st.chained / 1e6).toFixed(1)} M, misses ${st.misses}, fallback steps ${st.fallbackSteps}, interpreter steps ${st.steps}`); }
  if (args.includes('--jit-profile') && vm.jit) { for (const t of vm.proc?.threads ?? []) vm.jit.harvest(t.cpu.b4); console.log(`[jitprof] ${Object.entries(vm.jit.stats.prof ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)}M`).join(', ')}; chained ${(vm.jit.stats.chained / 1e6).toFixed(1)}M; unchained (thunk, stop, budget, miss) ${[0, 1, 2, 3].map((k) => (vm.mem.read32(PROF_OPS_BASE + NOCHAIN_PROF + 4 * k) / 1e6).toFixed(1) + 'M').join(' ')}; API calls ${(vm.apiCalls / 1e6).toFixed(1)}M`);
    // (the fast-path API calls the dispatcher ran in WASM, per API)
    const u32 = vm.mem.u32, base = FAST_PROF >>> 2, names = Object.entries(FAST_NAMES).reduce((a, [k, v]) => { a[v] ??= k.replace(/^[a-z0-9]+\.dll!/, ''); return a; }, { 16: 'deferred COM' });
    const per = []; for (let i = 0; i < 32; i++) if (u32[base + i]) per.push([names[i] ?? i, u32[base + i]]);
    console.log(`[jitprof] fast API calls: ${per.sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${(n / 1e6).toFixed(2)}M`).join(', ')}`); }
  if (globalThis.ORTHROS_SITE_PROF) siteReport();
  if (apiHist) console.log(`[api] ${[...apiHist].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.API_HIST_N || 25)).map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)}M`).join(', ')}`);
  if (threadInsns) console.log(`[threads] ${[...threadInsns].sort((a, b) => b[1] - a[1]).map(([id, n]) => `t${id} ${(n / 1e6).toFixed(0)}M`).join(', ')}`);
  // (each thread's Sleep pattern: Sleep(0) calls, those that ran a ready thread, throttled ones, streaks ended by a gap
  // of 50 µs or more / by other API calls between, and the short and long sleeps)
  for (const t of vm.proc?.threads ?? []) if (t.sleepStats) { const s = t.sleepStats; console.log(`[sleeps] t${t.id} prio ${t.priority ?? 0}: Sleep(0) ${s.zero} (ran another thread ${s.yields ?? 0}, throttled ${s.throttled}, streaks ended by a gap ${s.brokeGap ?? 0} / by other calls ${s.brokeApi ?? 0}), Sleep(1..2) ${s.short}, longer ${s.long}`); }
  for (const t of vm.proc?.threads ?? []) if (t.peekIdle) { const s = t.peekIdle; console.log(`[peekidle] t${t.id}: ${s.parks} waits (${s.longParks} long), polling ended ${s.ends} times (${s.cut} right after a wait), wait overshoot ${s.over.toFixed(2)} ms, interval min ${s.ivs.length ? Math.min(...s.ivs).toFixed(2) : '-'} of [${s.ivs.map((x) => x.toFixed(1)).join(' ')}] ms, spins near the expected end ${s.near}, ends after it ${s.late} (by ${(s.lateMs / Math.max(1, s.late)).toFixed(2)} ms), streaks broken by guest work ${s.loose}${s.hist ? `, guest instructions between calls (log2 histogram) ${s.hist.map((n, i) => n ? `2^${i}:${n}` : '').filter(Boolean).join(' ')}` : ''}`); }
  for (const l of vm.peekReport()) console.log(l);
  console.log(`${why}: wall ${wall.toFixed(1)} s, CPU ${cpu.toFixed(1)} s, ~${minsns.toFixed(0)} M guest instructions (${(minsns / cpu).toFixed(0)} MIPS per CPU second), ${vm.jit?.stats.regions ?? 0} regions, translation ${(vm.jit?.stats.translateMs ?? 0).toFixed(0)} ms`);
};
// --stall <ms>:<n>[:<from>]: the process stops <ms> ms (Atomics.wait) at one budget slice end in <n> (xorshift, seed
// --stall-seed, else the time), from <from> s of wall time on — the host descheduling the emulator in the middle of a
// thread's work: with the real clock the guest sees its time jump between two instructions (what a loaded machine does)
if (opt('stall')) {
  const [ms, n, from = 0] = opt('stall').split(':').map(Number), sab = new Int32Array(new SharedArrayBuffer(4)), s0 = performance.now();
  let x = (Number(opt('stall-seed', 0)) || Date.now()) >>> 0 || 1, stalls = 0;
  const sliceEnd = vm.sliceEnd.bind(vm);
  vm.sliceEnd = (t, o) => {
    if (performance.now() - s0 >= from * 1000) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; if (x % n === 0) { Atomics.wait(sab, 0, 0, ms); stalls++; } }
    return sliceEnd(t, o);
  };
  process.on('exit', () => console.log(`[stall] ${stalls} stalls of ${ms} ms`));
}
// --api-hist: the API calls dispatched to JavaScript (the WASM fast paths not counted), most frequent first, with the report
const apiHist = args.includes('--api-hist') ? new Map() : null;
// (the tick counters' reads, the translated code's fast paths included: GetTickCount / timeGetTime by any path)
if (apiHist) for (const [k, n] of [['tickCount', 'GetTickCount (all paths)'], ['mmTime', 'timeGetTime (all paths)']]) { const f = vm.timerRes[k].bind(vm.timerRes); vm.timerRes[k] = (t) => { apiHist.set(n, (apiHist.get(n) ?? 0) + 1); return f(t); }; }
// --threads: guest instructions per thread (nested runs charged to the outermost), with the report
const threadInsns = args.includes('--threads') ? new Map() : null;
if (threadInsns) {
  const runThread = vm.runThread.bind(vm);
  vm.runThread = (t, o) => { const g0 = vm.guestInsns; try { return runThread(t, o); } finally { if (t.onStack === 0) threadInsns.set(t.id, (threadInsns.get(t.id) ?? 0) + vm.guestInsns - g0); } };
}
const dispatch = vm.dispatchThunk.bind(vm);
let apiSeq = opt('api-seq') ? (([n, at]) => ({ n: Number(n), at: Number(at ?? 0), list: [], fast: 0 }))(opt('api-seq').split('@')) : null;
let d3dLog = 0; // (--d3d-log: Direct3D frames and draws every 5 s)
// --input <file>: a harness scenario played on the headless host (tools/node-scenario.mjs); the run ends after its last
// event (--phases <file>: the phase results as JSON)
// --bench <name>: a bench scenario of the page's bench mode (tools/scenarios/bench/index.json: its file, its pointer
// coordinates scaled from its `coords` to the game's display as the page scales them); --coords W,H: the same scaling for
// an --input file
const benchDef = opt('bench') ? JSON.parse(fs.readFileSync(new URL('./scenarios/bench/index.json', import.meta.url), 'utf8')).benches.find((b) => b.name === opt('bench')) : null;
if (opt('bench') && !benchDef) throw new Error(`no bench ${opt('bench')} in tools/scenarios/bench/index.json`);
const scenarioFile = benchDef ? new URL('./scenarios/bench/' + benchDef.file, import.meta.url) : opt('input');
const scenarioFrom = benchDef?.coords ?? (opt('coords') ? opt('coords').split(',').map(Number) : null);
const scenario = scenarioFile ? new NodeScenario(fs.readFileSync(scenarioFile, 'utf8'), vm, (l) => console.log(l), args.includes('--virtual') ? () => clock.now() : undefined, { from: scenarioFrom }) : null;
// --slow-apis <ms>: with a scenario, the APIs' time in the frames longer than that, per phase ([slowapis] lines)
if (scenario && opt('slow-apis')) scenario.enableSlowApis(Number(opt('slow-apis')));
// --gc <ms>: with a scenario, this thread's garbage collections per phase and in the frames longer than that ([gc] lines)
if (scenario && opt('gc')) scenario.enableGc(Number(opt('gc')), await import('node:v8'));
// --jit-profile with a scenario: each phase's profile counters (the difference since the previous mark)
if (scenario && args.includes('--jit-profile') && vm.jit) {
  let last = null;
  scenario.jitProf = () => {
    for (const t of vm.proc?.threads ?? []) vm.jit.harvest(t.cpu.b4);
    const cur = { ...(vm.jit.stats.prof ?? {}), chained: vm.jit.stats.chained, fallbackSteps: vm.jit.stats.fallbackSteps, steps: vm.jit.stats.steps ?? 0, misses: vm.jit.stats.misses, apiCalls: vm.apiCalls };
    for (let k = 0; k < 4; k++) cur['nochain' + ['Thunk', 'Stop', 'Budget', 'Miss'][k]] = vm.mem.read32(PROF_OPS_BASE + NOCHAIN_PROF + 4 * k) >>> 0;
    const d = Object.entries(cur).map(([k, v]) => [k, v - (last?.[k] ?? 0)]).filter(([, v]) => v);
    last = cur;
    return d.map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)}M`).join(', ');
  };
}
// --sleeps with a scenario: each phase's Sleep pattern per thread, per frame ([sleeps] lines: the counters of kernel32's
// Sleep — the calls, Sleep(0)s that ran a ready thread, throttled ones, why their streaks ended — and the scheduler's picks)
if (scenario && args.includes('--sleeps')) {
  let last = new Map(), picks0 = 0;
  (scenario.phaseReports ??= []).push((label, frames) => {
    const f = Math.max(1, frames), out = [];
    for (const t of vm.proc?.threads ?? []) {
      const s = t.sleepStats; if (!s) continue;
      const cur = { zero: s.zero, yields: s.yields ?? 0, throttled: s.throttled, gap: s.brokeGap ?? 0, api: s.brokeApi ?? 0, short: s.short, long: s.long, insns: t.insnsRun ?? 0 }, p = last.get(t.id) ?? {};
      last.set(t.id, cur);
      const d = (k) => ((cur[k] - (p[k] ?? 0)) / f).toFixed(1);
      if (cur.zero + cur.short + cur.long - (p.zero ?? 0) - (p.short ?? 0) - (p.long ?? 0) > 0) out.push(`t${t.id}(prio ${t.priority ?? 0}) Sleep(0) ${d('zero')} [ran another ${d('yields')}, throttled ${d('throttled')}, streak ends: gap ${d('gap')} calls ${d('api')}] Sleep(1-2) ${d('short')} longer ${d('long')}`);
    }
    const picks = vm.sched?.picks ?? 0;
    console.log(`[sleeps] ${label} per frame: ${out.join('; ')}; scheduler picks ${((picks - picks0) / f).toFixed(0)}`); picks0 = picks;
  });
}
// --slow-threads <ms> (with --threads and a scenario): the guest instructions of each thread in the frames longer than
// that, against all frames, per phase ([slowthreads] lines, M per frame): which threads make the slow frames' guest time
if (threadInsns && scenario && opt('slow-threads')) {
  const over = Number(opt('slow-threads')), fh = vm.host.frameHook;
  let last = performance.now(), prev = new Map(), slow = new Map(), all = new Map(), nSlow = 0, nAll = 0;
  vm.host.frameHook = () => {
    fh?.();
    const now = performance.now(), dt = now - last; last = now;
    for (const [id, n] of threadInsns) {
      const d = n - (prev.get(id) ?? 0); prev.set(id, n); if (!d) continue;
      all.set(id, (all.get(id) ?? 0) + d); if (dt > over) slow.set(id, (slow.get(id) ?? 0) + d);
    }
    nAll++; if (dt > over) nSlow++;
  };
  (scenario.phaseReports ??= []).push((label) => {
    const ids = [...all.keys()].sort((a, b) => (all.get(b) ?? 0) - (all.get(a) ?? 0));
    console.log(`[slowthreads] ${label}: ${nSlow} frames > ${over} ms of ${nAll}; M guest instructions per frame, slow / all: ${ids.map((id) => `t${id} ${((slow.get(id) ?? 0) / Math.max(1, nSlow) / 1e6).toFixed(2)} / ${(all.get(id) / nAll / 1e6).toFixed(2)}`).join(', ')}`);
    slow = new Map(); all = new Map(); nSlow = 0; nAll = 0;
  });
}
// --cpu-prof <file.cpuprofile> --cpu-prof-window <phase>:<from s>:<to s>: a V8 CPU profile of this thread between those
// seconds of a scenario phase (e.g. play:120:180: one minute of play), for Chrome DevTools or a summary script
let cpuProf = null;
if (scenario && opt('cpu-prof')) {
  const [label, from, to] = (opt('cpu-prof-window') ?? 'play:60:120').split(':');
  const { Session } = await import('node:inspector');
  cpuProf = { label, from: Number(from), to: Number(to), file: opt('cpu-prof'), session: new Session(), on: false, done: false };
  cpuProf.session.connect();
}
const cpuProfTick = () => {
  const p = cpuProf, ph = scenario.phase; if (p.done || !ph || ph.label !== p.label) return;
  const s = scenario.now() - ph.t;
  if (!p.on && s >= p.from) { p.on = true; p.session.post('Profiler.enable'); p.session.post('Profiler.setSamplingInterval', { interval: 200 }); p.session.post('Profiler.start'); console.log(`[cpuprof] started at ${p.label}+${s.toFixed(1)} s`); }
  else if (p.on && s >= p.to) { p.done = true; p.session.post('Profiler.stop', (err, r) => { if (!err) fs.writeFileSync(p.file, JSON.stringify(r.profile)); console.log(`[cpuprof] ${err ? 'failed: ' + err.message : 'written ' + p.file}`); }); }
};
vm.dispatchThunk = (t, i) => {
  if (cpuProf) cpuProfTick();
  if (learnedHeat && vm.proc.moduleList.length !== heatModules) { heatModules = vm.proc.moduleList.length; vm.jit.heatAdd(learnedHeat.apply(vm.proc.moduleList)); }
  const th = vm.api.thunk(i);
  if (args.includes('--d3d-log') && performance.now() - d3dLog > 5000) { d3dLog = performance.now(); const d = vm.d3dDevice; console.log(`[d3d] t=${((d3dLog - t0) / 1000).toFixed(0)}s frames=${d?.frames ?? '-'} draws=${d?.draws ?? '-'} insns=${(vm.guestInsns / 1e6).toFixed(0)}M`); }
  // --api-seq <n>@<s>: the next n API calls dispatched to JavaScript after s seconds, run-length encoded (thread, name,
  // and, with --jit-profile, the clock reads the dispatcher's fast path ran in between), printed once recorded — e.g.
  // a loop polling an API, and what else it calls
  if (apiSeq && th && performance.now() - t0 >= apiSeq.at * 1000) {
    const u32 = vm.mem.u32, b = FAST_PROF >>> 2, fast = u32[b + 19] + u32[b + 20] + u32[b + 28], k = `t${t.id} ${th.name}${fast !== apiSeq.fast ? ` [+${fast - apiSeq.fast} fast timer]` : ''}`; apiSeq.fast = fast;
    const l = apiSeq.list; if (l.length && l[l.length - 1][0] === k) l[l.length - 1][1]++; else l.push([k, 1]);
    if (--apiSeq.n === 0) { console.log(`[apiseq] ${l.map(([x, c]) => c > 1 ? `${x} x${c}` : x).join('\n  ')}`); apiSeq = null; }
  }
  if (apiHist && th) { apiHist.set(th.name, (apiHist.get(th.name) ?? 0) + 1); if (th.name === 'Sleep') { const k = `Sleep(${vm.mem.read32((t.cpu.esp + 4) >>> 0)}) t${t.id} from ${(vm.mem.read32(t.cpu.esp >>> 0) >>> 0).toString(16)}`; apiHist.set(k, (apiHist.get(k) ?? 0) + 1); } }
  if (scenario) {
    scenario.tick();
    if (scenario.finished) { if (opt('phases')) fs.writeFileSync(opt('phases'), JSON.stringify(scenario.results, null, 1)); report('scenario end'); process.exit(0); }
  }
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
vm.host.waitEvent = (ms) => { scenario?.tick(); const p = acct.enter(ACCT.wait); try { return clock.sleep(Math.min(ms, scenario ? 5 : 50)); } finally { acct.leave(p); } }; // (pacing: not guest time)
// --stop-on <text>: stop once a log message of any kind contains that text (as the harness's --stop-on), e.g. the end of
// a game's first-launch computation
const stopOn = opt('stop-on', null);
if (stopOn) { const log = vm.log.bind(vm); vm.log = (kind, msg) => { if (typeof msg === 'string' && msg.includes(stopOn)) { report(`"${stopOn}" logged`); fs.rmSync(saveDir, { recursive: true, force: true }); process.exit(0); } log(kind, msg); }; }
vm.createProcess({ exePath: normalizeWin(manifest.mount + '\\' + manifest.exe), args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides });
if (learnedHeat) { heatModules = vm.proc.moduleList.length; vm.jit.heatAdd(learnedHeat.apply(vm.proc.moduleList)); }
acct.enter(ACCT.guest); // (as the browser worker's slices: the VM's own sections enter their categories)
try { vm.run(); report('exited'); } catch (e) { if (e.report) console.log(e.report); report(`stopped (${String(e.message ?? e).split('\n')[0].slice(0, 120)})`); } // (a guest crash: its report first)
if (!keepDir) fs.rmSync(saveDir, { recursive: true, force: true });
