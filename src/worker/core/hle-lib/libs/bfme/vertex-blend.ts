import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

const LOOP_CONTINUATION_DELTA = 0xb6;

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Replace BFME's four-source float4 blend loop at 0x00e2dc30. The surrounding
 * function has already acquired its source buffers; the WASM handler consumes
 * the entire inner loop, then this wrapper restores the one live callee-saved
 * register and resumes immediately after the original x87 loop.
 */
export function assembleBfmeVertexBlendWrapper(
    address: number,
    stubAddress: number,
    continuationAddress: number,
): Uint8Array {
    return Uint8Array.from([
        0xe8, ...rel32(address + 5, stubAddress),       // call HLE stub
        0x8b, 0x75, 0xfc,                              // mov esi,[ebp-4]
        0xe9, ...rel32(address + 13, continuationAddress), // jmp after x87 loop
    ]);
}

export function buildBfmeVertexBlendWrapper(info: EntryFilterInfo): number | null {
    const continuation = (info.targetAddress + LOOP_CONTINUATION_DELTA) >>> 0;
    const size = assembleBfmeVertexBlendWrapper(0x1000, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeVertexBlendWrapper(address, info.stubAddress, continuation);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    info.markNonPreemptible(address, address + code.length);
    return address;
}

/** The production route is handler 148 in v86 WASM. Reaching JS means the
 * exact-signature handler rejected corrupt/unmapped guest state. */
export const bfmeVertexBlendFallbackHandler: ThunkImplementation = () => 0;

