// Trap-free x86 fast path for kernel32!Sleep(0).
//
// Most Sleep(0) calls only volunteer the remainder of the current Windows
// quantum. Running every one through OUT -> WASM -> JIT re-entry is needlessly
// expensive in tight polling/pacing loops, even when the WASM handler itself
// avoids JavaScript. This wrapper keeps the ordinary calls in guest x86 and
// periodically tail-jumps to the original thunk so the scheduler can run a
// guest peer or yield a sole runnable thread to the browser.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';

export const SLEEP_INLINE_COUNTER_OFF = 0;
export const SLEEP_INLINE_LIMIT_OFF = 4;
export const SLEEP_INLINE_HAS_PEERS_OFF = 8;
export const SLEEP_INLINE_ENABLED_OFF = 12;
export const SLEEP_INLINE_CONTROL_SIZE = 16;
export const SLEEP_INLINE_SOLE_MULTIPLIER = 64;

export interface SleepInlineStub {
    sleepStub: number;
    controlAddr: number;
    slowTrapStub: number;
    functionId: number;
    regionBase: number;
    regionEnd: number;
}

/**
 * Emit the stdcall Sleep wrapper and its guest-visible control block.
 *
 * Control layout (all u32): counter, peer threshold, has-runnable-peers,
 * enabled. The effective sole-thread threshold is limit * 64. The wrapper
 * deliberately mirrors Rust handle_sleep's pre-increment comparison: with a
 * limit of 64, calls 1..64 return inline and call 65 reaches the scheduler.
 */
export function writeSleepInlineStub(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    slowTrapStub: number,
    functionId: number,
    initialLimit = 64,
): SleepInlineStub {
    const controlAddr = allocator.alloc(SLEEP_INLINE_CONTROL_SIZE, 'THUNK_DATA', 'rw', 16);
    const REGION_SIZE = 128;
    const regionBase = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx', 16);
    const regionEnd = regionBase + REGION_SIZE;
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    dv.setUint32(controlAddr + SLEEP_INLINE_COUNTER_OFF, 0, true);
    dv.setUint32(controlAddr + SLEEP_INLINE_LIMIT_OFF, initialLimit >>> 0, true);
    dv.setUint32(controlAddr + SLEEP_INLINE_HAS_PEERS_OFF, 0, true);
    dv.setUint32(controlAddr + SLEEP_INLINE_ENABLED_OFF, 1, true);

    let off = regionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xff; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const rel32 = (opcode: number, sites: number[]) => {
        w8(0x0f); w8(opcode); sites.push(off); w32(0);
    };
    const patchAll = (sites: number[], target: number) => {
        for (const p of sites) dv.setInt32(p, target - (p + 4), true);
    };

    const sleepStub = off;
    const slow: number[] = [];
    const haveLimit: number[] = [];

    // Disabled A/B baseline or Sleep(N>0) -> original thunk.
    w8(0x83); w8(0x3d); w32(controlAddr + SLEEP_INLINE_ENABLED_OFF); w8(0x00); // cmp [enabled],0
    rel32(0x84, slow);                                                         // je slow
    w8(0x8b); w8(0x44); w8(0x24); w8(0x04);                                  // mov eax,[esp+4]
    w8(0x85); w8(0xc0);                                                       // test eax,eax
    rel32(0x85, slow);                                                         // jne slow

    // ECX = completed inline calls; EDX = effective threshold.
    w8(0x8b); w8(0x0d); w32(controlAddr + SLEEP_INLINE_COUNTER_OFF);           // mov ecx,[counter]
    w8(0x8b); w8(0x15); w32(controlAddr + SLEEP_INLINE_LIMIT_OFF);             // mov edx,[limit]
    w8(0x83); w8(0x3d); w32(controlAddr + SLEEP_INLINE_HAS_PEERS_OFF); w8(0x00); // cmp [peers],0
    rel32(0x85, haveLimit);                                                     // jne have_limit
    w8(0xc1); w8(0xe2); w8(0x06);                                             // shl edx,6
    const haveLimitAddr = off;
    w8(0x85); w8(0xd2);                                                       // test edx,edx
    rel32(0x84, slow);                                                         // jz slow
    w8(0x3b); w8(0xca);                                                       // cmp ecx,edx
    rel32(0x83, slow);                                                         // jae slow
    w8(0x41);                                                                 // inc ecx
    w8(0x89); w8(0x0d); w32(controlAddr + SLEEP_INLINE_COUNTER_OFF);           // mov [counter],ecx
    w8(0x31); w8(0xc0);                                                       // xor eax,eax
    w8(0xc2); w8(0x04); w8(0x00);                                             // ret 4

    const slowAddr = off;
    w8(0xc7); w8(0x05); w32(controlAddr + SLEEP_INLINE_COUNTER_OFF); w32(0);   // mov [counter],0
    w8(0xe9); const slowJump = off; w32(0);                                    // jmp original thunk
    dv.setInt32(slowJump, slowTrapStub - (slowJump + 4), true);

    patchAll(haveLimit, haveLimitAddr);
    patchAll(slow, slowAddr);

    Logger.log(LogCategory.SYSTEM,
        `Inline Sleep(0) stub emitted: fast=0x${sleepStub.toString(16)} ` +
        `slow=0x${slowTrapStub.toString(16)} ctl=0x${controlAddr.toString(16)} funcId=${functionId}`);
    return { sleepStub, controlAddr, slowTrapStub, functionId, regionBase, regionEnd };
}
