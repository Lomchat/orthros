import type { EntryFilterInfo } from '../../types';

/**
 * Guest-side guard for BFME's `stringbase<char>::tolower` at 0x00c87da0.
 *
 * The original has a cheap in-place branch only when the backing store is
 * uniquely owned and has spare capacity.  Every other case performs the
 * class' copy-on-write/allocation machinery and must remain guest code.
 *
 *   ECX = stringbase object
 *   [ECX] = storage
 *   [storage+0] u32 refcount
 *   [storage+4] u16 length
 *   [storage+6] u16 capacity
 */
export function assembleBfmeStringLowerFilter(
    filterAddress: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const origPatches: number[] = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const emitU32 = (value: number) => emit(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    );
    const emitOrigJcc = (opcode2: number) => {
        emit(0x0f, opcode2);
        origPatches.push(code.length);
        emitU32(0);
    };

    emit(0x85, 0xc9);                         // test ecx, ecx
    emitOrigJcc(0x84);                        // jz .orig
    emit(0x8b, 0x11);                         // mov edx, [ecx]
    emit(0x85, 0xd2);                         // test edx, edx
    emitOrigJcc(0x84);                        // jz .orig
    emit(0x83, 0x3a, 0x01);                   // cmp dword [edx], 1
    emitOrigJcc(0x85);                        // jne .orig
    emit(0x0f, 0xb7, 0x42, 0x04);             // movzx eax, word [edx+4] (length)
    emit(0x66, 0x3b, 0x42, 0x06);             // cmp ax, word [edx+6] (capacity)
    emitOrigJcc(0x83);                        // jae .orig (length >= capacity)

    const hypOffset = code.length;
    emit(0xe9, 0, 0, 0, 0);                  // .hyp: jmp stub
    const origOffset = code.length;
    emit(0xe9, 0, 0, 0, 0);                  // .orig: jmp trampoline

    for (const at of origPatches) {
        const rel = (filterAddress + origOffset - (filterAddress + at + 4)) | 0;
        code[at] = rel & 0xff;
        code[at + 1] = (rel >>> 8) & 0xff;
        code[at + 2] = (rel >>> 16) & 0xff;
        code[at + 3] = (rel >>> 24) & 0xff;
    }
    const hypRel = (stubAddress - (filterAddress + hypOffset + 5)) | 0;
    code[hypOffset + 1] = hypRel & 0xff;
    code[hypOffset + 2] = (hypRel >>> 8) & 0xff;
    code[hypOffset + 3] = (hypRel >>> 16) & 0xff;
    code[hypOffset + 4] = (hypRel >>> 24) & 0xff;
    const origRel = (trampolineAddress - (filterAddress + origOffset + 5)) | 0;
    code[origOffset + 1] = origRel & 0xff;
    code[origOffset + 2] = (origRel >>> 8) & 0xff;
    code[origOffset + 3] = (origRel >>> 16) & 0xff;
    code[origOffset + 4] = (origRel >>> 24) & 0xff;
    return Uint8Array.from(code);
}

export function buildBfmeStringLowerFilter(info: EntryFilterInfo): number | null {
    const size = assembleBfmeStringLowerFilter(0x1000, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeStringLowerFilter(
        address,
        info.stubAddress,
        info.trampolineAddress,
    );
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

