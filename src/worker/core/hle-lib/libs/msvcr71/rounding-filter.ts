import { fpuPush } from '../../../fpu-helper';
import { System } from '../../../system';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';
import type { EntryFilterInfo } from '../../types';

/**
 * Route finite doubles to the WASM ceil/floor handler. NaN and infinity retain
 * the original VC71 routine because it also owns errno and x87 exception state.
 */
export function assembleMsvcr71FiniteDoubleFilter(
    filterAddress: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const emitU32 = (value: number) => emit(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    );
    const emitJmp = (target: number) => {
        const at = filterAddress + code.length;
        emit(0xe9);
        emitU32((target - (at + 5)) | 0);
    };

    emit(0x8b, 0x44, 0x24, 0x08);       // mov eax,[esp+8] (high half)
    emit(0x25); emitU32(0x7ff00000);    // and eax,exponent mask
    emit(0x3d); emitU32(0x7ff00000);    // cmp eax,all-ones exponent
    emit(0x0f, 0x85, 0x05, 0x00, 0x00, 0x00); // jne finite
    emitJmp(trampolineAddress);          // NaN/Inf → original VC71
    emitJmp(stubAddress);                // finite → WASM handler
    return Uint8Array.from(code);
}

export function buildMsvcr71FiniteDoubleFilter(info: EntryFilterInfo): number | null {
    const size = assembleMsvcr71FiniteDoubleFilter(0x1000, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleMsvcr71FiniteDoubleFilter(
        address, info.stubAddress, info.trampolineAddress,
    );
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

function pairToDouble(lo: number, hi: number): number {
    const data = new DataView(new ArrayBuffer(8));
    data.setUint32(0, lo >>> 0, true);
    data.setUint32(4, hi >>> 0, true);
    return data.getFloat64(0, true);
}

function roundingFallback(fn: (value: number) => number): ThunkImplementation {
    return (_ctx, _mem, args) => {
        const result = fn(pairToDouble(args[0] ?? 0, args[1] ?? 0));
        const v86 = System.getInstance().process?.v86;
        if (v86) fpuPush(v86, result);
        return result | 0;
    };
}

export const msvcr71CeilFallback = roundingFallback(Math.ceil);
export const msvcr71FloorFallback = roundingFallback(Math.floor);
