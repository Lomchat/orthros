import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { registerVc9SetjmpExports } from "../../src/worker/modules/crt-vc9-setjmp";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

describe("crt-vc9-setjmp", () => {
    const reg32 = new Uint32Array(8);
    const instruction_pointer = new Uint32Array(1);
    const segment_offsets = new Uint32Array(8);
    const mockCpu = {
        reg32,
        instruction_pointer,
        segment_offsets,
    };
    const mockProcess = { v86: { /* getCPU returns mock */ } };

    let mem: Uint8Array;

    beforeEach(() => {
        reg32.fill(0);
        instruction_pointer[0] = 0;
        segment_offsets.fill(0);
        mem = new Uint8Array(0x10000);
        Mem.bind(() => mem);
    });

    test("_setjmp3 saves return address to guest jmp_buf", () => {
        const exports: Record<string, ThunkImplementation> = {};
        registerVc9SetjmpExports(exports, {
            process: {
                v86: { cpu: mockCpu },
            } as any,
        });

        const buf = 0x500;
        reg32[4] = 0x800;
        Mem.writeUint32(0x800, 0x00401000);
        reg32[5] = 0x00123456;
        reg32[3] = 0x11111111;

        const ret = exports["_setjmp3"]!(null as any, mem, [buf, 0]);
        expect(ret).toBe(0);
        expect(Mem.readUint32(buf + 5 * 4)).toBe(0x00401000);
        expect(Mem.readUint32(buf + 0)).toBe(0x00123456);
    });

    test("_setjmp3 records the live SEH frame into Registration (offset 24)", () => {
        const exports: Record<string, ThunkImplementation> = {};
        registerVc9SetjmpExports(exports, { process: { v86: { cpu: mockCpu } } as any });

        const buf = 0x500;
        const tebAddr = 0x2000;
        segment_offsets[4] = tebAddr;
        Mem.writeUint32(tebAddr, 0x3000); // FS:[0] = current SEH head
        reg32[4] = 0x800;
        Mem.writeUint32(0x800, 0x00401000);

        exports["_setjmp3"]!(null as any, mem, [buf, 0]);
        expect(Mem.readUint32(buf + 6 * 4)).toBe(0x3000);
    });

    test("__CxxLongjmpUnwind is a no-op when the buffer's Registration is invalid", () => {
        const exports: Record<string, ThunkImplementation> = {};
        registerVc9SetjmpExports(exports, { process: { v86: { cpu: mockCpu } } as any });

        const buf = 0x500;
        segment_offsets[4] = 0x2000;
        Mem.writeUint32(buf + 6 * 4, 0xFFFFFFFF); // Registration unset

        const ret = exports["__CxxLongjmpUnwind"]!({ esp: 0x800 } as any, mem, [buf]);
        expect(ret).toBe(0);
    });

    test("__CxxLongjmpUnwind unlinks unwound SEH frames up to the target Registration", () => {
        const exports: Record<string, ThunkImplementation> = {};
        registerVc9SetjmpExports(exports, { process: { v86: { cpu: mockCpu } } as any });

        const buf = 0x500;
        const tebAddr = 0x2000;
        const targetFrame = 0x3000;
        const liveFrame = 0x4000; // one frame with no MSVC FuncInfo — nothing to unwind
        segment_offsets[4] = tebAddr;
        Mem.writeUint32(tebAddr, liveFrame); // FS:[0] = liveFrame
        Mem.writeUint32(liveFrame, targetFrame); // liveFrame->next = targetFrame
        Mem.writeUint32(liveFrame + 4, 0); // handler = 0 (not a valid MSVC thunk)
        Mem.writeUint32(liveFrame + 8, 0); // no FuncInfo/scopetable
        Mem.writeUint32(buf + 6 * 4, targetFrame); // Registration = targetFrame

        const ret = exports["__CxxLongjmpUnwind"]!({ esp: 0x800 } as any, mem, [buf]);
        expect(ret).toBe(0); // no destructors found -> plain return, no trampoline
        expect(Mem.readUint32(tebAddr)).toBe(targetFrame); // FS:[0] unlinked up to target
    });
});
