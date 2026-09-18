// kernel32.dll part 2: files, directories, environment, code pages and locale, console output.
import { E } from './errors.js';
import { decodeBytes, encodeString, CP_UTF8 } from './strings.js';
import { msToFiletime, filetimeToMs, allocString, allocWString } from './kernel32.js';
import { normalizeWin } from '../vfs/vfs.js';

const INVALID_HANDLE = 0xffffffff;
const FILE_ATTRIBUTE_READONLY = 1, FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_ARCHIVE = 0x20, FILE_ATTRIBUTE_NORMAL = 0x80;
const GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
const CREATE_NEW = 1, CREATE_ALWAYS = 2, OPEN_EXISTING = 3, OPEN_ALWAYS = 4, TRUNCATE_EXISTING = 5;

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerKernel32File(api, vm) {
  const mem = vm.mem;
  const K = {};

  // ---------------------------------------------------------------- std handles / console
  const ensureStd = (proc) => {
    if (proc.stdHandles) return;
    const mk = (kind) => proc.handles.create({ type: 'file', console: kind, pos: 0 });
    proc.stdHandles = [mk('in'), mk('out'), mk('err')];
  };
  const fileOf = (c, h) => { ensureStd(c.proc); return c.proc.handles.getAs(h, 'file'); };
  K.GetStdHandle = [1, (c) => { ensureStd(c.proc); const n = c.sarg(0); return n === -10 ? c.proc.stdHandles[0] : n === -11 ? c.proc.stdHandles[1] : n === -12 ? c.proc.stdHandles[2] : INVALID_HANDLE; }];
  K.SetStdHandle = [2, (c) => { ensureStd(c.proc); const n = c.sarg(0); const i = n === -10 ? 0 : n === -11 ? 1 : n === -12 ? 2 : -1; if (i < 0) return c.fail(E.INVALID_HANDLE); c.proc.stdHandles[i] = c.arg(1); return 1; }];
  const consoleWrite = (kind, bytes) => {
    const s = decodeBytes(bytes, 0);
    vm.stdout.push(s);
    if (vm.stdout.length > 4096) vm.stdout.splice(0, vm.stdout.length - 2048); // bounded console history
    if (vm.onStdout) vm.onStdout(s, kind);
    else if (kind === 'err') (vm.onStderr ?? globalThis.process?.stderr?.write?.bind(globalThis.process.stderr))?.(s);
  };
  K.WriteConsoleA = [5, (c) => { const f = fileOf(c, c.arg(0)); if (!f?.console) return c.fail(E.INVALID_HANDLE); consoleWrite(f.console, mem.bytes(c.arg(1), c.arg(2))); c.out32(3, c.arg(2)); return 1; }];
  K.WriteConsoleW = [5, (c) => { const f = fileOf(c, c.arg(0)); if (!f?.console) return c.fail(E.INVALID_HANDLE); const s = mem.readWString(c.arg(1), c.arg(2)); vm.stdout.push(s); vm.onStdout?.(s, f.console); c.out32(3, c.arg(2)); return 1; }];
  K.ReadConsoleA = [5, (c) => { c.out32(3, 0); return 1; }];

  // ---------------------------------------------------------------- files
  const openFile = (c, path, access, share, disposition, flags) => {
    if (!path) return c.fail(E.INVALID_PARAMETER) | INVALID_HANDLE;
    ensureStd(c.proc);
    const up = path.toUpperCase();
    if (up === 'CONOUT$' || up === 'CON') return c.proc.handles.create({ type: 'file', console: 'out', pos: 0 });
    if (up === 'CONIN$') return c.proc.handles.create({ type: 'file', console: 'in', pos: 0 });
    if (up.startsWith('\\\\.\\')) { vm.warn(`CreateFile(${path}): devices unsupported`); return c.fail(E.FILE_NOT_FOUND) | INVALID_HANDLE; }
    const wp = c.proc.path(path);
    const st = vm.vfs.stat(wp);
    const write = (access & GENERIC_WRITE) !== 0 || (access & 2) !== 0;
    if (st && st.isDir) {
      if (flags & 0x02000000) return c.proc.handles.create({ type: 'file', dir: true, path: wp, pos: 0 });
      return c.fail(E.ACCESS_DENIED) | INVALID_HANDLE;
    }
    let f = null;
    switch (disposition) {
      case CREATE_NEW:
        if (st) return c.fail(E.FILE_EXISTS) | INVALID_HANDLE;
        f = vm.vfs.open(wp, { create: true, write: true });
        break;
      case CREATE_ALWAYS:
        f = vm.vfs.open(wp, { create: true, truncate: true, write: true });
        if (st) c.setLastError(E.ALREADY_EXISTS);
        break;
      case OPEN_EXISTING:
        if (!st) { vm.log('file', `open ${wp} (${write ? 'rw' : 'r'}) FAILED not found`); return c.fail(E.FILE_NOT_FOUND) | INVALID_HANDLE; }
        f = vm.vfs.open(wp, { write });
        break;
      case OPEN_ALWAYS:
        f = vm.vfs.open(wp, { create: true, write: true });
        if (st) c.setLastError(E.ALREADY_EXISTS);
        break;
      case TRUNCATE_EXISTING:
        if (!st) return c.fail(E.FILE_NOT_FOUND) | INVALID_HANDLE;
        f = vm.vfs.open(wp, { truncate: true, write: true });
        break;
      default:
        return c.fail(E.INVALID_PARAMETER) | INVALID_HANDLE;
    }
    if (!f) {
      const parent = wp.slice(0, wp.lastIndexOf('\\'));
      const err = vm.vfs.stat(parent) ? (write ? E.ACCESS_DENIED : E.FILE_NOT_FOUND) : E.PATH_NOT_FOUND;
      vm.log('file', `open ${wp} (${write ? 'rw' : 'r'}, disp ${disposition}) FAILED error ${err}`);
      return c.fail(err) | INVALID_HANDLE;
    }
    const h = c.proc.handles.create({ type: 'file', file: f, path: wp, pos: 0, write, close() { f.close(); } });
    vm.log('file', `open ${wp} (${write ? 'rw' : 'r'}) -> ${h}`);
    return h;
  };
  K.CreateFileA = [7, (c) => openFile(c, c.str(0), c.arg(1), c.arg(2), c.arg(4), c.arg(5))];
  K.CreateFileW = [7, (c) => openFile(c, c.wstr(0), c.arg(1), c.arg(2), c.arg(4), c.arg(5))];
  K.OpenFile = [3, (c) => { const h = openFile(c, c.str(0), (c.arg(2) & 1) ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ, 0, OPEN_EXISTING, 0); return h === INVALID_HANDLE ? 0xffffffff : h; }];
  K._lopen = [2, (c) => { const h = openFile(c, c.str(0), (c.arg(1) & 1) ? GENERIC_READ | GENERIC_WRITE : GENERIC_READ, 0, OPEN_EXISTING, 0); return h === INVALID_HANDLE ? 0xffffffff : h; }];
  K._lclose = [1, (c) => { c.proc.handles.close(c.arg(0)); return 0; }];
  K._lread = [3, (c) => { const f = fileOf(c, c.arg(0)); if (!f?.file) return 0xffffffff; const d = f.file.read(f.pos, c.arg(2)); mem.writeBytes(c.arg(1), d); f.pos += d.length; return d.length; }];
  K._llseek = [3, (c) => { const f = fileOf(c, c.arg(0)); if (!f?.file) return 0xffffffff; const m = c.arg(2); f.pos = m === 0 ? c.sarg(1) : m === 1 ? f.pos + c.sarg(1) : f.file.size() + c.sarg(1); return f.pos; }];

  K.ReadFile = [5, (c) => {
    const f = fileOf(c, c.arg(0));
    if (!f) return c.fail(E.INVALID_HANDLE);
    if (f.console) { c.out32(3, 0); return 1; }
    if (!f.file) return c.fail(E.ACCESS_DENIED);
    const ovl = c.arg(4);
    let pos = f.pos;
    if (ovl) pos = mem.read32(ovl + 8) + mem.read32(ovl + 12) * 4294967296;
    const n = c.arg(2);
    const d = f.file.read(pos, n);
    if (d.length) mem.writeBytes(c.arg(1), d);
    if (ovl) { mem.write32(ovl, 0); mem.write32(ovl + 4, d.length); const np = pos + d.length; mem.write32(ovl + 8, np >>> 0); mem.write32(ovl + 12, Math.floor(np / 4294967296)); }
    else f.pos = pos + d.length;
    c.out32(3, d.length);
    if (d.length === 0 && n > 0 && ovl) return c.fail(E.HANDLE_EOF);
    return 1;
  }];
  K.WriteFile = [5, (c) => {
    const f = fileOf(c, c.arg(0));
    if (!f) return c.fail(E.INVALID_HANDLE);
    const n = c.arg(2);
    if (f.console) { consoleWrite(f.console, mem.bytes(c.arg(1), n)); c.out32(3, n); return 1; }
    if (!f.file || !f.write) return c.fail(E.ACCESS_DENIED);
    const ovl = c.arg(4);
    let pos = f.pos;
    if (ovl) pos = mem.read32(ovl + 8) + mem.read32(ovl + 12) * 4294967296;
    const w = f.file.write(pos, mem.bytes(c.arg(1), n));
    if (w < 0) return c.fail(E.ACCESS_DENIED);
    if (ovl) { mem.write32(ovl + 4, w); const np = pos + w; mem.write32(ovl + 8, np >>> 0); mem.write32(ovl + 12, Math.floor(np / 4294967296)); }
    else f.pos = pos + w;
    c.out32(3, w);
    return 1;
  }];
  K.SetFilePointer = [4, (c) => {
    const f = fileOf(c, c.arg(0));
    if (!f || !f.file) return c.fail(E.INVALID_HANDLE) | INVALID_HANDLE;
    const hiPtr = c.arg(2);
    let dist = c.sarg(1);
    if (hiPtr) dist = mem.readS32(hiPtr) * 4294967296 + c.arg(1);
    const m = c.arg(3);
    let np = m === 0 ? dist : m === 1 ? f.pos + dist : f.file.size() + dist;
    if (np < 0) return c.fail(E.NEGATIVE_SEEK) | INVALID_HANDLE;
    f.pos = np;
    if (hiPtr) mem.write32(hiPtr, Math.floor(np / 4294967296));
    c.setLastError(0);
    return np >>> 0;
  }];
  K.SetFilePointerEx = [5, (c) => {
    const f = fileOf(c, c.arg(0));
    if (!f || !f.file) return c.fail(E.INVALID_HANDLE);
    const dist = Number(mem.dv.getBigInt64(c.sp + 4 + 4, true));
    const m = c.arg(4);
    const np = m === 0 ? dist : m === 1 ? f.pos + dist : f.file.size() + dist;
    if (np < 0) return c.fail(E.NEGATIVE_SEEK);
    f.pos = np;
    c.out64(3, BigInt(np));
    return 1;
  }];
  K.GetFileSize = [2, (c) => { const f = fileOf(c, c.arg(0)); if (!f?.file) return c.fail(E.INVALID_HANDLE) | INVALID_HANDLE; const s = f.file.size(); c.out32(1, Math.floor(s / 4294967296)); c.setLastError(0); return s >>> 0; }];
  K.GetFileSizeEx = [2, (c) => { const f = fileOf(c, c.arg(0)); if (!f?.file) return c.fail(E.INVALID_HANDLE); c.out64(1, BigInt(f.file.size())); return 1; }];
  K.GetFileType = [1, (c) => { const f = fileOf(c, c.arg(0)); if (!f) return c.fail(E.INVALID_HANDLE); return f.console ? 2 : 1; }];
  K.SetEndOfFile = [1, (c) => { const f = fileOf(c, c.arg(0)); if (!f?.file) return c.fail(E.INVALID_HANDLE); f.file.truncate(f.pos); return 1; }];
  K.FlushFileBuffers = [1, () => 1];
  K.LockFile = [5, () => 1];
  K.UnlockFile = [5, () => 1];
  K.LockFileEx = [6, () => 1];
  K.UnlockFileEx = [5, () => 1];
  K.GetOverlappedResult = [4, (c) => { const o = c.arg(1); c.out32(2, mem.read32(o + 4)); return 1; }];
  K.CancelIo = [1, () => 1];
  K.DeviceIoControl = [8, (c) => c.fail(E.INVALID_FUNCTION)];
  K.GetFileTime = [4, (c) => { const f = fileOf(c, c.arg(0)); if (!f) return c.fail(E.INVALID_HANDLE); const st = f.path ? vm.vfs.stat(f.path) : null; const t = msToFiletime(st?.mtime || vm.clock.wall()); c.out64(1, t); c.out64(2, t); c.out64(3, t); return 1; }];
  K.SetFileTime = [4, () => 1];
  K.GetFileInformationByHandle = [2, (c) => {
    const f = fileOf(c, c.arg(0)); if (!f) return c.fail(E.INVALID_HANDLE);
    const st = f.path ? vm.vfs.stat(f.path) : null; const p = c.arg(1); mem.fill(p, 52, 0);
    mem.write32(p, st?.isDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE);
    const t = msToFiletime(st?.mtime || vm.clock.wall()); mem.write64(p + 4, t); mem.write64(p + 12, t); mem.write64(p + 20, t);
    mem.write32(p + 28, 0x12345678); const size = st?.size ?? 0; mem.write32(p + 32, Math.floor(size / 4294967296)); mem.write32(p + 36, size >>> 0);
    mem.write32(p + 40, 1); mem.write32(p + 44, 0); mem.write32(p + 48, (c.arg(0) * 2654435761) >>> 0);
    return 1;
  }];

  const attrsOf = (c, path) => {
    if (!path) return c.fail(E.INVALID_PARAMETER) | INVALID_HANDLE;
    const wp = c.proc.path(path);
    const st = vm.vfs.stat(wp);
    if (!st) return c.fail(E.FILE_NOT_FOUND) | INVALID_HANDLE;
    return st.isDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE;
  };
  K.GetFileAttributesA = [1, (c) => attrsOf(c, c.str(0))];
  K.GetFileAttributesW = [1, (c) => attrsOf(c, c.wstr(0))];
  K.SetFileAttributesA = [2, () => 1];
  K.SetFileAttributesW = [2, () => 1];
  K.GetFileAttributesExA = [3, (c) => {
    const wp = c.proc.path(c.str(0) ?? ''); const st = vm.vfs.stat(wp);
    if (!st) return c.fail(E.FILE_NOT_FOUND);
    const p = c.arg(2); mem.write32(p, st.isDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE);
    const t = msToFiletime(st.mtime || vm.clock.wall()); mem.write64(p + 4, t); mem.write64(p + 12, t); mem.write64(p + 20, t);
    mem.write32(p + 28, Math.floor(st.size / 4294967296)); mem.write32(p + 32, st.size >>> 0);
    return 1;
  }];
  K.DeleteFileA = [1, (c) => (vm.vfs.unlink(c.proc.path(c.str(0) ?? '')) ? 1 : c.fail(E.FILE_NOT_FOUND))];
  K.DeleteFileW = [1, (c) => (vm.vfs.unlink(c.proc.path(c.wstr(0) ?? '')) ? 1 : c.fail(E.FILE_NOT_FOUND))];
  K.MoveFileA = [2, (c) => (vm.vfs.rename(c.proc.path(c.str(0) ?? ''), c.proc.path(c.str(1) ?? '')) ? 1 : c.fail(E.FILE_NOT_FOUND))];
  K.MoveFileExA = [3, (c) => (vm.vfs.rename(c.proc.path(c.str(0) ?? ''), c.proc.path(c.str(1) ?? '')) ? 1 : c.fail(E.FILE_NOT_FOUND))];
  K.CopyFileA = [3, (c) => {
    const src = c.proc.path(c.str(0) ?? ''), dst = c.proc.path(c.str(1) ?? '');
    if (c.arg(2) && vm.vfs.stat(dst)) return c.fail(E.FILE_EXISTS);
    const data = vm.vfs.readFile(src); if (!data) return c.fail(E.FILE_NOT_FOUND);
    const f = vm.vfs.open(dst, { create: true, truncate: true, write: true }); if (!f) return c.fail(E.ACCESS_DENIED);
    f.write(0, data); f.close(); return 1;
  }];
  K.CreateDirectoryA = [2, (c) => (vm.vfs.mkdir(c.proc.path(c.str(0) ?? '')) ? 1 : c.fail(vm.vfs.stat(c.proc.path(c.str(0) ?? '')) ? E.ALREADY_EXISTS : E.PATH_NOT_FOUND))];
  K.CreateDirectoryW = [2, (c) => (vm.vfs.mkdir(c.proc.path(c.wstr(0) ?? '')) ? 1 : c.fail(E.ALREADY_EXISTS))];
  K.RemoveDirectoryA = [1, (c) => 1];
  K.GetCurrentDirectoryA = [2, (c) => { const s = c.proc.cwd; const n = c.arg(0); if (n <= s.length) return s.length + 1; mem.writeCString(c.arg(1), s); return s.length; }];
  K.GetCurrentDirectoryW = [2, (c) => { const s = c.proc.cwd; const n = c.arg(0); if (n <= s.length) return s.length + 1; mem.writeWString(c.arg(1), s); return s.length; }];
  K.SetCurrentDirectoryA = [1, (c) => { const p = c.proc.path(c.str(0) ?? ''); if (!vm.vfs.stat(p)?.isDir) return c.fail(E.PATH_NOT_FOUND); c.proc.cwd = p; return 1; }];
  K.SetCurrentDirectoryW = [1, (c) => { const p = c.proc.path(c.wstr(0) ?? ''); if (!vm.vfs.stat(p)?.isDir) return c.fail(E.PATH_NOT_FOUND); c.proc.cwd = p; return 1; }];
  const fullPath = (c, wide) => {
    const s = wide ? c.wstr(0) : c.str(0);
    const p = c.proc.path(s ?? '');
    const n = c.arg(1), buf = c.arg(2);
    if (n <= p.length) return p.length + 1;
    if (wide) mem.writeWString(buf, p); else mem.writeCString(buf, p);
    const fp = c.arg(3);
    if (fp) mem.write32(fp, buf + (wide ? 2 : 1) * (p.lastIndexOf('\\') + 1));
    return p.length;
  };
  K.GetFullPathNameA = [4, (c) => fullPath(c, false)];
  K.GetFullPathNameW = [4, (c) => fullPath(c, true)];
  K.GetLongPathNameA = [3, (c) => { const s = c.str(0) ?? ''; if (c.arg(2) <= s.length) return s.length + 1; mem.writeCString(c.arg(1), s); return s.length; }];
  K.GetShortPathNameA = K.GetLongPathNameA;
  K.GetTempPathA = [2, (c) => { const s = 'C:\\Users\\Player\\Temp\\'; if (c.arg(0) <= s.length) return s.length + 1; mem.writeCString(c.arg(1), s); return s.length; }];
  K.GetTempPathW = [2, (c) => { const s = 'C:\\Users\\Player\\Temp\\'; if (c.arg(0) <= s.length) return s.length + 1; mem.writeWString(c.arg(1), s); return s.length; }];
  K.GetTempFileNameA = [4, (c) => { const dir = (c.str(0) ?? 'C:\\Users\\Player\\Temp').replace(/\\$/, ''); const n = (c.arg(2) || (c.proc.tmpCounter = (c.proc.tmpCounter || 0) + 1)) & 0xffff; const name = `${dir}\\${(c.str(1) ?? 'tmp').slice(0, 3)}${n.toString(16).toUpperCase()}.tmp`; mem.writeCString(c.arg(3), name); if (!c.arg(2)) { const f = vm.vfs.open(c.proc.path(name), { create: true, write: true }); f?.close(); } return n; }];
  K.GetSystemDirectoryA = [2, (c) => { const s = 'C:\\Windows\\System32'; if (c.arg(1) <= s.length) return s.length + 1; mem.writeCString(c.arg(0), s); return s.length; }];
  K.GetSystemDirectoryW = [2, (c) => { const s = 'C:\\Windows\\System32'; if (c.arg(1) <= s.length) return s.length + 1; mem.writeWString(c.arg(0), s); return s.length; }];
  K.GetWindowsDirectoryA = [2, (c) => { const s = 'C:\\Windows'; if (c.arg(1) <= s.length) return s.length + 1; mem.writeCString(c.arg(0), s); return s.length; }];
  K.GetWindowsDirectoryW = [2, (c) => { const s = 'C:\\Windows'; if (c.arg(1) <= s.length) return s.length + 1; mem.writeWString(c.arg(0), s); return s.length; }];
  K.GetSystemWindowsDirectoryA = K.GetWindowsDirectoryA;
  K.GetComputerNameA = [2, (c) => { const s = 'ORTHROS'; if (mem.read32(c.arg(1)) <= s.length) return c.fail(E.INSUFFICIENT_BUFFER); mem.writeCString(c.arg(0), s); mem.write32(c.arg(1), s.length); return 1; }];
  K.GetComputerNameW = [2, (c) => { const s = 'ORTHROS'; if (mem.read32(c.arg(1)) <= s.length) return c.fail(E.INSUFFICIENT_BUFFER); mem.writeWString(c.arg(0), s); mem.write32(c.arg(1), s.length); return 1; }];
  K.GetDiskFreeSpaceA = [5, (c) => { c.out32(1, 8); c.out32(2, 512); c.out32(3, 0x400000); c.out32(4, 0x800000); return 1; }];
  K.GetDiskFreeSpaceExA = [4, (c) => { const free = 16n * 1024n * 1024n * 1024n; c.out64(1, free); c.out64(2, 4n * free); c.out64(3, free); return 1; }];
  K.GetDriveTypeA = [1, (c) => { const s = (c.str(0) ?? '').toUpperCase(); return s.startsWith('C') ? 3 : s.startsWith('D') ? 5 : 1; }];
  K.GetDriveTypeW = [1, (c) => { const s = (c.wstr(0) ?? '').toUpperCase(); return s.startsWith('C') ? 3 : s.startsWith('D') ? 5 : 1; }];
  K.GetLogicalDrives = [0, () => 0x4];
  K.GetLogicalDriveStringsA = [2, (c) => { const s = 'C:\\\0'; if (c.arg(0) < s.length + 1) return s.length + 1; mem.writeBytes(c.arg(1), [...s].map((ch) => ch.charCodeAt(0)).concat([0])); return s.length; }];
  K.GetVolumeInformationA = [8, (c) => { if (c.arg(1)) mem.writeCString(c.arg(1), 'ORTHROS', c.arg(2)); c.out32(3, 0x1234abcd); c.out32(4, 255); c.out32(5, 0x700ff); if (c.arg(6)) mem.writeCString(c.arg(6), 'NTFS', c.arg(7)); return 1; }];
  K.SearchPathA = [6, (c) => {
    const name = c.str(1) ?? ''; const ext = c.str(2);
    const cands = [c.str(0) ? c.str(0) + '\\' + name : name, c.proc.exeDir + '\\' + name, c.proc.cwd + '\\' + name];
    for (let p of cands) { p = c.proc.path(p); if (!vm.vfs.stat(p) && ext) p += ext; if (vm.vfs.stat(p)) { if (c.arg(3) <= p.length) return p.length + 1; mem.writeCString(c.arg(4), p); if (c.arg(5)) mem.write32(c.arg(5), c.arg(4) + p.lastIndexOf('\\') + 1); return p.length; } }
    return c.fail(E.FILE_NOT_FOUND);
  }];

  // FindFirstFile family
  // Win32 wildcard semantics (FsRtlIsNameInExpression with the DOS tokens FindFirstFile produces):
  //   DOS_STAR (`*` before a dot) matches up to the final dot of the name, DOS_QM (`?`) matches one
  //   character or nothing at a dot/end, DOS_DOT (`.`) matches a dot or the end of the name.
  //   So `*.` lists names without extension, `*.*` lists everything, `abc.*` also matches `abc`.
  const DOS_STAR = '<', DOS_QM = '>', DOS_DOT = '"';
  const translate = (g) => {
    if (g === '*.*') return '*';
    let e = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      e += c === '.' ? DOS_DOT : c === '?' ? DOS_QM : c === '*' && g[i + 1] === '.' ? DOS_STAR : c.toLowerCase();
    }
    return e;
  };
  const matchExpr = (name, i, e, j) => {
    for (;;) {
      if (j === e.length) return i === name.length;
      const t = e[j];
      if (t === '*') { for (let k = i; k <= name.length; k++) if (matchExpr(name, k, e, j + 1)) return true; return false; }
      if (t === DOS_STAR) { const d = name.lastIndexOf('.'); const lim = d >= i ? d : name.length; for (let k = i; k <= lim; k++) if (matchExpr(name, k, e, j + 1)) return true; return false; }
      if (t === DOS_QM) { if (i === name.length || name[i] === '.') { while (e[j] === DOS_QM) j++; continue; } i++; j++; continue; }
      if (t === DOS_DOT) { if (i === name.length) { j++; continue; } if (name[i] === '.') { i++; j++; continue; } return false; }
      if (i < name.length && name[i].toLowerCase() === t) { i++; j++; continue; }
      return false;
    }
  };
  const globToRe = (g) => { const e = translate(g); return { test: (name) => matchExpr(name, 0, e, 0) }; };
  const writeFindData = (p, e, wide) => {
    mem.fill(p, wide ? 592 : 320, 0);
    mem.write32(p, e.isDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE);
    const t = msToFiletime(e.mtime || vm.clock.wall());
    mem.write64(p + 4, t); mem.write64(p + 12, t); mem.write64(p + 20, t);
    mem.write32(p + 28, Math.floor(e.size / 4294967296)); mem.write32(p + 32, e.size >>> 0);
    if (wide) mem.writeWString(p + 44, e.name, 260); else mem.writeCString(p + 44, e.name, 260);
  };
  const findFirst = (c, pattern, wide) => {
    if (!pattern) return c.fail(E.INVALID_PARAMETER) | INVALID_HANDLE;
    const full = c.proc.path(pattern);
    const slash = full.lastIndexOf('\\');
    const dir = full.slice(0, slash) || full.slice(0, 2) + '\\';
    const glob = full.slice(slash + 1);
    let entries;
    if (!/[*?]/.test(glob)) {
      const st = vm.vfs.stat(full);
      entries = st ? [{ name: glob, size: st.size, isDir: st.isDir, mtime: st.mtime }] : [];
      if (st) { const real = vm.vfs.readdir(dir)?.find((e) => e.name.toLowerCase() === glob.toLowerCase()); if (real) entries[0].name = real.name; }
    } else {
      const list = vm.vfs.readdir(dir);
      if (!list) return c.fail(E.PATH_NOT_FOUND) | INVALID_HANDLE;
      const re = globToRe(glob);
      entries = [];
      if (re.test('.')) entries.push({ name: '.', size: 0, isDir: true, mtime: 0 }, { name: '..', size: 0, isDir: true, mtime: 0 });
      for (const e of list) if (re.test(e.name)) entries.push(e);
    }
    vm.log('file', `find ${full} -> ${entries.length ? entries.map((e) => e.name).join(', ') : 'nothing'}`);
    if (!entries.length) return c.fail(E.FILE_NOT_FOUND) | INVALID_HANDLE;
    writeFindData(c.arg(1), entries[0], wide);
    return c.proc.handles.create({ type: 'find', entries, i: 1 });
  };
  K.FindFirstFileA = [2, (c) => findFirst(c, c.str(0), false)];
  K.FindFirstFileW = [2, (c) => findFirst(c, c.wstr(0), true)];
  K.FindFirstFileExA = [6, (c) => findFirst(c, c.str(0), false)];
  K.FindNextFileA = [2, (c) => { const f = c.proc.handles.getAs(c.arg(0), 'find'); if (!f) return c.fail(E.INVALID_HANDLE); if (f.i >= f.entries.length) return c.fail(E.NO_MORE_FILES); writeFindData(c.arg(1), f.entries[f.i++], false); return 1; }];
  K.FindNextFileW = [2, (c) => { const f = c.proc.handles.getAs(c.arg(0), 'find'); if (!f) return c.fail(E.INVALID_HANDLE); if (f.i >= f.entries.length) return c.fail(E.NO_MORE_FILES); writeFindData(c.arg(1), f.entries[f.i++], true); return 1; }];
  K.FindClose = [1, (c) => (c.proc.handles.close(c.arg(0)) ? 1 : c.fail(E.INVALID_HANDLE))];

  // File mappings (read the whole file into a private region; writes are not flushed back)
  K.CreateFileMappingA = [6, (c) => {
    const h = c.arg(0) >>> 0;
    const f = h === INVALID_HANDLE ? null : fileOf(c, h);
    if (h !== INVALID_HANDLE && !f?.file) return c.fail(E.INVALID_HANDLE);
    const size = c.arg(4) + c.arg(3) * 4294967296 || f?.file.size() || 0;
    return c.proc.handles.create({ type: 'mapping', file: f, size, views: [] });
  }];
  K.CreateFileMappingW = K.CreateFileMappingA;
  K.OpenFileMappingA = [3, (c) => c.fail(E.FILE_NOT_FOUND)];
  K.MapViewOfFile = [5, (c) => {
    const m = c.proc.handles.getAs(c.arg(0), 'mapping'); if (!m) return c.fail(E.INVALID_HANDLE);
    const off = c.arg(3) + c.arg(2) * 4294967296; const n = c.arg(4) || (m.size - off);
    const base = c.proc.vmem.alloc(n, 4, 'mapview'); if (!base) return c.fail(E.NOT_ENOUGH_MEMORY);
    if (m.file) { const d = m.file.file.read(off, n); mem.writeBytes(base, d); if (d.length < n) mem.fill(base + d.length, n - d.length, 0); } else mem.fill(base, n, 0);
    m.views.push(base); return base;
  }];
  K.MapViewOfFileEx = [6, (c) => K.MapViewOfFile[1](c)];
  K.UnmapViewOfFile = [1, (c) => { const q = c.proc.vmem.query(c.arg(0)); c.proc.vmem.release(c.arg(0)); vm.invalidateCode(c.arg(0), q.size || 0x1000); return 1; }];
  K.FlushViewOfFile = [2, () => 1];

  // INI files
  const iniRead = (c, path) => { const d = vm.vfs.readFile(c.proc.path(path)); return d ? decodeBytes(d, 0) : ''; };
  const iniGet = (text, section, key) => {
    let cur = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) { cur = line.slice(1, line.indexOf(']')).toLowerCase(); continue; }
      const eq = line.indexOf('=');
      if (eq > 0 && cur === section.toLowerCase() && line.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) return line.slice(eq + 1).trim();
    }
    return null;
  };
  K.GetPrivateProfileStringA = [6, (c) => {
    const v = iniGet(iniRead(c, c.str(5) ?? ''), c.str(0) ?? '', c.str(1) ?? '') ?? c.str(2) ?? '';
    const n = Math.min(v.length, c.arg(4) - 1); mem.writeCString(c.arg(3), v.slice(0, n)); return n;
  }];
  K.GetPrivateProfileIntA = [4, (c) => { const v = iniGet(iniRead(c, c.str(3) ?? ''), c.str(0) ?? '', c.str(1) ?? ''); return v === null ? c.arg(2) : (parseInt(v, 10) | 0) >>> 0; }];
  const iniWrite = (c, path, text) => {
    const full = c.proc.path(path);
    const f = vm.vfs.open(full, { write: true, create: true, truncate: true });
    if (!f) return false;
    const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    f.write(0, bytes); f.truncate(bytes.length); f.close();
    return true;
  };
  /** section == null: delete the section; key == null: delete the key; else set (or append) key=value */
  const iniSet = (text, section, key, value) => {
    const lines = text.length ? text.split(/\r?\n/) : [];
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const isHdr = (l) => l.trim().startsWith('[');
    const hdrName = (l) => l.trim().slice(1, l.trim().indexOf(']')).toLowerCase();
    let start = lines.findIndex((l) => isHdr(l) && hdrName(l) === section.toLowerCase());
    let end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && isHdr(l)); if (start >= 0 && end < 0) end = lines.length;
    if (key === null) { if (start >= 0) lines.splice(start, end - start); return lines.join('\r\n') + '\r\n'; }
    if (start < 0) { if (value === null) return text; if (lines.length && lines[lines.length - 1].trim() !== '') lines.push(''); lines.push(`[${section}]`, `${key}=${value}`); return lines.join('\r\n') + '\r\n'; }
    const idx = lines.findIndex((l, i) => i > start && i < end && !isHdr(l) && l.indexOf('=') > 0 && l.slice(0, l.indexOf('=')).trim().toLowerCase() === key.toLowerCase());
    if (value === null) { if (idx >= 0) lines.splice(idx, 1); }
    else if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.splice(end, 0, `${key}=${value}`);
    return lines.join('\r\n') + '\r\n';
  };
  K.WritePrivateProfileStringA = [4, (c) => {
    const section = c.str(0), key = c.str(1), value = c.str(2), file = c.str(3);
    if (!file || !section) return c.fail(E.INVALID_PARAMETER);
    const text = iniSet(iniRead(c, file), section, key, value);
    if (!iniWrite(c, file, text)) return c.fail(E.ACCESS_DENIED);
    vm.log('file', `ini write ${file} [${section}] ${key}=${value}`);
    return 1;
  }];
  K.WritePrivateProfileStringW = [4, (c) => K.WritePrivateProfileStringA[1]({ ...c, str: (i) => c.wstr(i) })];
  K.GetPrivateProfileSectionA = [4, (c) => {
    const text = iniRead(c, c.str(3) ?? ''), section = (c.str(0) ?? '').toLowerCase();
    let cur = '', out = '';
    for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (line.startsWith('[')) { cur = line.slice(1, line.indexOf(']')).toLowerCase(); continue; } if (cur === section && line && !line.startsWith(';')) out += line + '\0'; }
    const max = c.arg(2); if (max < 2) return 0;
    const s = out.slice(0, max - 2); mem.writeCString(c.arg(1), s); mem.write8(c.arg(1) + s.length + 1, 0);
    return s.length;
  }];
  K.GetPrivateProfileSectionNamesA = [3, (c) => {
    const text = iniRead(c, c.str(2) ?? '');
    let out = '';
    for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (line.startsWith('[')) out += line.slice(1, line.indexOf(']')) + '\0'; }
    const max = c.arg(1); if (max < 2) return 0;
    const s = out.slice(0, max - 2); mem.writeCString(c.arg(0), s); mem.write8(c.arg(0) + s.length + 1, 0);
    return s.length;
  }];
  K.GetProfileIntA = [3, (c) => c.arg(2)];
  K.GetProfileStringA = [5, (c) => { const v = c.str(2) ?? ''; mem.writeCString(c.arg(3), v, c.arg(4)); return v.length; }];

  // ---------------------------------------------------------------- environment
  K.GetEnvironmentStrings = [0, (c) => allocString(c, c.proc.envBlock())];
  K.GetEnvironmentStringsA = K.GetEnvironmentStrings;
  K.GetEnvironmentStringsW = [0, (c) => allocWString(c, c.proc.envBlock())];
  K.FreeEnvironmentStringsA = [1, (c) => { c.proc.processHeap.free_(c.arg(0)); return 1; }];
  K.FreeEnvironmentStringsW = K.FreeEnvironmentStringsA;
  const envGet = (proc, name) => { for (const [k, v] of proc.env) if (k.toLowerCase() === name.toLowerCase()) return v; return null; };
  K.GetEnvironmentVariableA = [3, (c) => { const v = envGet(c.proc, c.str(0) ?? ''); if (v === null) return c.fail(E.ENVVAR_NOT_FOUND); if (c.arg(2) <= v.length) return v.length + 1; mem.writeCString(c.arg(1), v); return v.length; }];
  K.GetEnvironmentVariableW = [3, (c) => { const v = envGet(c.proc, c.wstr(0) ?? ''); if (v === null) return c.fail(E.ENVVAR_NOT_FOUND); if (c.arg(2) <= v.length) return v.length + 1; mem.writeWString(c.arg(1), v); return v.length; }];
  K.SetEnvironmentVariableA = [2, (c) => { const k = c.str(0) ?? ''; const v = c.str(1); for (const key of c.proc.env.keys()) if (key.toLowerCase() === k.toLowerCase()) c.proc.env.delete(key); if (v !== null) c.proc.env.set(k, v); return 1; }];
  K.SetEnvironmentVariableW = [2, (c) => { const k = c.wstr(0) ?? ''; const v = c.wstr(1); for (const key of c.proc.env.keys()) if (key.toLowerCase() === k.toLowerCase()) c.proc.env.delete(key); if (v !== null) c.proc.env.set(k, v); return 1; }];
  K.ExpandEnvironmentStringsA = [3, (c) => { const s = (c.str(0) ?? '').replace(/%([^%]+)%/g, (m, k) => envGet(c.proc, k) ?? m); if (c.arg(2) <= s.length) return s.length + 1; mem.writeCString(c.arg(1), s); return s.length + 1; }];

  // ---------------------------------------------------------------- strings, code pages, locale
  K.lstrlenA = [1, (c) => (c.arg(0) ? mem.readCString(c.arg(0)).length : 0)];
  K.lstrlenW = [1, (c) => (c.arg(0) ? mem.readWString(c.arg(0)).length : 0)];
  K.lstrcpyA = [2, (c) => { mem.writeCString(c.arg(0), mem.readCString(c.arg(1))); return c.arg(0); }];
  K.lstrcpyW = [2, (c) => { mem.writeWString(c.arg(0), mem.readWString(c.arg(1))); return c.arg(0); }];
  K.lstrcpynA = [3, (c) => { mem.writeCString(c.arg(0), mem.readCString(c.arg(1)), c.arg(2)); return c.arg(0); }];
  K.lstrcpynW = [3, (c) => { mem.writeWString(c.arg(0), mem.readWString(c.arg(1)), c.arg(2)); return c.arg(0); }];
  K.lstrcatA = [2, (c) => { const d = mem.readCString(c.arg(0)); mem.writeCString(c.arg(0), d + mem.readCString(c.arg(1))); return c.arg(0); }];
  K.lstrcatW = [2, (c) => { const d = mem.readWString(c.arg(0)); mem.writeWString(c.arg(0), d + mem.readWString(c.arg(1))); return c.arg(0); }];
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0) >>> 0;
  K.lstrcmpA = [2, (c) => cmp(mem.readCString(c.arg(0)), mem.readCString(c.arg(1)))];
  K.lstrcmpiA = [2, (c) => cmp(mem.readCString(c.arg(0)).toLowerCase(), mem.readCString(c.arg(1)).toLowerCase())];
  K.lstrcmpW = [2, (c) => cmp(mem.readWString(c.arg(0)), mem.readWString(c.arg(1)))];
  K.lstrcmpiW = [2, (c) => cmp(mem.readWString(c.arg(0)).toLowerCase(), mem.readWString(c.arg(1)).toLowerCase())];
  K.GetACP = [0, () => 1252];
  K.GetOEMCP = [0, () => 437];
  K.IsValidCodePage = [1, (c) => ([0, 1, 437, 850, 1200, 1252, 28591, 65001].includes(c.arg(0)) ? 1 : 0)];
  K.GetCPInfo = [2, (c) => { const p = c.arg(1); mem.write32(p, c.arg(0) === CP_UTF8 ? 4 : 1); mem.write8(p + 4, 0x3f); mem.fill(p + 5, 13, 0); return 1; }];
  K.GetCPInfoExA = [3, (c) => { const p = c.arg(2); mem.write32(p, 1); mem.write8(p + 4, 0x3f); mem.fill(p + 5, 13, 0); mem.write32(p + 18, 0x3f); mem.write32(p + 22, c.arg(0) || 1252); mem.writeCString(p + 26, 'ANSI - Latin I', 260); return 1; }];
  K.IsDBCSLeadByte = [1, () => 0];
  K.IsDBCSLeadByteEx = [2, () => 0];
  K.MultiByteToWideChar = [6, (c) => {
    const cp = c.arg(0), src = c.arg(2), srcLen = c.sarg(3), dst = c.arg(4), dstLen = c.arg(5);
    let bytes;
    if (srcLen < 0) { const s = mem.readCString(src); bytes = mem.bytes(src, s.length + 1); }
    else bytes = mem.bytes(src, srcLen);
    const s = decodeBytes(bytes, cp);
    if (dstLen === 0) return s.length;
    if (s.length > dstLen) return c.fail(E.INSUFFICIENT_BUFFER);
    for (let i = 0; i < s.length; i++) mem.write16(dst + 2 * i, s.charCodeAt(i));
    return s.length;
  }];
  K.WideCharToMultiByte = [8, (c) => {
    const cp = c.arg(0), src = c.arg(2), srcLen = c.sarg(3), dst = c.arg(4), dstLen = c.arg(5), defUsed = c.arg(7);
    const s = srcLen < 0 ? mem.readWString(src) + '\0' : mem.readWString(src, srcLen).padEnd(0) ;
    let str = srcLen < 0 ? s : (() => { let t = ''; for (let i = 0; i < srcLen; i++) t += String.fromCharCode(mem.read16(src + 2 * i)); return t; })();
    const { bytes, lossy } = encodeString(str, cp);
    if (defUsed) mem.write32(defUsed, lossy ? 1 : 0);
    if (dstLen === 0) return bytes.length;
    if (bytes.length > dstLen) return c.fail(E.INSUFFICIENT_BUFFER);
    mem.writeBytes(dst, bytes);
    return bytes.length;
  }];
  const ctype1 = (ch) => {
    const c = ch.charCodeAt(0);
    let t = 0;
    if (/\p{Lu}/u.test(ch)) t |= 0x101; else if (/\p{Ll}/u.test(ch)) t |= 0x102; else if (/\p{L}/u.test(ch)) t |= 0x100;
    if (c >= 48 && c <= 57) t |= 4;
    if (c === 32 || (c >= 9 && c <= 13)) t |= 8;
    if (c === 32 || c === 9) t |= 0x40;
    if (c < 32 || c === 127) t |= 0x20;
    if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) t |= 0x10;
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) t |= 0x80;
    if (c > 127 && !(t & 0x100)) t |= 0x10;
    return t;
  };
  K.GetStringTypeA = [5, (c) => { const s = c.sarg(3) < 0 ? mem.readCString(c.arg(2)) : decodeBytes(mem.bytes(c.arg(2), c.arg(3)), 0); for (let i = 0; i < s.length; i++) mem.write16(c.arg(4) + 2 * i, c.arg(1) === 1 ? ctype1(s[i]) : 0); return 1; }];
  K.GetStringTypeExA = [5, (c) => K.GetStringTypeA[1](c)];
  K.GetStringTypeW = [4, (c) => { const s = c.sarg(2) < 0 ? mem.readWString(c.arg(1)) : mem.readWString(c.arg(1), c.arg(2)); for (let i = 0; i < s.length; i++) mem.write16(c.arg(3) + 2 * i, c.arg(0) === 1 ? ctype1(s[i]) : 0); return 1; }];
  const lcmap = (c, s, flags) => {
    let r = s;
    if (flags & 0x100) r = r.toLowerCase();
    if (flags & 0x200) r = r.toUpperCase();
    return r;
  };
  K.LCMapStringA = [6, (c) => {
    const flags = c.arg(1), src = c.arg(2), n = c.sarg(3), dst = c.arg(4), dn = c.arg(5);
    const s = n < 0 ? mem.readCString(src) : decodeBytes(mem.bytes(src, n), 0);
    const r = lcmap(c, s, flags);
    const { bytes } = encodeString(r, 0);
    const out = n < 0 ? bytes.length + 1 : bytes.length;
    if (dn === 0) return out;
    if (out > dn) return c.fail(E.INSUFFICIENT_BUFFER);
    mem.writeBytes(dst, bytes); if (n < 0) mem.write8(dst + bytes.length, 0);
    return out;
  }];
  K.LCMapStringW = [6, (c) => {
    const flags = c.arg(1), src = c.arg(2), n = c.sarg(3), dst = c.arg(4), dn = c.arg(5);
    const s = n < 0 ? mem.readWString(src) : mem.readWString(src, n);
    const r = lcmap(c, s, flags);
    const out = n < 0 ? r.length + 1 : r.length;
    if (dn === 0) return out;
    if (out > dn) return c.fail(E.INSUFFICIENT_BUFFER);
    for (let i = 0; i < r.length; i++) mem.write16(dst + 2 * i, r.charCodeAt(i)); if (n < 0) mem.write16(dst + 2 * r.length, 0);
    return out;
  }];
  const compareStr = (a, b, flags) => { if (flags & 1) { a = a.toLowerCase(); b = b.toLowerCase(); } return a < b ? 1 : a > b ? 3 : 2; };
  K.CompareStringA = [6, (c) => { const a = c.sarg(3) < 0 ? mem.readCString(c.arg(2)) : decodeBytes(mem.bytes(c.arg(2), c.arg(3)), 0); const b = c.sarg(5) < 0 ? mem.readCString(c.arg(4)) : decodeBytes(mem.bytes(c.arg(4), c.arg(5)), 0); return compareStr(a, b, c.arg(1)); }];
  K.CompareStringW = [6, (c) => { const a = c.sarg(3) < 0 ? mem.readWString(c.arg(2)) : mem.readWString(c.arg(2), c.arg(3)); const b = c.sarg(5) < 0 ? mem.readWString(c.arg(4)) : mem.readWString(c.arg(4), c.arg(5)); return compareStr(a, b, c.arg(1)); }];
  const LOCALE = { 0x1: '0409', 0x2: 'English', 0x3: 'ENU', 0x4: 'English (United States)', 0x5: '0409', 0x6: 'United States', 0x7: 'USA', 0x8: 'United States', 0x9: 'English', 0xa: 'English', 0xb: '0409', 0xc: 'English (United States)', 0xe: '$', 0xf: ',', 0x10: '.', 0x11: '1', 0x12: ';', 0x13: '.', 0x14: '2', 0x15: '3', 0x16: '0', 0x17: '0', 0x19: '2', 0x1a: '1', 0x1b: '0', 0x1c: '/', 0x1d: ':', 0x1f: 'M/d/yyyy', 0x20: 'dddd, MMMM dd, yyyy', 0x1003: 'h:mm:ss tt', 0x21: '0', 0x22: '0', 0x23: '0', 0x24: '0', 0x25: '0', 0x28: 'AM', 0x29: 'PM', 0x1004: '1252', 0x1006: '850', 0x1009: '0', 0x1011: '1', 0x1012: '1', 0x1000: 'M/d/yyyy', 0x1001: 'English', 0x1002: 'United States', 0x5a: '0', 0x5b: '0', 0x5c: 'eng', 0x5d: 'USA', 0x1000e: ',', 0x1000f: '.', 0x59: '1', 0x2a: 'Monday', 0x2b: 'Tuesday', 0x2c: 'Wednesday', 0x2d: 'Thursday', 0x2e: 'Friday', 0x2f: 'Saturday', 0x30: 'Sunday', 0x38: 'January', 0x39: 'February', 0x3a: 'March', 0x3b: 'April', 0x3c: 'May', 0x3d: 'June', 0x3e: 'July', 0x3f: 'August', 0x40: 'September', 0x41: 'October', 0x42: 'November', 0x43: 'December', 0x31: 'Mon', 0x32: 'Tue', 0x33: 'Wed', 0x34: 'Thu', 0x35: 'Fri', 0x36: 'Sat', 0x37: 'Sun', 0x44: 'Jan', 0x45: 'Feb', 0x46: 'Mar', 0x47: 'Apr', 0x48: 'May', 0x49: 'Jun', 0x4a: 'Jul', 0x4b: 'Aug', 0x4c: 'Sep', 0x4d: 'Oct', 0x4e: 'Nov', 0x4f: 'Dec' };
  const localeInfo = (c, wide) => {
    const type = c.arg(1) & 0xffff;
    const s = LOCALE[type];
    if (s === undefined) { vm.warn(`GetLocaleInfo: unknown LCTYPE 0x${c.arg(1).toString(16)}`); return c.fail(E.INVALID_PARAMETER); }
    const n = c.arg(3);
    if (n === 0) return s.length + 1;
    if (n <= s.length) return c.fail(E.INSUFFICIENT_BUFFER);
    if (c.arg(1) & 0x20000000) { mem.write32(c.arg(2), parseInt(s, 10) | 0); return 2; }
    if (wide) mem.writeWString(c.arg(2), s); else mem.writeCString(c.arg(2), s);
    return s.length + 1;
  };
  K.GetLocaleInfoA = [4, (c) => localeInfo(c, false)];
  K.GetLocaleInfoW = [4, (c) => localeInfo(c, true)];
  K.GetUserDefaultLCID = [0, () => 0x409];
  K.GetSystemDefaultLCID = [0, () => 0x409];
  K.GetUserDefaultLangID = [0, () => 0x409];
  K.GetSystemDefaultLangID = [0, () => 0x409];
  K.GetThreadLocale = [0, () => 0x409];
  K.SetThreadLocale = [1, () => 1];
  K.GetUserDefaultUILanguage = [0, () => 0x409];
  K.GetSystemDefaultUILanguage = [0, () => 0x409];
  K.IsValidLocale = [2, () => 1];
  K.EnumSystemLocalesA = [2, (c) => { vm.callGuest(c.thread, c.arg(0), [allocString(c, '00000409')]); return 1; }];
  K.GetDateFormatA = [6, (c) => { const ms = c.arg(3) ? readSystemTimeMs(mem, c.arg(3)) : vm.clock.wall(); const d = new Date(ms); const s = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; if (c.arg(5) === 0) return s.length + 1; mem.writeCString(c.arg(4), s, c.arg(5)); return s.length + 1; }];
  K.GetTimeFormatA = [6, (c) => { const ms = c.arg(3) ? readSystemTimeMs(mem, c.arg(3)) : vm.clock.wall(); const d = new Date(ms); const s = `${d.getUTCHours() % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`; if (c.arg(5) === 0) return s.length + 1; mem.writeCString(c.arg(4), s, c.arg(5)); return s.length + 1; }];
  K.FormatMessageA = [7, (c) => {
    const flags = c.arg(0), id = c.arg(2), buf = c.arg(4), size = c.arg(5);
    let s;
    if (flags & 0x1000) s = `Error ${id}.\r\n`;
    else if (flags & 0x400) s = mem.readCString(c.arg(1));
    else if (flags & 0x800) { const m = c.proc.moduleByHandle(c.arg(1)); s = `Message ${id} from ${m?.name ?? '?'}.\r\n`; }
    else s = `Message ${id}.\r\n`;
    if (flags & 0x100) { const p = c.proc.processHeap.alloc(s.length + 1); mem.writeCString(p, s); mem.write32(buf, p); return s.length; }
    if (size <= s.length) return c.fail(E.INSUFFICIENT_BUFFER);
    mem.writeCString(buf, s); return s.length;
  }];
  K.FormatMessageW = [7, (c) => { const s = `Error ${c.arg(2)}.\r\n`; if (c.arg(0) & 0x100) { const p = allocWString(c, s); mem.write32(c.arg(4), p); return s.length; } if (c.arg(5) <= s.length) return c.fail(E.INSUFFICIENT_BUFFER); mem.writeWString(c.arg(4), s); return s.length; }];
  K.AreFileApisANSI = [0, () => 1];
  K.SetFileApisToANSI = [0, () => {}];
  K.SetFileApisToOEM = [0, () => {}];

  // Atoms
  K.AddAtomA = [1, (c) => addAtom(c, c.str(0))];
  K.GlobalAddAtomA = [1, (c) => addAtom(c, c.str(0))];
  K.FindAtomA = [1, (c) => { const s = (c.str(0) ?? '').toLowerCase(); for (const [k, v] of c.proc.atoms) if (v.toLowerCase() === s) return k; return 0; }];
  K.GlobalFindAtomA = K.FindAtomA;
  K.DeleteAtom = [1, (c) => { c.proc.atoms.delete(c.arg(0)); return 0; }];
  K.GlobalDeleteAtom = K.DeleteAtom;
  K.GetAtomNameA = [3, (c) => { const s = c.proc.atoms.get(c.arg(0)); if (!s) return 0; mem.writeCString(c.arg(1), s, c.arg(2)); return Math.min(s.length, c.arg(2) - 1); }];
  K.GlobalGetAtomNameA = K.GetAtomNameA;
  function addAtom(c, s) {
    if (!s) return 0;
    if (s.startsWith('#')) return parseInt(s.slice(1), 10) & 0xffff;
    for (const [k, v] of c.proc.atoms) if (v.toLowerCase() === s.toLowerCase()) return k;
    const a = c.proc.nextAtom++; c.proc.atoms.set(a, s); return a;
  }

  api.define('kernel32.dll', K);
}

function readSystemTimeMs(mem, addr) {
  return Date.UTC(mem.read16(addr), mem.read16(addr + 2) - 1, mem.read16(addr + 6), mem.read16(addr + 8), mem.read16(addr + 10), mem.read16(addr + 12), mem.read16(addr + 14));
}

export { normalizeWin };
