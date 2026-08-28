import type { EntryFilterInfo } from '../../types';

/** RVA delta from the exported VC71 `_stricmp` locale wrapper to `_tlsindex`. */
export const MSVCR71_STRICMP_TLS_INDEX_DELTA = 0x3ae54;

/**
 * Admit the exported `_stricmp` wrapper directly to the WASM ASCII comparator
 * only when the current thread's VC71 locale is the C locale. Locale-aware
 * calls retain the complete original wrapper.
 */
export function assembleMsvcr71LocaleStricmpFilter(
    filterAddress: number,
    targetAddress: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const originalPatches: number[] = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const emitU32 = (value: number) => emit(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    );
    const toOriginal = (condition: number) => {
        emit(0x0f, condition);
        originalPatches.push(code.length);
        emitU32(0);
    };

    emit(0x64, 0xa1); emitU32(0x2c); // mov eax,fs:[0x2c]
    emit(0x85, 0xc0);                // test eax,eax
    toOriginal(0x84);                // jz original
    emit(0x8b, 0x0d);                // mov ecx,[tls-index-global]
    emitU32((targetAddress + MSVCR71_STRICMP_TLS_INDEX_DELTA) >>> 0);
    emit(0x83, 0xf9, 0x40);          // cmp ecx,64
    toOriginal(0x83);                // jae original
    emit(0x8b, 0x04, 0x88);          // mov eax,[eax+ecx*4] (PTD)
    emit(0x85, 0xc0);
    toOriginal(0x84);
    emit(0x8b, 0x40, 0x64);          // mov eax,[eax+0x64] (locale)
    emit(0x85, 0xc0);
    toOriginal(0x84);
    emit(0x83, 0x78, 0x14, 0x00);    // cmp dword [eax+0x14],0
    toOriginal(0x85);                // jne original

    const stubJmpOffset = code.length;
    emit(0xe9); emitU32(0);
    const originalOffset = code.length;
    emit(0xe9); emitU32(0);

    const originalAddress = filterAddress + originalOffset;
    for (const patch of originalPatches) {
        const rel = (originalAddress - (filterAddress + patch + 4)) | 0;
        for (let i = 0; i < 4; i++) code[patch + i] = (rel >>> (i * 8)) & 0xff;
    }
    const patchJmp = (offset: number, target: number) => {
        const rel = (target - (filterAddress + offset + 5)) | 0;
        for (let i = 0; i < 4; i++) code[offset + 1 + i] = (rel >>> (i * 8)) & 0xff;
    };
    patchJmp(stubJmpOffset, stubAddress);
    patchJmp(originalOffset, trampolineAddress);
    return Uint8Array.from(code);
}

export function buildMsvcr71LocaleStricmpFilter(info: EntryFilterInfo): number | null {
    const size = assembleMsvcr71LocaleStricmpFilter(0x1000, info.targetAddress, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleMsvcr71LocaleStricmpFilter(
        address, info.targetAddress, info.stubAddress, info.trampolineAddress,
    );
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}
