import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Route the parser's one-byte read to the BFME WASM kernel. Every other size
 * re-enters the byte-exact original routine. The wrapper supplies the implicit
 * this pointer as the kernel's first explicit argument. */
export function assembleBfmeMemoryStreamRead1Filter(
    address: number,
    stubAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [
        0x83, 0x7c, 0x24, 0x08, 0x01, // cmp dword [esp+8],1
        0x0f, 0x85, 0, 0, 0, 0,       // jne original
        0xff, 0x74, 0x24, 0x08,       // push dword [esp+8] (size)
        0xff, 0x74, 0x24, 0x08,       // push dword [esp+8] (destination)
        0x51,                           // push ecx (object)
        0xe8, 0, 0, 0, 0,             // call handler stub (ret 12)
        0xc2, 0x08, 0x00,             // ret 8
        0xe9, 0, 0, 0, 0,             // original: jmp relocated prologue
    ];
    const originalAt = 28;
    code.splice(7, 4, ...rel32(address + 11, address + originalAt));
    code.splice(21, 4, ...rel32(address + 25, stubAddress));
    code.splice(originalAt + 1, 4, ...rel32(address + originalAt + 5, trampolineAddress));
    return Uint8Array.from(code);
}

export function buildBfmeMemoryStreamRead1Filter(info: EntryFilterInfo): number | null {
    const size = assembleBfmeMemoryStreamRead1Filter(0x1000, 0x2000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeMemoryStreamRead1Filter(
        address,
        info.stubAddress,
        info.trampolineAddress,
    );
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    return address;
}

export function readBfmeMemoryStream1(memory: Uint8Array, args: number[]): number {
    const object = args[0] >>> 0;
    const destination = args[1] >>> 0;
    if ((args[2] | 0) !== 1 || !object || object + 0x20 > memory.length) return -1;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const base = view.getUint32(object + 0x14, true) >>> 0;
    if (!base) return -1;
    const position = view.getInt32(object + 0x18, true);
    const end = view.getInt32(object + 0x1c, true);
    const available = (end - position) | 0;
    const count = 1 <= available ? 1 : available;
    if (count > 0 && destination) {
        const source = (base + position) >>> 0;
        if (source >= memory.length || destination >= memory.length) return -1;
        memory[destination] = memory[source];
    }
    view.setInt32(object + 0x18, (position + count) | 0, true);
    return count;
}

/** JS fallback used only if the WASM kernel declines the guarded call. */
export const bfmeMemoryStreamRead1Fallback: ThunkImplementation = (_ctx, memory, args) =>
    readBfmeMemoryStream1(memory, args);
