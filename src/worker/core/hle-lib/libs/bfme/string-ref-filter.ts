import type { EntryFilterInfo } from '../../types';

const STRINGBASE_LOCK_GUARD = 0x01336e2c;

type FilterKind = 'release' | 'copy' | 'assign';

/**
 * Guest-side guards for the three extremely hot `stringbase<char>` reference
 * helpers in BFME 1.03 FR. The process-wide string lock must have been
 * initialized by the original code before any fast path is admitted.
 *
 * Registers used here are volatile in MSVC thiscall code (EAX/EDX). ECX and
 * ESP remain exactly as they were at function entry for both the OUT stub and
 * the relocated-prologue decline path.
 */
export function assembleBfmeStringRefFilter(
    kind: FilterKind,
    filterAddress: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const patches: Array<{ at: number; label: 'hyp' | 'orig' }> = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const emitU32 = (value: number) => emit(
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    );
    const jcc = (opcode2: number, label: 'hyp' | 'orig') => {
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
        jcc(0x84, 'hyp');             // null object is a complete fast path
        emit(0x83, 0x38, 0x01);       // cmp dword [eax],1
        jcc(0x87, 'hyp');             // refcount > 1: decrement without freeing
    } else {
        emit(0x8b, 0x54, 0x24, 0x04); // mov edx,[esp+4] (source object)
        emit(0x85, 0xd2);             // test edx,edx
        jcc(0x84, 'orig');
        if (kind === 'copy') {
            // Copy construction never releases an old destination value.
            jcc(0x85, 'hyp');         // JNZ is unconditional here: test edx above
        } else {
            emit(0x3b, 0xca);         // cmp ecx,edx
            jcc(0x84, 'hyp');         // self assignment
            emit(0x8b, 0x01);         // mov eax,[ecx] (old storage)
            emit(0x85, 0xc0);         // test eax,eax
            jcc(0x84, 'hyp');         // no old value to release
            emit(0x83, 0x38, 0x01);   // cmp dword [eax],1
            jcc(0x87, 'hyp');         // shared old value: decrement is enough
        }
    }

    // Every non-accepted fallthrough declines to the exact original code.
    const fallthroughOrig = code.length;
    emit(0xe9, 0, 0, 0, 0);
    const hypOffset = code.length;
    emit(0xe9, 0, 0, 0, 0);
    const origOffset = code.length;
    emit(0xe9, 0, 0, 0, 0);

    const labelOffset = (label: 'hyp' | 'orig') => label === 'hyp' ? hypOffset : origOffset;
    for (const patch of patches) {
        const target = filterAddress + labelOffset(patch.label);
        const rel = (target - (filterAddress + patch.at + 4)) | 0;
        for (let i = 0; i < 4; i++) code[patch.at + i] = (rel >>> (i * 8)) & 0xff;
    }
    const writeJmp = (offset: number, target: number) => {
        const rel = (target - (filterAddress + offset + 5)) | 0;
        for (let i = 0; i < 4; i++) code[offset + 1 + i] = (rel >>> (i * 8)) & 0xff;
    };
    writeJmp(fallthroughOrig, trampolineAddress);
    writeJmp(hypOffset, stubAddress);
    writeJmp(origOffset, trampolineAddress);
    return Uint8Array.from(code);
}

function build(kind: FilterKind, info: EntryFilterInfo): number | null {
    const size = assembleBfmeStringRefFilter(kind, 0x1000, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeStringRefFilter(kind, address, info.stubAddress, info.trampolineAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

export const buildBfmeStringReleaseFilter = (info: EntryFilterInfo) => build('release', info);
export const buildBfmeStringCopyFilter = (info: EntryFilterInfo) => build('copy', info);
export const buildBfmeStringAssignFilter = (info: EntryFilterInfo) => build('assign', info);

