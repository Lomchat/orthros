#!/usr/bin/env node
// Orthros CLI runner (Node, headless): boots a game folder + manifest, runs it, reports.
//
//   node src/host/cli.js <manifest.json|game-folder> [options]
//     --interp            use the reference interpreter instead of the JIT
//     --log a,b,c         log kinds (loader,warn,crash,api,win,file,thread,jit,debug,all)
//     --seconds N         stop after N seconds of host time (default: unlimited)
//     --status FILE       write the unknown-import list into FILE (between markers)
//     --trace-api         alias for --log api
import fs from 'node:fs';
import path from 'node:path';
import { Vm, GuestCrash } from '../core/vm.js';
import { Vfs, MemBackend, normalizeWin } from '../vfs/vfs.js';
import { NodeBackend } from '../vfs/node-backend.js';
import { RealClock } from '../core/clock.js';
import { HeadlessHost } from './display.js';
import { Registry } from '../win32/registry.js';

function parseArgs(argv) {
  const o = { positional: [], log: null, interp: false, seconds: 0, status: null, profile: false, progress: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interp') o.interp = true;
    else if (a === '--log') o.log = argv[++i].split(',');
    else if (a === '--trace-api') o.log = [...(o.log ?? ['loader', 'warn', 'crash']), 'api'];
    else if (a === '--seconds') o.seconds = +argv[++i];
    else if (a === '--status') o.status = argv[++i];
    else if (a === '--profile') o.profile = true;
    else if (a === '--progress') o.progress = +argv[++i];
    else o.positional.push(a);
  }
  return o;
}

/** Load a manifest (json file) or synthesize one for a bare folder (first .exe found). */
export function loadManifest(target) {
  let manifest, dir;
  if (target.endsWith('.json')) {
    manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
    dir = path.resolve(path.dirname(target), manifest.folder ?? '.');
  } else {
    dir = path.resolve(target);
    const m = path.join(dir, 'manifest.json');
    if (fs.existsSync(m)) manifest = JSON.parse(fs.readFileSync(m, 'utf8'));
    else {
      const exe = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.exe'));
      if (!exe) throw new Error(`no manifest.json and no .exe in ${dir}`);
      manifest = { exe };
    }
  }
  manifest.mount ??= 'C:\\Game';
  manifest.args ??= '';
  manifest.dllOverrides ??= {};
  manifest.env ??= {};
  manifest.display ??= { width: 1024, height: 768 };
  return { manifest, dir };
}

/** Build the VFS: game folder read-only under the mount point, writable user dirs in memory. */
export function makeVfs(manifest, dir, saveDir) {
  const vfs = new Vfs();
  const root = new MemBackend();
  vfs.mount('C:\\', root);
  for (const d of ['Windows', 'Windows\\System32', 'Windows\\Temp', 'Users', 'Users\\Player', 'Users\\Player\\Temp', 'Users\\Player\\AppData', 'Users\\Player\\AppData\\Roaming', 'Users\\Player\\AppData\\Local', 'Users\\Player\\Documents', 'Program Files', 'Program Files\\Common Files', 'Game']) root.mkdir(d);
  vfs.mount(manifest.mount, new NodeBackend(dir, { readOnly: !manifest.writableGameFolder }));
  if (saveDir) {
    // the user profile lives on disk (saves, settings): standard profile subdirectories must exist there
    for (const d of ['', 'Temp', 'AppData/Roaming', 'AppData/Local', 'AppData/LocalLow', 'Documents', 'Desktop', 'Saved Games']) fs.mkdirSync(path.join(saveDir, d), { recursive: true });
    vfs.mount('C:\\Users\\Player', new NodeBackend(saveDir));
  }
  return vfs;
}

export function writeStatus(file, proc, vm) {
  if (!file || !fs.existsSync(file)) return;
  const lines = [];
  const items = [...proc.unknownImports].sort((a, b) => b[1].calls - a[1].calls);
  if (!items.length) lines.push('- (aucun)');
  for (const [k, v] of items) lines.push(`- \`${k}\` (référencé par ${v.from}, ${v.calls} appel${v.calls > 1 ? 's' : ''})`);
  const text = fs.readFileSync(file, 'utf8');
  const marker = '## Imports Win32 inconnus (rempli automatiquement à partir de M4)';
  const i = text.indexOf(marker);
  if (i < 0) return;
  const head = text.slice(0, i + marker.length);
  fs.writeFileSync(file, head + '\n' + lines.join('\n') + '\n');
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (!o.positional.length) { console.error('usage: node src/host/cli.js <manifest.json|folder> [--interp] [--log kinds] [--seconds N] [--status STATUS.md]'); process.exit(2); }
  const { manifest, dir } = loadManifest(o.positional[0]);
  const saveDir = manifest.saveDir ? path.resolve(path.dirname(o.positional[0]), manifest.saveDir) : null;
  const vfs = makeVfs(manifest, dir, saveDir);
  const clock = new RealClock();
  const host = new HeadlessHost({ clock, width: manifest.display.width, height: manifest.display.height });
  const vm = new Vm({ vfs, clock, host, jit: !o.interp, logKinds: o.log ?? ['loader', 'warn', 'crash', 'win', 'thread'], apiHist: true, profile: o.profile });
  vm.onStdout = (s) => process.stdout.write(s);
  // registry: generic defaults + manifest seed + values persisted from earlier runs (in the save dir)
  vm.registry = new Registry();
  vm.registry.seed(manifest.registry);
  const regFile = saveDir ? path.join(saveDir, 'registry.json') : null;
  if (regFile && fs.existsSync(regFile)) { try { vm.registry.load(JSON.parse(fs.readFileSync(regFile, 'utf8'))); } catch (e) { console.error(`[orthros] bad ${regFile}: ${e.message}`); } }
  const saveRegistry = () => { if (regFile && vm.registry.dirty) { fs.writeFileSync(regFile, JSON.stringify(vm.registry.toJSON(), null, 1)); vm.registry.dirty = false; } };
  const exePath = normalizeWin(manifest.mount + '\\' + manifest.exe);
  const t0 = performance.now();
  let code = null;
  try {
    vm.createProcess({ exePath, args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides, cwd: manifest.cwd ? normalizeWin(manifest.mount + '\\' + manifest.cwd) : undefined });
    if (o.seconds) {
      const deadline = t0 + o.seconds * 1000;
      vm.deadline = deadline;
      vm.host.waitEvent = (ms) => { clock.sleep(Math.min(ms, 50)); if (performance.now() > deadline) throw new Error('time limit'); };
      const dt = vm.dispatchThunk.bind(vm);
      vm.dispatchThunk = (t, i) => { if (performance.now() > deadline) throw new Error('time limit'); return dt(t, i); };
    }
    if (o.progress) {
      vm.progressEvery = o.progress * 1000; vm.progressAt = performance.now() + vm.progressEvery;
      vm.onProgress = (t) => {
        const top = vm.profile ? [...vm.profile].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${vm.proc.symbolize(k << 6)} ${(100 * v / vm.slices).toFixed(0)}%`).join(', ') : '';
        console.log(`[progress] t=${((performance.now() - t0) / 1000).toFixed(0)}s heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB api=${vm.apiCalls} slices=${vm.slices} regions=${vm.jit?.stats.regions}/live ${vm.jit?.stats.live} inval=${vm.jit?.stats.invalidations}/${vm.jit?.stats.dropped} thread=${t.id} eip=${vm.proc.symbolize(t.cpu.eip)} threads=${vm.proc.threads.length} ${top}`);
        if (vm.profile) vm.profile.clear(); vm.slices = 0;
      };
    }
    code = vm.run();
    console.log(`\n[orthros] process exited with code ${code} after ${((performance.now() - t0) / 1000).toFixed(1)}s, ${vm.apiCalls} API calls`);
  } catch (e) {
    if (e instanceof GuestCrash) console.log(`\n[orthros] ${e.report}`);
    else if (e.message === 'time limit') { const t = vm.lastThread; console.log(`\n[orthros] time limit reached after ${o.seconds}s, ${vm.apiCalls} API calls`); if (t) console.log(vm.crashReport(t, 'time limit (state of the last running thread)')); }
    else { console.log(`\n[orthros] host error: ${e.stack}`); }
  }
  saveRegistry();
  if (vm.jit) console.log(`[orthros] jit: ${JSON.stringify(vm.jit.stats)}${vm.deferredCalls ? ` deferred COM call batches: ${vm.deferredCalls}` : ''}`);
  if (vm.apiHistCounts) console.log('[orthros] top API calls: ' + [...vm.apiHist()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}=${v}`).join(' '));
  if (vm.profile) { const total = vm.slices || 1; console.log(`[orthros] profile: ${vm.slices} slices of 100k instructions (~${(vm.slices / 10).toFixed(0)}M instructions)`); for (const [k, v] of [...vm.profile].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${(100 * v / total).toFixed(1).padStart(5)}%  ${vm.proc.symbolize(k << 6)}`); }
  console.log(`[orthros] modules: ${vm.proc?.moduleList.map((m) => m.name).join(', ')}`);
  const unknown = [...(vm.proc?.unknownImports ?? [])];
  if (vm.firstD3DCall) console.log(`[orthros] first Direct3D call: ${vm.firstD3DCall.name} from ${vm.firstD3DCall.from} after ${vm.firstD3DCall.apiCalls} API calls`);
  console.log(`[orthros] unknown imports: ${unknown.length}` + (unknown.length ? '\n  ' + unknown.sort((a, b) => b[1].calls - a[1].calls).map(([k, v]) => `${k} (${v.calls}, from ${v.from})`).join('\n  ') : ''));
  if (o.status && vm.proc) writeStatus(o.status, vm.proc, vm);
  process.exitCode = code === null ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
