import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    stringAssignCStr,
    stringBegin,
    stringCopyConstruct,
    stringDestroy,
    stringEnd,
    stringInitFromCStr,
    writeStringIterator,
    type CppStringHeap,
} from "../../src/worker/modules/crt-cppstring";
import { msvcp90Module } from "../../src/worker/api/msvcp90.api";

const OBJ = 0x40;
const SRC = 0x100;
const DST = 0x180;
const CSTR = 0x300;

let mem: Uint8Array;
let nextAlloc: number;
let frees: number[];
let heap: CppStringHeap;

function readU32(ptr: number): number {
    return (
        mem[ptr] |
        (mem[ptr + 1] << 8) |
        (mem[ptr + 2] << 16) |
        (mem[ptr + 3] << 24)
    ) >>> 0;
}

function writeCStr(ptr: number, value: string): void {
    for (let i = 0; i < value.length; i++) {
        mem[ptr + i] = value.charCodeAt(i) & 0xff;
    }
    mem[ptr + value.length] = 0;
}

function readBytes(ptr: number, len: number): string {
    return String.fromCharCode(...mem.subarray(ptr, ptr + len));
}

describe("crt-cppstring MSVC9 string helpers", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x2000);
        nextAlloc = 0x1000;
        frees = [];
        heap = {
            alloc(bytes) {
                const ptr = nextAlloc;
                nextAlloc += bytes;
                return ptr;
            },
            free(ptr) {
                frees.push(ptr >>> 0);
            },
        };
        Mem.bind(() => mem);
    });

    test("C-string constructor treats destination as fresh storage", () => {
        mem.fill(0xaa, OBJ, OBJ + 24);
        writeCStr(CSTR, "0123456789abcdef");

        stringInitFromCStr(OBJ, CSTR, heap);

        const data = readU32(OBJ);
        expect(frees).toEqual([]);
        expect(readU32(OBJ + 16)).toBe(16);
        expect(readU32(OBJ + 20)).toBeGreaterThanOrEqual(16);
        expect(readBytes(data, 16)).toBe("0123456789abcdef");
    });

    test("copy constructor does not destroy uninitialized destination", () => {
        writeCStr(CSTR, "heap-backed-string");
        stringInitFromCStr(SRC, CSTR, heap);
        mem.fill(0xbb, DST, DST + 24);

        stringCopyConstruct(DST, SRC, heap);

        expect(frees).toEqual([]);
        expect(readBytes(readU32(DST), 18)).toBe("heap-backed-string");
    });

    test("assignment from heap string to SSO releases old heap storage", () => {
        writeCStr(CSTR, "heap-backed-string");
        stringInitFromCStr(OBJ, CSTR, heap);
        const oldHeap = readU32(OBJ);
        writeCStr(CSTR, "short");

        stringAssignCStr(OBJ, CSTR, heap);

        expect(frees).toEqual([oldHeap]);
        expect(readU32(OBJ + 16)).toBe(5);
        expect(readU32(OBJ + 20)).toBe(15);
        expect(readBytes(OBJ, 5)).toBe("short");
    });

    test("assignment from heap string to null releases old heap storage", () => {
        writeCStr(CSTR, "heap-backed-string");
        stringInitFromCStr(OBJ, CSTR, heap);
        const oldHeap = readU32(OBJ);

        stringAssignCStr(OBJ, 0, heap);

        expect(frees).toEqual([oldHeap]);
        expect(readU32(OBJ + 16)).toBe(0);
        expect(readU32(OBJ + 20)).toBe(15);
    });

    test("iterator return helper writes hidden MSVC return buffer", () => {
        writeCStr(CSTR, "abc");
        stringInitFromCStr(OBJ, CSTR, heap);

        const ret = writeStringIterator(DST, stringEnd(OBJ));

        expect(ret).toBe(DST);
        expect(readU32(DST)).toBe(stringBegin(OBJ) + 3);
    });

    test("begin/end descriptors pop the hidden iterator return pointer", () => {
        const begin = msvcp90Module.functions.find((f) => f.name.startsWith("?begin@"));
        const end = msvcp90Module.functions.find((f) => f.name.startsWith("?end@"));

        expect(begin?.stackCleanupBytes).toBe(4);
        expect(end?.stackCleanupBytes).toBe(4);
    });

    test("destructor releases heap storage once", () => {
        writeCStr(CSTR, "heap-backed-string");
        stringInitFromCStr(OBJ, CSTR, heap);
        const oldHeap = readU32(OBJ);

        stringDestroy(OBJ, heap);

        expect(frees).toEqual([oldHeap]);
        expect(readU32(OBJ + 16)).toBe(0);
        expect(readU32(OBJ + 20)).toBe(15);
    });
});
