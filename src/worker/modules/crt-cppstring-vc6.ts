/**
 * MSVC 6.0 (msvcp60) std::basic_string<char> layout helpers.
 * 16-byte object: allocator payload; char* _Ptr; unsigned _Len; unsigned _Res.
 * Empty strings point at static _Nullstr; non-empty storage is heap-backed.
 */

import { Mem } from "../core/memory/mem-accessor";

export const MSVC6_STRING_SIZE = 16;
/** CRT/guest heap blocks live well above the null/low stub page. */
const MIN_PLAUSIBLE_HEAP_PTR = 0x10000;

const OFF_ALLOC = 0;
const OFF_PTR = 4;
const OFF_LEN = 8;
const OFF_RES = 12;

export interface CppStringHeap {
    alloc(bytes: number): number;
    free(ptr: number): void;
}

function readU32(ptr: number): number {
    return Mem.readUint32(ptr) ?? 0;
}

function writeU32(ptr: number, value: number): void {
    Mem.writeUint32(ptr, value >>> 0);
}

function readSize(ptr: number): number {
    return readU32(ptr + OFF_LEN);
}

function writeSize(ptr: number, size: number): void {
    writeU32(ptr + OFF_LEN, size);
}

function readRes(ptr: number): number {
    return readU32(ptr + OFF_RES);
}

function writeRes(ptr: number, res: number): void {
    writeU32(ptr + OFF_RES, res);
}

function readDataPtr(ptr: number): number {
    return readU32(ptr + OFF_PTR);
}

function writeDataPtr(ptr: number, dataPtr: number): void {
    writeU32(ptr + OFF_PTR, dataPtr >>> 0);
}

function isHeap(ptr: number, nullstr: number): boolean {
    const data = readDataPtr(ptr);
    return data >= MIN_PLAUSIBLE_HEAP_PTR
        && data !== nullstr;
}

function readObjectBytes(src: number, nullstr: number): Uint8Array {
    const len = readSize(src);
    if (len === 0) return new Uint8Array(0);
    const data = readDataPtr(src);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = Mem.readUint8(data + i) ?? 0;
    }
    return bytes;
}

function readCStringBytes(cstr: number, count?: number): Uint8Array {
    if (!cstr) return new Uint8Array(0);
    if (count !== undefined) {
        const max = count >>> 0;
        const bytes = new Uint8Array(max);
        for (let i = 0; i < max; i++) {
            bytes[i] = Mem.readUint8(cstr + i) ?? 0;
        }
        return bytes;
    }
    const bytes: number[] = [];
    for (let i = 0; i < 0x100000; i++) {
        const b = Mem.readUint8(cstr + i);
        if (b === null || b === 0) break;
        bytes.push(b);
    }
    return Uint8Array.from(bytes);
}

function writeHeapBytes(buf: number, bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
        Mem.writeBytes(buf + i, new Uint8Array([bytes[i] & 0xff]));
    }
    Mem.writeBytes(buf + bytes.length, new Uint8Array([0]));
}

function setEmpty(ptr: number, nullstr: number): void {
    writeDataPtr(ptr, nullstr);
    writeSize(ptr, 0);
    writeRes(ptr, 0);
}

function initEmpty(ptr: number, nullstr: number): void {
    writeU32(ptr + OFF_ALLOC, 0);
    setEmpty(ptr, nullstr);
}

function freeHeapStorage(ptr: number, heap: CppStringHeap, nullstr: number): void {
    if (isHeap(ptr, nullstr)) {
        heap.free(readDataPtr(ptr));
    }
}

export function vc6StringTidy(ptr: number, built: boolean, heap: CppStringHeap, nullstr: number): void {
    if (built) {
        freeHeapStorage(ptr, heap, nullstr);
    }
    setEmpty(ptr, nullstr);
}

export function vc6StringGrow(
    ptr: number,
    newSize: number,
    trim: boolean,
    heap: CppStringHeap,
    nullstr: number,
): boolean {
    const need = newSize >>> 0;
    const curRes = readRes(ptr);
    const curLen = readSize(ptr);
    const curData = readDataPtr(ptr);
    const needsWritable = need > 0 && (curData === 0 || curData === nullstr);

    if (curRes < need || needsWritable) {
        const buf = heap.alloc(need + 1);
        if (!buf) return false;
        if (curLen > 0 && curData !== 0 && curData !== nullstr) {
            writeHeapBytes(buf, readObjectBytes(ptr, nullstr));
        } else {
            Mem.writeBytes(buf, new Uint8Array([0]));
        }
        freeHeapStorage(ptr, heap, nullstr);
        writeDataPtr(ptr, buf);
        writeRes(ptr, need);
        return true;
    }

    if (trim && need === 0) {
        vc6StringTidy(ptr, true, heap, nullstr);
    }
    return true;
}

export function vc6StringCopy(ptr: number, add: number, heap: CppStringHeap, nullstr: number): void {
    const target = readSize(ptr) + (add >>> 0);
    vc6StringGrow(ptr, Math.max(target, readRes(ptr)), false, heap, nullstr);
}

export function vc6StringSplit(ptr: number, heap: CppStringHeap, nullstr: number): void {
    vc6StringCopy(ptr, 0, heap, nullstr);
}

export function vc6StringEos(ptr: number, newSize: number, nullstr: number): void {
    const size = newSize >>> 0;
    const data = readDataPtr(ptr);
    if (size === 0) {
        if (data && data !== nullstr) {
            Mem.writeBytes(data, new Uint8Array([0]));
        }
        writeSize(ptr, 0);
        return;
    }
    Mem.writeBytes(data + size, new Uint8Array([0]));
    writeSize(ptr, size);
}

export function vc6StringReplace(ptr: number, bytes: Uint8Array, heap: CppStringHeap, nullstr: number): void {
    if (bytes.length === 0) {
        vc6StringTidy(ptr, true, heap, nullstr);
        return;
    }
    if (!vc6StringGrow(ptr, bytes.length, false, heap, nullstr)) return;
    writeHeapBytes(readDataPtr(ptr), bytes);
    writeSize(ptr, bytes.length);
}

export function vc6StringAssignRange(
    dst: number,
    src: number,
    pos: number,
    count: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const srcLen = readSize(src);
    const start = pos >>> 0;
    let n = count >>> 0;
    if (start > srcLen) n = 0;
    else if (start + n > srcLen) n = srcLen - start;

    const bytes = readObjectBytes(src, nullstr);
    vc6StringReplace(dst, bytes.subarray(start, start + n), heap, nullstr);
    return dst;
}

export function vc6StringAssignCStrCount(
    ptr: number,
    cstr: number,
    count: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const bytes = readCStringBytes(cstr, count >>> 0);
    vc6StringReplace(ptr, bytes, heap, nullstr);
    return ptr;
}

export function vc6StringErase(ptr: number, pos: number, count: number, nullstr: number): number {
    const len = readSize(ptr);
    const start = pos | 0;
    let n = count >>> 0;
    if (start < 0 || start > len) return ptr;
    if (n === 0xffffffff || start + n > len) n = len - start;

    const data = readDataPtr(ptr);
    for (let i = start; i + n < len; i++) {
        const b = Mem.readUint8(data + i + n) ?? 0;
        Mem.writeBytes(data + i, new Uint8Array([b]));
    }
    vc6StringEos(ptr, len - n, nullstr);
    return ptr;
}

export function vc6StringEqualsCStr(str: number, cstr: number, nullstr: number): number {
    const len = readSize(str);
    if (!cstr) return len === 0 ? 1 : 0;
    const data = readDataPtr(str);
    for (let i = 0; i < len; i++) {
        const sc = Mem.readUint8(data + i) ?? 0;
        const cc = Mem.readUint8(cstr + i);
        if (cc === null || cc !== sc) return 0;
    }
    const tail = Mem.readUint8(cstr + len);
    return tail === 0 ? 1 : 0;
}

function compareObjectBytes(a: number, b: number, nullstr: number): number {
    const aLen = readSize(a);
    const bLen = readSize(b);
    const aData = readDataPtr(a);
    const bData = readDataPtr(b);
    const min = Math.min(aLen, bLen);
    for (let i = 0; i < min; i++) {
        const ac = Mem.readUint8(aData + i) ?? 0;
        const bc = Mem.readUint8(bData + i) ?? 0;
        if (ac < bc) return -1;
        if (ac > bc) return 1;
    }
    if (aLen < bLen) return -1;
    if (aLen > bLen) return 1;
    return 0;
}

export function vc6StringEquals(strA: number, strB: number, nullstr: number): number {
    return compareObjectBytes(strA, strB, nullstr) === 0 ? 1 : 0;
}

export function vc6StringLess(strA: number, strB: number, nullstr: number): number {
    return compareObjectBytes(strA, strB, nullstr) < 0 ? 1 : 0;
}

export function vc6StringCStr(ptr: number, nullstr: number): number {
    const data = readDataPtr(ptr);
    return data || nullstr;
}

export function vc6StringFind(
    ptr: number,
    needle: number,
    pos: number,
    needleLen: number,
    nullstr: number,
): number {
    const hayLen = readSize(ptr);
    const start = pos >>> 0;
    if (start > hayLen) return 0xffffffff;
    const nLen = needleLen >>> 0;
    if (nLen === 0) return start;
    if (!needle || start + nLen > hayLen) return 0xffffffff;

    const hayData = readDataPtr(ptr);
    outer: for (let i = start; i + nLen <= hayLen; i++) {
        for (let j = 0; j < nLen; j++) {
            const hc = Mem.readUint8(hayData + i + j) ?? 0;
            const nc = Mem.readUint8(needle + j) ?? 0;
            if (hc !== nc) continue outer;
        }
        return i >>> 0;
    }
    return 0xffffffff;
}

export function vc6StringFindFirstOf(
    ptr: number,
    chars: number,
    pos: number,
    charCount: number,
    nullstr: number,
): number {
    const len = readSize(ptr);
    const start = pos >>> 0;
    if (start >= len || !chars) return 0xffffffff;
    const n = charCount >>> 0;
    const data = readDataPtr(ptr);
    for (let i = start; i < len; i++) {
        const c = Mem.readUint8(data + i) ?? 0;
        for (let j = 0; j < n; j++) {
            if ((Mem.readUint8(chars + j) ?? 0) === c) return i >>> 0;
        }
    }
    return 0xffffffff;
}

export function vc6StringFindLastOf(
    ptr: number,
    chars: number,
    pos: number,
    charCount: number,
    nullstr: number,
): number {
    const len = readSize(ptr);
    if (len === 0) return 0xffffffff;
    let start = pos >>> 0;
    if (start === 0xffffffff || start >= len) start = len - 1;
    const n = charCount >>> 0;
    const data = readDataPtr(ptr);
    for (let i = start; i >= 0; i--) {
        const c = Mem.readUint8(data + i) ?? 0;
        for (let j = 0; j < n; j++) {
            if ((Mem.readUint8(chars + j) ?? 0) === c) return i >>> 0;
        }
    }
    return 0xffffffff;
}

export function vc6StringInsert(
    ptr: number,
    pos: number,
    cstr: number,
    count: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const len = readSize(ptr);
    const at = pos >>> 0;
    const ins = readCStringBytes(cstr, count >>> 0);
    const cur = readObjectBytes(ptr, nullstr);
    const prefix = cur.subarray(0, Math.min(at, cur.length));
    const suffix = cur.subarray(Math.min(at, cur.length));
    const merged = new Uint8Array(prefix.length + ins.length + suffix.length);
    merged.set(prefix, 0);
    merged.set(ins, prefix.length);
    merged.set(suffix, prefix.length + ins.length);
    vc6StringReplace(ptr, merged, heap, nullstr);
    return ptr;
}

export function vc6StringAppendCStrCount(
    ptr: number,
    cstr: number,
    count: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const cur = readObjectBytes(ptr, nullstr);
    const add = readCStringBytes(cstr, count >>> 0);
    const merged = new Uint8Array(cur.length + add.length);
    merged.set(cur, 0);
    merged.set(add, cur.length);
    vc6StringReplace(ptr, merged, heap, nullstr);
    return ptr;
}

export function vc6StringAppendCharCount(
    ptr: number,
    count: number,
    ch: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const cur = readObjectBytes(ptr, nullstr);
    const n = count >>> 0;
    const merged = new Uint8Array(cur.length + n);
    merged.set(cur, 0);
    merged.fill(ch & 0xff, cur.length);
    vc6StringReplace(ptr, merged, heap, nullstr);
    return ptr;
}

export function vc6StringCtorCStr(
    ptr: number,
    cstr: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    initEmpty(ptr, nullstr);
    if (cstr) {
        const bytes = readCStringBytes(cstr);
        vc6StringReplace(ptr, bytes, heap, nullstr);
    }
    return ptr;
}

export function vc6StringCopyCtor(
    dst: number,
    src: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    initEmpty(dst, nullstr);
    vc6StringReplace(dst, readObjectBytes(src, nullstr), heap, nullstr);
    return dst;
}

export function vc6StringConcat(
    dst: number,
    left: number,
    right: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const l = readObjectBytes(left, nullstr);
    const r = readObjectBytes(right, nullstr);
    const merged = new Uint8Array(l.length + r.length);
    merged.set(l, 0);
    merged.set(r, l.length);
    vc6StringReplace(dst, merged, heap, nullstr);
    return dst;
}

export function vc6StringConcatCStrLeft(
    dst: number,
    leftCstr: number,
    right: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const l = readCStringBytes(leftCstr);
    const r = readObjectBytes(right, nullstr);
    const merged = new Uint8Array(l.length + r.length);
    merged.set(l, 0);
    merged.set(r, l.length);
    vc6StringReplace(dst, merged, heap, nullstr);
    return dst;
}

export function vc6StringConcatCStrRight(
    dst: number,
    left: number,
    rightCstr: number,
    heap: CppStringHeap,
    nullstr: number,
): number {
    const l = readObjectBytes(left, nullstr);
    const r = readCStringBytes(rightCstr);
    const merged = new Uint8Array(l.length + r.length);
    merged.set(l, 0);
    merged.set(r, l.length);
    vc6StringReplace(dst, merged, heap, nullstr);
    return dst;
}
