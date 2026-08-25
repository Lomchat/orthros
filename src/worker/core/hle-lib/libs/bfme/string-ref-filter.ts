import type { EntryFilterInfo } from '../../types';

const STRINGBASE_LOCK_GUARD = 0x01336e2c;

type FilterKind = 'release' | 'copy' | 'assign';

/**
 * Guest-side guards for the three extremely hot `stringbase<char>` reference
 * helpers in BFME 1.03 FR. The process-wide string lock must have been
 * initialized by the original code before any fast path is admitted.
 *
 * Accepted branches execute the complete refcount operation directly in guest
 * code. This removes the OUT/WASM boundary from a path hit tens of thousands
 * of times per second. The builder registers the bounded wrapper as scheduler
 * non-preemptible, making each multi-instruction refcount transaction atomic
 * just like the previous single WASM handler invocation.
 *
 * Registers used here are volatile in MSVC thiscall code (EAX/EDX). ESP remains
 * exactly as it was at function entry; decline paths jump to the relocated
 * original prologue.
 */
export function assembleBfmeStringRefFilter(
    kind: FilterKind,
    filterAddress: number,
    _stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const patches: Array<{ at: number; label: 'fast' | 'orig' }> = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const emitU32 = (value: number) => emit(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    );
    const jcc = (opcode2: number, label: 'fast' | 'orig') => {
        emit(0x0f, opcode2);
        patches.push({ at: code.length, label });
        emitU32(0);
    };

    // test byte ptr [STRINGBASE_LOCK_GUARD], 1; jz .orig
    emit(0xf6, 0x05); emitU32(STRINGBASE_LOCK_GUARD); emit(0x01);
    jcc(0x84, 'orig');
    emit(0x85, 0xc9);                 // test ecx,ecx
    jcc(0x84, 'orig');

    if (kind === 'release') {
        emit(0x8b, 0x01);             // mov eax,[ecx]
        emit(0x85, 0xc0);             // test eax,eax
        jcc(0x84, 'fast');            // null storage is a complete fast path
        emit(0x83, 0x38, 0x01);       // cmp dword [eax],1
        jcc(0x86, 'orig');            // refcount <= 1: original must free
        emit(0xff, 0x08);             // dec dword [eax]
        emit(0xc7, 0x01, 0, 0, 0, 0); // mov dword [ecx],0
    } else {
        emit(0x8b, 0x54, 0x24, 0x04); // mov edx,[esp+4] (source object)
        emit(0x85, 0xd2);             // test edx,edx
        jcc(0x84, 'orig');
        if (kind === 'copy') {
            emit(0x8b, 0x02);         // mov eax,[edx] (new storage)
            emit(0x89, 0x01);         // mov [ecx],eax
            emit(0x85, 0xc0);         // test eax,eax
            emit(0x74, 0x02);         // jz +2
            emit(0xff, 0x00);         // inc dword [eax]
        } else {
            emit(0x3b, 0xca);         // cmp ecx,edx
            jcc(0x84, 'fast');        // self assignment
            emit(0x8b, 0x01);         // mov eax,[ecx] (old storage)
            emit(0x85, 0xc0);         // test eax,eax
            emit(0x74, 0x0b);         // jz .install
            emit(0x83, 0x38, 0x01);   // cmp dword [eax],1
            jcc(0x86, 'orig');        // unique old value needs allocator/free
            emit(0xff, 0x08);         // dec dword [eax]
            // .install
            emit(0x8b, 0x02);         // mov eax,[edx]
            emit(0x89, 0x01);         // mov [ecx],eax
            emit(0x85, 0xc0);         // test eax,eax
            emit(0x74, 0x02);         // jz +2
            emit(0xff, 0x00);         // inc dword [eax]
        }
    }

    const fastOffset = code.length;
    if (kind === 'release') {
        emit(0x33, 0xc0, 0xc3);       // xor eax,eax; ret
    } else {
        emit(0x8b, 0xc1, 0xc2, 0x04, 0x00); // mov eax,ecx; ret 4
    }
    const origOffset = code.length;
    emit(0xe9, 0, 0, 0, 0);

    const labelOffset = (label: 'fast' | 'orig') => label === 'fast' ? fastOffset : origOffset;
    for (const patch of patches) {
        const target = filterAddress + labelOffset(patch.label);
        const rel = (target - (filterAddress + patch.at + 4)) | 0;
        for (let i = 0; i < 4; i++) code[patch.at + i] = (rel >>> (i * 8)) & 0xff;
    }
    const writeJmp = (offset: number, target: number) => {
        const rel = (target - (filterAddress + offset + 5)) | 0;
        for (let i = 0; i < 4; i++) code[offset + 1 + i] = (rel >>> (i * 8)) & 0xff;
    };
    writeJmp(origOffset, trampolineAddress);
    return Uint8Array.from(code);
}

function build(kind: FilterKind, info: EntryFilterInfo): number | null {
    const size = assembleBfmeStringRefFilter(kind, 0x1000, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeStringRefFilter(kind, address, info.stubAddress, info.trampolineAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    info.markNonPreemptible(address, address + code.length);
    return address;
}

export const buildBfmeStringReleaseFilter = (info: EntryFilterInfo) => build('release', info);
export const buildBfmeStringCopyFilter = (info: EntryFilterInfo) => build('copy', info);
export const buildBfmeStringAssignFilter = (info: EntryFilterInfo) => build('assign', info);
