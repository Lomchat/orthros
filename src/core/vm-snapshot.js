// Snapshots of a whole Vm (docs/snapshot.md, DECISIONS.md D071): what a snapshot of the machine holds — the classes it
// may contain and their transient fields, the objects every Vm builds alike (known, restored in place) — and the capture
// and restore at a quiet point. One file lists them, to be read when a snapshot is refused: a field added to one of
// these classes is in snapshots unless declared transient here.
import { THUNK_BASE, THUNK_END, THUNK_SIZE } from '../cpu/memory.js';
import { DEFER_QUEUE } from '../cpu/jit/runtime.js';
import { SnapRegistry, SnapshotError, SnapshotStale, snapshotClass, snapshotConstant, encodeGraph, decodeGraph, capturePages, restorePages, SNAPSHOT_FORMAT } from './snapshot.js';
import { VirtualClock } from './clock.js';
import { MemBackend, seenFingerprint, hashBytes } from '../vfs/vfs.js';
import { Scheduler, PARK } from './sched.js';
import { TimerResolution } from './timer-res.js';
import { CpuState } from '../cpu/state.js';
import { Process, Thread, TS } from '../win32/process.js';
import { HandleTable } from '../win32/handles.js';
import { VMem } from '../win32/vmem.js';
import { Heap } from '../win32/heap.js';
import { PeImage } from '../loader/pe.js';
import { Com } from '../win32/com.js';
import { Seh } from '../win32/seh.js';
import { Mutex } from '../win32/kernel32.js';
import { Registry } from '../win32/registry.js';
import { WindowManager } from '../win32/user32.js';
import { GdiState } from '../win32/gdi32.js';
import { StateTable } from '../win32/state-table.js';
import { FileHandle } from '../win32/kernel32-file.js';
import { Surface } from '../gfx/gdi/surface.js';
import { TextEngine } from '../gfx/gdi/text.js';

/** The Vm's fields that are not machine state: the executors, the host's links, diagnostics, the registry itself. */
const VM_TRANSIENT = ['vfs', 'clock', 'host', 'mem', 'api', 'interp', 'jit', 'exec', 'ctx', 'snap', 'logFn', 'logKinds', 'traceApi', 'traceApiBg',
  'traceApiRet', 'traceApiSite', 'traceApiSiteMax', 'apiTrace', 'apiTracePos', 'apiTraceNames', 'apiTraceRets', 'apiTraceTids', 'apiHistCounts',
  'profile', 'progressAt', 'progressEvery', 'onProgress', 'heapProv', 'heapProvMap', 'stdout', 'onStdout', 'deadline', 'sliceInsns',
  'runOptsByDepth', 'restoring', 'traceCom', 'traceComQuiet', 'GuestCrash', 'returnThunk', 'callbackReturnThunk', 'exitThreadThunk', 'exitProcessThunk',
  'jitArgs', 'waitLogMin', 'mainWaits', 'recentFiles', 'recentReads', 'readSliceMs', 'apiTail', 'exitReport', 'traceRing', 'traceByArg',
  'ctorOpts', 'group', 'parentVm', 'kernelNamed']; // (group...: child processes, core/procs.js — a machine with several is not snapshotted)

snapshotConstant('sched.PARK', PARK);
snapshotConstant('process.TS', TS);
snapshotClass(Scheduler, { skip: ['vm'], init: (s, vm) => { s.vm = vm; } });
snapshotClass(TimerResolution);
snapshotClass(CpuState, { save: (c) => ({ base: c.base }), load: (d, vm) => new CpuState(vm.mem, d.base) });
// (a parked wait is closures: rebuilt at the restore by re-executing the blocking call — see restoreVm)
// (runMs: host time spent, diagnostics)
snapshotClass(Thread, { skip: ['wait', 'parkWait', 'blockReason', 'runMs'], init: (t) => { t.wait = null; t.parkWait = null; t.blockReason = null; t.runMs = 0; } });

/**
 * Fields read against the host's clock (performance.now()), meaningless in another page: reset at a restore, and
 * not compared by snapshotsDiffer. Each: [path pattern, what restoreVm puts there].
 */
export const HOST_TIME_FIELDS = [];
snapshotClass(Process);
snapshotClass(HandleTable);
snapshotClass(VMem);
snapshotClass(Heap, { skip: ['watchLog'] }); // (debugging hook)
// (the file's bytes are only read while the image is mapped: not kept)
snapshotClass(PeImage, { skip: ['bytes', 'dv'], init: (img) => { img.bytes = null; img.dv = null; } });
snapshotClass(Com, { skip: ['vm', 'failedSeen'], init: (c, vm) => { c.vm = vm; c.failedSeen = new Map(); } });
snapshotClass(Seh, { skip: ['vm'], init: (s, vm) => { s.vm = vm; } });
snapshotClass(Mutex);
snapshotClass(Registry);
snapshotClass(WindowManager, { resume: (wm) => wm.resumeHost() });
snapshotClass(GdiState);
snapshotClass(MemBackend);
snapshotClass(StateTable, { skip: ['rec', 'recId', 'recMark'], init: (t) => { t.rec ??= null; } }); // (the recorder's change marks: the host's)
// (an open file: opened again by its path in the restored machine's file system, at the same position)
snapshotClass(FileHandle, { skip: ['file'], init: (h, vm) => {
  h.file ??= vm.vfs.open(h.path, { write: h.write });
  if (!h.file) throw new SnapshotError(`an open file is gone: ${h.path}`);
} });
snapshotClass(Surface, { name: 'gdi.Surface' });
snapshotClass(TextEngine, { skip: ['pending', 'onReady', 'canvas', 'ctx', 'hasCanvas', 'fontSet'], init: (e) => e.attachHost(), resume: (e, vm) => e.reloadFonts((p) => vm.vfs.readFile(p)) });

/** The registry of a new Vm (built before its modules register: they declare their own state to it). */
export function vmSnapRegistry(vm) {
  const reg = new SnapRegistry();
  reg.known('vm', vm, { skip: VM_TRANSIENT });
  reg.known('mem', vm.mem, { state: false });
  reg.known('mem.buffer', vm.mem.buffer, { state: false }); // (views on the guest memory: rebuilt on the restored Vm's)
  for (const [k, v] of Object.entries(vm.mem)) if (ArrayBuffer.isView(v)) reg.known(`mem.${k}`, v, { state: false }); // (its own views, shared)
  reg.known('vfs', vm.vfs, { state: false });
  // (its mounts, built by the host alike: the in-memory ones — files the game wrote outside its profile — with their
  // contents, the others the host's: the game's files, the profile folder. A persistent one — the profile, kept across
  // sessions — stays the player's current one; what the machine saw of it goes with the snapshot, which a restore
  // compares with the profile first: persistentSeen)
  for (const m of vm.vfs.mounts ?? []) {
    const seen = m.backend instanceof MemBackend ? m.backend.seen : null;
    reg.known(`vfs.mount:${m.lower}`, m.backend, { state: m.backend instanceof MemBackend && !seen });
    if (seen) reg.known(`vfs.seen:${m.lower}`, seen);
  }
  if (vm.host) reg.known('host', vm.host, { state: false });
  reg.known('clock', vm.clock, { save: saveClock, load: loadClock });
  reg.known('api', vm.api, { save: saveApi, load: loadApi });
  return reg;
}

/** The guest's time goes on from where it was: a virtual clock's state; a real clock's origin moved. */
function saveClock(c) { return c instanceof VirtualClock ? { virtual: { t: c.t, wallOrigin: c.wallOrigin, slept: c.slept } } : { now: c.now(), wallSkew: c.wall() - Date.now() }; }
function loadClock(c, d) {
  if (d.virtual) { if (!(c instanceof VirtualClock)) throw new SnapshotError('a virtual-clock snapshot restored on a real clock'); Object.assign(c, d.virtual); return; }
  if (c instanceof VirtualClock) throw new SnapshotError('a real-clock snapshot restored on a virtual clock');
  c.origin = performance.now() - d.now / (c.scale ?? 1);
}

/**
 * The API registry: which thunk slots exist (by DLL and name, at their addresses) and the layout of the module images.
 * The handlers are the restored Vm's own, found by name; the images are in the guest memory.
 */
function saveApi(api) {
  const thunks = [];
  api.thunks.forEach((t, i) => { if (t) thunks.push([i, t.dll, t.name, t.addr, t.def ? 1 : 0]); });
  return { thunks, windows: [...api.windows.values()].map((w) => ({ ...w, chunk: { ...w.chunk } })), windowList: api.windowList.map((w) => w.dll),
    windowTop: api.windowTop, chunkFloor: api.chunkFloor, unknown: [...api.unknown] };
}
function loadApi(api, d) {
  api.windows = new Map(d.windows.map((w) => [w.dll, w]));
  api.windowList = d.windowList.map((n) => api.windows.get(n));
  api.windowTop = d.windowTop; api.chunkFloor = d.chunkFloor;
  api.unknown = new Map(d.unknown);
  api.thunks.fill(null); api.thunkIndex.clear();
  for (const [i, dll, name, addr, hadDef] of d.thunks) {
    const def = api.lookup(dll, name) ?? api.lazyDefs.get(dll)?.(name) ?? null;
    if (hadDef && !def) throw new SnapshotError(`no handler for ${dll}!${name} in the restored Vm`);
    api.thunks[i] = { dll, name, def, addr };
    api.thunkIndex.set(`${dll}!${name}`, i);
    if (api.onThunk) api.onThunk(i, `${dll}!${name}`, def);
  }
}

/**
 * The end of a Vm's construction: everything its modules left reachable from it is built alike by every Vm — known,
 * restored in place (see SnapRegistry.knowGraph).
 */
export function sealVmSnapRegistry(vm) {
  vm.snap.known('vm.ctx', vm.ctx, { state: false }); // (the call context handlers get, rebound at every call: effectCtx points at it)
  const transient = new Set(VM_TRANSIENT);
  vm.snap.knowGraph(vm, (o, k) => o === vm && transient.has(k));
}

/** Why `vm` cannot be snapshotted now (null: it can — between time slices, nothing in progress). */
export function notQuiet(vm) {
  if (!vm.proc) return 'no process';
  if (vm.group) return 'several processes (a child process was started)';
  if (vm.depth) return 'inside a time slice';
  if (vm.sched.nestedWaits) return 'a nested wait in progress';
  if (vm.readsInFlight) return 'file reads in flight';
  if (vm.mem.u32[DEFER_QUEUE >>> 2]) return 'deferred COM calls of the JIT pending';
  for (const t of vm.proc.threads) {
    if (t.onStack) return `thread ${t.id} inside a dispatch loop`;
    if (t.callbackDepth) return `thread ${t.id} inside a callback`;
  }
  return null;
}

/**
 * A snapshot of `vm` (between time slices: see notQuiet). `meta`: what the restoring side checks before using it
 * (the game, its version, the emulator's sources... — docs/snapshot.md).
 */
/**
 * What the host set up before the process started that the machine read and a later session must set up alike for a
 * snapshot to apply: the registry (seeded from the manifest, the player's settings). Kept with the process.
 */
export function startConditions(vm) {
  return { registry: vm.registry ? hashBytes(new TextEncoder().encode(JSON.stringify(vm.registry.toJSON()))) : null };
}

/** Per persistent mount (the profile), what the machine saw of it: its paths as they are now (seenFingerprint). */
function persistentSeen(vm) {
  const out = {};
  for (const m of vm.vfs.mounts ?? []) if (m.backend instanceof MemBackend && m.backend.seen) out[m.lower] = seenFingerprint(m.backend, m.backend.seen);
  return out;
}

/** What differs between two seenFingerprint values of a path: entries of a listing added / removed, else both. */
function seenChange(a, b) {
  if (!a.startsWith('d:') || !b.startsWith('d:')) return `${a.slice(0, 40)} -> ${b.slice(0, 40)}`;
  const x = new Set(a.slice(2).split('|')), y = new Set(b.slice(2).split('|'));
  return [...[...y].filter((e) => !x.has(e)).map((e) => '+' + e), ...[...x].filter((e) => !y.has(e)).map((e) => '-' + e)].slice(0, 6).join(' ');
}

/** Why `snap` does not apply to `vm`, a fresh Vm set up for this session, or null (checked before anything changes). */
export function snapshotStale(vm, snap) {
  if (snap.format !== SNAPSHOT_FORMAT) return `snapshot format ${snap.format}, expected ${SNAPSHOT_FORMAT}`;
  const meta = snap.meta ?? {};
  if (JSON.stringify(startConditions(vm)) !== JSON.stringify(meta.start ?? null)) return 'the registry the game starts with changed';
  return persistentChanged(vm, meta.persistent);
}

/**
 * Why the persistent mounts of `vm` (the profile) are no longer as a snapshot's machine saw them (`persistent`: its
 * meta.persistent), or null. Also asked by the session that took it before keeping it: a file the game wrote after the
 * capture would make the next start refuse it.
 */
export function persistentChanged(vm, persistent) {
  for (const m of vm.vfs.mounts ?? []) {
    if (!(m.backend instanceof MemBackend) || !m.backend.seen) continue;
    const then = persistent?.[m.lower];
    if (!then) return `no record of ${m.prefix}`;
    const now = seenFingerprint(m.backend, new Map(Object.entries(then).map(([k, [bits]]) => [k, bits])));
    for (const k of Object.keys(then)) if (JSON.stringify(now[k]) !== JSON.stringify(then[k])) return `${m.prefix}${k ? '\\' + k.replaceAll('/', '\\') : ''} changed since the snapshot (${seenChange(then[k][1], now[k][1])})`;
  }
  return null;
}

export function captureVm(vm, meta = {}, problems = null) {
  // (COM calls the JIT queued run at the next API call, by whichever thread makes it: now, by the last one that ran)
  if (vm.mem.u32[DEFER_QUEUE >>> 2] && vm.lastThread && !vm.depth) vm.drainDeferred(vm.lastThread);
  const why = notQuiet(vm);
  if (why) throw new SnapshotError(`not a quiet point: ${why}`);
  const t0 = performance.now(), graph = encodeGraph(vm, vm.snap, problems), t1 = performance.now(), pages = capturePages(vm.mem);
  meta = { ...meta, start: vm.proc.start ?? null, persistent: persistentSeen(vm) };
  return { format: SNAPSHOT_FORMAT, meta, pages, graph, timing: { graphMs: t1 - t0, pagesMs: performance.now() - t1 } }; // (timing: not saved)
}

/**
 * Restore `snap` into `vm`: a fresh Vm built like the captured one (same game, files, host and kind of clock), whose
 * process was not created. Its executors start empty (the JIT translates again); threads that were parked in a
 * blocking call re-execute it.
 */
export function restoreVm(vm, snap) {
  if (vm.proc) throw new SnapshotError('restoring into a Vm that already runs a process');
  const stale = snapshotStale(vm, snap);
  if (stale) throw new SnapshotStale(stale); // (nothing changed yet: the Vm can still start the usual way)
  const graph = decodeGraph(snap.graph, vm.snap, vm);
  restorePages(vm.mem, snap.pages); // (after the objects: some write their initial state there — CpuState)
  // A thread parked in a blocking call waits on closures the call made: the call is re-executed as at its first try (at
  // top level, as from a time slice) to make them again; then the snapshot's state is put back over what it changed, and
  // the wait keeps its deadline.
  const waits = new Map();
  for (const t of vm.proc.threads) if (t.state === TS.BLOCKED) waits.set(t, rebuildWait(vm, t));
  graph.reimpose(); restorePages(vm.mem, snap.pages);
  for (const [t, w] of waits) {
    if (w) { w.deadline = t.wakeAt; t.wait = w; t.blockReason = w.reason; continue; }
    vm.sched.markReady(t); t.wakeAt = Infinity; t.blockReason = null; // (the call would not block now: it runs again when scheduled)
  }
  if (vm.jit) vm.jit.setProcessConsts(vm.proc.processHeap.handle);
  const hostWaits = graph.resume();
  vm.restoring = hostWaits.length ? Promise.all(hostWaits) : null; // (the host's side catching up: awaited before the machine runs)
  return vm;
}

/** The wait a parked thread's blocking call makes when executed again (null: it completes without blocking now). */
function rebuildWait(vm, t) {
  const idx = (t.cpu.eip - THUNK_BASE) / THUNK_SIZE;
  if (t.cpu.eip < THUNK_BASE || t.cpu.eip >= THUNK_END || idx !== Math.floor(idx)) throw new SnapshotError(`thread ${t.id} blocked outside an API call (eip ${t.cpu.eip.toString(16)})`);
  const depth = vm.depth, current = vm.current;
  vm.depth = 1; vm.current = t; t.topLevel = true; t.state = TS.RUNNING;
  try { vm.dispatchThunk(t, idx); } catch (e) { throw new SnapshotError(`thread ${t.id}'s blocking call failed again: ${e.message}`); }
  finally { vm.depth = depth; vm.current = current; }
  return t.state === TS.BLOCKED ? t.wait : null;
}
