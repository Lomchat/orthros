import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

/** JS safety tier for a rare WASM decline after the guest filter accepted. */
export function lowerUniqueStringbase(memory: Uint8Array, objectAddress: number): number | null {
    const object = objectAddress >>> 0;
    if (object === 0 || object + 4 > memory.length) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const storage = view.getUint32(object, true) >>> 0;
    if (storage === 0 || storage + 9 > memory.length) return null;
    const refs = view.getUint32(storage, true) >>> 0;
    const length = view.getUint16(storage + 4, true);
    const capacity = view.getUint16(storage + 6, true);
    if (refs !== 1 || length >= capacity || storage + 8 + length >= memory.length) return null;

    let eax = storage;
    for (let i = 0; i < length; i++) {
        const at = storage + 8 + i;
        let byte = memory[at];
        if (byte >= 0x41 && byte <= 0x5a) byte += 0x20;
        memory[at] = byte;
        eax = byte;
    }
    memory[storage + 8 + length] = 0;
    return eax >>> 0;
}

export const bfmeStringLowerHandler: ThunkImplementation = (ctx, memory) => {
    // The x86 entry filter already enforces the unique/spare-capacity branch.
    // Re-check here because this is also the recovery tier for a WASM page-fault
    // decline.  A null result is unreachable in normal execution.
    return lowerUniqueStringbase(memory, ctx.ecx >>> 0) ?? 0;
};

