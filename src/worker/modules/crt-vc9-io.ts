/**
 * VC9 CRT file/time I/O — find64, stat64, file64, time64.
 */

import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import type { VfsEntry, VfsFileHandle } from "../runtime/filesystem/vfs";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { getCPU } from "../core/thunking/thunk-utils";
import { ArrayVaListReader, scanCLazy } from "./crt-format";

export interface Vc9IoHost {
    process: { v86: unknown };
    readCString(ptr: number, maxLen?: number): string;
    setErrno(code: number): boolean;
    statImpl(pathPtr: number, structPtr: number, wide: boolean): number;
    fseek(filePtr: number, offset: number, origin: number): number;
    ftell(filePtr: number): number;
    filelength(fd: number): number;
    fileStreams: Map<number, { fd: number; handle: VfsFileHandle; ungetChar: number }>;
    malloc(size: number): number;
    writeCString(ptr: number, value: string): void;
    memset(ptr: number, val: number, size: number): number;
}

interface FindState {
    entries: VfsEntry[];
    index: number;
}

let nextFindHandle = 0x4000;
const findHandles = new Map<number, FindState>();

function parseFilespec(filespec: string): { dir: string; pattern: string } {
    const normalized = filespec.replace(/\//g, "\\");
    const slash = normalized.lastIndexOf("\\");
    if (slash < 0) return { dir: ".", pattern: normalized };
    return { dir: normalized.slice(0, slash) || ".", pattern: normalized.slice(slash + 1) };
}

function matchWildcard(name: string, pattern: string): boolean {
    if (pattern === "*" || pattern === "*.*") return true;
    const re = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
        "i",
    );
    return re.test(name);
}

/** __finddata64_t — minimal fields used by games (name @0, size @32 as int64). */
const FINDDATA64I32_SIZE = 296;
const FINDDATA64I32_ATTRIB_OFFSET = 0;
const FINDDATA64I32_SIZE_OFFSET = 32;
const FINDDATA64I32_NAME_OFFSET = 36;
const FINDDATA64I32_NAME_CHARS = 260;

/** _finddata64i32_t: 64-bit timestamps, 32-bit size, char name[260]. */
function fillFindData64i32(structPtr: number, entry: VfsEntry, host: Vc9IoHost): void {
    host.memset(structPtr, 0, FINDDATA64I32_SIZE);
    const name = entry.name;
    const nameBytes = new Uint8Array(FINDDATA64I32_NAME_CHARS);
    const nameLen = Math.min(name.length, FINDDATA64I32_NAME_CHARS - 1);
    for (let i = 0; i < nameLen; i++) {
        nameBytes[i] = name.charCodeAt(i) & 0xff;
    }
    Mem.writeBytes(structPtr + FINDDATA64I32_NAME_OFFSET, nameBytes);
    Mem.writeUint32(structPtr + FINDDATA64I32_SIZE_OFFSET, entry.size >>> 0);
    Mem.writeUint32(structPtr + FINDDATA64I32_ATTRIB_OFFSET, 0x8000 | 0x0100);
}

/** __stat64 — st_size at +32 (int64). */
function fillStat64(structPtr: number, size: number, host: Vc9IoHost): void {
    host.memset(structPtr, 0, 56);
    Mem.writeUint32(structPtr + 4, 0x8000 | 0x0100);
    Mem.writeUint32(structPtr + 32, size >>> 0);
    Mem.writeUint32(structPtr + 36, 0);
}

/** struct _stat — st_mode at +4, st_size at +20 (32-bit MSVCRT). */
function fillStat32(structPtr: number, size: number, host: Vc9IoHost): void {
    host.memset(structPtr, 0, 48);
    Mem.writeUint32(structPtr + 4, 0x8000 | 0x0100);
    Mem.writeUint32(structPtr + 20, size >>> 0);
}

/** struct _finddata_t — size at +16, name[260] at +20. */
const FINDDATA32_SIZE = 280;
const FINDDATA32_ATTRIB_OFFSET = 0;
const FINDDATA32_SIZE_OFFSET = 16;
const FINDDATA32_NAME_OFFSET = 20;
const FINDDATA32_NAME_CHARS = 260;

function fillFindData32(structPtr: number, entry: VfsEntry, host: Vc9IoHost): void {
    host.memset(structPtr, 0, FINDDATA32_SIZE);
    const name = entry.name;
    const nameBytes = new Uint8Array(FINDDATA32_NAME_CHARS);
    const nameLen = Math.min(name.length, FINDDATA32_NAME_CHARS - 1);
    for (let i = 0; i < nameLen; i++) {
        nameBytes[i] = name.charCodeAt(i) & 0xff;
    }
    Mem.writeBytes(structPtr + FINDDATA32_NAME_OFFSET, nameBytes);
    Mem.writeUint32(structPtr + FINDDATA32_SIZE_OFFSET, entry.size >>> 0);
    Mem.writeUint32(structPtr + FINDDATA32_ATTRIB_OFFSET, 0x8000 | 0x0100);
}

let asctimeBuf = 0;

export function registerVc9IoExports(exports: Record<string, ThunkImplementation>, host: Vc9IoHost): void {
    exports["_stat64i32"] = (_ctx, _mem, args) => {
        const pathPtr = args[0] ?? 0;
        const structPtr = args[1] ?? 0;
        if (!pathPtr || !structPtr) {
            host.setErrno(22);
            return -1;
        }
        const path = host.readCString(pathPtr, 512);
        const vfs = System.getInstance().fileSystem;
        const exists = vfs.hasRomFile(path) || vfs.openSync(path, 0x80000000, 3) !== null;
        if (!exists) {
            host.setErrno(2);
            return -1;
        }
        fillStat64(structPtr, vfs.getFileSize(path), host);
        return 0;
    };

    exports["_fstat64i32"] = (_ctx, _mem, args) => {
        const fd = args[0] ?? 0;
        const structPtr = args[1] ?? 0;
        if (!structPtr) {
            host.setErrno(22);
            return -1;
        }
        const len = host.filelength(fd);
        if (len < 0) {
            host.setErrno(9);
            return -1;
        }
        fillStat64(structPtr, len, host);
        return 0;
    };

    exports["_fstat"] = (_ctx, _mem, args) => {
        const fd = args[0] ?? 0;
        const structPtr = args[1] ?? 0;
        if (!structPtr) {
            host.setErrno(22);
            return -1;
        }
        const len = host.filelength(fd);
        if (len < 0) {
            host.setErrno(9);
            return -1;
        }
        fillStat32(structPtr, len, host);
        return 0;
    };

    exports["_findfirst64i32"] = (_ctx, _mem, args) => {
        const filespecPtr = args[0] ?? 0;
        const dataPtr = args[1] ?? 0;
        if (!filespecPtr || !dataPtr) {
            host.setErrno(22);
            return -1;
        }
        const { dir, pattern } = parseFilespec(host.readCString(filespecPtr, 512));
        const vfs = System.getInstance().fileSystem;
        const cwd = (System.getInstance() as { currentDirectory?: string }).currentDirectory || "C:\\";
        let searchDir = dir;
        if (!searchDir.match(/^[A-Za-z]:/)) {
            searchDir = cwd.endsWith("\\") ? cwd + searchDir : `${cwd}\\${searchDir}`;
        }
        const all = vfs.listDirectory(searchDir);
        const matched = all.filter((e) => matchWildcard(e.name, pattern));
        if (matched.length === 0) {
            host.setErrno(2);
            return -1;
        }
        const handle = nextFindHandle++;
        findHandles.set(handle, { entries: matched, index: 0 });
        fillFindData64i32(dataPtr, matched[0]!, host);
        return handle;
    };

    exports["_findfirst"] = (_ctx, _mem, args) => {
        const filespecPtr = args[0] ?? 0;
        const dataPtr = args[1] ?? 0;
        if (!filespecPtr || !dataPtr) {
            host.setErrno(22);
            return -1;
        }
        const { dir, pattern } = parseFilespec(host.readCString(filespecPtr, 512));
        const vfs = System.getInstance().fileSystem;
        const cwd = (System.getInstance() as { currentDirectory?: string }).currentDirectory || "C:\\";
        let searchDir = dir;
        if (!searchDir.match(/^[A-Za-z]:/)) {
            searchDir = cwd.endsWith("\\") ? cwd + searchDir : `${cwd}\\${searchDir}`;
        }
        const all = vfs.listDirectory(searchDir);
        const matched = all.filter((e) => matchWildcard(e.name, pattern));
        if (matched.length === 0) {
            host.setErrno(2);
            return -1;
        }
        const handle = nextFindHandle++;
        findHandles.set(handle, { entries: matched, index: 0 });
        fillFindData32(dataPtr, matched[0]!, host);
        return handle;
    };

    exports["_findnext64i32"] = (_ctx, _mem, args) => {
        const handle = args[0] ?? 0;
        const dataPtr = args[1] ?? 0;
        const state = findHandles.get(handle);
        if (!state || !dataPtr) {
            host.setErrno(18);
            return -1;
        }
        state.index++;
        if (state.index >= state.entries.length) {
            host.setErrno(18);
            return -1;
        }
        fillFindData64i32(dataPtr, state.entries[state.index]!, host);
        return 0;
    };

    exports["_findnext"] = (_ctx, _mem, args) => {
        const handle = args[0] ?? 0;
        const dataPtr = args[1] ?? 0;
        const state = findHandles.get(handle);
        if (!state || !dataPtr) {
            host.setErrno(18);
            return -1;
        }
        state.index++;
        if (state.index >= state.entries.length) {
            host.setErrno(18);
            return -1;
        }
        fillFindData32(dataPtr, state.entries[state.index]!, host);
        return 0;
    };

    exports["_findclose"] = (_ctx, _mem, args) => {
        const handle = args[0] ?? 0;
        if (!findHandles.delete(handle)) {
            host.setErrno(9);
            return -1;
        }
        return 0;
    };

    exports["_filelengthi64"] = (_ctx, _mem, args) => {
        const fd = args[0] ?? 0;
        const len = host.filelength(fd);
        if (len < 0) return -1;
        const cpu = getCPU(host.process.v86);
        if (cpu?.reg32) cpu.reg32[2] = 0;
        return len >>> 0;
    };

    exports["_ftelli64"] = (_ctx, _mem, args) => {
        const pos = host.ftell(args[0] ?? 0);
        if (pos < 0) return -1;
        const cpu = getCPU(host.process.v86);
        if (cpu?.reg32) cpu.reg32[2] = 0;
        return pos >>> 0;
    };

    exports["_fseeki64"] = (_ctx, _mem, args) => {
        const filePtr = args[0] ?? 0;
        const offsetLo = args[1] ?? 0;
        const origin = args[2] ?? 0;
        return host.fseek(filePtr, offsetLo | 0, origin);
    };

    exports["_time64"] = (_ctx, _mem, args) => {
        const timerPtr = args[0] ?? 0;
        const secs = Math.floor(Date.now() / 1000);
        const lo = secs >>> 0;
        const hi = Math.floor(secs / 0x100000000) | 0;
        if (timerPtr) {
            Mem.writeUint32(timerPtr, lo);
            Mem.writeUint32(timerPtr + 4, hi);
        }
        const cpu = getCPU(host.process.v86);
        if (cpu?.reg32) cpu.reg32[2] = hi;
        return lo;
    };

    exports["_localtime64"] = (_ctx, _mem, args) => {
        const timePtr = args[0] ?? 0;
        if (!timePtr) return 0;
        const lo = Mem.readUint32(timePtr) ?? 0;
        const hi = Mem.readUint32(timePtr + 4) ?? 0;
        const secs = lo + hi * 0x100000000;
        const date = new Date(secs * 1000);
        if (!asctimeBuf) {
            asctimeBuf = host.malloc(36);
        }
        const buf = asctimeBuf;
        Mem.writeUint32(buf + 0, date.getSeconds());
        Mem.writeUint32(buf + 4, date.getMinutes());
        Mem.writeUint32(buf + 8, date.getHours());
        Mem.writeUint32(buf + 12, date.getDate());
        Mem.writeUint32(buf + 16, date.getMonth());
        Mem.writeUint32(buf + 20, date.getFullYear() - 1900);
        Mem.writeUint32(buf + 24, date.getDay());
        const start = new Date(date.getFullYear(), 0, 1);
        const yday = Math.floor((date.getTime() - start.getTime()) / 86400000);
        Mem.writeUint32(buf + 28, yday);
        Mem.writeUint32(buf + 32, date.getTimezoneOffset() > 0 ? 1 : 0);
        return buf >>> 0;
    };

    exports["asctime"] = (_ctx, _mem, args) => {
        const tmPtr = args[0] ?? 0;
        if (!tmPtr) return 0;
        const mon = Mem.readUint32(tmPtr + 16) ?? 0;
        const mday = Mem.readUint32(tmPtr + 12) ?? 0;
        const hour = Mem.readUint32(tmPtr + 8) ?? 0;
        const min = Mem.readUint32(tmPtr + 4) ?? 0;
        const sec = Mem.readUint32(tmPtr + 0) ?? 0;
        const year = (Mem.readUint32(tmPtr + 20) ?? 0) + 1900;
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const text = `${months[mon] ?? "???"} ${String(mday).padStart(2, " ")} ${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")} ${year}\n`;
        if (!asctimeBuf) asctimeBuf = host.malloc(32);
        host.writeCString(asctimeBuf, text);
        return asctimeBuf >>> 0;
    };

    exports["fscanf"] = (_ctx, _mem, args) => {
        const filePtr = args[0] ?? 0;
        const fmtPtr = args[1] ?? 0;
        if (!filePtr || !fmtPtr) return -1;
        const stream = host.fileStreams.get(filePtr);
        if (!stream) return -1;
        const format = host.readCString(fmtPtr, 4096);
        // Minimal: no stream read — use empty input unless fgets buffer exists
        const input = "";
        let argIdx = 2;
        const reader = new ArrayVaListReader(args, argIdx);
        return scanCLazy(
            input,
            format,
            (addr, v) => Mem.writeUint32(addr, v >>> 0),
            (addr, v) => {
                const buf = new ArrayBuffer(8);
                const f = new Float64Array(buf);
                f[0] = v;
                const u = new Uint32Array(buf);
                Mem.writeUint32(addr, u[0] ?? 0);
                Mem.writeUint32(addr + 4, u[1] ?? 0);
            },
            () => reader.nextUint32(),
        );
    };

    exports["_gcvt"] = (_ctx, _mem, args) => {
        const ndigit = args[1] ?? 0;
        const bufPtr = args[2] ?? 0;
        if (!bufPtr) return 0;
        const lo = args[0] ?? 0;
        const buf = new ArrayBuffer(8);
        const u32 = new Uint32Array(buf);
        const f64 = new Float64Array(buf);
        u32[0] = lo >>> 0;
        u32[1] = 0;
        const val = f64[0];
        const text = Number.isFinite(val) ? val.toPrecision(Math.max(1, ndigit)) : "0";
        host.writeCString(bufPtr, text);
        return bufPtr >>> 0;
    };
}
