import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Exact front cache for lotrbfme.exe 1.03 FR's DXT colour encoder at
 * 0x00e67124. EAX is an implicit fourth input (sixteen RGBA-float pixels),
 * while the original callee pops its three stack arguments.
 *
 * The same WASM handler is called in two phases:
 *   phase 0: exact lookup; EAX=1 means the 8-byte output was restored
 *   phase 1: record the byte-exact output after the original encoder ran
 *
 * A miss executes the relocated original body. The wrapper keeps all three
 * callee-saved registers and the original stdcall stack contract intact.
 */
export function assembleBfmeDxtEncodeCacheWrapper(
    address: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [
        0x53,                         // push ebx
        0x56,                         // push esi
        0x57,                         // push edi
        0x89, 0xc6,                   // mov esi,eax (source)
        0x8b, 0x7c, 0x24, 0x10,       // mov edi,[esp+16] (output)
        0x8b, 0x5c, 0x24, 0x14,       // mov ebx,[esp+20] (mode)
        0xff, 0x74, 0x24, 0x18,       // push [esp+24] (saved option)

        0x6a, 0x00,                   // push 0 (lookup phase)
        0xff, 0x74, 0x24, 0x04,       // push saved option
        0x53,                         // push ebx (mode)
        0x57,                         // push edi (output)
        0x56,                         // push esi (source)
        0xe8, 0, 0, 0, 0,             // call cache handler (ret 20)
        0x85, 0xc0,                   // test eax,eax
        0x75, 0x1a,                   // jnz common success

        0xff, 0x34, 0x24,             // push saved option
        0x53,                         // push ebx
        0x57,                         // push edi
        0x89, 0xf0,                   // mov eax,esi
        0xe8, 0, 0, 0, 0,             // call relocated original (ret 12)

        0x6a, 0x01,                   // push 1 (record phase)
        0xff, 0x74, 0x24, 0x04,       // push saved option
        0x53,                         // push ebx
        0x57,                         // push edi
        0x56,                         // push esi
        0xe8, 0, 0, 0, 0,             // call cache handler (ret 20)

        0x83, 0xc4, 0x04,             // common: discard saved option
        0x5f,                         // pop edi
        0x5e,                         // pop esi
        0x5b,                         // pop ebx
        0x31, 0xc0,                   // xor eax,eax
        0xc2, 0x0c, 0x00,             // ret 12
    ];
    // CALL opcodes are at bytes 26, 42 and 56; patch only their rel32 fields.
    code.splice(27, 4, ...rel32(address + 31, stubAddress));
    code.splice(43, 4, ...rel32(address + 47, trampolineAddress));
    code.splice(57, 4, ...rel32(address + 61, stubAddress));
    return Uint8Array.from(code);
}

export function buildBfmeDxtEncodeCacheWrapper(info: EntryFilterInfo): number | null {
    const size = assembleBfmeDxtEncodeCacheWrapper(0x1000, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeDxtEncodeCacheWrapper(address, info.stubAddress, info.trampolineAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

let fallbackCalls = 0;

/** Safe fallback when the WASM cache cannot inspect a call: report a miss. */
export const bfmeDxtEncodeCacheFallback: ThunkImplementation = () => {
    fallbackCalls++;
    return 0;
};

export function getBfmeDxtEncodeCacheFallbacks(reset = false): number {
    const result = fallbackCalls;
    if (reset) fallbackCalls = 0;
    return result;
}
