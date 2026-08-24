// Trap-free x86 fast paths for uncontended Win32 critical sections.
// Slow/contended/invalid cases tail-jump to the ordinary kernel32 OUT stub.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';

export function writeCriticalSectionInlineStubs(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    enterTrapStubAddr: number,
    leaveTrapStubAddr: number,
): { enterStub: number; leaveStub: number; regionBase: number; regionEnd: number } {
    const REGION_SIZE = 256;
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    const w8 = (v: number) => { mem[off++] = v & 0xff; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const rel32 = (opcode: number, patches: number[]) => {
        w8(0x0f); w8(opcode); patches.push(off); w32(0);
    };
    const patchAll = (sites: number[], target: number) => {
        for (const p of sites) dv.setInt32(p, target - (p + 4), true);
    };
    const emitSuccess = () => {
        w8(0x31); w8(0xc0);             // xor eax,eax
        w8(0xc2); w8(0x04); w8(0x00);   // ret 4
    };
    const emitSlowJump = (target: number) => {
        w8(0xe9); const p = off; w32(0);
        dv.setInt32(p, target - (p + 4), true);
    };
    const emitCurrentTidEdx = () => {
        // mov edx,dword ptr fs:[0x24] — TEB.ClientId.UniqueThread
        w8(0x64); w8(0x8b); w8(0x15); w32(0x24);
    };

    // EnterCriticalSection(CS*) — free or recursive only.
    const enterStub = off;
    const enterSlow: number[] = [];
    const enterFree: number[] = [];
    w8(0x8b); w8(0x44); w8(0x24); w8(0x04); // mov eax,[esp+4]
    w8(0x85); w8(0xc0);                     // test eax,eax
    rel32(0x84, enterSlow);                  // jz slow
    w8(0xa9); w32(3);                       // test eax,3
    rel32(0x85, enterSlow);                  // jnz slow
    w8(0x8b); w8(0x48); w8(0x0c);           // mov ecx,[eax+12] owner
    emitCurrentTidEdx();
    w8(0x85); w8(0xd2);                     // test edx,edx
    rel32(0x84, enterSlow);                  // jz slow
    w8(0x85); w8(0xc9);                     // test ecx,ecx
    rel32(0x84, enterFree);                  // jz free
    w8(0x3b); w8(0xca);                     // cmp ecx,edx
    rel32(0x85, enterSlow);                  // jne slow
    w8(0xff); w8(0x40); w8(0x08);           // inc dword [eax+8]
    emitSuccess();
    const enterFreeAddr = off;
    w8(0x83); w8(0x78); w8(0x04); w8(0xff); // cmp dword [eax+4],-1
    rel32(0x85, enterSlow);                  // jne slow
    w8(0xc7); w8(0x40); w8(0x04); w32(0);   // lockCount=0
    w8(0xc7); w8(0x40); w8(0x08); w32(1);   // recursion=1
    w8(0x89); w8(0x50); w8(0x0c);           // owner=tid
    emitSuccess();
    const enterSlowAddr = off;
    emitSlowJump(enterTrapStubAddr);
    patchAll(enterFree, enterFreeAddr);
    patchAll(enterSlow, enterSlowAddr);

    // LeaveCriticalSection(CS*) — recursive decrement or waiter-free release.
    const leaveStub = off;
    const leaveSlow: number[] = [];
    const leaveRecursive: number[] = [];
    w8(0x8b); w8(0x44); w8(0x24); w8(0x04); // mov eax,[esp+4]
    w8(0x85); w8(0xc0);
    rel32(0x84, leaveSlow);
    w8(0xa9); w32(3);
    rel32(0x85, leaveSlow);
    w8(0x8b); w8(0x48); w8(0x0c);           // owner
    emitCurrentTidEdx();
    w8(0x85); w8(0xd2);
    rel32(0x84, leaveSlow);
    w8(0x3b); w8(0xca);                     // owner == current tid
    rel32(0x85, leaveSlow);
    w8(0x8b); w8(0x48); w8(0x08);           // recursion
    w8(0x83); w8(0xf9); w8(0x01);           // cmp ecx,1
    rel32(0x87, leaveRecursive);             // ja recursive
    rel32(0x85, leaveSlow);                  // jne slow (zero/corrupt)
    w8(0x83); w8(0x78); w8(0x10); w8(0x00); // cmp dword [eax+16],0
    rel32(0x85, leaveSlow);                  // waiter/event → slow
    w8(0xc7); w8(0x40); w8(0x04); w32(0xffffffff);
    w8(0xc7); w8(0x40); w8(0x08); w32(0);
    w8(0xc7); w8(0x40); w8(0x0c); w32(0);
    emitSuccess();
    const leaveRecursiveAddr = off;
    w8(0xff); w8(0x48); w8(0x08);           // dec dword [eax+8]
    emitSuccess();
    const leaveSlowAddr = off;
    emitSlowJump(leaveTrapStubAddr);
    patchAll(leaveRecursive, leaveRecursiveAddr);
    patchAll(leaveSlow, leaveSlowAddr);

    Logger.log(LogCategory.SYSTEM,
        `Inline critical-section stubs emitted: enter=0x${enterStub.toString(16)} ` +
        `leave=0x${leaveStub.toString(16)}`);
    return { enterStub, leaveStub, regionBase: base, regionEnd: base + REGION_SIZE };
}
