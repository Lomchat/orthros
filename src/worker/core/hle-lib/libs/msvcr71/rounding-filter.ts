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

/**
 * Execute the common floor(double) domain entirely in guest SSE2 code. Values
 * whose truncated integer is INT_MIN are deliberately declined: that is also
 * CVTTSD2SI's sentinel for NaN, infinity and every out-of-range conversion.
 * Exact values return through FLD [esp+4], preserving negative zero bit-for-bit.
 */
export function assembleMsvcr71FloorInline(
    codeAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const emitI32 = (value: number) => emit(
        value & 0xff,
        (value >> 8) & 0xff,
        (value >> 16) & 0xff,
        (value >> 24) & 0xff,
    );
    const jcc = (condition: number) => {
        const at = code.length;
        emit(0x0f, condition, 0, 0, 0, 0);
        return at;
    };
    const patchJcc = (at: number, target: number) => {
        const rel = (target - (codeAddress + at + 6)) | 0;
        code[at + 2] = rel & 0xff;
        code[at + 3] = (rel >> 8) & 0xff;
        code[at + 4] = (rel >> 16) & 0xff;
        code[at + 5] = (rel >> 24) & 0xff;
    };

    emit(0xf2, 0x0f, 0x10, 0x44, 0x24, 0x04); // movsd xmm0,[esp+4]
    emit(0xf2, 0x0f, 0x2c, 0xc0);             // cvttsd2si eax,xmm0
    emit(0x3d); emitI32(0x80000000);           // cmp eax,INT_MIN sentinel
    const special = jcc(0x84);                 // je original
    emit(0xf2, 0x0f, 0x2a, 0xc8);             // cvtsi2sd xmm1,eax
    emit(0x66, 0x0f, 0x2e, 0xc8);             // ucomisd xmm1,xmm0
    const exact = jcc(0x84);                   // je exact input
    const converted = jcc(0x86);               // jbe truncated <= input
    emit(0x48);                                // dec eax (negative fraction)
    emit(0xf2, 0x0f, 0x2a, 0xc8);             // cvtsi2sd xmm1,eax

    const convertedTarget = code.length;
    emit(0x83, 0xec, 0x08);                    // sub esp,8
    emit(0xf2, 0x0f, 0x11, 0x0c, 0x24);       // movsd [esp],xmm1
    emit(0xdd, 0x04, 0x24);                    // fld qword [esp]
    emit(0x83, 0xc4, 0x08, 0xc3);              // add esp,8; ret

    const exactTarget = code.length;
    emit(0xdd, 0x44, 0x24, 0x04, 0xc3);        // fld qword [esp+4]; ret

    patchJcc(special, trampolineAddress);
    patchJcc(exact, codeAddress + exactTarget);
    patchJcc(converted, codeAddress + convertedTarget);
    return Uint8Array.from(code);
}

export function buildMsvcr71FloorInline(info: EntryFilterInfo): number | null {
    const size = assembleMsvcr71FloorInline(0x1000, 0x2000).length;
    const address = info.allocCode(size);
    const code = assembleMsvcr71FloorInline(address, info.trampolineAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

/** Numerical contract of the guest leaf. Null means "run original VC71". */
export function msvcr71FloorInlineReference(value: number): number | null {
    if (!Number.isFinite(value) || value <= -0x80000000 || value >= 0x80000000) return null;
    const truncated = Math.trunc(value);
    if (value === truncated) return value;
    return truncated > value ? truncated - 1 : truncated;
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
