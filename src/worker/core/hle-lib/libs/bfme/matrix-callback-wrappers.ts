import type { EntryFilterInfo } from '../../types';

const TRANSFORM_UPDATE_IAT = 0x013378a0;
const MATRIX_UPDATE_IAT = 0x013378a4;

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** CALL the no-argument WASM copy stub, then retain the original update callback. */
export function assembleTransformPopWrapper(address: number, stubAddress: number): Uint8Array {
    return Uint8Array.from([
        0xe8, ...rel32(address + 5, stubAddress), // call stub
        0x8d, 0x41, 0x20,                       // lea eax,[ecx+0x20]
        0x50,                                   // push eax
        0xff, 0x15,                             // call dword [TRANSFORM_UPDATE_IAT]
        TRANSFORM_UPDATE_IAT & 0xff,
        (TRANSFORM_UPDATE_IAT >>> 8) & 0xff,
        (TRANSFORM_UPDATE_IAT >>> 16) & 0xff,
        (TRANSFORM_UPDATE_IAT >>> 24) & 0xff,
        0x83, 0xc4, 0x04,                       // add esp,4
        0xc3,                                   // ret
    ]);
}

/** Copy the original stack argument for the cdecl WASM stub, then perform the
 * original thiscall update and callee-clean the caller's argument. */
export function assembleMatrixAdjustWrapper(address: number, stubAddress: number): Uint8Array {
    return Uint8Array.from([
        0xff, 0x74, 0x24, 0x04,                 // push dword [esp+4]
        0xe8, ...rel32(address + 9, stubAddress), // call stub
        0x83, 0xc4, 0x04,                       // add esp,4
        0x51,                                   // push ecx
        0xff, 0x15,                             // call dword [MATRIX_UPDATE_IAT]
        MATRIX_UPDATE_IAT & 0xff,
        (MATRIX_UPDATE_IAT >>> 8) & 0xff,
        (MATRIX_UPDATE_IAT >>> 16) & 0xff,
        (MATRIX_UPDATE_IAT >>> 24) & 0xff,
        0x59,                                   // pop ecx
        0xc2, 0x04, 0x00,                       // ret 4
    ]);
}

function install(info: EntryFilterInfo, codeFor: (address: number, stub: number) => Uint8Array): number | null {
    const size = codeFor(0x1000, 0x2000).length;
    const address = info.allocCode(size);
    const code = codeFor(address, info.stubAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

export const buildTransformPopWrapper = (info: EntryFilterInfo): number | null =>
    install(info, assembleTransformPopWrapper);

export const buildMatrixAdjustWrapper = (info: EntryFilterInfo): number | null =>
    install(info, assembleMatrixAdjustWrapper);
