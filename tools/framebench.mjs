#!/usr/bin/env node
// Emulator-thread work per frame of a real game, in Node (no browser, no GPU): the game runs headless with its Direct3D
// work going to the WebGL backend over a no-op WebGL2 context (`--gfx backend`: the in-thread path), to the render
// worker's recorder with the commands dropped (`--gfx recorder`: what ?glworker=1 leaves on the emulator thread), or
// nowhere (`--gfx none`). Once frames carry enough draws (a 3D scene: the menus of most games, without input), the
// frame accounting (src/core/frame-acct.js) of the next frames is reported — mean ms per frame by category, draws per
// frame, process CPU per frame — and the guest instructions executed. A measure of the Direct3D path's cost on real
// workloads that neither the shared machine's load on a browser's GPU process nor SwiftShader disturb.
//   node tools/framebench.mjs <manifest id | manifest.json> [--games-dir /srv/orthros/data_games] [--profile <dir to copy>]
//     [--gfx backend|recorder|none] [--min-draws 100] [--warm 300] [--frames 600] [--limit 900]
//     [--input "3:key:27;10:click:320,192;@12:click:10,10" (seconds after the first frame, or with @ after the start: a
//     key's virtual-key code, a left click)]
//     [--prof <file.cpuprofile>: a V8 CPU profile of the measured frames only]
//     [--programs <learn dir>/programs2-<manifest>.json [--programs-raw: with their learned sources, not regenerated]]
//     [--apis <n>: the n APIs with the most time per frame (the accounting's sampled estimate), each with the time the
//     deferred-queue drain run before it took (vm.drainDeferred, timed on every call) — the drain is part of the
//     sampled time of whichever JavaScript API follows queued calls]
// With --gfx recorder the link's counters per frame follow (bytes of buffer data copied into the ring, fence waits...).
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
import { acct, CATS, C } from '../src/core/frame-acct.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { noopGl } from './noop-gl.mjs';
import { DEFER_QUEUE } from '../src/cpu/jit/runtime.js';
import { PROGRAM_GLSL_VERSION, ffKeyRegenerable } from '../src/gfx/program-id.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!target) { console.error('usage: node tools/framebench.mjs <manifest id | manifest.json> [--gfx backend|recorder|none] ...'); process.exit(2); }
const gfxKind = opt('gfx', 'backend'), minDraws = Number(opt('min-draws', 100)), warm = Number(opt('warm', 300)), frames = Number(opt('frames', 600)), limit = Number(opt('limit', 900));
const VK_SCAN = { 13: 0x1c, 27: 1, 32: 0x39 };
const inputs = (opt('input', '') || '').split(';').filter(Boolean).map((e) => { const [t, kind, a = ''] = e.split(':'); return { t: Number(t.replace('@', '')), abs: t.startsWith('@'), kind, a: a.split(',').map(Number) }; });
/** scripted input, as the harness gives it (a key held ~120 ms, a click held ~100 ms), `at` ms on the guest clock */
const schedule = ({ kind, a }, at) => {
  if (kind === 'key') { host.at(at, { type: 'keydown', vk: a[0], scan: VK_SCAN[a[0]], extended: false, repeat: 0 }); host.at(at + 120, { type: 'keyup', vk: a[0], scan: VK_SCAN[a[0]], extended: false }); }
  else if (kind === 'click') { host.at(at, { type: 'mousemove', x: a[0], y: a[1] }); host.at(at + 1, { type: 'mousedown', button: 0, x: a[0], y: a[1] }); host.at(at + 100, { type: 'mouseup', button: 0, x: a[0], y: a[1] }); }
};
let manifest, dir;
if (target.endsWith('.json') || fs.existsSync(target)) ({ manifest, dir } = loadManifest(target));
else { manifest = loadGameCatalog(opt('games-dir', '/srv/orthros/data_games')).get(target); if (!manifest) throw new Error(`no manifest ${target}`); dir = manifest.folder; }
// (a copy of the given user profile: the game's settings without its first-launch computation)
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-framebench-'));
if (opt('profile')) fs.cpSync(opt('profile'), saveDir, { recursive: true });
const vfs = makeVfs(manifest, dir, saveDir);
const clock = new RealClock();
/** the recorder's link (--gfx recorder): its counters are reported per frame */
let link = null, stats0 = null;
const host = new HeadlessHost({ clock, width: manifest.display?.width ?? 1024, height: manifest.display?.height ?? 768 });
// --programs <programs2-<manifest>.json>: the server's learned programs (as its list for this translator version)
// compiled ahead, as a session does; reported: programs built at a draw, learned ones taken (--gfx backend)
let pcache = null, gfxDev = null;
if (opt('programs')) {
  const j = JSON.parse(fs.readFileSync(opt('programs'), 'utf8')), sessions = Number(j.sessions) || 0;
  const list = j.programs.filter((r) => r[8] === PROGRAM_GLSL_VERSION || ffKeyRegenerable(r[1]) || ((r[8] ?? null) === null && r[7] >= sessions + 1 - 4)).sort((a, b) => a[5] - b[5]);
  pcache = { queue: list.map(([id, key, vs, fs2, attrs, , , , v]) => ({ id, key: args.includes('--programs-raw') ? '' : key, vs, fs: fs2, attrs, v })), ready: new Map(), learned: [], used: [], t0: performance.now(), parallel: true, started: 0, pending: 0, hits: 0, devices: new Set() };
  console.log(`programs: ${list.length} of ${j.programs.length} learned listed${args.includes('--programs-raw') ? ' (keys dropped: their sources as learned)' : ''}`);
}
if (gfxKind === 'backend') { const gl = noopGl(); host.gfx = { createDevice: (dev) => (gfxDev = new WebGLDevice(gl, dev, { programCache: pcache })) }; }
else if (gfxKind === 'recorder') {
  const words = new Int32Array(new SharedArrayBuffer(16 << 20));
  link = new RenderLink({ words, replayer: { reader: { consumed: 0 }, run() { this.reader.consumed = link.w.produced; } } });
  link.drain = function () { this.w.consumed = this.replayer.reader.consumed = this.w.produced; };
  host.gfx = { createDevice: (dev) => new Recorder(link, dev) };
}
const vm = new Vm({ vfs, clock, host, logKinds: process.env.FB_LOG ? process.env.FB_LOG.split(',') : ['crash'] });
vm.registry = new Registry();
vm.registry.seed(manifest.registry);
// (every guest thread waits: the worker would sleep — charged to `sleep`, as there)
vm.host.waitEvent = (ms) => { const p = acct.enter(C.sleep); try { clock.sleep(Math.min(ms, 50)); } finally { acct.leave(p); } };
const t0 = performance.now();
let firstFrameAt = null, streak = 0, phase = 'wait', counted = 0, lastDraws = 0, cpu0 = null, insn0 = 0, wall0 = 0;
const sums = new Float64Array(CATS.length);
let drawsSum = 0;
// --prof: the sampling profiler over the measured frames (node:inspector, this thread)
const profFile = opt('prof', null);
let session = null;
if (profFile) { const inspector = await import('node:inspector'); session = new inspector.Session(); session.connect(); session.post('Profiler.enable'); session.post('Profiler.setSamplingInterval', { interval: 200 }); }
// --apis: the drain of the deferred queue timed per API that triggers it (thunk index -> ms, calls)
const apiTop = Number(opt('apis', 0));
const drainMs = new Map(), drainN = new Map();
let acct0 = null;
if (apiTop) {
  const body = vm.dispatchThunkBody;
  vm.dispatchThunkBody = function (thread, idx) {
    if (phase === 'measure' && this.mem.u32[DEFER_QUEUE >>> 2]) { const t = performance.now(); this.drainDeferred(thread); drainMs.set(idx, (drainMs.get(idx) ?? 0) + performance.now() - t); drainN.set(idx, (drainN.get(idx) ?? 0) + 1); }
    return body.call(this, thread, idx);
  };
}
const apiTable = () => {
  const rows = [];
  for (let i = 0; i < acct.idxCalls.length; i++) {
    const calls = acct.idxCalls[i] - (acct0.calls[i] ?? 0), n = acct.idxN[i] - (acct0.n[i] ?? 0), ms = acct.idxMs[i] - (acct0.ms[i] ?? 0);
    if (!calls || !n) continue;
    const est = ms / n * calls / counted, dr = (drainMs.get(i) ?? 0) / counted, t = vm.api.thunk(i);
    rows.push([est, `${t?.name ?? i}: ${est.toFixed(3)} ms/frame (${(calls / counted).toFixed(1)} calls, ${(ms / n * 1000).toFixed(2)} us each sampled; drain before it ${dr.toFixed(3)} ms/frame in ${((drainN.get(i) ?? 0) / counted).toFixed(1)} drains, own ${((est - dr) / (calls / counted) * 1000).toFixed(2)} us each)`]);
  }
  rows.sort((a, b) => b[0] - a[0]);
  let tot = 0; for (const v of drainMs.values()) tot += v;
  console.log(`apis: drain total ${(tot / counted).toFixed(3)} ms/frame\n  ` + rows.slice(0, apiTop).map((r) => r[1]).join('\n  '));
};
const finish = (why) => {
  if (apiTop) apiTable();
  if (pcache && gfxDev) console.log(`programs: built at a draw ${gfxDev.stats.programs} (${(gfxDev.stats.programMs ?? 0).toFixed(0)} ms), learned compiled ahead ${pcache.started}, taken ${pcache.hits}, regenerated from their key ${pcache.regenerated ?? 0}, other versions skipped ${pcache.stale ?? 0}`);
  if (session) session.post('Profiler.stop', (err, r) => { if (!err) fs.writeFileSync(profFile, JSON.stringify(r.profile)); });
  const cpu = process.cpuUsage(cpu0), wall = performance.now() - wall0, gi = vm.guestInsns - insn0;
  const mean = CATS.map((c, i) => [c, sums[i] / counted]).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]);
  console.log(`${why}: ${manifest.id ?? target} gfx=${gfxKind}: ${counted} frames, ${(drawsSum / counted).toFixed(0)} draws/frame, ${(wall / counted).toFixed(2)} ms/frame wall, ${((cpu.user + cpu.system) / 1000 / counted).toFixed(2)} ms/frame process CPU; mean ms/frame: ${mean.map(([c, v]) => `${c} ${v.toFixed(2)}`).join(', ')}; guest ${(gi / counted / 1e6).toFixed(2)} M instructions/frame`);
  if (link) console.log(`recorder per frame: ${Object.keys(link.stats).map((k) => [k, (link.stats[k] - stats0[k]) / counted]).filter(([, v]) => v).map(([k, v]) => `${k} ${+v.toFixed(2)}`).join(', ')}`);
  fs.rmSync(saveDir, { recursive: true, force: true });
  process.exit(0);
};
host.frameHook = (dev) => {
  const cats = acct.frame(), now = performance.now();
  if (firstFrameAt === null) {
    firstFrameAt = now;
    for (const e of inputs) if (!e.abs) schedule(e, clock.now() + e.t * 1000); // (times after the first frame)
  }
  const d = dev.draws - lastDraws; lastDraws = dev.draws;
  if (args.includes('--verbose') && dev.frames % 100 === 0) console.log(`[framebench] ${((now - t0) / 1000).toFixed(0)} s: frame ${dev.frames}, ${d} draws in the last, phase ${phase}`);
  if (phase === 'wait') { streak = d >= minDraws ? streak + 1 : 0; if (streak >= 30) { phase = 'warm'; counted = 0; } }
  else if (phase === 'warm') { if (++counted >= warm) { phase = 'measure'; counted = 0; sums.fill(0); drawsSum = 0; cpu0 = process.cpuUsage(); stats0 = link && { ...link.stats }; insn0 = vm.guestInsns; wall0 = now; acct0 = { calls: [...acct.idxCalls], n: [...acct.idxN], ms: [...acct.idxMs] }; session?.post('Profiler.start'); } }
  else { counted++; drawsSum += d; for (let i = 0; i < CATS.length; i++) sums[i] += cats[i]; if (counted >= frames) finish('measured'); }
  if (now - t0 > limit * 1000) { console.log(`time limit in phase ${phase} (${counted} frames, last frame ${d} draws)`); if (phase === 'measure' && counted) finish('time limit'); process.exit(1); }
};
for (const e of inputs) if (e.abs) schedule(e, clock.now() + e.t * 1000); // ('@' times: from the start)
vm.createProcess({ exePath: normalizeWin(manifest.mount + '\\' + manifest.exe), args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides });
acct.enter(C.guest); // (as the browser worker's pump does around its slices)
try { vm.run(); console.log('exited'); } catch (e) { console.log(`stopped (${String(e.message ?? e).split('\n')[0].slice(0, 160)})`); }
fs.rmSync(saveDir, { recursive: true, force: true });
