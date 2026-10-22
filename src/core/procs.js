// Child processes (docs/processes.md): a program started with CreateProcess runs in a Vm of its own — its own guest
// memory (a WebAssembly.Memory), JIT, scheduler and DLL state — on the same worker as its parent, interleaved with it
// by the root Vm's runFor. What Windows shares between processes is shared here: the kernel-object namespace (named
// mutexes, events, semaphores, file mappings), the objects inherited or opened by name, process and thread ids, the
// registry, the files, the clock and the host (display, input, audio), which belongs to one process at a time (the
// foreground one: the last to create a Direct3D device). A machine that never starts a child has no group: its path is
// unchanged.
import { TS } from '../win32/process.js';
import { HANDLE_BLOCK } from '../win32/handles.js';
import { acquireMapping, dropViews } from '../win32/mappings.js';

/** time a member's runFor gets per turn when several are busy (ms) */
const TURN_MS = 4;
/** fields the host sets on the root Vm after its construction that a child gets too */
const CHILD_INHERITS = ['registry', 'asyncReads', 'onStdout', 'readSliceMs', 'waitLogMin', 'deadline'];

/**
 * processes running at once at most (a launcher restarting its game, a game relaunching itself: each a machine with a
 * guest memory of its own — 2 GB of address space reserved; an exited one is released, see reap)
 */
export const MAX_LIVE_PROCESSES = 8;

const RUNNING = Object.freeze({ state: 'running' }), IDLE = Object.freeze({ state: 'idle' });

export class ProcessGroup {
  /** @param {import('./vm.js').Vm} root the machine the host created (its first process) */
  constructor(root) {
    this.root = root;
    /**
     * @type {import('./vm.js').Vm[]} every process's machine, the root first. An exited one leaves at the next turn
     * (reap): its memory, JIT and window state released; the handles other processes hold on it name a record of its end.
     */
    this.vms = [root];
    /** the machine the host's display, input and audio belong to */
    this.foreground = root;
    /** named kernel objects, every process's (kernel32.js createNamed): the root's map, shared */
    this.named = root.kernelNamed ?? new Map();
    /** file mappings with views in more than one process (kernel32-file.js): their bytes kept alike at each switch */
    this.mappings = new Set();
    /** the machine running now (between switches: the last one) */
    this.current = root;
    this.idleSince = -1;
    this.spawned = 0;
    /** called when the foreground process changes (the worker re-points its per-process hooks): (vm) => void */
    this.onForeground = null;
    /** exited members not reaped yet (reap: at the group's next turn, when none of them is inside its own run) */
    this.ended = [];
    /** bytes compared or copied to keep the shared mappings alike (diagnostics) */
    this.syncBytes = 0;
    // handle values: every process allocates from blocks of its own (HandleTable.alloc) — the root keeps the block it is
    // in, the others are taken above it
    this.handleTop = 0;
    if (root.proc) this.ownHandles(root.proc.handles, true);
  }

  /** A block of handle values no process of the group has used: its first value. */
  takeHandles() { const b = this.handleTop; this.handleTop += HANDLE_BLOCK; return b; }

  /** `table` allocates from the group's blocks (`keep`: the values it has handed out so far stay its own; else a new block). */
  ownHandles(table, keep = false) {
    table.pool = this;
    if (keep) { table.limit = Math.ceil((table.next + 4) / HANDLE_BLOCK) * HANDLE_BLOCK; this.handleTop = Math.max(this.handleTop, table.limit); return; }
    table.next = this.takeHandles(); table.limit = table.next + HANDLE_BLOCK;
  }

  /** the members still running */
  live() { return this.vms.filter((v) => !v.proc?.exited); }

  /**
   * A new machine for a child process of `parent` (its process not created yet): built like the root — same files,
   * clock, host, options — sharing the group's namespace, with process and thread ids, handle values and window handles
   * of its own range.
   */
  spawn(parent) {
    if (this.live().length >= MAX_LIVE_PROCESSES) throw Object.assign(new Error(`${MAX_LIVE_PROCESSES} processes running already`), { processLimit: true });
    const VmClass = /** @type {any} */ (this.root.constructor);
    const n = ++this.spawned;
    const child = new VmClass({ ...this.root.ctorOpts, group: this });
    for (const k of CHILD_INHERITS) if (parent[k] !== undefined) child[k] = parent[k];
    if (parent.mainWaits) child.mainWaits = new Map();
    child.nextPid = this.root.nextPid + 0x100 * n; // (pids and tids: unique across the processes)
    child.tidBase = 0x800 + 0x10000 * n;
    child.parentVm = parent;
    this.vms.push(child);
    return child;
  }

  /** Wake the waiters of every process whose object a thread of `from` released or signaled (Scheduler.signal). */
  signal() { for (const v of this.vms) if (v.proc && !v.proc.exited) v.sched.signal(); }

  /** The thread of id `tid` in any process. */
  thread(tid) { for (const v of this.vms) { const t = v.proc?.thread(tid); if (t) return t; } return null; }

  /** The machine whose process has id `pid`. */
  byPid(pid) { return this.vms.find((v) => v.proc?.pid === pid) ?? null; }

  /** `vm` takes the display, the input and the audio (it created a Direct3D device, or showed the first window). */
  setForeground(vm) {
    if (this.foreground === vm || vm.proc?.exited) return;
    const prev = this.foreground;
    this.foreground = vm;
    this.root.log('loader', `process ${vm.proc?.pid} (${vm.proc?.exe?.name ?? '?'}) takes the display and the input from process ${prev?.proc?.pid}`);
    // (the page shows its windows, display mode, title and cursor from now on)
    if (vm.wm && vm.wm.proc === vm.proc) { vm.wm.resumeHost(); vm.wm.present(true); }
    this.onForeground?.(vm, prev);
  }

  // ---------------------------------------------------------------- shared mappings
  /**
   * `vm` is about to run guest code: the shared mappings' bytes another process wrote brought into its views
   * (win32/mappings.js — only what changed, nothing for a mapping it holds already). A process that only waits is never
   * brought up to date: it does not run guest code (Vm.runOwn calls this before a slice).
   */
  enter(vm) {
    this.current = vm;
    for (const m of this.mappings) this.syncBytes += acquireMapping(vm, m);
  }
  /** a mapping's views changed: shared (synced at switches) while they are in more than one process */
  noteViews(m) {
    const vms = new Set(m.views.map((v) => v.vm));
    if (vms.size > 1) { this.mappings.add(m); return; }
    // (views left in one process only: brought up to date now — no switch keeps them so from here)
    if (this.mappings.delete(m) && vms.size === 1) this.syncBytes += acquireMapping([...vms][0], m);
  }

  // ---------------------------------------------------------------- running
  /**
   * The root Vm's runFor when the machine has several processes: every live member runs in turns of TURN_MS (or until
   * `untilMs`), its shared mappings synced around its turn; the members' own idle waits are handed back here (none
   * sleeps while another has work), and the group sleeps, or hands the wait to a cooperative host, when all wait.
   */
  runFor(untilMs) {
    const root = this.root;
    for (;;) {
      let running = false, wake = Infinity, wakeAt = Infinity, ran = 0;
      for (const v of this.vms) {
        if (!v.proc || v.proc.exited) continue;
        const now = performance.now();
        const r = this.turn(v, untilMs === Infinity ? now + TURN_MS : Math.min(untilMs, now + TURN_MS));
        ran++;
        if (r.state === 'exited') { this.exited(v, r.code); continue; }
        if (r.state === 'running') running = true;
        else if (r.state === 'sleep') { wake = Math.min(wake, r.until); wakeAt = Math.min(wakeAt, r.at ?? Infinity); }
      }
      if (this.ended.length) this.reap();
      if (!ran || this.vms.every((v) => !v.proc || v.proc.exited)) return { state: 'exited', code: this.finish() };
      const now = performance.now();
      if (running) { this.idleSince = -1; if (untilMs !== Infinity && now >= untilMs) return RUNNING; continue; }
      // every process waits
      if (untilMs !== Infinity && root.host?.cooperative) return wake === Infinity ? IDLE : { state: 'sleep', until: wake };
      if (untilMs !== Infinity && now >= untilMs) return RUNNING;
      // (slept on the guest's clock — a virtual one advances by it — at most 50 ms at a time)
      const clock = root.clock, ms = Math.min(50, wakeAt === Infinity ? 50 : Math.max(0.5, wakeAt - clock.now())); // (never 0: a wait due now is checked again after a moment)
      if (wake === Infinity) {
        if (this.idleSince < 0) this.idleSince = root.clock.now();
        else if (root.clock.now() - this.idleSince > root.sched.deadlockLimit) {
          const v = this.live()[0], t = v.proc.threads.find((x) => x.state === TS.BLOCKED) ?? v.proc.threads[0];
          v.deadlock(t, `every process waits (${t?.blockReason ?? 'idle'})`);
        }
      } else this.idleSince = -1;
      if (root.host?.waitEvent) root.host.waitEvent(ms); else clock.sleep(ms);
    }
  }

  /** One member's turn: its slices (its shared mappings brought up to date before it runs guest code: enter). */
  turn(v, until) {
    this.current = v;
    return v.runOwn(until, true);
  }

  /**
   * Run the other processes for a moment from a wait of `vm` nested in a JavaScript frame (sched.js nestedWait: a
   * window procedure, a DllMain waits for another process): true when one of them ran.
   */
  runOthers(vm, ms = TURN_MS) {
    let any = false;
    const until = performance.now() + ms;
    for (const v of this.vms) {
      if (v === vm || !v.proc || v.proc.exited || v.depth > 0) continue; // (a machine already inside its own run: not re-entered)
      const r = this.turn(v, until);
      if (r.state === 'exited') this.exited(v, r.code);
      else if (r.state === 'running') any = true;
    }
    this.enter(vm); // (it goes on with its guest code: what the others wrote meanwhile)
    return any;
  }

  /** `v`'s process ended: its waiters woken, its handles closed, the display back to another process. */
  exited(v, code) {
    const proc = v.proc;
    if (v.groupExited) return; // (told twice: terminated by another process, then its own run ended)
    v.groupExited = true;
    proc.exited = true; proc.exitCode = code >>> 0;
    for (const t of proc.threads) if (t.state !== TS.DONE) t.state = TS.DONE;
    // (its objects: the named ones it holds released — a mutex it owned abandoned — the others with their last handle)
    for (const [h, o] of [...proc.handles.map]) {
      if (o?.type === 'mutex' && proc.threads.some((t) => t.id === o.owner)) { o.owner = 0; o.count = 0; o.abandoned = true; }
      if (o && o.type !== 'thread' && o.type !== 'process' && o.type !== 'heap') proc.handles.close(h);
    }
    // (its views of the paging file's mappings: their bytes kept in the mappings, as an unmap does)
    for (const m of new Set(v.mapViews?.values() ?? [])) { dropViews(v, m); this.noteViews(m); proc.handles.forgetName(m); }
    v.mapViews?.clear();
    this.root.log('loader', `process ${proc.pid} (${proc.exe?.name ?? '?'}) exited with code ${code >>> 0}`);
    if (this.foreground === v) { const next = (v.parentVm && !v.parentVm.proc?.exited ? v.parentVm : this.live()[0]); if (next) this.setForeground(next); }
    if (v !== this.root) this.ended.push(v);
    this.signal();
  }

  /**
   * The exited members leave the group, and nothing of the group keeps their machine: the handles other processes hold
   * on their process and threads name a record of its end (what a wait, GetExitCodeProcess/Thread, GetProcessId read),
   * the objects they created no longer point into their memory, their children's parent is theirs, and the host
   * forgets their memory (the render worker's copy of it, its devices). The machine — guest memory, JIT, windows,
   * Direct3D and sound state — is then garbage.
   */
  reap() {
    const gone = this.ended.splice(0);
    const recs = new Map();
    for (const v of gone) {
      const i = this.vms.indexOf(v); if (i > 0) this.vms.splice(i, 1);
      const p = v.proc, rec = new ExitedProcess(p);
      recs.set(p, rec);
      for (const t of p.threads) recs.set(t, new ExitedThread(t, rec));
    }
    const ownedBy = (o) => gone.find((v) => o?.states?.mem === v.mem);
    const fix = (o) => { if (o?.type === 'mutex' && ownedBy(o)) { o.close(); o.states = null; } }; // (its state out of the dead memory: Mutex.close)
    for (const v of this.vms) {
      const map = v.proc?.handles.map; if (!map) continue;
      for (const [h, o] of map) { const r = recs.get(o); if (r) map.set(h, r); else fix(o); }
      if (gone.includes(v.parentVm)) { let p = v.parentVm; while (p && gone.includes(p)) p = p.parentVm; v.parentVm = p ?? this.root; }
    }
    for (const o of this.named.values()) fix(o);
    if (gone.includes(this.current)) this.current = this.root;
    for (const v of gone) { this.root.host?.forgetProcess?.(v); v.parentVm = null; }
  }

  /** every process ended: the host told once, with the root's exit code */
  finish() {
    const code = this.root.proc.exitCode >>> 0;
    if (!this.finished) { this.finished = true; this.root.host?.onExit?.(code); }
    return code;
  }
}

/** What another process's handle on an exited process names once its machine is released (ProcessGroup.reap). */
export class ExitedProcess {
  constructor(p) {
    this.type = 'process'; this.pid = p.pid; this.exited = true; this.exitCode = p.exitCode; this.handle = p.handle;
    this.exe = p.exe ? { name: p.exe.name } : null; this.priorityClass = p.priorityClass;
  }
}

/** What a handle on a thread of an exited process names once its machine is released. */
export class ExitedThread {
  constructor(t, proc) {
    this.type = 'thread'; this.id = t.id; this.state = TS.DONE; this.exitCode = t.exitCode; this.handle = t.handle;
    this.proc = proc; this.priority = t.priority ?? 0; this.suspendCount = 0;
  }
  isRunnable() { return false; }
}
