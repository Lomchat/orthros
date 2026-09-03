// Trap-free x86 clock leaf shared by kernel32!GetTickCount and winmm!timeGetTime.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';

/**
 * The Orthros virtual TSC advances at exactly 2^32 ticks per second. Thus:
 *
 *   milliseconds = floor(TSC * 1000 / 2^32)
 *
 * The emitted leaf computes the low 32 bits of that expression using one RDTSC
 * and two 32-bit multiplies. It follows the Win32 ABI (EAX result; ECX/EDX and
 * flags volatile) and contains no OUT trap or memory access. The high-word
 * product is formed directly in ECX and the two partial products share one LEA;
 * the epoch remains a real ADD so the leaf preserves the original final EFLAGS.
 * This matters for games that poll the clock hundreds of thousands of times per
 * second, while some old binaries are observably sensitive to those volatile flags.
 * The epoch is read from a THUNK_DATA slot rather than baked in as an immediate:
 * THUNK_CODE then holds the same bytes in every session, which the ahead-of-time
 * translations of these leaves check before trusting their image.
 */
export function writeTimeInlineStub(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    epochOffsetMs: number,
): { timeStub: number; regionBase: number; regionEnd: number } {
    const REGION_SIZE = 64;
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const epochSlot = allocator.alloc(4, 'THUNK_DATA', 'rw', 4);
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    dv.setUint32(epochSlot, epochOffsetMs >>> 0, true);
    let off = base;
    const w8 = (v: number) => { mem[off++] = v & 0xff; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

    const timeStub = off;
    w8(0x0f); w8(0x31);                   // rdtsc                 EDX:EAX = ticks
    w8(0x69); w8(0xca); w32(1000);        // imul ecx,edx,1000     low(high*1000)
    w8(0xba); w32(1000);                  // mov edx,1000
    w8(0xf7); w8(0xe2);                   // mul edx               high(EAX*1000) -> EDX
    w8(0x8d); w8(0x04); w8(0x0a);         // lea eax,[edx+ecx]
    w8(0x03); w8(0x05); w32(epochSlot);   // add eax,[epochSlot]   (also final EFLAGS)
    w8(0xc3);                             // ret

    Logger.log(LogCategory.SYSTEM,
        `Inline time stub emitted: time=0x${timeStub.toString(16)}, epochOffsetMs=${epochOffsetMs >>> 0} at 0x${epochSlot.toString(16)}`);
    return { timeStub, regionBase: base, regionEnd: base + REGION_SIZE };
}
