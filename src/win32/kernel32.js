// kernel32.dll: process, threads, synchronization, memory, modules, time, misc.
// File/directory/environment/string APIs live in kernel32-file.js.
import { SIGNATURES } from './signatures.js';
import { E } from './errors.js';
import { TS, PEB_ADDR, TEB_TLS_SLOTS } from './process.js';
import { INFINITE, WAIT_OBJECT_0, WAIT_ABANDONED, WAIT_TIMEOUT, WAIT_FAILED } from '../core/sched.js';
import { MEM_COMMIT, MEM_RESERVE, MEM_DECOMMIT, MEM_RELEASE, PAGE_READWRITE, PAGE_NOACCESS, MEM_TOP_DOWN } from './vmem.js';
import { findResource } from '../loader/pe.js';
import { registerKernel32File } from './kernel32-file.js';
import { ApiRegistry } from './api.js';

export const STILL_ACTIVE = 0x103;
const INVALID_HANDLE = 0xffffffff;

/** Object signaled state for waits. */
export function isSignaled(obj, thread) {
  switch (obj.type) {
    case 'event': return obj.signaled;
    case 'mutex': return obj.owner === 0 || obj.owner === thread.id;
    case 'semaphore': return obj.count > 0;
    case 'thread': return obj.state === TS.DONE;
    case 'process': return obj.exited;
    case 'timer': return obj.signaled;
    case 'file': return true;
    default: return true;
  }
}
export function consumeSignal(obj, thread) {
  switch (obj.type) {
    case 'event': if (!obj.manual) obj.signaled = false; return WAIT_OBJECT_0;
    case 'mutex': { const ab = obj.abandoned ? WAIT_ABANDONED : WAIT_OBJECT_0; obj.abandoned = false; obj.owner = thread.id; obj.count++; return ab; }
    case 'semaphore': obj.count--; return WAIT_OBJECT_0;
    case 'timer': if (!obj.manual) obj.signaled = false; return WAIT_OBJECT_0;
    default: return WAIT_OBJECT_0;
  }
}

/** Resolve a handle for waiting (pseudo handles included). */
export function waitObject(ctx, h) {
  h >>>= 0;
  if (h === 0xffffffff) return ctx.proc;
  if (h === 0xfffffffe) return ctx.thread;
  return ctx.proc.handles.get(h) ?? null;
}

const FILETIME_EPOCH = 11644473600000; // ms between 1601 and 1970

export function msToFiletime(ms) { return BigInt(Math.floor((ms + FILETIME_EPOCH) * 10000)); }
export function filetimeToMs(ft) { return Number(ft) / 10000 - FILETIME_EPOCH; }

export function writeSystemTime(mem, addr, ms) {
  const d = new Date(ms);
  mem.write16(addr, d.getUTCFullYear()); mem.write16(addr + 2, d.getUTCMonth() + 1); mem.write16(addr + 4, d.getUTCDay());
  mem.write16(addr + 6, d.getUTCDate()); mem.write16(addr + 8, d.getUTCHours()); mem.write16(addr + 10, d.getUTCMinutes());
  mem.write16(addr + 12, d.getUTCSeconds()); mem.write16(addr + 14, d.getUTCMilliseconds());
}
export function readSystemTime(mem, addr) {
  return Date.UTC(mem.read16(addr), mem.read16(addr + 2) - 1, mem.read16(addr + 6), mem.read16(addr + 8), mem.read16(addr + 10), mem.read16(addr + 12), mem.read16(addr + 14));
}

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerKernel32(api, vm) {
  for (const [k, v] of Object.entries(SIGNATURES)) api.signatures.set(k, v);
  const mem = vm.mem;
  const K = {};
  const named = new Map(); // named kernel objects

  const createNamed = (ctx, nameArg, make) => {
    const name = nameArg;
    if (name && named.has(name)) { ctx.setLastError(E.ALREADY_EXISTS); const o = named.get(name); o.refs++; return ctx.proc.handles.create(o); }
    const o = make();
    o.refs = 1;
    if (name) { o.name = name; named.set(name, o); }
    ctx.setLastError(0);
    return ctx.proc.handles.create(o);
  };

  // ---------------------------------------------------------------- process / errors
  K.GetLastError = [0, (c) => c.thread.lastError];
  K.SetLastError = [1, (c) => { c.thread.lastError = c.arg(0); }];
  K.ExitProcess = [1, (c) => vm.exitProcess(c.arg(0)), { noreturn: true }];
  K.TerminateProcess = [2, (c) => { const h = c.arg(0) >>> 0; if (h === 0xffffffff || c.proc.handles.get(h) === c.proc) vm.exitProcess(c.arg(1)); return 1; }];
  K.GetCurrentProcess = [0, () => 0xffffffff];
  K.GetCurrentProcessId = [0, (c) => c.proc.pid];
  K.GetCurrentThread = [0, () => 0xfffffffe];
  K.GetCurrentThreadId = [0, (c) => c.thread.id];
  K.GetExitCodeProcess = [2, (c) => { c.out32(1, c.proc.exited ? c.proc.exitCode : STILL_ACTIVE); return 1; }];
  K.OpenProcess = [3, (c) => (c.arg(2) === c.proc.pid ? c.proc.handles.create(c.proc) : c.fail(E.INVALID_PARAMETER))];
  K.GetProcessVersion = [1, () => 0x00050001];
  K.GetPriorityClass = [1, (c) => c.proc.priorityClass];
  K.SetPriorityClass = [2, (c) => { c.proc.priorityClass = c.arg(1); return 1; }];
  K.GetProcessAffinityMask = [3, (c) => { c.out32(1, 1); c.out32(2, 1); return 1; }];
  K.SetProcessAffinityMask = [2, () => 1];
  K.SetProcessWorkingSetSize = [3, () => 1];
  K.GetProcessWorkingSetSize = [3, (c) => { c.out32(1, 0x100000); c.out32(2, 0x8000000); return 1; }];
  K.GetProcessTimes = [5, (c) => { const z = 0n; c.out64(1, msToFiletime(vm.clock.wall() - vm.clock.now())); c.out64(2, z); c.out64(3, z); c.out64(4, BigInt(Math.floor(vm.clock.now() * 10000))); return 1; }];
  K.SetErrorMode = [1, (c) => { const o = c.proc.errorMode; c.proc.errorMode = c.arg(0); return o; }];
  K.GetErrorMode = [0, (c) => c.proc.errorMode];
  K.IsDebuggerPresent = [0, () => 0];
  K.CheckRemoteDebuggerPresent = [2, (c) => { c.out32(1, 0); return 1; }];
  K.DebugBreak = [0, (c) => { vm.warn('DebugBreak called'); }];
  K.OutputDebugStringA = [1, (c) => { vm.log('debug', c.str(0) ?? ''); }];
  K.OutputDebugStringW = [1, (c) => { vm.log('debug', c.wstr(0) ?? ''); }];
  K.SetUnhandledExceptionFilter = [1, (c) => { const o = c.proc.unhandledFilter ?? 0; c.proc.unhandledFilter = c.arg(0); return o; }];
  K.UnhandledExceptionFilter = [1, () => 1];
  K.IsBadReadPtr = [2, (c) => (c.arg(1) === 0 ? 0 : c.proc.vmem.isCommitted(c.arg(0), c.arg(1)) ? 0 : 1)];
  K.IsBadWritePtr = [2, (c) => (c.arg(1) === 0 ? 0 : c.proc.vmem.isCommitted(c.arg(0), c.arg(1)) ? 0 : 1)];
  K.IsBadCodePtr = [1, (c) => (c.proc.vmem.isCommitted(c.arg(0), 1) ? 0 : 1)];
  K.IsBadStringPtrA = [2, (c) => (c.proc.vmem.isCommitted(c.arg(0), 1) ? 0 : 1)];
  K.IsBadHugeReadPtr = K.IsBadReadPtr; K.IsBadHugeWritePtr = K.IsBadWritePtr;
  K.RaiseException = [4, (c) => { vm.raiseException(c, c.arg(0), c.arg(1), c.arg(2), c.arg(3)); }, { noreturn: true }];
  K.RtlUnwind = [4, (c) => vm.seh.rtlUnwind(c)];
  K.FatalAppExitA = [2, (c) => { vm.warn(`FatalAppExit: ${c.str(1)}`); vm.exitProcess(1); }, { noreturn: true }];
  K.FatalExit = [1, (c) => vm.exitProcess(c.arg(0)), { noreturn: true }];
  K.GetVersion = [0, () => 0x0a280105];
  K.GetVersionExA = [1, (c) => {
    const p = c.arg(0); const size = mem.read32(p);
    mem.write32(p + 4, 5); mem.write32(p + 8, 1); mem.write32(p + 12, 2600); mem.write32(p + 16, 2);
    mem.writeCString(p + 20, 'Service Pack 3', 128);
    if (size >= 156) { mem.write16(p + 148, 3); mem.write16(p + 150, 0); mem.write16(p + 152, 0x100); mem.write8(p + 154, 1); }
    return 1;
  }];
  K.GetVersionExW = [1, (c) => {
    const p = c.arg(0); const size = mem.read32(p);
    mem.write32(p + 4, 5); mem.write32(p + 8, 1); mem.write32(p + 12, 2600); mem.write32(p + 16, 2);
    mem.writeWString(p + 20, 'Service Pack 3', 128);
    if (size >= 284) { mem.write16(p + 276, 3); mem.write16(p + 278, 0); mem.write16(p + 280, 0x100); mem.write8(p + 282, 1); }
    return 1;
  }];
  K.VerifyVersionInfoA = [4, () => 1];
  K.VerifyVersionInfoW = [4, () => 1];
  K.VerSetConditionMask = [4, (c) => { c.cpu.edx = c.arg(1); return c.arg(0); }]; // 64-bit return in edx:eax (approx)
  K.GetSystemInfo = [1, (c) => {
    const p = c.arg(0);
    mem.write16(p, 0); mem.write16(p + 2, 0); mem.write32(p + 4, 0x1000); mem.write32(p + 8, 0x10000); mem.write32(p + 12, 0x7ffeffff);
    mem.write32(p + 16, 1); mem.write32(p + 20, 1); mem.write32(p + 24, 586); mem.write32(p + 28, 0x10000); mem.write16(p + 32, 6); mem.write16(p + 34, 0x0f02);
  }];
  K.GetNativeSystemInfo = K.GetSystemInfo;
  K.IsProcessorFeaturePresent = [1, (c) => ([2, 3, 6, 8, 10].includes(c.arg(0)) ? 1 : 0)];
  K.GetStartupInfoA = [1, (c) => {
    const p = c.arg(0); mem.fill(p, 68, 0); mem.write32(p, 68); mem.write32(p + 44, 0x1);
    mem.write16(p + 48, 1); mem.write32(p + 56, c.proc.stdHandles[0]); mem.write32(p + 60, c.proc.stdHandles[1]); mem.write32(p + 64, c.proc.stdHandles[2]);
  }];
  K.GetStartupInfoW = K.GetStartupInfoA;
  K.GetCommandLineA = [0, (c) => c.proc.cmdlineA ??= allocString(c, c.proc.cmdline)];
  K.GetCommandLineW = [0, (c) => c.proc.cmdlineW ??= allocWString(c, c.proc.cmdline)];
  K.SetHandleCount = [1, (c) => c.arg(0)];
  K.GetProcessHeap = [0, (c) => c.proc.processHeap.handle];
  K.GetProcessHeaps = [2, (c) => { const n = c.arg(0), p = c.arg(1); c.proc.heaps.forEach((h, i) => { if (i < n) mem.write32(p + 4 * i, h.handle); }); return c.proc.heaps.length; }];
  K.MulDiv = [3, (c) => { const a = c.sarg(0), b = c.sarg(1), d = c.sarg(2); if (d === 0) return -1; const r = (a * b) / d; return (Math.round(r) | 0) >>> 0; }];
  K.Beep = [2, () => 1];
  K.GetConsoleMode = [2, (c) => c.fail(E.INVALID_HANDLE)];
  K.SetConsoleCtrlHandler = [2, () => 1];
  K.GetConsoleCP = [0, () => 437];
  K.GetConsoleOutputCP = [0, () => 437];
  K.SetConsoleMode = [2, () => 0];
  K.AllocConsole = [0, () => 1];
  K.FreeConsole = [0, () => 1];
  K.GetConsoleScreenBufferInfo = [2, () => 0];
  K.SetConsoleTextAttribute = [2, () => 1];
  K.GetConsoleTitleA = [2, () => 0];
  K.SetConsoleTitleA = [1, () => 1];

  // ---------------------------------------------------------------- handles
  K.CloseHandle = [1, (c) => {
    const h = c.arg(0) >>> 0;
    if (h === 0xffffffff || h === 0xfffffffe) return 1;
    const o = c.proc.handles.get(h);
    if (!o) return c.fail(E.INVALID_HANDLE);
    if (o.type === 'thread' || o.type === 'process' || o.type === 'heap') { c.proc.handles.map.delete(h); return 1; }
    c.proc.handles.close(h);
    return 1;
  }];
  K.DuplicateHandle = [7, (c) => {
    const h = c.arg(1) >>> 0;
    let nh;
    if (h === 0xffffffff) nh = c.proc.handles.create(c.proc);
    else if (h === 0xfffffffe) nh = c.proc.handles.create(c.thread);
    else { nh = c.proc.handles.dup(h); if (!nh) return c.fail(E.INVALID_HANDLE); }
    c.out32(3, nh);
    return 1;
  }];
  K.GetHandleInformation = [2, (c) => { c.out32(1, 0); return 1; }];
  K.SetHandleInformation = [3, () => 1];

  // ---------------------------------------------------------------- threads
  K.CreateThread = [6, (c) => {
    const t = c.proc.createThread({ start: c.arg(2), param: c.arg(3), stackSize: c.arg(1), suspended: (c.arg(4) & 4) !== 0 });
    c.out32(5, t.id);
    vm.log('thread', `CreateThread -> tid ${t.id} start ${c.proc.symbolize(c.arg(2))}`);
    return t.handle;
  }];
  K.ExitThread = [1, (c) => vm.exitThread(c.thread, c.arg(0)), { noreturn: true }];
  K.TerminateThread = [2, (c) => {
    const t = c.arg(0) >>> 0 === 0xfffffffe ? c.thread : c.proc.handles.getAs(c.arg(0), 'thread');
    if (!t) return c.fail(E.INVALID_HANDLE);
    if (t === c.thread) vm.exitThread(t, c.arg(1));
    t.exitCode = c.arg(1); t.pendingExit = true;
    if (t.onStack === 0) c.proc.removeThread(t);
    return 1;
  }];
  K.GetExitCodeThread = [2, (c) => {
    const t = c.arg(0) >>> 0 === 0xfffffffe ? c.thread : c.proc.handles.getAs(c.arg(0), 'thread');
    if (!t) return c.fail(E.INVALID_HANDLE);
    c.out32(1, t.state === TS.DONE ? t.exitCode : STILL_ACTIVE);
    return 1;
  }];
  K.SuspendThread = [1, (c) => {
    const t = c.arg(0) >>> 0 === 0xfffffffe ? c.thread : c.proc.handles.getAs(c.arg(0), 'thread');
    if (!t) return c.fail(E.INVALID_HANDLE);
    const prev = t.suspendCount++;
    if (t === c.thread) { vm.sched.block(t, () => t.suspendCount === 0, INFINITE, 'suspended'); }
    else if (t.state === TS.READY) t.state = TS.SUSPENDED;
    return prev;
  }];
  K.ResumeThread = [1, (c) => {
    const t = c.arg(0) >>> 0 === 0xfffffffe ? c.thread : c.proc.handles.getAs(c.arg(0), 'thread');
    if (!t) return c.fail(E.INVALID_HANDLE);
    const prev = t.suspendCount;
    if (t.suspendCount > 0 && --t.suspendCount === 0 && t.state === TS.SUSPENDED) t.state = TS.READY;
    return prev;
  }];
  K.GetThreadPriority = [1, (c) => { const t = c.arg(0) >>> 0 === 0xfffffffe ? c.thread : c.proc.handles.getAs(c.arg(0), 'thread'); return t ? t.priority : 0x7fffffff; }];
  K.SetThreadPriority = [2, (c) => { const t = c.arg(0) >>> 0 === 0xfffffffe ? c.thread : c.proc.handles.getAs(c.arg(0), 'thread'); if (!t) return c.fail(E.INVALID_HANDLE); t.priority = c.sarg(1); return 1; }];
  K.SetThreadPriorityBoost = [2, () => 1];
  K.SetThreadAffinityMask = [2, () => 1];
  K.SetThreadIdealProcessor = [2, () => 0];
  K.GetThreadTimes = [5, (c) => { c.out64(1, msToFiletime(vm.clock.wall())); c.out64(2, 0n); c.out64(3, 0n); c.out64(4, BigInt(Math.floor(vm.clock.now() * 10000))); return 1; }];
  K.GetThreadContext = [2, (c) => { vm.warn('GetThreadContext: unsupported'); return 0; }];
  K.SetThreadContext = [2, () => 0];
  K.OpenThread = [3, (c) => { const t = c.proc.thread(c.arg(2)); return t ? c.proc.handles.create(t) : c.fail(E.INVALID_PARAMETER); }];
  K.SwitchToThread = [0, (c) => (vm.sched.yieldFrom(c.thread) ? 1 : 0)];
  K.Sleep = [1, (c) => { const ms = c.arg(0); if (ms === 0) vm.sched.yieldFrom(c.thread); else vm.sched.block(c.thread, () => false, ms === INFINITE ? INFINITE : ms, 'sleep'); }];
  K.SleepEx = [2, (c) => { const ms = c.arg(0); if (ms === 0) vm.sched.yieldFrom(c.thread); else vm.sched.block(c.thread, () => false, ms === INFINITE ? INFINITE : ms, 'sleep'); return 0; }];
  K.QueueUserAPC = [3, (c) => { const t = c.proc.handles.getAs(c.arg(1), 'thread'); if (!t) return 0; t.apcQueue.push({ fn: c.arg(0), arg: c.arg(2) }); return 1; }];

  // TLS
  K.TlsAlloc = [0, (c) => {
    const s = c.proc.tlsSlots;
    for (let i = 0; i < s.length; i++) if (!s[i]) { s[i] = 1; for (const t of c.proc.threads) tlsSet(c, t, i, 0); return i; }
    return c.fail(E.NOT_ENOUGH_MEMORY) | 0xffffffff;
  }];
  K.TlsFree = [1, (c) => { const i = c.arg(0); if (i >= c.proc.tlsSlots.length) return c.fail(E.INVALID_PARAMETER); c.proc.tlsSlots[i] = 0; return 1; }];
  K.TlsGetValue = [1, (c) => { const i = c.arg(0); if (i >= 1088) return c.fail(E.INVALID_PARAMETER); c.thread.lastError = 0; return tlsGet(c, c.thread, i); }];
  K.TlsSetValue = [2, (c) => { const i = c.arg(0); if (i >= 1088) return c.fail(E.INVALID_PARAMETER); tlsSet(c, c.thread, i, c.arg(1)); return 1; }];
  function tlsExpansion(c, t) {
    let p = mem.read32(t.teb + 0xf94);
    if (!p) { p = c.proc.processHeap.alloc(1024 * 4, true); mem.write32(t.teb + 0xf94, p); }
    return p;
  }
  function tlsGet(c, t, i) { return i < 64 ? mem.read32(t.teb + TEB_TLS_SLOTS + 4 * i) : mem.read32(tlsExpansion(c, t) + 4 * (i - 64)); }
  function tlsSet(c, t, i, v) { if (i < 64) mem.write32(t.teb + TEB_TLS_SLOTS + 4 * i, v); else mem.write32(tlsExpansion(c, t) + 4 * (i - 64), v); }

  // Critical sections (guest-memory layout: +4 LockCount, +8 RecursionCount, +12 OwningThread)
  K.InitializeCriticalSection = [1, (c) => { const p = c.arg(0); mem.write32(p, 0); mem.write32(p + 4, 0xffffffff); mem.write32(p + 8, 0); mem.write32(p + 12, 0); mem.write32(p + 16, 0); mem.write32(p + 20, 0); }];
  K.InitializeCriticalSectionAndSpinCount = [2, (c) => { K.InitializeCriticalSection[1](c); mem.write32(c.arg(0) + 20, c.arg(1)); return 1; }];
  K.SetCriticalSectionSpinCount = [2, (c) => { const p = c.arg(0); const o = mem.read32(p + 20); mem.write32(p + 20, c.arg(1)); return o; }];
  K.DeleteCriticalSection = [1, (c) => { const p = c.arg(0); mem.write32(p + 4, 0xffffffff); mem.write32(p + 8, 0); mem.write32(p + 12, 0); }];
  K.EnterCriticalSection = [1, (c) => {
    const p = c.arg(0), tid = c.thread.id;
    if (mem.read32(p + 12) === tid) { mem.write32(p + 8, mem.read32(p + 8) + 1); mem.write32(p + 4, mem.read32(p + 4) + 1); return; }
    if (mem.readS32(p + 4) !== -1) vm.sched.block(c.thread, () => mem.readS32(p + 4) === -1, INFINITE, 'critsec');
    mem.write32(p + 4, 0); mem.write32(p + 8, 1); mem.write32(p + 12, tid);
  }];
  K.TryEnterCriticalSection = [1, (c) => {
    const p = c.arg(0), tid = c.thread.id;
    if (mem.read32(p + 12) === tid) { mem.write32(p + 8, mem.read32(p + 8) + 1); mem.write32(p + 4, mem.read32(p + 4) + 1); return 1; }
    if (mem.readS32(p + 4) !== -1) return 0;
    mem.write32(p + 4, 0); mem.write32(p + 8, 1); mem.write32(p + 12, tid);
    return 1;
  }];
  K.LeaveCriticalSection = [1, (c) => {
    const p = c.arg(0);
    const rec = mem.read32(p + 8) - 1;
    mem.write32(p + 8, rec);
    mem.write32(p + 4, mem.read32(p + 4) - 1);
    if (rec <= 0) { mem.write32(p + 12, 0); mem.write32(p + 4, 0xffffffff); mem.write32(p + 8, 0); }
  }];

  // Interlocked (single JS thread: plain memory ops)
  K.InterlockedIncrement = [1, (c) => { const p = c.arg(0); const v = (mem.read32(p) + 1) >>> 0; mem.write32(p, v); return v; }];
  K.InterlockedDecrement = [1, (c) => { const p = c.arg(0); const v = (mem.read32(p) - 1) >>> 0; mem.write32(p, v); return v; }];
  K.InterlockedExchange = [2, (c) => { const p = c.arg(0); const o = mem.read32(p); mem.write32(p, c.arg(1)); return o; }];
  K.InterlockedExchangeAdd = [2, (c) => { const p = c.arg(0); const o = mem.read32(p); mem.write32(p, (o + c.arg(1)) >>> 0); return o; }];
  K.InterlockedCompareExchange = [3, (c) => { const p = c.arg(0); const o = mem.read32(p); if (o === c.arg(2)) mem.write32(p, c.arg(1)); return o; }];
  K.InterlockedExchangePointer = K.InterlockedExchange;
  K.InterlockedCompareExchangePointer = K.InterlockedCompareExchange;

  // ---------------------------------------------------------------- synchronization objects
  K.CreateEventA = [4, (c) => createNamed(c, c.str(3), () => ({ type: 'event', manual: c.arg(1) !== 0, signaled: c.arg(2) !== 0 }))];
  K.CreateEventW = [4, (c) => createNamed(c, c.wstr(3), () => ({ type: 'event', manual: c.arg(1) !== 0, signaled: c.arg(2) !== 0 }))];
  K.OpenEventA = [3, (c) => { const o = named.get(c.str(2)); if (!o || o.type !== 'event') return c.fail(E.FILE_NOT_FOUND); o.refs++; return c.proc.handles.create(o); }];
  K.SetEvent = [1, (c) => { const o = c.proc.handles.getAs(c.arg(0), 'event'); if (!o) return c.fail(E.INVALID_HANDLE); o.signaled = true; return 1; }];
  K.ResetEvent = [1, (c) => { const o = c.proc.handles.getAs(c.arg(0), 'event'); if (!o) return c.fail(E.INVALID_HANDLE); o.signaled = false; return 1; }];
  K.PulseEvent = [1, (c) => { const o = c.proc.handles.getAs(c.arg(0), 'event'); if (!o) return c.fail(E.INVALID_HANDLE); o.signaled = true; vm.sched.yieldFrom(c.thread); o.signaled = false; return 1; }];
  K.CreateMutexA = [3, (c) => createNamed(c, c.str(2), () => ({ type: 'mutex', owner: c.arg(1) ? c.thread.id : 0, count: c.arg(1) ? 1 : 0, abandoned: false }))];
  K.CreateMutexW = [3, (c) => createNamed(c, c.wstr(2), () => ({ type: 'mutex', owner: c.arg(1) ? c.thread.id : 0, count: c.arg(1) ? 1 : 0, abandoned: false }))];
  K.OpenMutexA = [3, (c) => { const o = named.get(c.str(2)); if (!o || o.type !== 'mutex') return c.fail(E.FILE_NOT_FOUND); o.refs++; return c.proc.handles.create(o); }];
  K.ReleaseMutex = [1, (c) => { const o = c.proc.handles.getAs(c.arg(0), 'mutex'); if (!o) return c.fail(E.INVALID_HANDLE); if (o.owner !== c.thread.id) return c.fail(288); if (--o.count === 0) o.owner = 0; return 1; }];
  K.CreateSemaphoreA = [4, (c) => createNamed(c, c.str(3), () => ({ type: 'semaphore', count: c.sarg(1), max: c.sarg(2) }))];
  K.CreateSemaphoreW = [4, (c) => createNamed(c, c.wstr(3), () => ({ type: 'semaphore', count: c.sarg(1), max: c.sarg(2) }))];
  K.ReleaseSemaphore = [3, (c) => { const o = c.proc.handles.getAs(c.arg(0), 'semaphore'); if (!o) return c.fail(E.INVALID_HANDLE); c.out32(2, o.count); if (o.count + c.sarg(1) > o.max) return c.fail(298); o.count += c.sarg(1); return 1; }];
  K.CreateWaitableTimerA = [3, (c) => createNamed(c, c.str(2), () => ({ type: 'timer', manual: c.arg(1) !== 0, signaled: false, due: Infinity, period: 0 }))];
  K.SetWaitableTimer = [6, (c) => {
    const o = c.proc.handles.getAs(c.arg(0), 'timer'); if (!o) return c.fail(E.INVALID_HANDLE);
    const due = mem.dv.getBigInt64(c.arg(1), true); const now = vm.clock.now();
    o.due = due < 0n ? now + Number(-due) / 10000 : filetimeToMs(due) - vm.clock.wall() + now;
    o.period = c.sarg(2); o.signaled = false;
    c.proc.timers.push({ due: o.due, timer: o, kind: 'waitable' });
    return 1;
  }];
  K.CancelWaitableTimer = [1, (c) => { const o = c.proc.handles.getAs(c.arg(0), 'timer'); if (!o) return c.fail(E.INVALID_HANDLE); o.due = Infinity; c.proc.timers = c.proc.timers.filter((t) => t.timer !== o); return 1; }];

  const waitOne = (c, h, ms, alertable) => {
    const o = waitObject(c, h);
    if (!o) { c.setLastError(E.INVALID_HANDLE); return WAIT_FAILED; }
    if (o === c.thread) { c.setLastError(E.INVALID_HANDLE); return WAIT_FAILED; }
    const to = ms === INFINITE ? INFINITE : ms;
    const ok = isSignaled(o, c.thread) || vm.sched.block(c.thread, () => isSignaled(o, c.thread) || (alertable && c.thread.apcQueue.length > 0), to, 'wait:' + o.type);
    if (alertable && c.thread.apcQueue.length) { runApcs(c); if (!isSignaled(o, c.thread)) return 0xc0; }
    if (!ok) return WAIT_TIMEOUT;
    return consumeSignal(o, c.thread);
  };
  const runApcs = (c) => { while (c.thread.apcQueue.length) { const a = c.thread.apcQueue.shift(); vm.callGuest(c.thread, a.fn, [a.arg]); } };
  K.WaitForSingleObject = [2, (c) => waitOne(c, c.arg(0), c.arg(1), false)];
  K.WaitForSingleObjectEx = [3, (c) => waitOne(c, c.arg(0), c.arg(1), c.arg(2) !== 0)];
  const waitMany = (c, n, ph, all, ms, alertable) => {
    const objs = [];
    for (let i = 0; i < n; i++) { const o = waitObject(c, mem.read32(ph + 4 * i)); if (!o) { c.setLastError(E.INVALID_HANDLE); return WAIT_FAILED; } objs.push(o); }
    const t = c.thread;
    const ready = () => (all ? objs.every((o) => isSignaled(o, t)) : objs.findIndex((o) => isSignaled(o, t)) >= 0);
    const ok = ready() || vm.sched.block(t, () => ready() || (alertable && t.apcQueue.length > 0), ms === INFINITE ? INFINITE : ms, 'waitmany');
    if (alertable && t.apcQueue.length) { runApcs(c); if (!ready()) return 0xc0; }
    if (!ok) return WAIT_TIMEOUT;
    if (all) { let r = WAIT_OBJECT_0; for (const o of objs) { const rr = consumeSignal(o, t); if (rr === WAIT_ABANDONED) r = WAIT_ABANDONED; } return r; }
    const i = objs.findIndex((o) => isSignaled(o, t));
    return consumeSignal(objs[i], t) + i;
  };
  K.WaitForMultipleObjects = [4, (c) => waitMany(c, c.arg(0), c.arg(1), c.arg(2) !== 0, c.arg(3), false)];
  K.WaitForMultipleObjectsEx = [5, (c) => waitMany(c, c.arg(0), c.arg(1), c.arg(2) !== 0, c.arg(3), c.arg(4) !== 0)];
  K.SignalObjectAndWait = [4, (c) => {
    const s = waitObject(c, c.arg(0));
    if (s?.type === 'event') s.signaled = true; else if (s?.type === 'mutex') { if (--s.count === 0) s.owner = 0; } else if (s?.type === 'semaphore') s.count++;
    return waitOne(c, c.arg(1), c.arg(2), c.arg(3) !== 0);
  }];

  // ---------------------------------------------------------------- memory
  K.VirtualAlloc = [4, (c) => {
    const addr = c.arg(0), size = c.arg(1), type = c.arg(2), prot = c.arg(3);
    const vmem = c.proc.vmem;
    if (size === 0) return c.fail(E.INVALID_PARAMETER);
    if (type & MEM_RESERVE || (type & MEM_COMMIT && (!addr || vmem.query(addr).state === 0x10000))) {
      const base = vmem.reserve(size, addr, 'valloc', { topDown: (type & MEM_TOP_DOWN) !== 0 });
      if (!base) return c.fail(E.NOT_ENOUGH_MEMORY);
      if (type & MEM_COMMIT) { vmem.commit(base, base === (addr & ~0xffff) && addr ? addr + size - base : size, prot); mem.fill(base, alignPage(size), 0); }
      return base;
    }
    if (type & MEM_COMMIT) {
      const b = vmem.commit(addr, size, prot);
      if (!b) return c.fail(E.INVALID_ADDRESS);
      return b;
    }
    return c.fail(E.INVALID_PARAMETER);
  }];
  K.VirtualFree = [3, (c) => {
    const addr = c.arg(0), size = c.arg(1), type = c.arg(2);
    const vmem = c.proc.vmem;
    if (type & MEM_RELEASE) { const q = vmem.query(addr); if (!vmem.release(addr)) return c.fail(E.INVALID_ADDRESS); vm.invalidateCode(addr, q.size || 0x1000); return 1; }
    if (type & MEM_DECOMMIT) { vmem.decommit(addr, size); vm.invalidateCode(addr, size || 0x1000); return 1; }
    return c.fail(E.INVALID_PARAMETER);
  }];
  K.VirtualProtect = [4, (c) => { const o = c.proc.vmem.protect(c.arg(0), c.arg(1), c.arg(2)); if (o < 0) return c.fail(E.INVALID_ADDRESS); c.out32(3, o); if (c.arg(2) & 0xf0) vm.invalidateCode(c.arg(0), c.arg(1)); return 1; }];
  K.VirtualQuery = [3, (c) => {
    const q = c.proc.vmem.query(c.arg(0)); const p = c.arg(1);
    mem.write32(p, q.base); mem.write32(p + 4, q.allocBase); mem.write32(p + 8, q.allocProtect ?? 0); mem.write32(p + 12, q.size);
    mem.write32(p + 16, q.state); mem.write32(p + 20, q.protect); mem.write32(p + 24, q.type);
    return 28;
  }];
  K.VirtualLock = [2, () => 1];
  K.VirtualUnlock = [2, () => 1];
  K.FlushInstructionCache = [3, (c) => { vm.invalidateCode(c.arg(1), c.arg(2) || 0x1000); return 1; }];
  K.ReadProcessMemory = [5, (c) => { mem.copy(c.arg(2), c.arg(1), c.arg(3)); c.out32(4, c.arg(3)); return 1; }];
  K.WriteProcessMemory = [5, (c) => { mem.copy(c.arg(1), c.arg(2), c.arg(3)); c.out32(4, c.arg(3)); return 1; }];
  K.GlobalMemoryStatus = [1, (c) => {
    const p = c.arg(0);
    mem.write32(p, 32); mem.write32(p + 4, 30); mem.write32(p + 8, 0x7fff0000); mem.write32(p + 12, 0x60000000);
    mem.write32(p + 16, 0xffffffff); mem.write32(p + 20, 0xc0000000); mem.write32(p + 24, 0x7ffe0000); mem.write32(p + 28, 0x70000000);
  }];
  K.GlobalMemoryStatusEx = [1, (c) => {
    const p = c.arg(0);
    mem.write32(p + 4, 30);
    mem.write64(p + 8, 0x7fff0000n); mem.write64(p + 16, 0x60000000n); mem.write64(p + 24, 0xffffffffn); mem.write64(p + 32, 0xc0000000n);
    mem.write64(p + 40, 0x7ffe0000n); mem.write64(p + 48, 0x70000000n); mem.write64(p + 56, 0n);
    return 1;
  }];

  // Heaps
  const heapOf = (c, h) => c.proc.handles.getAs(h, 'heap');
  K.HeapCreate = [3, (c) => c.proc.createHeap({ initial: c.arg(1), max: c.arg(2), tag: 'user' }).handle];
  K.HeapDestroy = [1, (c) => { const h = heapOf(c, c.arg(0)); if (!h || h === c.proc.processHeap) return c.fail(E.INVALID_HANDLE); h.destroy(); c.proc.heaps = c.proc.heaps.filter((x) => x !== h); c.proc.handles.map.delete(c.arg(0)); return 1; }];
  K.HeapAlloc = [3, (c) => { const h = heapOf(c, c.arg(0)); if (!h) return c.fail(E.INVALID_HANDLE); const p = h.alloc(c.arg(2), (c.arg(1) & 8) !== 0); if (!p) c.setLastError(E.NOT_ENOUGH_MEMORY); return p; }];
  K.HeapFree = [3, (c) => { const h = heapOf(c, c.arg(0)); if (!h) return c.fail(E.INVALID_HANDLE); if (!c.arg(2)) return 1; if (!h.free_(c.arg(2))) { vm.warn(`HeapFree: bad pointer ${c.arg(2).toString(16)} from ${c.proc.symbolize(c.retAddr)}`); return c.fail(E.INVALID_PARAMETER); } return 1; }];
  K.HeapReAlloc = [4, (c) => { const h = heapOf(c, c.arg(0)); if (!h) return c.fail(E.INVALID_HANDLE); const p = h.realloc(c.arg(2), c.arg(3), (c.arg(1) & 8) !== 0, (c.arg(1) & 0x10) !== 0); if (!p) c.setLastError(E.NOT_ENOUGH_MEMORY); return p; }];
  K.HeapSize = [3, (c) => { const h = heapOf(c, c.arg(0)); if (!h) return 0xffffffff; const s = h.size(c.arg(2)); return s < 0 ? 0xffffffff : s; }];
  K.HeapValidate = [3, (c) => { const h = heapOf(c, c.arg(0)); return h && h.validate(c.arg(2)) ? 1 : 0; }];
  K.HeapCompact = [2, () => 0x10000];
  K.HeapLock = [1, () => 1];
  K.HeapUnlock = [1, () => 1];
  K.HeapWalk = [2, (c) => c.fail(E.NO_MORE_ITEMS)];
  K.HeapSetInformation = [4, () => 1];
  K.HeapQueryInformation = [5, () => 0];

  // Global/Local (fixed-pointer semantics on the process heap)
  const galloc = (c, flags, size) => { const p = c.proc.processHeap.alloc(size, (flags & 0x40) !== 0); if (!p) c.setLastError(E.NOT_ENOUGH_MEMORY); return p; };
  K.GlobalAlloc = [2, (c) => galloc(c, c.arg(0), c.arg(1))];
  K.LocalAlloc = [2, (c) => galloc(c, c.arg(0), c.arg(1))];
  K.GlobalFree = [1, (c) => (c.arg(0) === 0 || c.proc.processHeap.free_(c.arg(0)) ? 0 : c.arg(0))];
  K.LocalFree = K.GlobalFree;
  K.GlobalLock = [1, (c) => c.arg(0)];
  K.LocalLock = K.GlobalLock;
  K.GlobalUnlock = [1, () => 1];
  K.LocalUnlock = K.GlobalUnlock;
  K.GlobalHandle = [1, (c) => c.arg(0)];
  K.LocalHandle = K.GlobalHandle;
  K.GlobalSize = [1, (c) => Math.max(c.proc.processHeap.size(c.arg(0)), 0)];
  K.LocalSize = K.GlobalSize;
  K.GlobalFlags = [1, () => 0];
  K.LocalFlags = K.GlobalFlags;
  K.GlobalReAlloc = [3, (c) => c.proc.processHeap.realloc(c.arg(0), c.arg(1), (c.arg(2) & 0x40) !== 0)];
  K.LocalReAlloc = K.GlobalReAlloc;
  K.GlobalCompact = [1, () => 0x100000];

  // ---------------------------------------------------------------- modules
  const modHandle = (m) => (m.builtin ? m.base || api.dll(m.name).base : m.base);
  K.GetModuleHandleA = [1, (c) => { const n = c.str(0); if (!n) return c.proc.exe.base; const m = c.proc.modules.get(ApiRegistry.norm(n)); return m ? modHandle(m) : c.fail(E.MOD_NOT_FOUND); }];
  K.GetModuleHandleW = [1, (c) => { const n = c.wstr(0); if (!n) return c.proc.exe.base; const m = c.proc.modules.get(ApiRegistry.norm(n)); return m ? modHandle(m) : c.fail(E.MOD_NOT_FOUND); }];
  K.GetModuleHandleExA = [3, (c) => {
    let m;
    if (c.arg(0) & 4) m = c.proc.moduleByAddr(c.arg(1));
    else { const n = c.str(1); m = n ? c.proc.modules.get(ApiRegistry.norm(n)) : c.proc.exe; }
    if (!m) return c.fail(E.MOD_NOT_FOUND);
    c.out32(2, modHandle(m)); return 1;
  }];
  K.GetModuleHandleExW = [3, (c) => {
    let m;
    if (c.arg(0) & 4) m = c.proc.moduleByAddr(c.arg(1));
    else { const n = c.wstr(1); m = n ? c.proc.modules.get(ApiRegistry.norm(n)) : c.proc.exe; }
    if (!m) return c.fail(E.MOD_NOT_FOUND);
    c.out32(2, modHandle(m)); return 1;
  }];
  const loadLib = (c, name) => {
    if (!name) return c.fail(E.INVALID_PARAMETER);
    const before = c.proc.moduleList.length;
    const m = c.proc.loadModule(name);
    if (!m) { vm.warn(`LoadLibrary(${name}) failed`); return c.fail(E.MOD_NOT_FOUND); }
    // attach newly loaded native modules (dependencies first)
    for (let i = before; i < c.proc.moduleList.length; i++) { const nm = c.proc.moduleList[i]; if (!nm.attached) vm.attachModule(c.thread, nm); }
    return modHandle(m);
  };
  K.LoadLibraryA = [1, (c) => loadLib(c, c.str(0))];
  K.LoadLibraryW = [1, (c) => loadLib(c, c.wstr(0))];
  K.LoadLibraryExA = [3, (c) => loadLib(c, c.str(0))];
  K.LoadLibraryExW = [3, (c) => loadLib(c, c.wstr(0))];
  K.FreeLibrary = [1, (c) => 1];
  K.FreeLibraryAndExitThread = [2, (c) => vm.exitThread(c.thread, c.arg(1)), { noreturn: true }];
  K.DisableThreadLibraryCalls = [1, () => 1];
  K.GetProcAddress = [2, (c) => {
    const m = c.proc.moduleByHandle(c.arg(0));
    if (!m) return c.fail(E.MOD_NOT_FOUND);
    const a = c.arg(1);
    const byOrd = a < 0x10000;
    const name = byOrd ? null : mem.readCString(a);
    if (m.builtin) {
      if (byOrd) { const d = api.dlls.get(m.name); const n = d?.ordinals.get(a); if (!n) { vm.warn(`GetProcAddress(${m.name}, #${a}) unknown`); return c.fail(E.PROC_NOT_FOUND); } return api.thunkFor(m.name, n); }
      if (!api.lookup(m.name, name)) { vm.warn(`GetProcAddress(${m.name}, ${name}) -> NULL (not implemented)`); return c.fail(E.PROC_NOT_FOUND); }
      return api.thunkFor(m.name, name);
    }
    const addr = c.proc.resolveExport(m, name, byOrd ? a : null, c.proc.exe);
    return addr || c.fail(E.PROC_NOT_FOUND);
  }];
  const modFileName = (c, wide) => {
    const m = c.proc.moduleByHandle(c.arg(0));
    if (!m) return c.fail(E.MOD_NOT_FOUND);
    const s = c.proc.moduleFileName(m);
    const buf = c.arg(1), size = c.arg(2);
    if (!size) return 0;
    const n = Math.min(s.length, size - 1);
    if (wide) mem.writeWString(buf, s.slice(0, n), size); else mem.writeCString(buf, s.slice(0, n), size);
    if (n < s.length) c.setLastError(E.INSUFFICIENT_BUFFER); else c.setLastError(0);
    return n;
  };
  K.GetModuleFileNameA = [3, (c) => modFileName(c, false)];
  K.GetModuleFileNameW = [3, (c) => modFileName(c, true)];

  // Resources
  const findRes = (c, type, name, lang) => {
    const m = c.proc.moduleByHandle(c.arg(0));
    if (!m || m.builtin) return c.fail(E.RESOURCE_TYPE_NOT_FOUND);
    const r = findResource(m, mem, type, name, lang);
    if (!r) return c.fail(E.RESOURCE_NAME_NOT_FOUND);
    return c.proc.handles.create({ type: 'resource', addr: r.addr, size: r.size });
  };
  const resId = (v, wide) => (v < 0x10000 ? v : wide ? mem.readWString(v) : mem.readCString(v));
  K.FindResourceA = [3, (c) => findRes(c, resId(c.arg(2), false), resId(c.arg(1), false), -1)];
  K.FindResourceW = [3, (c) => findRes(c, resId(c.arg(2), true), resId(c.arg(1), true), -1)];
  K.FindResourceExA = [4, (c) => findRes(c, resId(c.arg(1), false), resId(c.arg(2), false), -1)];
  K.FindResourceExW = [4, (c) => findRes(c, resId(c.arg(1), true), resId(c.arg(2), true), -1)];
  K.LoadResource = [2, (c) => { const r = c.proc.handles.getAs(c.arg(1), 'resource'); return r ? c.arg(1) : c.fail(E.INVALID_HANDLE); }];
  K.LockResource = [1, (c) => { const r = c.proc.handles.getAs(c.arg(0), 'resource'); return r ? r.addr : 0; }];
  K.SizeofResource = [2, (c) => { const r = c.proc.handles.getAs(c.arg(1), 'resource'); return r ? r.size : 0; }];
  K.FreeResource = [1, () => 0];

  // ---------------------------------------------------------------- time
  const TICK_BASE = 0x1000000; // fake uptime so GetTickCount does not start at 0
  K.GetTickCount = [0, () => (TICK_BASE + Math.floor(vm.clock.now())) >>> 0];
  K.GetTickCount64 = [0, (c) => { const t = BigInt(TICK_BASE + Math.floor(vm.clock.now())); c.cpu.edx = Number(t >> 32n); return Number(t & 0xffffffffn); }];
  K.QueryPerformanceFrequency = [1, (c) => { c.out64(0, 10000000n); return 1; }];
  K.QueryPerformanceCounter = [1, (c) => { c.out64(0, BigInt(Math.floor(vm.clock.now() * 10000))); return 1; }];
  K.GetSystemTimeAsFileTime = [1, (c) => { c.out64(0, msToFiletime(vm.clock.wall())); }];
  K.GetSystemTime = [1, (c) => writeSystemTime(mem, c.arg(0), vm.clock.wall())];
  K.GetLocalTime = [1, (c) => writeSystemTime(mem, c.arg(0), vm.clock.wall())];
  K.SetLocalTime = [1, () => 1];
  K.SystemTimeToFileTime = [2, (c) => { c.out64(1, msToFiletime(readSystemTime(mem, c.arg(0)))); return 1; }];
  K.FileTimeToSystemTime = [2, (c) => { writeSystemTime(mem, c.arg(1), filetimeToMs(mem.read64(c.arg(0)))); return 1; }];
  K.FileTimeToLocalFileTime = [2, (c) => { c.out64(1, mem.read64(c.arg(0))); return 1; }];
  K.LocalFileTimeToFileTime = [2, (c) => { c.out64(1, mem.read64(c.arg(0))); return 1; }];
  K.SystemTimeToTzSpecificLocalTime = [3, (c) => { mem.copy(c.arg(2), c.arg(1), 16); return 1; }];
  K.CompareFileTime = [2, (c) => { const a = mem.read64(c.arg(0)), b = mem.read64(c.arg(1)); return a < b ? 0xffffffff : a > b ? 1 : 0; }];
  K.FileTimeToDosDateTime = [3, (c) => {
    const d = new Date(filetimeToMs(mem.read64(c.arg(0))));
    c.out16(1, ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate());
    c.out16(2, (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1));
    return 1;
  }];
  K.DosDateTimeToFileTime = [3, (c) => {
    const dd = c.arg(0) & 0xffff, tt = c.arg(1) & 0xffff;
    const ms = Date.UTC(1980 + (dd >> 9), ((dd >> 5) & 15) - 1, dd & 31, tt >> 11, (tt >> 5) & 63, (tt & 31) * 2);
    c.out64(2, msToFiletime(ms)); return 1;
  }];
  K.GetTimeZoneInformation = [1, (c) => { const p = c.arg(0); mem.fill(p, 172, 0); mem.writeWString(p + 4, 'Coordinated Universal Time', 32); mem.writeWString(p + 88, 'Coordinated Universal Time', 32); return 0; }];
  K.GetSystemTimes = [3, (c) => { c.out64(0, 0n); c.out64(1, 0n); c.out64(2, BigInt(Math.floor(vm.clock.now() * 10000))); return 1; }];

  // ---------------------------------------------------------------- toolhelp32 snapshots
  K.CreateToolhelp32Snapshot = [2, (c) => {
    const flags = c.arg(0);
    const snap = { type: 'snapshot', modules: [], i: 0, pi: 0, ti: 0 };
    if (flags & 0x18) snap.modules = c.proc.moduleList.slice();
    return c.proc.handles.create(snap);
  }];
  const modEntry = (c, p, m, wide) => {
    mem.write32(p, wide ? 1064 : 548); mem.write32(p + 4, 1); mem.write32(p + 8, c.proc.pid); mem.write32(p + 12, 1); mem.write32(p + 16, 1);
    mem.write32(p + 20, m.base); mem.write32(p + 24, m.size); mem.write32(p + 28, m.base);
    if (wide) { mem.writeWString(p + 32, m.name, 256); mem.writeWString(p + 544, c.proc.moduleFileName(m), 260); } else { mem.writeCString(p + 32, m.name, 256); mem.writeCString(p + 288, c.proc.moduleFileName(m), 260); }
  };
  K.Module32First = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s || !s.modules.length) return c.fail(E.NO_MORE_FILES); s.i = 1; modEntry(c, c.arg(1), s.modules[0], false); return 1; }];
  K.Module32Next = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s || s.i >= s.modules.length) return c.fail(E.NO_MORE_FILES); modEntry(c, c.arg(1), s.modules[s.i++], false); return 1; }];
  K.Module32FirstW = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s || !s.modules.length) return c.fail(E.NO_MORE_FILES); s.i = 1; modEntry(c, c.arg(1), s.modules[0], true); return 1; }];
  K.Module32NextW = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s || s.i >= s.modules.length) return c.fail(E.NO_MORE_FILES); modEntry(c, c.arg(1), s.modules[s.i++], true); return 1; }];
  const procEntry = (c, p) => { mem.write32(p, 296); mem.write32(p + 4, 1); mem.write32(p + 8, c.proc.pid); mem.write32(p + 12, 0); mem.write32(p + 16, 0); mem.write32(p + 20, c.proc.threads.length); mem.write32(p + 24, 4); mem.write32(p + 28, 8); mem.write32(p + 32, 0); mem.writeCString(p + 36, c.proc.exe.name, 260); };
  K.Process32First = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s) return c.fail(E.INVALID_HANDLE); s.pi = 1; procEntry(c, c.arg(1)); return 1; }];
  K.Process32Next = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s || s.pi >= 1) return c.fail(E.NO_MORE_FILES); s.pi = 1; procEntry(c, c.arg(1)); return 1; }];
  const threadEntry = (c, p, t) => { mem.write32(p, 28); mem.write32(p + 4, 1); mem.write32(p + 8, t.id); mem.write32(p + 12, c.proc.pid); mem.write32(p + 16, t.priority + 8); mem.write32(p + 20, 0); mem.write32(p + 24, 0); };
  K.Thread32First = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s) return c.fail(E.INVALID_HANDLE); s.ti = 1; threadEntry(c, c.arg(1), c.proc.threads[0]); return 1; }];
  K.Thread32Next = [2, (c) => { const s = c.proc.handles.getAs(c.arg(0), 'snapshot'); if (!s || s.ti >= c.proc.threads.length) return c.fail(E.NO_MORE_FILES); threadEntry(c, c.arg(1), c.proc.threads[s.ti++]); return 1; }];
  K.Heap32ListFirst = [2, (c) => c.fail(E.NO_MORE_FILES)];
  K.Heap32ListNext = [2, (c) => c.fail(E.NO_MORE_FILES)];
  K.Toolhelp32ReadProcessMemory = [5, (c) => { mem.copy(c.arg(2), c.arg(1), c.arg(3)); c.out32(4, c.arg(3)); return 1; }];

  // Fiber-local storage (Vista+; the CRT probes for it): implemented on top of TLS slots
  K.FlsAlloc = [1, (c) => K.TlsAlloc[1](c)];
  K.FlsFree = [1, (c) => K.TlsFree[1](c)];
  K.FlsGetValue = [1, (c) => K.TlsGetValue[1](c)];
  K.FlsSetValue = [2, (c) => K.TlsSetValue[1](c)];

  // Undecorated aliases, W variants, comm/console stubs
  K.lstrcpy = [2, (c) => { mem.writeCString(c.arg(0), mem.readCString(c.arg(1))); return c.arg(0); }];
  K.lstrcpyn = [3, (c) => { mem.writeCString(c.arg(0), mem.readCString(c.arg(1)), c.arg(2)); return c.arg(0); }];
  K.lstrcat = [2, (c) => { const d = mem.readCString(c.arg(0)); mem.writeCString(c.arg(0), d + mem.readCString(c.arg(1))); return c.arg(0); }];
  K.lstrcmp = [2, (c) => { const a = mem.readCString(c.arg(0)), b = mem.readCString(c.arg(1)); return (a < b ? -1 : a > b ? 1 : 0) >>> 0; }];
  K.lstrcmpi = [2, (c) => { const a = mem.readCString(c.arg(0)).toLowerCase(), b = mem.readCString(c.arg(1)).toLowerCase(); return (a < b ? -1 : a > b ? 1 : 0) >>> 0; }];
  K.lstrlen = [1, (c) => (c.arg(0) ? mem.readCString(c.arg(0)).length : 0)];
  K.GetDateFormatW = [6, (c) => { const d = new Date(vm.clock.wall()); const s = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; if (c.arg(5) === 0) return s.length + 1; mem.writeWString(c.arg(4), s, c.arg(5)); return s.length + 1; }];
  K.GetTimeFormatW = [6, (c) => { const d = new Date(vm.clock.wall()); const s = `${d.getUTCHours() % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`; if (c.arg(5) === 0) return s.length + 1; mem.writeWString(c.arg(4), s, c.arg(5)); return s.length + 1; }];
  K.GetStringTypeExW = [5, (c) => { const s = c.sarg(3) < 0 ? mem.readWString(c.arg(2)) : mem.readWString(c.arg(2), c.arg(3)); for (let i = 0; i < s.length; i++) mem.write16(c.arg(4) + 2 * i, 0); return 1; }];
  for (const n of ['SetCommState', 'GetCommState', 'SetupComm', 'PurgeComm', 'SetCommTimeouts', 'GetCommTimeouts', 'SetCommMask', 'GetCommMask', 'WaitCommEvent', 'GetCommConfig', 'SetCommConfig', 'ClearCommError', 'EscapeCommFunction', 'TransmitCommChar', 'GetCommModemStatus', 'SetNamedPipeHandleState', 'ReadConsoleInputA', 'PeekConsoleInputA', 'SetConsoleCursorInfo', 'GetConsoleCursorInfo', 'SetConsoleScreenBufferSize', 'SetConsoleWindowInfo', 'WriteConsoleOutputA', 'ReadConsoleOutputA', 'FillConsoleOutputCharacterA', 'FillConsoleOutputAttribute', 'SetConsoleCursorPosition', 'WriteConsoleOutputCharacterA', 'ScrollConsoleScreenBufferA']) K[n] = [api.signatures.get(n), (c) => c.fail(E.INVALID_HANDLE)];
  K.GetNumberOfConsoleInputEvents = [2, (c) => { c.out32(1, 0); return 1; }];
  K.GetLargestConsoleWindowSize = [1, () => (25 << 16) | 80];
  K.CreateProcessA = [10, (c) => { vm.warn(`CreateProcess(${c.str(0) ?? c.str(1)}) refused`); return c.fail(E.ACCESS_DENIED); }];
  K.CreateProcessW = [10, (c) => { vm.warn(`CreateProcess(${c.wstr(0) ?? c.wstr(1)}) refused`); return c.fail(E.ACCESS_DENIED); }];
  K.WinExec = [2, (c) => { vm.warn(`WinExec(${c.str(0)}) refused`); return 2; }];
  K.GetLogicalProcessorInformation = [2, (c) => c.fail(E.INSUFFICIENT_BUFFER)];
  K.GetSystemDefaultLangID2 = K.GetVersion;

  api.define('kernel32.dll', K);
  registerKernel32File(api, vm);
}

function alignPage(v) { return (v + 0xfff) & ~0xfff; }

/** Allocate a persistent ANSI string in the process heap; returns its address. */
export function allocString(ctx, s) {
  const p = ctx.proc.processHeap.alloc(s.length + 1);
  ctx.mem.writeCString(p, s);
  return p;
}
export function allocWString(ctx, s) {
  const p = ctx.proc.processHeap.alloc(2 * (s.length + 1));
  ctx.mem.writeWString(p, s);
  return p;
}
