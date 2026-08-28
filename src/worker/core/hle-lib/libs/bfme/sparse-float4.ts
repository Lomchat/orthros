import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Materialize the five live inputs before the raw handler. ESI doubles as the
 * status/result register: zero declines through the relocated original first
 * instructions, while success contains the final destination lane address. */
export function assembleBfmeSparseFloat4Wrapper(
    address: number,
    stubAddress: number,
    trampolineAddress: number,
    continuationAddress: number,
): Uint8Array {
    return Uint8Array.from([
        0x55, 0x52, 0x51, 0x57, 0x50,                 // push ebp,edx,ecx,edi,eax
        0xe8, ...rel32(address + 10, stubAddress),
        0x85, 0xf6,                                    // test esi,esi
        0x0f, 0x85, ...rel32(address + 18, address + 28), // jnz success
        0x58, 0x5f, 0x59, 0x5a, 0x5d,                 // decline: restore eax,edi,ecx,edx,ebp
        0xe9, ...rel32(address + 28, trampolineAddress),
        0x8b, 0x54, 0x24, 0x0c,                       // success: restore live edx
        0x83, 0xc4, 0x14,                              // add esp,20
        0xe9, ...rel32(address + 40, continuationAddress),
    ]);
}

export function buildBfmeSparseFloat4Wrapper(info: EntryFilterInfo): number | null {
    const continuation = (info.targetAddress + 0x53) >>> 0;
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
