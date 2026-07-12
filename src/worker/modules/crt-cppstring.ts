/**
 * MSVC 2008 (v90) std::basic_string<char> layout helpers.
 * 24-byte object: union { char[16] | char* } + size + capacity (SSO when capacity < 16).
 */

import { Mem } from "../core/memory/mem-accessor";

export const MSVC08_STRING_SIZE = 24;
const SSO_CAPACITY = 15; // _Myres < 16 → inline buffer

export interface CppStringHeap {
    alloc(bytes: number): number;
    free(ptr: number): void;
}

const OFF_SIZE = 16;
const OFF_CAPACITY = 20;

function writeByte(ptr: number, value: number): void {
    Mem.writeBytes(ptr, new Uint8Array([value & 0xff]));
}

function readCapacity(ptr: number): number {
    return Mem.readUint32(ptr + OFF_CAPACITY) ?? 0;
}

function writeCapacity(ptr: number, cap: number): void {
    Mem.writeUint32(ptr + OFF_CAPACITY, cap >>> 0);
}

function readSize(ptr: number): number {
    return Mem.readUint32(ptr + OFF_SIZE) ?? 0;
}

function writeSize(ptr: number, size: number): void {
    Mem.writeUint32(ptr + OFF_SIZE, size >>> 0);
}

function isSso(ptr: number): boolean {
    return readCapacity(ptr) < 16;
}

function dataPtr(ptr: number): number {
    if (isSso(ptr)) return ptr;
    return Mem.readUint32(ptr) ?? 0;
}

function clearObject(ptr: number): void {
    Mem.writeBytes(ptr, new Uint8Array(MSVC08_STRING_SIZE));
    writeSize(ptr, 0);
    writeCapacity(ptr, SSO_CAPACITY);
}

function freeHeapStorage(ptr: number, heap: CppStringHeap): void {
    if (!isSso(ptr)) {
        const p = Mem.readUint32(ptr) ?? 0;
        if (p) heap.free(p);
    }
}

function setSsoData(ptr: number, bytes: Uint8Array, len: number): void {
    clearObject(ptr);
    if (len <= SSO_CAPACITY) {
        for (let i = 0; i < len; i++) {
            writeByte(ptr + i, bytes[i]);
        }
        writeByte(ptr + len, 0);
        writeSize(ptr, len);
        writeCapacity(ptr, SSO_CAPACITY);
        return;
    }
    throw new Error("setSsoData: len exceeds SSO");
}

function writeHeapBytes(buf: number, bytes: Uint8Array, len: number): void {
    for (let i = 0; i < len; i++) {
        writeByte(buf + i, bytes[i]);
    }
    writeByte(buf + len, 0);
}

function setHeapDataFresh(ptr: number, heap: CppStringHeap, bytes: Uint8Array, len: number): void {
    const cap = Math.max(len, 16);
    const buf = heap.alloc(cap + 1);
    if (!buf) {
        clearObject(ptr);
        return;
    }
    writeHeapBytes(buf, bytes, len);
    Mem.writeUint32(ptr, buf);
    writeSize(ptr, len);
    writeCapacity(ptr, cap);
}

function constructData(ptr: number, heap: CppStringHeap, bytes: Uint8Array): void {
    const len = bytes.length;
    if (len <= SSO_CAPACITY) {
        setSsoData(ptr, bytes, len);
    } else {
        setHeapDataFresh(ptr, heap, bytes, len);
    }
}

function replaceData(ptr: number, heap: CppStringHeap, bytes: Uint8Array): void {
    const len = bytes.length;
    if (len <= SSO_CAPACITY) {
        freeHeapStorage(ptr, heap);
        setSsoData(ptr, bytes, len);
        return;
    }

    const oldCap = readCapacity(ptr);
    const oldHeap = oldCap >= 16 ? (Mem.readUint32(ptr) ?? 0) : 0;
    const cap = oldCap >= len ? oldCap : Math.max(len, 16);
    let buf = oldHeap;

    if (!buf || oldCap < len) {
        const newBuf = heap.alloc(cap + 1);
        if (!newBuf) return;
        if (oldHeap) heap.free(oldHeap);
        buf = newBuf;
    }

    writeHeapBytes(buf, bytes, len);
    Mem.writeUint32(ptr, buf);
    writeSize(ptr, len);
    writeCapacity(ptr, cap);
}

function readObjectBytes(src: number): Uint8Array {
    const len = readSize(src);
    const srcData = dataPtr(src);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        const b = Mem.readUint8(srcData + i);
        bytes[i] = b ?? 0;
    }
    return bytes;
}

function readCStringBytes(cstr: number, maxLen = 0x100000): Uint8Array {
    const limit = Math.max(1, maxLen >>> 0);
    const bytes: number[] = [];
    for (let i = 0; i < limit; i++) {
        const b = Mem.readUint8(cstr + i);
        if (b === null || b === 0) break;
        bytes.push(b);
    }
    return Uint8Array.from(bytes);
}

function copyFromObject(dst: number, src: number, heap: CppStringHeap): void {
    constructData(dst, heap, readObjectBytes(src));
}

export function stringInitEmpty(ptr: number): void {
    clearObject(ptr);
}

export function stringInitFromCStr(ptr: number, cstr: number, heap: CppStringHeap): void {
    if (!cstr) {
        stringInitEmpty(ptr);
        return;
    }
    constructData(ptr, heap, readCStringBytes(cstr));
}

export function stringCopyConstruct(dst: number, src: number, heap: CppStringHeap): void {
    copyFromObject(dst, src, heap);
}

export function stringDestroy(ptr: number, heap: CppStringHeap): void {
    freeHeapStorage(ptr, heap);
    clearObject(ptr);
}

export function stringAssignCStr(ptr: number, cstr: number, heap: CppStringHeap): number {
    replaceData(ptr, heap, cstr ? readCStringBytes(cstr) : new Uint8Array(0));
    return ptr;
}

export function stringAppendCStr(ptr: number, cstr: number, heap: CppStringHeap): number {
    if (!cstr) return ptr;
    const appendBytes = readCStringBytes(cstr);
    if (appendBytes.length === 0) return ptr;

    const curSize = readSize(ptr);
    const combined = new Uint8Array(curSize + appendBytes.length);
    const curData = dataPtr(ptr);
    for (let i = 0; i < curSize; i++) {
        combined[i] = Mem.readUint8(curData + i) ?? 0;
    }
    combined.set(appendBytes, curSize);

    replaceData(ptr, heap, combined);
    return ptr;
}

export function stringCompareLess(a: number, b: number): number {
    const aSize = readSize(a);
    const bSize = readSize(b);
    const aData = dataPtr(a);
    const bData = dataPtr(b);
    const minLen = Math.min(aSize, bSize);
    for (let i = 0; i < minLen; i++) {
        const ac = Mem.readUint8(aData + i) ?? 0;
        const bc = Mem.readUint8(bData + i) ?? 0;
        if (ac < bc) return 1;
        if (ac > bc) return 0;
    }
    return aSize < bSize ? 1 : 0;
}

export function stringBegin(ptr: number): number {
    return dataPtr(ptr);
}

export function stringEnd(ptr: number): number {
    return dataPtr(ptr) + readSize(ptr);
}

export function writeStringIterator(iteratorPtr: number, charPtr: number): number {
    // Minimal VC9 release iterator payload: the caller passes a hidden return buffer.
    if (!iteratorPtr) return charPtr >>> 0;
    Mem.writeUint32(iteratorPtr, charPtr >>> 0);
    return iteratorPtr >>> 0;
}
