import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';
import { libHleManager } from '../../lib-hle-manager';

const LIB_ID = 'msvcr71';
const FN_NAME = 'sscanf_scalar';

function putRel32(code: number[], at: number, fromAfter: number, target: number): void {
    const rel = (target - fromAfter) | 0;
    code[at] = rel & 0xff;
    code[at + 1] = (rel >>> 8) & 0xff;
    code[at + 2] = (rel >>> 16) & 0xff;
    code[at + 3] = (rel >>> 24) & 0xff;
}

/** Admit only the three exact one-output formats proven hot in BFME. Complex
 * and variadic formats stay entirely inside the original MSVCR71 parser. */
export function assembleMsvcr71SscanfScalarFilter(
    base: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const declines: number[] = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const accepts: number[] = [];
    const jcc8 = (opcode: number, list: number[]) => {
        emit(opcode, 0);
        list.push(code.length - 1);
    };

    emit(0x8b, 0x44, 0x24, 0x04);             // mov eax,[esp+4]  input
    emit(0x85, 0xc0);                           // test eax,eax
    jcc8(0x74, declines);                       // jz decline
    emit(0x8b, 0x54, 0x24, 0x08);             // mov edx,[esp+8]  format
    emit(0x85, 0xd2);                           // test edx,edx
    jcc8(0x74, declines);
    emit(0x0f, 0xb7, 0x0a);                    // movzx ecx,word [edx]
    emit(0x81, 0xf9, 0x25, 0x64, 0, 0);       // cmp ecx,"%d"
    jcc8(0x74, accepts);
    emit(0x81, 0xf9, 0x25, 0x75, 0, 0);       // cmp ecx,"%u"
    jcc8(0x74, accepts);
    emit(0x81, 0xf9, 0x25, 0x66, 0, 0);       // cmp ecx,"%f"
    jcc8(0x75, declines);
    const acceptedKindOffset = code.length;
    emit(0x80, 0x7a, 0x02, 0x00);              // cmp byte [edx+2],0
    jcc8(0x75, declines);
    const acceptOffset = code.length;
    emit(0xe9, 0, 0, 0, 0);                    // jmp WASM dispatch stub
    const declineOffset = code.length;
    emit(0xe9, 0, 0, 0, 0);                    // jmp trampoline

    for (const at of accepts) code[at] = (acceptedKindOffset - (at + 1)) & 0xff;
    for (const at of declines) code[at] = (declineOffset - (at + 1)) & 0xff;
    putRel32(code, declineOffset + 1, base + declineOffset + 5, trampolineAddress);
    putRel32(code, acceptOffset + 1, base + acceptOffset + 5, stubAddress);
    return Uint8Array.from(code);
}

export function buildMsvcr71SscanfScalarFilter(info: EntryFilterInfo): number | null {
    // Allocate once with the fixed length, then assemble address-relative JMPs.
    const size = 64;
    const address = info.allocCode(size);
    const code = assembleMsvcr71SscanfScalarFilter(address, info.stubAddress, info.trampolineAddress);
    if (code.length > size || address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

/** Only reached when the WASM parser deliberately declines unsupported scanf
 * syntax or an unusual token. Complete that call through the exact CRT. */
export const msvcr71SscanfScalarFallback: ThunkImplementation = (_ctx, _mem, args) => {
    const result = libHleManager.callOriginalSync(
        LIB_ID, FN_NAME, [args[0] >>> 0, args[1] >>> 0, args[2] >>> 0], 'cdecl', true,
    );
    return result.ok ? result.eax : 0;
};
