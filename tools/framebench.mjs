#!/usr/bin/env node
// Emulator-thread work per frame of a real game, in Node (no browser, no GPU): the game runs headless with its Direct3D
// work going to the WebGL backend over a no-op WebGL2 context (`--gfx backend`: the in-thread path), to the render
// worker's recorder with the commands dropped (`--gfx recorder`: what ?glworker=1 leaves on the emulator thread), or
// nowhere (`--gfx none`). Once frames carry enough draws (a 3D scene: the menus of most games, without input), the
// frame accounting (src/core/frame-acct.js) of the next frames is reported — mean ms per frame by category, draws per
// frame, process CPU per frame — and the guest instructions executed. A measure of the Direct3D path's cost on real
// workloads that neither the shared machine's load on a browser's GPU process nor SwiftShader disturb.
//   node tools/framebench.mjs <manifest id | manifest.json> [--games-dir /srv/orthros/data_games] [--profile <dir to copy>]
//     [--gfx backend|recorder|none] [--min-draws 100] [--warm 300] [--frames 600] [--limit 900] [--keys 3,6,9 (Escape,
//     seconds after the first frame)]
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

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!target) { console.error('usage: node tools/framebench.mjs <manifest id | manifest.json> [--gfx backend|recorder|none] ...'); process.exit(2); }
const gfxKind = opt('gfx', 'backend'), minDraws = Number(opt('min-draws', 100)), warm = Number(opt('warm', 300)), frames = Number(opt('frames', 600)), limit = Number(opt('limit', 900));
const keys = (opt('keys', '') || '').split(',').filter(Boolean).map(Number);
let manifest, dir;
if (target.endsWith('.json') || fs.existsSync(target)) ({ manifest, dir } = loadManifest(target));
else { manifest = loadGameCatalog(opt('games-dir', '/srv/orthros/data_games')).get(target); if (!manifest) throw new Error(`no manifest ${target}`); dir = manifest.folder; }
// (a copy of the given user profile: the game's settings without its first-launch computation)
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-framebench-'));
if (opt('profile')) fs.cpSync(opt('profile'), saveDir, { recursive: true });
const vfs = makeVfs(manifest, dir, saveDir);
const clock = new RealClock();
const host = new HeadlessHost({ clock, width: manifest.display?.width ?? 1024, height: manifest.display?.height ?? 768 });
if (gfxKind === 'backend') { const gl = noopGl(); host.gfx = { createDevice: (dev) => new WebGLDevice(gl, dev, {}) }; }
else if (gfxKind === 'recorder') {
  const words = new Int32Array(new SharedArrayBuffer(16 << 20));
  const link = new RenderLink({ words, replayer: { reader: { consumed: 0 }, run() { this.reader.consumed = link.w.produced; } } });
  link.drain = function () { this.w.consumed = this.replayer.reader.consumed = this.w.produced; };
  host.gfx = { createDevice: (dev) => new Recorder(link, dev) };
}
const vm = new Vm({ vfs, clock, host, logKinds: ['crash'] });
vm.registry = new Registry();
vm.registry.seed(manifest.registry);
// (every guest thread waits: the worker would sleep — charged to `sleep`, as there)
vm.host.waitEvent = (ms) => { const p = acct.enter(C.sleep); try { clock.sleep(Math.min(ms, 50)); } finally { acct.leave(p); } };
const t0 = performance.now();
let firstFrameAt = null, streak = 0, phase = 'wait', counted = 0, lastDraws = 0, cpu0 = null, insn0 = 0, wall0 = 0;
const sums = new Float64Array(CATS.length);
let drawsSum = 0;
const finish = (why) => {
  const cpu = process.cpuUsage(cpu0), wall = performance.now() - wall0, gi = vm.guestInsns - insn0;
  const mean = CATS.map((c, i) => [c, sums[i] / counted]).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]);
  console.log(`${why}: ${manifest.id ?? target} gfx=${gfxKind}: ${counted} frames, ${(drawsSum / counted).toFixed(0)} draws/frame, ${(wall / counted).toFixed(2)} ms/frame wall, ${((cpu.user + cpu.system) / 1000 / counted).toFixed(2)} ms/frame process CPU; mean ms/frame: ${mean.map(([c, v]) => `${c} ${v.toFixed(2)}`).join(', ')}; guest ${(gi / counted / 1e6).toFixed(2)} M instructions/frame`);
  fs.rmSync(saveDir, { recursive: true, force: true });
  process.exit(0);
};
host.frameHook = (dev) => {
  const cats = acct.frame(), now = performance.now();
  if (firstFrameAt === null) { firstFrameAt = now; for (const s of keys) for (const [type, dt] of [['keydown', 0], ['keyup', 120]]) host.at(clock.now() + s * 1000 + dt, { type, vk: 27, scan: 1, extended: false, repeat: 0 }); }
  const d = dev.draws - lastDraws; lastDraws = dev.draws;
  if (phase === 'wait') { streak = d >= minDraws ? streak + 1 : 0; if (streak >= 30) { phase = 'warm'; counted = 0; } }
  else if (phase === 'warm') { if (++counted >= warm) { phase = 'measure'; counted = 0; sums.fill(0); drawsSum = 0; cpu0 = process.cpuUsage(); insn0 = vm.guestInsns; wall0 = now; } }
  else { counted++; drawsSum += d; for (let i = 0; i < CATS.length; i++) sums[i] += cats[i]; if (counted >= frames) finish('measured'); }
  if (now - t0 > limit * 1000) { console.log(`time limit in phase ${phase} (${counted} frames, last frame ${d} draws)`); if (phase === 'measure' && counted) finish('time limit'); process.exit(1); }
};
vm.createProcess({ exePath: normalizeWin(manifest.mount + '\\' + manifest.exe), args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides });
acct.enter(C.guest); // (as the browser worker's pump does around its slices)
try { vm.run(); console.log('exited'); } catch (e) { console.log(`stopped (${String(e.message ?? e).split('\n')[0].slice(0, 160)})`); }
fs.rmSync(saveDir, { recursive: true, force: true });
