// Guest process and threads: address space, handles, modules, TEB/PEB, stacks, TLS.
import { CpuState, THREAD_STATES_BASE, ST, MAX_THREADS } from '../cpu/state.js';
import { VMem, PAGE_READWRITE } from './vmem.js';
import { HandleTable } from './handles.js';
import { Heap } from './heap.js';
import { PeImage, mapImage } from '../loader/pe.js';
import { ApiRegistry } from './api.js';
import { normalizeWin } from '../vfs/vfs.js';

export const PEB_ADDR = 0x7ffdf000;
export const TEB0_ADDR = 0x7ffde000;
export const KUSER_SHARED = 0x7ffe0000;
export const TEB_SIZE = 0x1000;
export const TEB_TLS_SLOTS = 0xe10; // 64 slots
export const TEB_TLS_ARRAY = 0xf20; // ThreadLocalStoragePointer target (module TLS blocks)
export const MAX_TLS_MODULES = 48;

export const TS = Object.freeze({ READY: 0, RUNNING: 1, BLOCKED: 2, SUSPENDED: 3, DONE: 4 });

let nextPid = 0x400;

export class Thread {
  /**
   * @param {Process} proc
   * @param {number} id
   * @param {number} slot cpu state slot index
   */
  constructor(proc, id, slot) {
    this.proc = proc;
    this.vm = proc.vm;
    this.id = id;
    this.type = 'thread';
    this.slot = slot;
    this.cpu = new CpuState(proc.mem, THREAD_STATES_BASE + slot * ST.SIZE);
    this.teb = 0;
    this.stackBase = 0;
    this.stackLimit = 0;
    this.stackRegion = 0;
    this.state = TS.READY;
    this.suspendCount = 0;
    this.exitCode = 0x103; // STILL_ACTIVE
    this.onStack = 0; // nesting count of dispatch loops running this thread
    this.baseDepth = -1;
    this.priority = 0;
    this.name = '';
    this.wakeAt = Infinity; // for Sleep / timed waits
    this.blockReason = '';
    this.startAddr = 0;
    this.startParam = 0;
    this.handle = 0;
    this.refs = 1;
    this.callbackDepth = 0;
    this.apcQueue = [];
    this.pendingExit = false;
  }

  get lastError() { return this.proc.mem.read32(this.teb + 0x34); }
  set lastError(v) { this.proc.mem.write32(this.teb + 0x34, v >>> 0); }
  get tlsArray() { return this.teb + TEB_TLS_ARRAY; }

  /** Set up the TEB for this thread. */
  initTeb(teb) {
    const m = this.proc.mem;
    this.teb = teb;
    m.fill(teb, TEB_SIZE, 0);
    m.write32(teb + 0x00, 0xffffffff); // SEH chain end
    m.write32(teb + 0x04, this.stackBase);
    m.write32(teb + 0x08, this.stackLimit);
    m.write32(teb + 0x18, teb); // Self
    m.write32(teb + 0x20, this.proc.pid);
    m.write32(teb + 0x24, this.id);
    m.write32(teb + 0x2c, teb + TEB_TLS_ARRAY);
    m.write32(teb + 0x30, PEB_ADDR);
    this.cpu.fsBase = teb;
  }

  isRunnable() { return this.state === TS.READY && this.onStack === 0; }
}

export class Process {
  /**
   * @param {import('../core/vm.js').Vm} vm
   * @param {{ exePath: string, args?: string, cwd?: string, env?: Record<string,string>, dllOverrides?: Record<string,string> }} opts
   */
  constructor(vm, opts) {
    this.vm = vm;
    this.mem = vm.mem;
    this.api = vm.api;
    this.vfs = vm.vfs;
    this.type = 'process';
    this.pid = nextPid; nextPid += 4;
    this.vmem = new VMem();
    this.handles = new HandleTable();
    /** @type {Map<string, any>} lowercase name -> module (PeModule or builtin marker) */
    this.modules = new Map();
    /** @type {any[]} native modules in load order */
    this.moduleList = [];
    this.exe = null;
    this.exePath = normalizeWin(opts.exePath);
    this.exeDir = this.exePath.slice(0, this.exePath.lastIndexOf('\\'));
    this.cwd = normalizeWin(opts.cwd ?? this.exeDir);
    this.args = opts.args ?? '';
    this.cmdline = `"${this.exePath}"` + (this.args ? ' ' + this.args : '');
    this.env = new Map(Object.entries({
      SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:',
      TEMP: 'C:\\Users\\Player\\Temp', TMP: 'C:\\Users\\Player\\Temp', USERPROFILE: 'C:\\Users\\Player',
      USERNAME: 'Player', COMPUTERNAME: 'ORTHROS', OS: 'Windows_NT', PATH: 'C:\\Windows\\System32;C:\\Windows',
      PATHEXT: '.COM;.EXE;.BAT;.CMD', NUMBER_OF_PROCESSORS: '1', PROCESSOR_ARCHITECTURE: 'x86',
      PROCESSOR_IDENTIFIER: 'x86 Family 6 Model 15 Stepping 2, GenuineIntel', PROCESSOR_LEVEL: '6',
      PROCESSOR_REVISION: '0f02', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\Player',
      APPDATA: 'C:\\Users\\Player\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Player\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files', CommonProgramFiles: 'C:\\Program Files\\Common Files',
      ...(opts.env ?? {}),
    }));
    this.dllOverrides = new Map(Object.entries(opts.dllOverrides ?? {}).map(([k, v]) => [ApiRegistry.norm(k), v]));
    this.exitCode = 0;
    this.exited = false;
    /** @type {Thread[]} */
    this.threads = [];
    this.nextTid = 0x800;
    this.usedSlots = new Uint8Array(MAX_THREADS);
    this.tlsSlots = new Uint8Array(1088); // 64 + 1024 expansion
    this.tlsValuesExpansion = new Map(); // tid -> guest address of expansion array
    this.tlsModules = []; // modules with a TLS directory (index = position)
    this.heaps = [];
    this.processHeap = null;
    this.unknownImports = new Map();
    this.atoms = new Map();
    this.nextAtom = 0xc000;
    this.timers = [];
    this.startTime = vm.clock.now();
    this.errorMode = 0;
    this.priorityClass = 0x20;
    this.affinity = 1;
    this.consoleOut = null;

    this.initPeb();
    this.initKuser();
    this.processHeap = this.createHeap({ tag: 'process' });
  }

  initPeb() {
    const m = this.mem;
    m.fill(PEB_ADDR, 0x1000, 0);
    m.write8(PEB_ADDR + 2, 0); // BeingDebugged
    m.write32(PEB_ADDR + 0x64, 1); // NumberOfProcessors
    m.write32(PEB_ADDR + 0xa4, 5); // OSMajorVersion
    m.write32(PEB_ADDR + 0xa8, 1); // OSMinorVersion
    m.write16(PEB_ADDR + 0xac, 2600); // OSBuildNumber
    m.write16(PEB_ADDR + 0xae, 0x300); // OSCSDVersion (SP3)
    m.write32(PEB_ADDR + 0xb0, 2); // OSPlatformId VER_PLATFORM_WIN32_NT
    m.write32(PEB_ADDR + 0xb4, 2); // ImageSubsystem GUI
    m.write32(PEB_ADDR + 0xb8, 4); // ImageSubsystemMajorVersion
  }

  initKuser() {
    const m = this.mem;
    m.fill(KUSER_SHARED, 0x1000, 0);
    m.write32(KUSER_SHARED + 0x04, 0x0fa00000); // TickCountMultiplier
    m.write16(KUSER_SHARED + 0x2c, 0x14c); // ImageNumberLow
    m.write16(KUSER_SHARED + 0x2e, 0x14c);
    m.writeWString(KUSER_SHARED + 0x30, 'C:\\Windows');
    m.write32(KUSER_SHARED + 0x26c, 5); // NtMajorVersion
    m.write32(KUSER_SHARED + 0x270, 1); // NtMinorVersion
    m.write32(KUSER_SHARED + 0x2d8, 1); // SuiteMask
    m.write32(KUSER_SHARED + 0x2f8, 1); // NumberOfPhysicalPages (dummy)
    this.updateKuserTime();
  }

  updateKuserTime() {
    const m = this.mem;
    const now = this.vm.clock.now();
    const tick = Math.floor(now) >>> 0;
    m.write32(KUSER_SHARED + 0x0, tick);
    // InterruptTime & SystemTime as 100ns units (KSYSTEM_TIME: low, high1, high2)
    const it = BigInt(Math.floor(now * 10000));
    m.write32(KUSER_SHARED + 0x8, Number(it & 0xffffffffn));
    m.write32(KUSER_SHARED + 0xc, Number(it >> 32n));
    m.write32(KUSER_SHARED + 0x10, Number(it >> 32n));
    const st = BigInt(Math.floor((Date.now() + 11644473600000) * 10000));
    m.write32(KUSER_SHARED + 0x14, Number(st & 0xffffffffn));
    m.write32(KUSER_SHARED + 0x18, Number(st >> 32n));
    m.write32(KUSER_SHARED + 0x1c, Number(st >> 32n));
    const tc = BigInt(Math.floor(now)) * 0x1000000n / 0xfa00000n * 0xfa00000n; // keep it simple
    m.write32(KUSER_SHARED + 0x320, tick);
    m.write32(KUSER_SHARED + 0x324, 0);
    m.write32(KUSER_SHARED + 0x328, 0);
    void tc;
  }

  // ------------------------------------------------------------------ heaps
  createHeap(opts = {}) {
    const h = new Heap(this, opts);
    h.handle = this.handles.create(h);
    this.heaps.push(h);
    return h;
  }

  // ------------------------------------------------------------------ threads
  /**
   * @param {{ start: number, param?: number, stackSize?: number, suspended?: boolean, main?: boolean, stackBase?: number }} o
   */
  createThread(o) {
    let slot = -1;
    for (let i = 0; i < MAX_THREADS; i++) if (!this.usedSlots[i]) { slot = i; break; }
    if (slot < 0) throw new Error('too many threads');
    this.usedSlots[slot] = 1;
    const t = new Thread(this, this.nextTid, slot);
    this.nextTid += 4;
    const stackSize = Math.max(o.stackSize || 0x100000, 0x10000);
    const region = this.vmem.alloc(stackSize, PAGE_READWRITE, `stack:${t.id}`, o.stackBase ?? 0, { topDown: !o.main });
    if (!region) throw new Error('cannot allocate thread stack');
    t.stackRegion = region;
    t.stackLimit = region;
    t.stackBase = region + stackSize;
    // TEB: main thread at the canonical address, others below it
    const teb = TEB0_ADDR - slot * TEB_SIZE;
    t.initTeb(teb);
    t.startAddr = o.start;
    t.startParam = o.param ?? 0;
    // initial frame: [param][return -> thread-exit thunk]
    const cpu = t.cpu;
    cpu.esp = (t.stackBase - 0x40) >>> 0;
    cpu.push32(t.startParam);
    cpu.push32(o.main ? this.vm.exitProcessThunk : this.vm.exitThreadThunk);
    cpu.eip = o.start;
    cpu.eax = 0; cpu.ebx = 0; cpu.ecx = o.start; cpu.edx = o.start; cpu.esi = 0; cpu.edi = 0; cpu.ebp = 0;
    this.setupThreadTls(t);
    if (o.suspended) { t.state = TS.SUSPENDED; t.suspendCount = 1; }
    t.handle = this.handles.create(t);
    this.threads.push(t);
    return t;
  }

  /** Allocate per-thread TLS blocks for all modules that carry a TLS directory. */
  setupThreadTls(t) {
    for (let i = 0; i < this.tlsModules.length; i++) this.allocModuleTls(t, i);
  }

  allocModuleTls(t, index) {
    const mod = this.tlsModules[index];
    if (!mod || !mod.tls) return;
    const size = Math.max(mod.tls.size, 4);
    const blk = this.processHeap.alloc(size, true);
    const init = mod.tls.end - mod.tls.start;
    if (init > 0) this.mem.copy(blk, mod.tls.start, init);
    this.mem.write32(t.tlsArray + 4 * index, blk);
  }

  thread(tid) { return this.threads.find((t) => t.id === tid) ?? null; }

  removeThread(t) {
    t.state = TS.DONE;
    this.usedSlots[t.slot] = 0;
    // keep the object for handle lookups (exit code), release its stack
    this.vmem.release(t.stackRegion);
  }

  // ------------------------------------------------------------------ modules
  /** Resolve a guest path relative to cwd. */
  path(p) { return normalizeWin(p, this.cwd); }

  /** Find a DLL file in the search path (exe dir, cwd). Returns guest path or null. */
  findDllFile(name) {
    const n = ApiRegistry.norm(name);
    if (/[\\/]/.test(name)) { const p = this.path(name); return this.vfs.stat(p) ? p : null; }
    for (const dir of [this.exeDir, this.cwd]) {
      const p = dir + '\\' + n;
      const st = this.vfs.stat(p);
      if (st && !st.isDir) return p;
    }
    return null;
  }

  /**
   * Load (or return the already loaded) module for a DLL name. Builtin API modules are preferred
   * unless the manifest overrides them to 'native' (and a file exists).
   */
  loadModule(name, { forExe = false, path = null, bytes = null } = {}) {
    const n = ApiRegistry.norm(name);
    let mod = this.modules.get(n);
    if (mod) { if (mod.refCount !== undefined) mod.refCount++; return mod; }
    const override = this.dllOverrides.get(n);
    const builtin = this.api.has(n);
    let file = path ?? (bytes ? null : this.findDllFile(name));
    if (!forExe && builtin && override !== 'native') { file = null; }
    if (!forExe && override === 'builtin') file = null;
    if (!file && !bytes) {
      if (builtin) { mod = { name: n, builtin: true, base: this.api.dll(n).base ?? 0 }; this.modules.set(n, mod); return mod; }
      return null;
    }
    const data = bytes ?? this.vfs.readFile(file);
    if (!data) return null;
    const img = new PeImage(data);
    mod = mapImage(img, this.mem, this.vmem, { name: n, path: file ?? this.path(name) });
    this.modules.set(n, mod);
    this.vm.log('loader', `mapped ${n} at ${hex(mod.base)} size ${hex(mod.size)} entry ${hex(mod.entry)}`);
    if (mod.tls) { mod.tls.index = this.tlsModules.length; this.tlsModules.push(mod); this.mem.write32(mod.tls.indexAddr, mod.tls.index); for (const t of this.threads) this.allocModuleTls(t, mod.tls.index); }
    this.resolveImports(mod);
    this.moduleList.push(mod);
    return mod;
  }

  resolveImports(mod) {
    const dlls = new Map();
    for (const imp of mod.imports) {
      let dep = dlls.get(imp.dll);
      if (dep === undefined) {
        dep = this.loadModule(imp.dll);
        if (!dep) { this.vm.log('loader', `${mod.name}: missing DLL ${imp.dll} (stubbing)`); dep = { name: imp.dll, builtin: true, missing: true }; this.modules.set(ApiRegistry.norm(imp.dll), dep); }
        dlls.set(imp.dll, dep);
      }
      const addr = this.resolveExport(dep, imp.name, imp.ordinal, mod);
      this.mem.write32(imp.iat, addr);
    }
  }

  /** Address of dll!name (or ordinal) for a module: thunk for builtins, export for native. */
  resolveExport(dep, name, ordinal, from = null) {
    if (dep.builtin) {
      const addr = name !== null ? this.api.thunkFor(dep.name, name) : this.api.thunkForOrdinal(dep.name, ordinal);
      const t = this.api.thunk((addr - 0x7fe00000) / 16);
      if (!t.def) this.noteUnknown(dep.name, name ?? `#${ordinal}`, from);
      return addr;
    }
    let addr = name !== null ? dep.exports.get(name) : dep.ordinals.get(ordinal);
    if (addr === undefined) {
      const fwd = name !== null ? dep.forwards.get(name) : dep.forwards.get('#' + ordinal);
      if (fwd) {
        const dot = fwd.indexOf('.');
        const fdll = fwd.slice(0, dot), fname = fwd.slice(dot + 1);
        const fmod = this.loadModule(fdll) ?? { name: ApiRegistry.norm(fdll), builtin: true, missing: true };
        return this.resolveExport(fmod, fname.startsWith('#') ? null : fname, fname.startsWith('#') ? +fname.slice(1) : null, from);
      }
      this.vm.log('loader', `${from?.name ?? '?'}: ${dep.name} has no export ${name ?? '#' + ordinal}`);
      return this.api.thunkFor(dep.name, name ?? `#${ordinal}`);
    }
    return addr;
  }

  noteUnknown(dll, name, from) {
    const key = `${dll}!${name}`;
    if (!this.unknownImports.has(key)) this.unknownImports.set(key, { from: from?.name ?? '?', calls: 0 });
  }

  moduleByAddr(addr) {
    for (const m of this.moduleList) if (addr >= m.base && addr < m.base + m.size) return m;
    return null;
  }

  moduleByHandle(h) {
    if (!h) return this.exe;
    for (const m of this.moduleList) if (m.base === (h >>> 0)) return m;
    for (const m of this.modules.values()) if (m.builtin && m.base === (h >>> 0)) return m;
    return null;
  }

  /** Windows-visible file name of a module. */
  moduleFileName(mod) {
    if (!mod) return this.exePath;
    if (mod.builtin) return 'C:\\Windows\\System32\\' + mod.name;
    return mod.path;
  }

  /** Format "module+offset" for an address. */
  symbolize(addr) {
    const m = this.moduleByAddr(addr);
    if (m) return `${m.name}+0x${(addr - m.base).toString(16)}`;
    const t = this.api.nameOf(addr);
    if (t) return t;
    return `0x${(addr >>> 0).toString(16)}`;
  }

  /** Environment block "A=B\0C=D\0\0" as a string. */
  envBlock() {
    let s = '';
    for (const [k, v] of this.env) s += `${k}=${v}\0`;
    return s + '\0';
  }
}

export function hex(v) { return '0x' + (v >>> 0).toString(16); }
