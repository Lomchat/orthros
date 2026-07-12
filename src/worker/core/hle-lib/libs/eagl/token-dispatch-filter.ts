/**
 * EAGL token-dispatch guest filter — PURE assembler, dependency-free so the
 * byte layout is unit-testable (tools/tests/eagl-token-dispatch.test.ts)
 * without worker singletons. Instruction-level commentary and the config
 * block contract live in ./token-dispatch.ts; the emitted shape is:
 *
 *   cmp byte [cfg+CFG_ENABLED_FLAG], 0 ; jz .orig      — armed gate
 *   mov edx, [esp+4] ; test edx, edx ; jz .orig        — node
 *   mov eax, [edx] ; cmp eax, -1 ; jne .cls
 *   mov edx, [edx+0x64] ; mov eax, [edx]               — alias node
 * .cls:
 *   imul eax, eax, 0x1c
 *   mov eax, [eax + tokenTable]                        — descriptor u32
 *   shr eax, 24                                        — class
 *   cmp eax,1 ; je .hyp ; cmp eax,2 ; je .hyp ; cmp eax,8 ; je .hyp
 *   cmp eax,6 ; jne .orig                              — class-6 batch path:
 *   cmp dword [ecx+0x84], 2 ; jne .hyp                 — record mode (2) must
 *                                                        run the original
 *                                                        (BeginStateBlock)
 * .orig: jmp trampoline                                — original, native
 * .hyp:  jmp stub                                      — OUT → handler 132
 *
 * ECX = `this` (EAGL device ctx) — thiscall, untouched by the filter; the
 * [ecx+0x84] commit-mode load has the same #PF surface as the original's own
 * unchecked ctx dereferences.
 */

/** Offset of the guest-filter gate byte inside the config block — must match
 *  token-dispatch.ts CFG_ENABLED_FLAG and stay clear of the fields read by
 *  hypercall.rs handle_eagl_token_dispatch (0x00..0x30). */
export const FILTER_ENABLED_FLAG_OFF = 0x34;

export function assembleTokenDispatchFilter(
    filterAddr: number,
    cfgBase: number,
    tokenTable: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const rel32Patches: Array<{ at: number; label: 'orig' | 'hyp' }> = [];
    const emit = (...bytes: number[]) => { code.push(...bytes); };
    const emitU32 = (v: number) => {
        code.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    };
    const emitJcc32 = (opcode2: number, label: 'orig' | 'hyp') => {
        emit(0x0f, opcode2);
        rel32Patches.push({ at: code.length, label });
        emitU32(0);
    };

    emit(0x80, 0x3d); emitU32(cfgBase + FILTER_ENABLED_FLAG_OFF); emit(0x00); // cmp byte [flag], 0
    emitJcc32(0x84, 'orig');                                           // jz .orig
    emit(0x8b, 0x54, 0x24, 0x04);                                      // mov edx, [esp+4]
    emit(0x85, 0xd2);                                                  // test edx, edx
    emitJcc32(0x84, 'orig');                                           // jz .orig
    emit(0x8b, 0x02);                                                  // mov eax, [edx]
    emit(0x83, 0xf8, 0xff);                                            // cmp eax, -1
    emit(0x75, 0x05);                                                  // jne .cls (+5)
    emit(0x8b, 0x52, 0x64);                                            // mov edx, [edx+0x64]
    emit(0x8b, 0x02);                                                  // mov eax, [edx]
    // .cls:
    emit(0x6b, 0xc0, 0x1c);                                            // imul eax, eax, 0x1c
    emit(0x8b, 0x80); emitU32(tokenTable);                             // mov eax, [eax+tbl]
    emit(0xc1, 0xe8, 0x18);                                            // shr eax, 24
    emit(0x83, 0xf8, 0x01);                                            // cmp eax, 1
    emitJcc32(0x84, 'hyp');                                            // je .hyp
    emit(0x83, 0xf8, 0x02);                                            // cmp eax, 2
    emitJcc32(0x84, 'hyp');                                            // je .hyp
    emit(0x83, 0xf8, 0x08);                                            // cmp eax, 8
    emitJcc32(0x84, 'hyp');                                            // je .hyp
    emit(0x83, 0xf8, 0x06);                                            // cmp eax, 6
    emitJcc32(0x85, 'orig');                                           // jne .orig
    emit(0x83, 0xb9, 0x84, 0x00, 0x00, 0x00, 0x02);                    // cmp dword [ecx+0x84], 2
    emitJcc32(0x85, 'hyp');                                            // jne .hyp (mode 2 falls to .orig)
    const origOff = code.length;
    emit(0xe9, 0, 0, 0, 0);                                            // .orig: jmp trampoline
    const hypOff = code.length;
    emit(0xe9, 0, 0, 0, 0);                                            // .hyp: jmp stub

    // Resolve label rel32s (relative to the *absolute* next-instruction addr).
    for (const p of rel32Patches) {
        const target = filterAddr + (p.label === 'orig' ? origOff : hypOff);
        const rel = (target - (filterAddr + p.at + 4)) | 0;
        code[p.at] = rel & 0xff; code[p.at + 1] = (rel >>> 8) & 0xff;
        code[p.at + 2] = (rel >>> 16) & 0xff; code[p.at + 3] = (rel >>> 24) & 0xff;
    }
    const relOrig = (trampolineAddress - (filterAddr + origOff + 5)) | 0;
    code[origOff + 1] = relOrig & 0xff; code[origOff + 2] = (relOrig >>> 8) & 0xff;
    code[origOff + 3] = (relOrig >>> 16) & 0xff; code[origOff + 4] = (relOrig >>> 24) & 0xff;
    const relHyp = (stubAddress - (filterAddr + hypOff + 5)) | 0;
    code[hypOff + 1] = relHyp & 0xff; code[hypOff + 2] = (relHyp >>> 8) & 0xff;
    code[hypOff + 3] = (relHyp >>> 16) & 0xff; code[hypOff + 4] = (relHyp >>> 24) & 0xff;
    return Uint8Array.from(code);
}

/** Byte length of the assembled filter (address-independent). */
export function tokenDispatchFilterSize(): number {
    return assembleTokenDispatchFilter(0x1000, 0, 0, 0x2000, 0x3000).length;
}
