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
 * flags volatile) and contains no OUT trap or memory access.
 */
export function writeTimeInlineStub(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    epochOffsetMs: number,
): { timeStub: number; regionBase: number; regionEnd: number } {
    const REGION_SIZE = 64;
    const base = allocator.alloc(REGION_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = base;
    const w8 = (v: number) => { mem[off++] = v & 0xff; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

    const timeStub = off;
    w8(0x0f); w8(0x31);                   // rdtsc                 EDX:EAX = ticks
    w8(0x89); w8(0xd1);                   // mov ecx,edx           save high word
    w8(0xba); w32(1000);                  // mov edx,1000
    w8(0xf7); w8(0xe2);                   // mul edx               high(EAX*1000) -> EDX
    w8(0x69); w8(0xc9); w32(1000);        // imul ecx,ecx,1000     low(high*1000)
    w8(0x01); w8(0xca);                   // add edx,ecx
    w8(0x89); w8(0xd0);                   // mov eax,edx
    w8(0x05); w32(epochOffsetMs);         // add eax,epochOffsetMs  (Win32 boot epoch)
    w8(0xc3);                             // ret

    Logger.log(LogCategory.SYSTEM,
        `Inline time stub emitted: time=0x${timeStub.toString(16)}, epochOffsetMs=${epochOffsetMs >>> 0}`);
    return { timeStub, regionBase: base, regionEnd: base + REGION_SIZE };
}
