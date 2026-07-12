import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { registerVc9IoExports, type Vc9IoHost } from "../../src/worker/modules/crt-vc9-io";
import type { VfsEntry } from "../../src/worker/runtime/filesystem/vfs";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

describe("crt-vc9-io", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let host: Vc9IoHost;

    beforeEach(() => {
        mem = new Uint8Array(0x4000);
        Mem.bind(() => mem);
        exports = {};
        host = {
            process: { v86: null },
            readCString: (ptr) => {
                let s = "";
                for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
                return s;
            },
            setErrno: () => true,
            statImpl: () => 0,
            fseek: () => 0,
            ftell: () => 42,
            filelength: () => 100,
            fileStreams: new Map(),
            malloc: (n) => {
                const p = 0x2000;
                return p + n;
            },
            writeCString: (ptr, value) => {
                for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i) & 0xff;
                mem[ptr + value.length] = 0;
            },
            memset: (ptr, val, size) => {
                mem.fill(val & 0xff, ptr, ptr + size);
                return ptr;
            },
        };
        registerVc9IoExports(exports, host);
    });

    test("asctime formats struct tm", () => {
        const tm = 0x100;
        Mem.writeUint32(tm + 0, 5);
        Mem.writeUint32(tm + 4, 30);
        Mem.writeUint32(tm + 8, 14);
        Mem.writeUint32(tm + 12, 12);
        Mem.writeUint32(tm + 16, 5);
        Mem.writeUint32(tm + 20, 126);
        const ptr = exports["asctime"]!(null as any, mem, [tm]);
        expect(ptr).toBeGreaterThan(0);
        const text = host.readCString(ptr);
        expect(text).toContain("Jun");
        expect(text).toContain("2026");
    });

    test("_time64 writes timer and returns low dword", () => {
        const timer = 0x200;
        const lo = exports["_time64"]!(null as any, mem, [timer]);
        expect(lo).toBeGreaterThan(0);
        expect(Mem.readUint32(timer)).toBe(lo);
    });

    test("_findfirst64i32 writes bounded finddata64i32 layout", () => {
        const system = System.getInstance();
        const originalListDirectory = system.fileSystem.listDirectory;
        const entry: VfsEntry = {
            path: "C:\\Games\\readme.txt",
            name: "readme.txt",
            kind: "file",
            size: 0x1234,
            source: "rom",
        };

        system.fileSystem.listDirectory = (() => [entry]) as typeof system.fileSystem.listDirectory;
        try {
            const filespec = 0x100;
            const findData = 0x300;
            const sentinel = findData + 296;
            host.writeCString(filespec, "C:\\Games\\*.txt");
            mem[sentinel] = 0xa5;

            const handle = exports["_findfirst64i32"]!(null as any, mem, [filespec, findData]);

            expect(handle).toBeGreaterThan(0);
            expect(Mem.readUint32(findData + 0)).toBe(0x8100);
            expect(Mem.readUint32(findData + 32)).toBe(0x1234);
            expect(host.readCString(findData + 36)).toBe("readme.txt");
            expect(mem[sentinel]).toBe(0xa5);
        } finally {
            system.fileSystem.listDirectory = originalListDirectory;
        }
    });
});
