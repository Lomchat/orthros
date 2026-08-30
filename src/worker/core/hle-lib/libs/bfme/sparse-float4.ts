import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Preserve the seven live registers around one raw call for the complete
 * three-level nest. ESI doubles as the temporary status register; both arms
 * restore its guest value before continuing. */
export function assembleBfmeSparseFloat4Wrapper(
    address: number,
    stubAddress: number,
    trampolineAddress: number,
    continuationAddress: number,
): Uint8Array {
    return Uint8Array.from([
        0x55, 0x53, 0x56, 0x52, 0x51, 0x57, 0x50,     // push ebp,ebx,esi,edx,ecx,edi,eax
        0xe8, ...rel32(address + 12, stubAddress),
        0x85, 0xf6,                                    // test esi,esi
        0x0f, 0x85, ...rel32(address + 20, address + 32), // jnz success
        0x58, 0x5f, 0x59, 0x5a, 0x5e, 0x5b, 0x5d,     // decline: restore all
        0xe9, ...rel32(address + 32, trampolineAddress),
        0x58, 0x5f, 0x59, 0x5a, 0x5e, 0x5b, 0x5d,     // success: restore all
        0xe9, ...rel32(address + 44, continuationAddress),
    ]);
}

export function buildBfmeSparseFloat4Wrapper(info: EntryFilterInfo): number | null {
    const continuation = (info.targetAddress + 0x95) >>> 0;
    const size = assembleBfmeSparseFloat4Wrapper(0x1000, 0x2000, 0x3000, 0x4000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeSparseFloat4Wrapper(
        address, info.stubAddress, info.trampolineAddress, continuation,
    );
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    info.markNonPreemptible(address, address + code.length);
    return address;
}

export const bfmeSparseFloat4Fallback: ThunkImplementation = () => 0;
