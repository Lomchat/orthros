import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Replace a complete RGB24 -> XRGB32 counted loop. The WASM handler consumes
 * all pixels using the loop's live EAX/ESI/ECX registers, then execution
 * resumes at the first instruction after the original back-edge.
 */
export function assembleBfmeRgb24ExpandWrapper(
    address: number,
    stubAddress: number,
    trampolineAddress: number,
    continuationAddress: number,
): Uint8Array {
    return Uint8Array.from([
        0x51,                                            // push ecx (destination end)
        0x56,                                            // push esi (destination)
        0x50,                                            // push eax (source)
        0xe8, ...rel32(address + 8, stubAddress),
        0x85, 0xdb,                                      // test ebx,ebx
        0x0f, 0x85, ...rel32(address + 16, address + 24), // jnz success
        0x58, 0x5e, 0x59,                                // decline: restore eax,esi,ecx
        0xe9, ...rel32(address + 24, trampolineAddress), // original loop
        0x83, 0xc4, 0x0c,                                // success: discard saved args
        0xe9, ...rel32(address + 32, continuationAddress),
    ]);
}

export function buildBfmeRgb24ExpandWrapper(info: EntryFilterInfo): number | null {
    // The signature covers the complete 0x1c-byte loop body including JB.
    const continuation = (info.targetAddress + 0x1c) >>> 0;
    const size = assembleBfmeRgb24ExpandWrapper(0x1000, 0x2000, 0x3000, 0x4000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeRgb24ExpandWrapper(
        address, info.stubAddress, info.trampolineAddress, continuation,
    );
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    info.markNonPreemptible(address, address + code.length);
    return address;
}

/** The exact-signature production route is handler 156 in v86 WASM. */
export const bfmeRgb24ExpandFallback: ThunkImplementation = () => 0;
