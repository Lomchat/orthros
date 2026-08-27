import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

// Exact no-op constructors observed as the fourth argument of BFME's MSVC
// vector-constructor iterator. The three low addresses are executable JMP
// thunks whose destinations are likewise `mov eax,ecx; ret`.
export const BFME_NOOP_VECTOR_CTORS = [
    0x00dff5f6,
    0x004427ee,
    0x0044677c,
    0x00445561,
    0x00d23a10,
    0x00d6a910,
    0x00d79690,
] as const;

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Route known no-op element constructors to an immediate `ret 16`, while
 * every other constructor re-enters the byte-exact original helper. */
export function assembleBfmeVectorCtorFilter(
    address: number,
    trampolineAddress: number,
    constructors: readonly number[] = BFME_NOOP_VECTOR_CTORS,
): Uint8Array {
    const code: number[] = [];
    const fastFixups: number[] = [];
    for (const constructor of constructors) {
        code.push(0x81, 0x7c, 0x24, 0x10); // cmp dword [esp+0x10], imm32
        code.push(constructor & 0xff, (constructor >>> 8) & 0xff,
            (constructor >>> 16) & 0xff, (constructor >>> 24) & 0xff);
        code.push(0x74, 0x00);             // je fast
        fastFixups.push(code.length - 1);
    }
    const declineAt = address + code.length;
    code.push(0xe9, ...rel32(declineAt + 5, trampolineAddress));
    const fastOffset = code.length;
    code.push(0xc2, 0x10, 0x00);           // ret 16
    for (const offset of fastFixups) code[offset] = (fastOffset - (offset + 1)) & 0xff;
    return Uint8Array.from(code);
}

export function buildBfmeVectorCtorFilter(info: EntryFilterInfo): number | null {
    const size = BFME_NOOP_VECTOR_CTORS.length * 10 + 8;
    const address = info.allocCode(size);
    const code = assembleBfmeVectorCtorFilter(address, info.trampolineAddress);
    if (code.length !== size || address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

/** The filter never routes to the allocated OUT stub. */
export const bfmeVectorCtorUnreachableHandler: ThunkImplementation = () => 0;
