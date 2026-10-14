// Snapshots of the machine (src/core/snapshot.js, vm-snapshot.js, docs/snapshot.md). The oracle: a test program is
// run to a point, its snapshot restored in a fresh Vm, and both machines go on alike (interpreter, virtual clock: the
// same slices) — they must stay the same, guest memory and every object of the state, and print the same. A field a
// later change adds and the restore misses makes them differ here; one the walk cannot keep makes the capture refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock, RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { captureVm, restoreVm, notQuiet, HOST_TIME_FIELDS } from '../src/core/vm-snapshot.js';
import { encodeSnapshot, decodeSnapshot, snapshotsDiffer, SnapshotError, SnapshotStale } from '../src/core/snapshot.js';
import { Registry } from '../src/win32/registry.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

function boot(exe, { create = true, profile = null, registry = null } = {}) {
  const vfs = new Vfs(), test = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', test);
  if (profile) vfs.mount('C:\\Users\\Player', profile); // (a persistent mount: the host's, what the machine saw of it recorded)
  test.open(exe, { create: true }).write(0, fs.readFileSync(PE_DIR + exe));
  const clock = new VirtualClock(), host = new HeadlessHost({ clock, width: 800, height: 600 });
  const vm = new Vm({ vfs, clock, host, jit: false, logKinds: [] });
  if (registry) { vm.registry = new Registry(); vm.registry.seed(registry); }
  if (create) vm.createProcess({ exePath: 'C:\\Test\\' + exe });
  return vm;
}
const slice = (vm) => vm.runFor(performance.now()).state; // (one time slice: the deadline is already past)
const snap = (vm) => decodeSnapshot(encodeSnapshot(captureVm(vm)));

/** Run `exe` `at` slices, restore its snapshot, run both `then` slices: what differs (empty: nothing). */
function oracle(exe, at, then = 200) {
  const a = boot(exe);
  for (let i = 0; i < at; i++) assert.notEqual(slice(a), 'exited', `${exe} exited before slice ${at}`);
  const s = snap(a), printed = a.stdout.join('').length;
  const b = restoreVm(boot(exe, { create: false }), s);
  const again = snapshotsDiffer(s, snap(b), { ignore: HOST_TIME_FIELDS });
  if (again.length) return ['restored machine is not the snapshot:', ...again];
  for (let i = 0; i < then; i++) {
    const ra = slice(a), rb = slice(b);
    if (ra !== rb) return [`slice ${i}: ${ra} vs ${rb}`];
    if (ra === 'exited') break;
  }
  const diff = a.proc.threads.every((t) => t.state === 4) ? [] : snapshotsDiffer(snap(a), snap(b), { ignore: HOST_TIME_FIELDS });
  if (a.stdout.join('').slice(printed) !== b.stdout.join('')) diff.push('printed differently');
  return diff;
}

for (const [exe, points] of [['sync.exe', [3, 15, 60]], ['priority.exe', [3, 15, 60]], ['bench.exe', [3, 60]], ['mci.exe', [3, 30]], ['dx9state.exe', [3, 15]], ['threads.exe', [3, 15]], ['dx.exe', [3]]]) {
  test(`${exe}: restored from a snapshot, goes on exactly like the machine it was taken from`, { skip: skip(exe) }, () => {
    for (const at of points) assert.deepEqual(oracle(exe, at), [], `${exe} restored at slice ${at}`);
  });
}

test('threads parked in a blocking call keep their wait and its deadline across a restore', { skip: skip('priority.exe') }, () => {
  const a = boot('priority.exe');
  for (let i = 0; i < 15; i++) slice(a);
  const parked = a.proc.threads.filter((t) => t.state === 2);
  assert.ok(parked.length, 'a thread is parked at that point');
  const b = restoreVm(boot('priority.exe', { create: false }), snap(a));
  for (const t of parked) {
    const r = b.proc.threads.find((x) => x.id === t.id);
    assert.equal(r.state, 2); assert.equal(r.wakeAt, t.wakeAt); assert.equal(typeof r.wait.cond, 'function');
  }
});

test('a snapshot refuses what it cannot rebuild, and says where', { skip: skip('sync.exe') }, () => {
  const a = boot('sync.exe');
  for (let i = 0; i < 3; i++) slice(a);
  a.proc.threads[0].hook = () => 1; // (a closure left in the state by some later change)
  assert.throws(() => captureVm(a), (e) => e instanceof SnapshotError && /a function \(\w+\) at vm\.\S*\.hook$/.test(e.message));
  class Gadget {}
  a.proc.threads[0].hook = new Gadget();
  assert.throws(() => captureVm(a), /an object of class Gadget \(not registered\) at vm\.\S*\.hook$/);
  const problems = [];
  captureVm(a, {}, problems);
  assert.equal(problems.length, 1, 'every refusal listed');
});

test('only at a quiet point; a snapshot is restored on the same kind of clock', { skip: skip('sync.exe') }, () => {
  const a = boot('sync.exe');
  for (let i = 0; i < 3; i++) slice(a);
  assert.equal(notQuiet(a), null);
  a.depth = 1;
  assert.throws(() => captureVm(a), /not a quiet point: inside a time slice/);
  a.depth = 0;
  const s = snap(a);
  const vfs = new Vfs(); vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', new MemBackend());
  const real = new Vm({ vfs, clock: new RealClock(), jit: false, logKinds: [] });
  assert.throws(() => restoreVm(real, s), /virtual-clock snapshot restored on a real clock/);
});

test('the profile stays the player\'s: a snapshot applies while what its machine saw of it is unchanged', { skip: skip('sync.exe') }, () => {
  const profile = (files) => { const p = new MemBackend(); p.seen = new Map(); p.mkdir('Saves'); for (const [f, t] of Object.entries(files)) p.open(f, { create: true }).write(0, new TextEncoder().encode(t)); return p; };
  const files = { 'options.ini': 'res=800', 'Saves/one.sav': 'A' }, reg = { 'HKEY_CURRENT_USER\\Software\\Game': { Lang: 'en' } };
  const a = boot('sync.exe', { profile: profile(files), registry: reg });
  for (let i = 0; i < 3; i++) slice(a);
  // (what the game did with its profile up to the snapshot: read its settings, listed its saves, wrote a log)
  const read = (p) => { const f = a.vfs.open(p); f.read(0, 64); };
  read('C:\\Users\\Player\\options.ini'); a.vfs.readdir('C:\\Users\\Player\\Saves'); a.vfs.open('C:\\Users\\Player\\boot.log', { create: true }).write(0, Uint8Array.of(1));
  const s = snap(a), restore = (p, r = reg) => { const b = boot('sync.exe', { create: false, profile: p, registry: r }); return [b, () => restoreVm(b, s)]; };
  // the same profile — as the browser keeps it, with the log the session wrote — and a file never seen: restored, the
  // profile the host's (not the snapshot's copy), what was seen kept for a later snapshot
  const same = profile({ ...files, 'boot.log': '\x01', 'Saves2.txt': 'new' });
  const [b, ok] = restore(same); ok();
  assert.equal(b.vfs.mounts.find((m) => m.lower === 'c:\\users\\player').backend, same);
  assert.ok(same.files.has('saves2.txt'));
  assert.deepEqual([...same.seen.keys()].sort(), [...a.vfs.mounts.find((m) => m.lower === 'c:\\users\\player').backend.seen.keys()].sort());
  for (let i = 0; i < 20; i++) assert.equal(slice(a), slice(b));
  // a setting changed, a save added to a folder the game listed, the registry it starts with changed: refused before
  // anything changed (the Vm starts the usual way)
  for (const [p, r, why] of [[profile({ ...files, 'options.ini': 'res=1024', 'boot.log': '\x01' }), reg, /options\.ini changed/],
    [profile({ ...files, 'Saves/two.sav': 'B', 'boot.log': '\x01' }), reg, /saves changed/],
    [profile({ ...files, 'boot.log': '\x01' }), { 'HKEY_CURRENT_USER\\Software\\Game': { Lang: 'fr' } }, /registry/]]) {
    const [c, go] = restore(p, r);
    assert.throws(go, (e) => e instanceof SnapshotStale && why.test(e.message));
    assert.equal(c.proc, null);
  }
});
