#!/usr/bin/env node
// Snapshot oracle on a game (docs/snapshot.md), in Node without rendering: the game runs on a virtual clock (with the
// JIT) to a point, its snapshot is taken and restored in a fresh Vm (its profile folder copied at that moment); then both
// machines go on alike on the interpreter (the same slices) and must stay the same — guest memory and every object of
// the state. A refused capture lists every field it cannot keep (the work left, by kind).
//   node tools/snapshot-check.mjs <manifest> --games-dir /srv/orthros/data_games [--at <virtual s>] [--then <slices>]
//     [--input <scenario> [--at-mark <label>]] [--input-after <scenario: times from the capture, played on both>] [--every <slices>] [--keep <dir>] [--log kinds]
//   --lockstep: after every slice a cheap signature of both (thread, guest instructions, API calls, registers): the first
//   slice they part, with each one's last API calls
//   --jit: both go on with an empty JIT (the original's replaced at the capture: Vm.resetJit) — the same translations,
//   the same slices, at the JIT's speed: long comparisons (a game started, played); default: the interpreter
import './node-wasm-flags.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vm } from '../src/core/vm.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Registry } from '../src/win32/registry.js';
import { makeVfs } from '../src/host/cli.js';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { captureVm, restoreVm, HOST_TIME_FIELDS } from '../src/core/vm-snapshot.js';
import { encodeSnapshot, decodeSnapshot, snapshotsDiffer } from '../src/core/snapshot.js';
import { NodeScenario } from './node-scenario.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const gamesDir = opt('games-dir', '/srv/orthros/data_games');
const manifest = loadGameCatalog(gamesDir).get(name);
if (!manifest) { console.error(`usage: snapshot-check.mjs <manifest> --games-dir <dir> [--at s] [--then slices]`); process.exit(2); }
const atMark = opt('at-mark'); // (a mark of --input: the capture once the scenario reached it)
const at = Number(opt('at', atMark ? 1e6 : 20)) * 1000, then = Number(opt('then', 2000)), every = Number(opt('every', 0));
const scratch = opt('keep') ?? fs.mkdtempSync(path.join(fs.existsSync('/tmp/orthros-scratch') ? '/tmp/orthros-scratch' : os.tmpdir(), 'snapshot-check-'));
fs.mkdirSync(scratch, { recursive: true });
const log = (...a) => console.log(`[${((performance.now()) / 1000).toFixed(1)}s]`, ...a);

function machine(saveDir, jit) {
  const clock = new VirtualClock(), host = new HeadlessHost({ clock, width: manifest.display.width, height: manifest.display.height });
  const vm = new Vm({ vfs: makeVfs(manifest, manifest.folder, saveDir), clock, host, jit, logKinds: (opt('log') ?? 'crash').split(',') });
  vm.registry = new Registry(); vm.registry.seed(manifest.registry);
  return vm;
}
const slice = (vm) => vm.runFor(performance.now()).state;
const snap = (vm) => decodeSnapshot(encodeSnapshot(captureVm(vm)));

// ---- A: to the capture point (JIT), the scenario's input on the virtual clock
const dirA = path.join(scratch, 'profile-a'), dirB = path.join(scratch, 'profile-b');
fs.rmSync(dirA, { recursive: true, force: true }); fs.mkdirSync(dirA, { recursive: true });
const a = machine(dirA, true);
a.createProcess({ exePath: `${manifest.mount}\\${manifest.exe.replace(/\//g, '\\')}`, args: manifest.args });
const scenario = opt('input') ? new NodeScenario(fs.readFileSync(opt('input'), 'utf8'), a, (l) => log(l), () => a.clock.now()) : null;
log(`${name}: running to ${atMark ? `the scenario's mark ${atMark}` : `${at / 1000} s of guest time`}`);
const marked = () => scenario?.phase?.label === atMark || scenario?.results.some((r) => r.label === atMark);
while (a.clock.now() < at && !(atMark && marked())) {
  const r = a.runFor(performance.now() + 50); scenario?.tick();
  if (r.state === 'exited') { log(`exited (${r.code}) before the capture point`); process.exit(1); }
}
const problems = [];
let s;
try { s = captureVm(a, { manifest: name }, problems); } catch (e) { log(`capture refused: ${e.message}`); process.exit(1); }
if (problems.length) {
  const kinds = new Map();
  for (const p of problems) { const k = p.replace(/ at .*/, ''); kinds.set(k, [...(kinds.get(k) ?? []), p.replace(/^.* at /, '')]); }
  log(`capture refused: ${problems.length} fields`);
  for (const [k, l] of [...kinds].sort((x, y) => y[1].length - x[1].length)) console.log(`  ${l.length} x ${k}: ${l.slice(0, 3).join(' | ')}`);
  process.exit(1);
}
const bytes = encodeSnapshot(s);
log(`captured at ${(a.clock.now() / 1000).toFixed(2)} s: ${s.graph.objects.length} objects, ${s.pages.index.length} pages, ${(bytes.length / 2 ** 20).toFixed(1)} MiB`);
fs.rmSync(dirB, { recursive: true, force: true }); fs.cpSync(dirA, dirB, { recursive: true });

// ---- B: restored; both go on on the interpreter
const jit = args.includes('--jit'), lockstep = args.includes('--lockstep') || !!opt('watch');
const watch = (opt('watch') ?? '').split(',').filter(Boolean).map((x) => parseInt(x, 16)); // (--watch <hex,...>: guest words compared at every slice too)
const b = machine(dirB, jit);
const t0 = performance.now(), a0 = a.clock.now();
restoreVm(b, decodeSnapshot(bytes));
log(`restored in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
const again = snapshotsDiffer(decodeSnapshot(bytes), snap(b), { ignore: HOST_TIME_FIELDS });
if (again.length) { log('the restored machine is not the snapshot:'); for (const d of again) console.log('  ' + d); process.exit(1); }
if (jit) a.resetJit(); else a.exec = a.interp; // (the same executor on both sides: the same slices)
const scenarioB = opt('input-after') ? new NodeScenario(fs.readFileSync(opt('input-after'), 'utf8'), b, () => {}, () => b.clock.now() - a0) : null;
const scenarioA = opt('input-after') ? new NodeScenario(fs.readFileSync(opt('input-after'), 'utf8'), a, (l) => log(l), () => a.clock.now() - a0) : null;
for (let i = 1; i <= then; i++) {
  const ra = slice(a), rb = slice(b); scenarioA?.tick(); scenarioB?.tick();
  if (lockstep) {
    const sig = (vm) => { const t = vm.lastThread, c = t?.cpu; return `t${t?.id} insns ${vm.guestInsns} api ${vm.apiCalls} eip ${c?.eip.toString(16)} eax ${c?.eax.toString(16)} esp ${c?.esp.toString(16)} clock ${vm.clock.now()}`; };
    const watched = (vm) => watch.map((x) => vm.mem.read32(x & ~3).toString(16)).join(' ');
    const sa = sig(a) + ' | ' + watched(a), sb = sig(b) + ' | ' + watched(b);
    if (sa !== sb) {
      log(`slice ${i}: they part\n  A ${sa}\n  B ${sb}`);
      for (const [n, vm] of [['A', a], ['B', b]]) console.log(`  ${n} last calls:\n    ${vm.recentApiCalls(12).join('\n    ')}`);
      const files = (vm) => [...vm.proc.handles.map].filter(([, o]) => o?.type === 'file' && o.path).map(([h, o]) => `${h}:${o.path}@${o.pos}/${o.file?.size?.() ?? '?'}${o.file?.constructor?.name ? ' ' + o.file.constructor.name : ''}`);
      const fa = files(a), fb = files(b);
      console.log(`  open files differing:\n    A ${fa.filter((x) => !fb.includes(x)).join('\n    A ')}\n    B ${fb.filter((x) => !fa.includes(x)).join('\n    B ')}`);
      process.exit(1);
    }
  }
  if (ra !== rb) { log(`slice ${i}: A ${ra}, B ${rb}`); process.exit(1); }
  if (ra === 'exited') { log(`both exited after ${i} slices`); break; }
  if ((every && i % every === 0) || i === then) {
    const d = snapshotsDiffer(snap(a), snap(b), { ignore: HOST_TIME_FIELDS });
    if (d.length) { log(`differ after ${i} slices (guest ${(a.clock.now() / 1000).toFixed(2)} s):`); for (const x of d) console.log('  ' + x); process.exit(1); }
    log(`same after ${i} slices (guest ${(a.clock.now() / 1000).toFixed(2)} s, ${a.apiCalls} API calls)`);
  }
}
if (!opt('keep')) fs.rmSync(scratch, { recursive: true, force: true });
