import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

/** Reference form of MSVCR71's internal 32-bit add-with-carry helper. */
export function msvcr71AddCarry(a: number, b: number): { sum: number; carry: number } {
    a >>>= 0;
    b >>>= 0;
    const sum = (a + b) >>> 0;
    return { sum, carry: sum < a ? 1 : 0 };
}

/** Reference form of the CRT's little-endian 96-bit shift-left helper. */
export function msvcr71Shift96(limbs: readonly [number, number, number]): [number, number, number] {
    const lo = limbs[0] >>> 0;
    const mid = limbs[1] >>> 0;
    const hi = limbs[2] >>> 0;
    return [
        (lo << 1) >>> 0,
        ((mid << 1) | (lo >>> 31)) >>> 0,
        ((hi << 1) | (mid >>> 31)) >>> 0,
    ];
}

/** Reference form of the CRT's ordered 96-bit in-place addition. The returned
 * carry is the carry produced by the final high-limb addition, matching EAX in
 * the original leaf. */
export function msvcr71Add96(
    left: readonly [number, number, number],
    right: readonly [number, number, number],
): { limbs: [number, number, number]; carry: number } {
    const lowWide = (left[0] >>> 0) + (right[0] >>> 0);
    const low = lowWide >>> 0;
    const midWide = (left[1] >>> 0) + (right[1] >>> 0) + Math.floor(lowWide / 0x1_0000_0000);
    const mid = midWide >>> 0;
    const highWide = (left[2] >>> 0) + (right[2] >>> 0) + Math.floor(midWide / 0x1_0000_0000);
    return {
        limbs: [low, mid, highWide >>> 0],
        carry: Math.floor(highWide / 0x1_0000_0000),
    };
}

/** Complete guest-native replacement for MSVCR71's internal add-with-carry
 * leaf used by floating-point decimal formatting. EAX/ECX/EDX are volatile
 * under cdecl; the wrapper preserves every non-volatile register. */
export function assembleMsvcr71AddCarryInline(): Uint8Array {
    return Uint8Array.from([
        0x8b, 0x4c, 0x24, 0x04,       // mov ecx,[esp+4]   ; a
        0x03, 0x4c, 0x24, 0x08,       // add ecx,[esp+8]   ; b
        0x0f, 0x92, 0xc0,             // setb al
        0x0f, 0xb6, 0xc0,             // movzx eax,al
        0x8b, 0x54, 0x24, 0x0c,       // mov edx,[esp+12]  ; out
        0x89, 0x0a,                   // mov [edx],ecx
        0xc3,                         // ret
    ]);
}

/** Complete guest-native replacement for the adjacent 96-bit left-shift leaf.
 * The three little-endian limbs are shifted in memory with the carry flag, so
 * the result is identical for every input while avoiding the original
 * push/pop pair and cross-block dispatches. */
export function assembleMsvcr71Shift96Inline(): Uint8Array {
    return Uint8Array.from([
        0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4]
        0xd1, 0x20,                   // shl dword [eax],1
        0xd1, 0x50, 0x04,             // rcl dword [eax+4],1
        0xd1, 0x50, 0x08,             // rcl dword [eax+8],1
        0xc3,                         // ret
    ]);
}

/** Complete guest-native replacement for MSVCR71's adjacent 96-bit add leaf.
 * The ordered reads deliberately mirror the original three add-with-carry
 * calls, including source/destination aliasing, while removing all nested
 * CALL/RET dispatch. */
export function assembleMsvcr71Add96Inline(): Uint8Array {
    return Uint8Array.from([
        0x8b, 0x54, 0x24, 0x04,       // mov edx,[esp+4]   ; destination
        0x8b, 0x44, 0x24, 0x08,       // mov eax,[esp+8]   ; source
        0x8b, 0x08,                   // mov ecx,[eax]
        0x01, 0x0a,                   // add [edx],ecx
        0x83, 0x52, 0x04, 0x00,       // adc dword [edx+4],0
        0x83, 0x52, 0x08, 0x00,       // adc dword [edx+8],0
        0x8b, 0x48, 0x04,             // mov ecx,[eax+4]
        0x01, 0x4a, 0x04,             // add [edx+4],ecx
        0x83, 0x52, 0x08, 0x00,       // adc dword [edx+8],0
        0x8b, 0x48, 0x08,             // mov ecx,[eax+8]
        0x01, 0x4a, 0x08,             // add [edx+8],ecx
        0x0f, 0x92, 0xc0,             // setb al
        0x0f, 0xb6, 0xc0,             // movzx eax,al
        0xc3,                         // ret
    ]);
}

function build(code: Uint8Array, info: EntryFilterInfo): number | null {
    const address = info.allocCode(code.length);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

export const buildMsvcr71AddCarryInline = (info: EntryFilterInfo) =>
    build(assembleMsvcr71AddCarryInline(), info);

export const buildMsvcr71Shift96Inline = (info: EntryFilterInfo) =>
    build(assembleMsvcr71Shift96Inline(), info);

export const buildMsvcr71Add96Inline = (info: EntryFilterInfo) =>
    build(assembleMsvcr71Add96Inline(), info);


// The generated wrappers never branch to the generic OUT stub. A registered
// handler is nevertheless required by the generic patcher.
export const msvcr71ArithmeticUnreachableHandler: ThunkImplementation = () => 0;
