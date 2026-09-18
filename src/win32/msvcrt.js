// msvcrt.dll (system C runtime) — used by system-linked DLLs such as dbghelp. All cdecl.
// Games usually ship their own CRT (msvcr71.dll...) which runs natively; this covers the rest.
import { CC_CDECL } from './api.js';
import { formatPrintf } from './wsprintf.js';
import { decodeBytes } from './strings.js';

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerMsvcrt(api, vm) {
  const mem = vm.mem;
  const M = {};
  const heap = (c) => c.proc.crtHeap ?? (c.proc.crtHeap = c.proc.createHeap({ tag: 'msvcrt' }));
  const cstr = (a) => (a ? mem.readCString(a) : '');
  const errnoAddr = (c) => c.proc.crtErrno ?? (c.proc.crtErrno = c.proc.processHeap.alloc(64, true));

  // ---- memory
  M.malloc = [1, (c) => heap(c).alloc(c.arg(0))];
  M.calloc = [2, (c) => heap(c).alloc(c.arg(0) * c.arg(1), true)];
  M.realloc = [2, (c) => (c.arg(0) ? heap(c).realloc(c.arg(0), c.arg(1)) : heap(c).alloc(c.arg(1)))];
  M.free = [1, (c) => { if (c.arg(0)) heap(c).free_(c.arg(0)); }];
  M._msize = [1, (c) => Math.max(heap(c).size(c.arg(0)), 0)];
  M['??2@YAPAXI@Z'] = M.malloc; // operator new
  M['??3@YAXPAX@Z'] = M.free; // operator delete
  M['??_U@YAPAXI@Z'] = M.malloc; M['??_V@YAXPAX@Z'] = M.free;
  M.memcpy = [3, (c) => { mem.copy(c.arg(0), c.arg(1), c.arg(2)); return c.arg(0); }];
  M.memmove = M.memcpy;
  M.memset = [3, (c) => { mem.fill(c.arg(0), c.arg(2), c.arg(1) & 0xff); return c.arg(0); }];
  M.memcmp = [3, (c) => { const a = mem.bytes(c.arg(0), c.arg(2)), b = mem.bytes(c.arg(1), c.arg(2)); for (let i = 0; i < c.arg(2); i++) if (a[i] !== b[i]) return a[i] < b[i] ? 0xffffffff : 1; return 0; }];
  M.memchr = [3, (c) => { const a = mem.bytes(c.arg(0), c.arg(2)); const i = a.indexOf(c.arg(1) & 0xff); return i < 0 ? 0 : c.arg(0) + i; }];

  // ---- strings
  M.strlen = [1, (c) => cstr(c.arg(0)).length];
  M.strcpy = [2, (c) => { mem.writeCString(c.arg(0), cstr(c.arg(1))); return c.arg(0); }];
  M.strncpy = [3, (c) => { const s = cstr(c.arg(1)); const n = c.arg(2); for (let i = 0; i < n; i++) mem.write8(c.arg(0) + i, i < s.length ? s.charCodeAt(i) : 0); return c.arg(0); }];
  M.strcat = [2, (c) => { const d = cstr(c.arg(0)); mem.writeCString(c.arg(0), d + cstr(c.arg(1))); return c.arg(0); }];
  M.strncat = [3, (c) => { const d = cstr(c.arg(0)); mem.writeCString(c.arg(0), d + cstr(c.arg(1)).slice(0, c.arg(2))); return c.arg(0); }];
  const cmp = (a, b) => (a < b ? 0xffffffff : a > b ? 1 : 0);
  M.strcmp = [2, (c) => cmp(cstr(c.arg(0)), cstr(c.arg(1)))];
  M.strncmp = [3, (c) => cmp(cstr(c.arg(0)).slice(0, c.arg(2)), cstr(c.arg(1)).slice(0, c.arg(2)))];
  M._stricmp = [2, (c) => cmp(cstr(c.arg(0)).toLowerCase(), cstr(c.arg(1)).toLowerCase())];
  M._strcmpi = M._stricmp; M.stricmp = M._stricmp;
  M._strnicmp = [3, (c) => cmp(cstr(c.arg(0)).slice(0, c.arg(2)).toLowerCase(), cstr(c.arg(1)).slice(0, c.arg(2)).toLowerCase())];
  M.strnicmp = M._strnicmp;
  M.strchr = [2, (c) => { const s = cstr(c.arg(0)); const ch = c.arg(1) & 0xff; if (ch === 0) return c.arg(0) + s.length; const i = s.indexOf(String.fromCharCode(ch)); return i < 0 ? 0 : c.arg(0) + i; }];
  M.strrchr = [2, (c) => { const s = cstr(c.arg(0)); const ch = c.arg(1) & 0xff; if (ch === 0) return c.arg(0) + s.length; const i = s.lastIndexOf(String.fromCharCode(ch)); return i < 0 ? 0 : c.arg(0) + i; }];
  M.strstr = [2, (c) => { const s = cstr(c.arg(0)); const i = s.indexOf(cstr(c.arg(1))); return i < 0 ? 0 : c.arg(0) + i; }];
  M.strpbrk = [2, (c) => { const s = cstr(c.arg(0)), set = cstr(c.arg(1)); for (let i = 0; i < s.length; i++) if (set.includes(s[i])) return c.arg(0) + i; return 0; }];
  M.strspn = [2, (c) => { const s = cstr(c.arg(0)), set = cstr(c.arg(1)); let i = 0; while (i < s.length && set.includes(s[i])) i++; return i; }];
  M.strcspn = [2, (c) => { const s = cstr(c.arg(0)), set = cstr(c.arg(1)); let i = 0; while (i < s.length && !set.includes(s[i])) i++; return i; }];
  M._strupr = [1, (c) => { mem.writeCString(c.arg(0), cstr(c.arg(0)).toUpperCase()); return c.arg(0); }];
  M._strlwr = [1, (c) => { mem.writeCString(c.arg(0), cstr(c.arg(0)).toLowerCase()); return c.arg(0); }];
  M._strdup = [1, (c) => { const s = cstr(c.arg(0)); const p = heap(c).alloc(s.length + 1); mem.writeCString(p, s); return p; }];
  M.strdup = M._strdup;
  M._strrev = [1, (c) => { mem.writeCString(c.arg(0), [...cstr(c.arg(0))].reverse().join('')); return c.arg(0); }];
  M.strtok = [2, (c) => {
    const p = c.proc; let s = c.arg(0) ? c.arg(0) : p.crtStrtok ?? 0;
    const delims = cstr(c.arg(1));
    while (s && delims.includes(String.fromCharCode(mem.read8(s))) && mem.read8(s)) s++;
    if (!s || !mem.read8(s)) { p.crtStrtok = 0; return 0; }
    const start = s;
    while (mem.read8(s) && !delims.includes(String.fromCharCode(mem.read8(s)))) s++;
    if (mem.read8(s)) { mem.write8(s, 0); p.crtStrtok = s + 1; } else p.crtStrtok = s;
    return start;
  }];
  M.atoi = [1, (c) => (parseInt(cstr(c.arg(0)), 10) | 0) >>> 0];
  M.atol = M.atoi;
  M.atof = [1, (c) => { c.retDouble(parseFloat(cstr(c.arg(0))) || 0); }];
  M.strtol = [3, (c) => { const s = cstr(c.arg(0)); const m = s.match(/^\s*[-+]?(0x[0-9a-f]+|\d+)/i); const v = m ? parseInt(m[0], c.arg(2) || (m[0].trim().toLowerCase().includes('0x') ? 16 : 10)) : 0; if (c.arg(1)) mem.write32(c.arg(1), c.arg(0) + (m ? m[0].length : 0)); return (v | 0) >>> 0; }];
  M.strtoul = [3, (c) => { const s = cstr(c.arg(0)); const m = s.match(/^\s*[-+]?(0x[0-9a-f]+|\d+)/i); const v = m ? parseInt(m[0], c.arg(2) || (m[0].trim().toLowerCase().includes('0x') ? 16 : 10)) : 0; if (c.arg(1)) mem.write32(c.arg(1), c.arg(0) + (m ? m[0].length : 0)); return v >>> 0; }];
  M.strtod = [2, (c) => { const s = cstr(c.arg(0)); const m = s.match(/^\s*[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)/); if (c.arg(1)) mem.write32(c.arg(1), c.arg(0) + (m ? m[0].length : 0)); c.retDouble(m ? parseFloat(m[0]) : 0); }];
  M.toupper = [1, (c) => String.fromCharCode(c.arg(0) & 0xff).toUpperCase().charCodeAt(0)];
  M.tolower = [1, (c) => String.fromCharCode(c.arg(0) & 0xff).toLowerCase().charCodeAt(0)];
  const ctype = (re) => [1, (c) => (re.test(String.fromCharCode(c.arg(0) & 0xff)) ? 1 : 0)];
  M.isalpha = ctype(/[A-Za-z]/); M.isdigit = ctype(/[0-9]/); M.isalnum = ctype(/[A-Za-z0-9]/); M.isspace = ctype(/[ \t\n\r\f\v]/);
  M.isupper = ctype(/[A-Z]/); M.islower = ctype(/[a-z]/); M.isxdigit = ctype(/[0-9A-Fa-f]/); M.ispunct = ctype(/[!-\/:-@\[-`{-~]/); M.isprint = ctype(/[ -~]/);
  M.wcslen = [1, (c) => mem.readWString(c.arg(0)).length];
  M.wcscpy = [2, (c) => { mem.writeWString(c.arg(0), mem.readWString(c.arg(1))); return c.arg(0); }];
  M.wcscmp = [2, (c) => cmp(mem.readWString(c.arg(0)), mem.readWString(c.arg(1)))];
  M.wcscat = [2, (c) => { mem.writeWString(c.arg(0), mem.readWString(c.arg(0)) + mem.readWString(c.arg(1))); return c.arg(0); }];
  M._wcsicmp = [2, (c) => cmp(mem.readWString(c.arg(0)).toLowerCase(), mem.readWString(c.arg(1)).toLowerCase())];
  M.mbstowcs = [3, (c) => { const s = cstr(c.arg(1)).slice(0, c.arg(2)); if (c.arg(0)) mem.writeWString(c.arg(0), s, c.arg(2) + 1); return s.length; }];
  M.wcstombs = [3, (c) => { const s = mem.readWString(c.arg(1)).slice(0, c.arg(2)); if (c.arg(0)) mem.writeCString(c.arg(0), s, c.arg(2) + 1); return s.length; }];

  // ---- formatted output
  M.sprintf = [2, (c) => { const s = formatPrintf(c, cstr(c.arg(1)), c.sp + 12); mem.writeCString(c.arg(0), s); return s.length; }];
  M._snprintf = [3, (c) => { const s = formatPrintf(c, cstr(c.arg(2)), c.sp + 16); const n = c.arg(1); if (s.length >= n) { mem.writeBytes(c.arg(0), [...s.slice(0, n)].map((x) => x.charCodeAt(0) & 0xff)); return 0xffffffff; } mem.writeCString(c.arg(0), s); return s.length; }];
  M.vsprintf = [3, (c) => { const s = formatPrintf(c, cstr(c.arg(1)), c.arg(2)); mem.writeCString(c.arg(0), s); return s.length; }];
  M._vsnprintf = [4, (c) => { const s = formatPrintf(c, cstr(c.arg(2)), c.arg(3)); const n = c.arg(1); if (s.length >= n) { mem.writeBytes(c.arg(0), [...s.slice(0, n)].map((x) => x.charCodeAt(0) & 0xff)); return 0xffffffff; } mem.writeCString(c.arg(0), s); return s.length; }];
  M.printf = [1, (c) => { const s = formatPrintf(c, cstr(c.arg(0)), c.sp + 8); vm.stdout.push(s); vm.onStdout?.(s, 'out'); return s.length; }];
  M.puts = [1, (c) => { const s = cstr(c.arg(0)) + '\n'; vm.stdout.push(s); vm.onStdout?.(s, 'out'); return 0; }];
  M.fprintf = [2, (c) => { const s = formatPrintf(c, cstr(c.arg(1)), c.sp + 12); vm.log('debug', s); return s.length; }];
  M.swprintf = [2, (c) => { const s = formatPrintf(c, mem.readWString(c.arg(1)), c.sp + 12, { wide: true }); mem.writeWString(c.arg(0), s); return s.length; }];
  M.sscanf = [2, (c) => sscanf(c, cstr(c.arg(0)), cstr(c.arg(1)), c.sp + 12)];

  // ---- misc runtime
  M._errno = [0, (c) => errnoAddr(c)];
  M.__doserrno = [0, (c) => errnoAddr(c) + 4];
  M._initterm = [2, (c) => { for (let p = c.arg(0); p < c.arg(1); p += 4) { const f = mem.read32(p); if (f) vm.callGuest(c.thread, f, []); } }];
  M._onexit = [1, (c) => c.arg(0)];
  M.__dllonexit = [3, (c) => c.arg(0)];
  M.atexit = [1, () => 0];
  M._adjust_fdiv = [0, () => 0];
  M.__set_app_type = [1, () => {}];
  M._controlfp = [2, (c) => 0x9001f];
  M._control87 = [2, () => 0x9001f];
  M._amsg_exit = [1, (c) => { vm.warn(`msvcrt: _amsg_exit(${c.arg(0)})`); vm.exitProcess(255); }, { noreturn: true }];
  M.exit = [1, (c) => vm.exitProcess(c.arg(0)), { noreturn: true }];
  M._exit = M.exit;
  M.abort = [0, () => vm.exitProcess(3), { noreturn: true }];
  M.rand = [0, (c) => { const p = c.proc; p.crtSeed = (Math.imul(p.crtSeed ?? 1, 214013) + 2531011) >>> 0; return (p.crtSeed >>> 16) & 0x7fff; }];
  M.srand = [1, (c) => { c.proc.crtSeed = c.arg(0); }];
  M.time = [1, (c) => { const t = Math.floor(vm.clock.wall() / 1000) >>> 0; if (c.arg(0)) mem.write32(c.arg(0), t); return t; }];
  M.clock = [0, () => Math.floor(vm.clock.now())];
  M._getpid = [0, (c) => c.proc.pid];
  M.getenv = [1, (c) => { const n = cstr(c.arg(0)).toLowerCase(); for (const [k, v] of c.proc.env) if (k.toLowerCase() === n) { const p = heap(c).alloc(v.length + 1); mem.writeCString(p, v); return p; } return 0; }];
  M.qsort = [4, (c) => {
    const base = c.arg(0), n = c.arg(1), size = c.arg(2), fn = c.arg(3);
    if (n < 2) return;
    const items = [];
    for (let i = 0; i < n; i++) items.push(mem.bytes(base + i * size, size).slice());
    const tmpA = heap(c).alloc(size), tmpB = heap(c).alloc(size);
    items.sort((a, b) => { mem.writeBytes(tmpA, a); mem.writeBytes(tmpB, b); return vm.callGuest(c.thread, fn, [tmpA, tmpB]) | 0; });
    for (let i = 0; i < n; i++) mem.writeBytes(base + i * size, items[i]);
    heap(c).free_(tmpA); heap(c).free_(tmpB);
  }];
  M.bsearch = [5, (c) => {
    const key = c.arg(0), base = c.arg(1), n = c.arg(2), size = c.arg(3), fn = c.arg(4);
    let lo = 0, hi = n - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const r = vm.callGuest(c.thread, fn, [key, base + mid * size]) | 0; if (r === 0) return base + mid * size; if (r < 0) hi = mid - 1; else lo = mid + 1; }
    return 0;
  }];
  M._except_handler3 = [4, (c) => vm.seh.exceptHandler3(c)];
  M._except_handler4 = [4, (c) => vm.seh.exceptHandler3(c)];
  M.__CxxFrameHandler = [4, (c) => 1];
  M._CxxThrowException = [2, (c) => { const p = c.proc.processHeap.alloc(12); mem.write32(p, 0x19930520); mem.write32(p + 4, c.arg(0)); mem.write32(p + 8, c.arg(1)); vm.raiseException(c, 0xe06d7363, 1, 3, p); }, { noreturn: true }];
  M._purecall = [0, (c) => { vm.warn('msvcrt: _purecall'); vm.exitProcess(255); }, { noreturn: true }];
  M._local_unwind2 = [2, () => {}];
  M._global_unwind2 = [1, () => {}];
  M._setjmp = [1, (c) => { vm.warn('msvcrt: _setjmp unsupported'); return 0; }];
  M.longjmp = [2, (c) => { vm.warn('msvcrt: longjmp unsupported'); }];
  M.__getmainargs = [5, (c) => { mem.write32(c.arg(0), 1); mem.write32(c.arg(1), 0); mem.write32(c.arg(2), 0); return 0; }];
  M.__p___argc = [0, (c) => c.proc.processHeap.alloc(4, true)];
  M.__p___argv = [0, (c) => c.proc.processHeap.alloc(4, true)];
  M.__p__commode = [0, (c) => c.proc.processHeap.alloc(4, true)];
  M.__p__fmode = [0, (c) => c.proc.processHeap.alloc(4, true)];
  M._ftol = [0, (c) => { const v = c.cpu.st(0); c.popFpu(); const t = Math.trunc(v); const q = BigInt.asIntN(64, BigInt(Number.isFinite(t) ? t : 0)); c.cpu.edx = Number((q >> 32n) & 0xffffffffn); return Number(q & 0xffffffffn); }];
  M._ftol2 = M._ftol; M._ftol2_sse = M._ftol;
  // math (double args, result in ST(0))
  const m1 = (fn) => [2, (c) => { c.retDouble(fn(c.argF64(0))); }];
  const m2 = (fn) => [4, (c) => { c.retDouble(fn(c.argF64(0), c.argF64(2))); }];
  M.sin = m1(Math.sin); M.cos = m1(Math.cos); M.tan = m1(Math.tan); M.asin = m1(Math.asin); M.acos = m1(Math.acos); M.atan = m1(Math.atan);
  M.sqrt = m1(Math.sqrt); M.exp = m1(Math.exp); M.log = m1(Math.log); M.log10 = m1(Math.log10); M.floor = m1(Math.floor); M.ceil = m1(Math.ceil); M.fabs = m1(Math.abs);
  M.sinh = m1(Math.sinh); M.cosh = m1(Math.cosh); M.tanh = m1(Math.tanh);
  M.atan2 = m2(Math.atan2); M.pow = m2(Math.pow); M.fmod = m2((a, b) => a % b);
  M.ldexp = [3, (c) => { c.retDouble(c.argF64(0) * Math.pow(2, c.sarg(2))); }];
  M.frexp = [3, (c) => { const v = c.argF64(0); if (v === 0 || !Number.isFinite(v)) { mem.write32(c.arg(2), 0); c.retDouble(v); return; } const e = Math.floor(Math.log2(Math.abs(v))) + 1; mem.write32(c.arg(2), e); c.retDouble(v / Math.pow(2, e)); }];
  M.modf = [3, (c) => { const v = c.argF64(0); const i = Math.trunc(v); mem.writeF64(c.arg(2), i); c.retDouble(v - i); }];
  M.abs = [1, (c) => Math.abs(c.sarg(0)) >>> 0];
  M.labs = M.abs;
  M._CIsin = [0, (c) => { c.cpu.setSt(0, Math.sin(c.cpu.st(0))); }];
  M._CIcos = [0, (c) => { c.cpu.setSt(0, Math.cos(c.cpu.st(0))); }];
  M._CIsqrt = [0, (c) => { c.cpu.setSt(0, Math.sqrt(c.cpu.st(0))); }];
  M._CIpow = [0, (c) => { const b = c.cpu.st(1), e = c.cpu.st(0); c.popFpu(); c.cpu.setSt(0, Math.pow(b, e)); }];
  M._CIatan2 = [0, (c) => { const y = c.cpu.st(1), x = c.cpu.st(0); c.popFpu(); c.cpu.setSt(0, Math.atan2(y, x)); }];
  M._CIfmod = [0, (c) => { const a = c.cpu.st(1), b = c.cpu.st(0); c.popFpu(); c.cpu.setSt(0, a % b); }];
  M._CIlog = [0, (c) => { c.cpu.setSt(0, Math.log(c.cpu.st(0))); }];
  M._CIexp = [0, (c) => { c.cpu.setSt(0, Math.exp(c.cpu.st(0))); }];
  M._CItan = [0, (c) => { c.cpu.setSt(0, Math.tan(c.cpu.st(0))); }];
  M._CIasin = [0, (c) => { c.cpu.setSt(0, Math.asin(c.cpu.st(0))); }];
  M._CIacos = [0, (c) => { c.cpu.setSt(0, Math.acos(c.cpu.st(0))); }];
  M._CIatan = [0, (c) => { c.cpu.setSt(0, Math.atan(c.cpu.st(0))); }];
  // file I/O (minimal, stdio streams unsupported beyond basics)
  M.fopen = [2, (c) => { vm.warn(`msvcrt: fopen(${cstr(c.arg(0))}) unsupported`); return 0; }];
  M.fclose = [1, () => 0]; M.fread = [4, () => 0]; M.fwrite = [4, (c) => c.arg(2)]; M.fflush = [1, () => 0]; M.fseek = [3, () => 0]; M.ftell = [1, () => 0];
  M.fputs = [2, (c) => { vm.log('debug', cstr(c.arg(0))); return 0; }];
  M.fgets = [3, () => 0];
  M.__iob_func = [0, (c) => c.proc.crtIob ?? (c.proc.crtIob = c.proc.processHeap.alloc(32 * 3, true))];
  M._iob = M.__iob_func;
  M.setlocale = [2, (c) => { const p = c.proc.crtLocale ?? (c.proc.crtLocale = c.proc.processHeap.alloc(8)); mem.writeCString(p, 'C'); return p; }];
  M._isatty = [1, () => 0];
  M._fileno = [1, (c) => 3];
  M._get_osfhandle = [1, () => 0xffffffff];
  M._beginthreadex = [6, (c) => { const t = c.proc.createThread({ start: c.arg(2), param: c.arg(3), stackSize: c.arg(1), suspended: (c.arg(4) & 4) !== 0 }); c.out32(5, t.id); return t.handle; }];
  M._beginthread = [3, (c) => { const t = c.proc.createThread({ start: c.arg(0), param: c.arg(2), stackSize: c.arg(1) }); return t.handle; }];
  M._endthreadex = [1, (c) => vm.exitThread(c.thread, c.arg(0)), { noreturn: true }];
  M._endthread = [0, (c) => vm.exitThread(c.thread, 0), { noreturn: true }];
  M._assert = [3, (c) => { vm.warn(`assertion failed: ${cstr(c.arg(0))} (${cstr(c.arg(1))}:${c.arg(2)})`); vm.exitProcess(3); }, { noreturn: true }];
  M._splitpath = [5, (c) => {
    const p = cstr(c.arg(0));
    const drive = /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : '';
    const rest = p.slice(drive.length);
    const slash = Math.max(rest.lastIndexOf('\\'), rest.lastIndexOf('/'));
    const dir = slash >= 0 ? rest.slice(0, slash + 1) : '';
    const file = slash >= 0 ? rest.slice(slash + 1) : rest;
    const dot = file.lastIndexOf('.');
    const name = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot) : '';
    if (c.arg(1)) mem.writeCString(c.arg(1), drive); if (c.arg(2)) mem.writeCString(c.arg(2), dir); if (c.arg(3)) mem.writeCString(c.arg(3), name); if (c.arg(4)) mem.writeCString(c.arg(4), ext);
  }];
  M._makepath = [5, (c) => { mem.writeCString(c.arg(0), cstr(c.arg(1)) + cstr(c.arg(2)) + cstr(c.arg(3)) + cstr(c.arg(4))); }];
  M._fullpath = [3, (c) => { const p = c.proc.path(cstr(c.arg(1))); const d = c.arg(0) || heap(c).alloc(p.length + 1); mem.writeCString(d, p, c.arg(0) ? c.arg(2) : Infinity); return d; }];
  M._access = [2, (c) => (vm.vfs.stat(c.proc.path(cstr(c.arg(0)))) ? 0 : 0xffffffff)];
  M._mkdir = [1, (c) => (vm.vfs.mkdir(c.proc.path(cstr(c.arg(0)))) ? 0 : 0xffffffff)];
  M._unlink = [1, (c) => (vm.vfs.unlink(c.proc.path(cstr(c.arg(0)))) ? 0 : 0xffffffff)];
  M.remove = M._unlink;
  M._getcwd = [2, (c) => { const p = c.arg(0) || heap(c).alloc(260); mem.writeCString(p, c.proc.cwd); return p; }];
  M._chdir = [1, (c) => { c.proc.cwd = c.proc.path(cstr(c.arg(0))); return 0; }];
  M._strtime = [1, (c) => { const d = new Date(vm.clock.wall()); mem.writeCString(c.arg(0), `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`); return c.arg(0); }];
  M._strdate = [1, (c) => { const d = new Date(vm.clock.wall()); mem.writeCString(c.arg(0), `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCFullYear() % 100).padStart(2, '0')}`); return c.arg(0); }];
  M.localtime = [1, (c) => tmOf(c, mem.read32(c.arg(0)))];
  M.gmtime = M.localtime;
  M.mktime = [1, (c) => { const p = c.arg(0); return Math.floor(Date.UTC(1900 + mem.readS32(p + 20), mem.readS32(p + 16), mem.readS32(p + 12), mem.readS32(p + 8), mem.readS32(p + 4), mem.readS32(p)) / 1000) >>> 0; }];
  M.strftime = [4, (c) => { const s = new Date((mem.read32(c.arg(3) + 0) || 0)).toISOString(); mem.writeCString(c.arg(0), s.slice(0, c.arg(1) - 1)); return Math.min(s.length, c.arg(1) - 1); }];
  M._vscprintf = [2, (c) => formatPrintf(c, cstr(c.arg(0)), c.arg(1)).length];
  M._scprintf = [1, (c) => formatPrintf(c, cstr(c.arg(0)), c.sp + 8).length];
  M._itoa = [3, (c) => { mem.writeCString(c.arg(1), (c.sarg(0)).toString(c.arg(2) || 10)); return c.arg(1); }];
  M._ltoa = M._itoa;
  M._ultoa = [3, (c) => { mem.writeCString(c.arg(1), (c.arg(0) >>> 0).toString(c.arg(2) || 10)); return c.arg(1); }];
  M._i64toa = [3, (c) => { mem.writeCString(c.arg(2), BigInt.asIntN(64, c.arg64(0)).toString(c.arg(3) || 10)); return c.arg(2); }];
  M._gcvt = [3, (c) => { mem.writeCString(c.arg(3), c.argF64(0).toPrecision(c.arg(2))); return c.arg(3); }];
  M._finite = [2, (c) => (Number.isFinite(c.argF64(0)) ? 1 : 0)];
  M._isnan = [2, (c) => (Number.isNaN(c.argF64(0)) ? 1 : 0)];
  M._fpclass = [2, (c) => { const v = c.argF64(0); return Number.isNaN(v) ? 2 : v === Infinity ? 0x200 : v === -Infinity ? 4 : v === 0 ? (Object.is(v, -0) ? 0x20 : 0x40) : v > 0 ? 0x100 : 8; }];
  M._hypot = m2(Math.hypot);
  M.difftime = [4, (c) => { c.retDouble(c.arg(0) - c.arg(2)); }];
  M._chkesp = [0, () => {}];
  M._lock = [1, () => {}]; M._unlock = [1, () => {}];
  M.__lconv_init = [0, () => 0];
  M._XcptFilter = [2, () => 0];
  M.__p__iob = M.__iob_func;
  M.signal = [2, () => 0];
  M.raise = [1, () => 0];
  M.system = [1, () => 0xffffffff];
  M._putenv = [1, () => 0];
  M.strerror = [1, (c) => { const p = c.proc.crtErr ?? (c.proc.crtErr = c.proc.processHeap.alloc(64)); mem.writeCString(p, `error ${c.arg(0)}`); return p; }];
  M.perror = [1, (c) => { vm.log('debug', cstr(c.arg(0))); }];
  M._set_se_translator = [1, () => 0];
  M.set_terminate = [1, () => 0];
  M.set_unexpected = [1, () => 0];
  M._set_error_mode = [1, () => 0];
  M._CrtDbgReport = [5, () => 0];
  M._CrtSetReportMode = [2, () => 0];
  M._CrtSetReportFile = [2, () => 0];
  M._CrtCheckMemory = [0, () => 1];
  M._CrtSetDbgFlag = [1, () => 0];
  M._HUGE = [0, () => 0];

  api.define('msvcrt.dll', M, { cc: CC_CDECL });
  api.dll('msvcrt.dll', ['msvcrt40.dll', 'crtdll.dll']);
  return M;
}

function tmOf(c, t) {
  const mem = c.mem;
  const p = c.proc.crtTm ?? (c.proc.crtTm = c.proc.processHeap.alloc(36, true));
  const d = new Date(t * 1000);
  mem.write32(p, d.getUTCSeconds()); mem.write32(p + 4, d.getUTCMinutes()); mem.write32(p + 8, d.getUTCHours()); mem.write32(p + 12, d.getUTCDate());
  mem.write32(p + 16, d.getUTCMonth()); mem.write32(p + 20, d.getUTCFullYear() - 1900); mem.write32(p + 24, d.getUTCDay());
  const start = Date.UTC(d.getUTCFullYear(), 0, 1); mem.write32(p + 28, Math.floor((d.getTime() - start) / 86400000)); mem.write32(p + 32, 0);
  return p;
}

/** Minimal sscanf: %d %i %u %x %f %s %c %n, widths, %*. Returns the number of assignments. */
export function sscanf(c, input, fmt, argAddr) {
  const mem = c.mem;
  let ip = 0, ap = argAddr, count = 0;
  const nextArg = () => { const v = mem.read32(ap); ap += 4; return v; };
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (/\s/.test(ch)) { while (ip < input.length && /\s/.test(input[ip])) ip++; continue; }
    if (ch !== '%') { if (input[ip] !== ch) return count; ip++; continue; }
    i++;
    let suppress = false; if (fmt[i] === '*') { suppress = true; i++; }
    let width = ''; while (fmt[i] >= '0' && fmt[i] <= '9') width += fmt[i++];
    let mod = ''; while ('hlL'.includes(fmt[i])) mod += fmt[i++];
    const conv = fmt[i];
    const w = width ? +width : Infinity;
    if (conv !== 'c' && conv !== 'n' && conv !== '%') while (ip < input.length && /\s/.test(input[ip])) ip++;
    let m;
    switch (conv) {
      case 'd': case 'i': case 'u': m = input.slice(ip).match(conv === 'i' ? /^[-+]?(0x[0-9a-f]+|0[0-7]*|\d+)/i : /^[-+]?\d+/); if (!m) return count; ip += Math.min(m[0].length, w); if (!suppress) { const v = parseInt(m[0].slice(0, w), conv === 'i' && /^0x/i.test(m[0]) ? 16 : 10); const a = nextArg(); if (mod === 'h') mem.write16(a, v); else mem.write32(a, v >>> 0); count++; } break;
      case 'x': case 'X': m = input.slice(ip).match(/^[-+]?(0x)?[0-9a-f]+/i); if (!m) return count; ip += Math.min(m[0].length, w); if (!suppress) { mem.write32(nextArg(), parseInt(m[0].slice(0, w), 16) >>> 0); count++; } break;
      case 'f': case 'g': case 'e': case 'E': case 'G': m = input.slice(ip).match(/^[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)/); if (!m) return count; ip += Math.min(m[0].length, w); if (!suppress) { const v = parseFloat(m[0].slice(0, w)); const a = nextArg(); if (mod === 'l' || mod === 'L') mem.writeF64(a, v); else mem.writeF32(a, v); count++; } break;
      case 's': m = input.slice(ip).match(/^\S+/); if (!m) return count; { const s = m[0].slice(0, w); ip += s.length; if (!suppress) { mem.writeCString(nextArg(), s); count++; } } break;
      case 'c': { const n = width ? +width : 1; if (ip + n > input.length) return count; if (!suppress) { const a = nextArg(); for (let k = 0; k < n; k++) mem.write8(a + k, input.charCodeAt(ip + k)); count++; } ip += n; break; }
      case 'n': if (!suppress) mem.write32(nextArg(), ip); break;
      case '%': if (input[ip] !== '%') return count; ip++; break;
      case '[': { let j = i + 1; let neg = false; if (fmt[j] === '^') { neg = true; j++; } let set = ''; if (fmt[j] === ']') { set += ']'; j++; } while (j < fmt.length && fmt[j] !== ']') set += fmt[j++]; i = j; let s = ''; while (ip < input.length && s.length < w && (set.includes(input[ip]) !== neg)) s += input[ip++]; if (!s.length) return count; if (!suppress) { mem.writeCString(nextArg(), s); count++; } break; }
      default: return count;
    }
  }
  return count;
}

export { decodeBytes };
