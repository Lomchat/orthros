import type { EntryFilterInfo } from '../../types';

/** RVA delta from MSVCR71 7.10.3052.4 `_getptd` to its TLS-index global. */
export const MSVCR71_GETPTD_TLS_INDEX_DELTA = 0x41dfa;

/**
 * Fast path for MSVCR71's internal `_getptd` helper.
 *
 * The original hot path preserves LastError around GetLastError,
 * TlsGetValue and SetLastError. Reading the TEB TLS array directly has the
 * same observable result without crossing three Win32 import stubs. A missing
 * TLS array, an out-of-range index or an uninitialised slot calls the relocated
 * original, which retains the allocation/error path exactly. Its successful
 * result is then mirrored into the TEB slot. This also repairs older runtime
 * paths where the scheduler TLS map and the guest-visible TEB array diverged.
 *
 * Only EAX/ECX and flags are touched; all are volatile under cdecl.
 */
export function assembleMsvcr71GetPtdInline(
    filterAddress: number,
    targetAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const slowPatches: number[] = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const emitU32 = (value: number) => emit(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    );
    const slow = () => {
        emit(0x0f, 0x84); // jz rel32
        slowPatches.push(code.length);
        emitU32(0);
    };

    emit(0x64, 0xa1); emitU32(0x2c); // mov eax,fs:[0x2c] (TLS array)
    emit(0x85, 0xc0);                // test eax,eax
    slow();
    emit(0x8b, 0x0d);                // mov ecx,[tls-index-global]
    emitU32((targetAddress + MSVCR71_GETPTD_TLS_INDEX_DELTA) >>> 0);
    emit(0x83, 0xf9, 0x40);          // cmp ecx,64
    emit(0x0f, 0x83);                // jae .original
    slowPatches.push(code.length);
    emitU32(0);
    emit(0x8b, 0x04, 0x88);          // mov eax,[eax+ecx*4]
    emit(0x85, 0xc0);                // test eax,eax
    slow();
    emit(0xc3);                      // ret

    const slowOffset = code.length;
    emit(0xe8);                      // call trampoline/original
    const trampolinePatch = code.length;
    emitU32(0);
    emit(0x85, 0xc0);                // test eax,eax
    emit(0x0f, 0x84);                // jz .return
    const zeroReturnPatch = code.length;
    emitU32(0);
    emit(0x8b, 0xd0);                // mov edx,eax (preserve result)
    emit(0x64, 0xa1); emitU32(0x2c); // mov eax,fs:[0x2c]
    emit(0x85, 0xc0);                // test eax,eax
    emit(0x0f, 0x84);                // jz .restore
    const noArrayPatch = code.length;
    emitU32(0);
    emit(0x8b, 0x0d);                // mov ecx,[tls-index-global]
    emitU32((targetAddress + MSVCR71_GETPTD_TLS_INDEX_DELTA) >>> 0);
    emit(0x83, 0xf9, 0x40);          // cmp ecx,64
    emit(0x0f, 0x83);                // jae .restore
    const badIndexPatch = code.length;
    emitU32(0);
    emit(0x89, 0x14, 0x88);          // mov [eax+ecx*4],edx
    const restoreOffset = code.length;
    emit(0x8b, 0xc2);                // mov eax,edx
    const returnOffset = code.length;
    emit(0xc3);                      // ret

    const slowAddress = filterAddress + slowOffset;
    for (const patch of slowPatches) {
        const rel = (slowAddress - (filterAddress + patch + 4)) | 0;
        for (let i = 0; i < 4; i++) code[patch + i] = (rel >>> (i * 8)) & 0xff;
    }
    const patchBranch = (patch: number, targetOffset: number) => {
        const rel = (filterAddress + targetOffset - (filterAddress + patch + 4)) | 0;
        for (let i = 0; i < 4; i++) code[patch + i] = (rel >>> (i * 8)) & 0xff;
    };
    patchBranch(zeroReturnPatch, returnOffset);
    patchBranch(noArrayPatch, restoreOffset);
    patchBranch(badIndexPatch, restoreOffset);
    const trampolineRel = (trampolineAddress - (filterAddress + trampolinePatch + 4)) | 0;
    for (let i = 0; i < 4; i++) code[trampolinePatch + i] = (trampolineRel >>> (i * 8)) & 0xff;
    return Uint8Array.from(code);
}

export function buildMsvcr71GetPtdInline(info: EntryFilterInfo): number | null {
    const size = assembleMsvcr71GetPtdInline(0x1000, info.targetAddress, 0x2000).length;
    const address = info.allocCode(size);
    const code = assembleMsvcr71GetPtdInline(address, info.targetAddress, info.trampolineAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}
