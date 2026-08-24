import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

function checkedU16(view: DataView, memoryLength: number, address: number): number | null {
    address >>>= 0;
    if (address + 2 > memoryLength) return null;
    return view.getUint16(address, true);
}

function checkedU32(view: DataView, memoryLength: number, address: number): number | null {
    address >>>= 0;
    if (address + 4 > memoryLength) return null;
    return view.getUint32(address, true) >>> 0;
}

function stringbase(
    view: DataView,
    memoryLength: number,
    object: number,
): { chars: number; length: number } | null {
    const storage = checkedU32(view, memoryLength, object);
    if (storage === null) return null;
    if (storage === 0) return { chars: 0, length: 0 };
    const length = checkedU16(view, memoryLength, (storage + 4) >>> 0);
    if (length === null) return null;
    const chars = (storage + 8) >>> 0;
    if (chars + length > memoryLength) return null;
    return { chars, length };
}

/**
 * BFME 1.03 FR @ 0x008a0270. Look up a stringbase key in the container's
 * single-linked node chain. The original compares bytes with REP CMPSB and
 * advances through node+0x60 after every mismatch.
 *
 * Returning null means the memory shape is invalid for the JS safety tier;
 * valid empty strings intentionally use chars=0 because no byte is read.
 */
export function findBfmeStringNode(
    memory: Uint8Array,
    container: number,
    keyObject: number,
): number | null {
    container >>>= 0;
    keyObject >>>= 0;
    if (!container || !keyObject) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    let node = checkedU32(view, memory.length, (container + 0x2c) >>> 0);
    if (node === null) return null;
    const key = stringbase(view, memory.length, keyObject);
    if (!key) return null;

    // A corrupt cycle would also loop forever in the original function. Keep
    // the JS fallback bounded so a bad pointer cannot freeze the host worker.
    const maxNodes = Math.max(1, Math.floor(memory.length / 4));
    for (let visited = 0; node !== 0 && visited < maxNodes; visited++) {
        const nodeStorage = checkedU32(view, memory.length, (node + 0x0c) >>> 0);
        if (nodeStorage === null) return null;
        let nodeChars = 0;
        let nodeLength = 0;
        if (nodeStorage !== 0) {
            const length = checkedU16(view, memory.length, (nodeStorage + 4) >>> 0);
            if (length === null) return null;
            nodeLength = length;
            nodeChars = (nodeStorage + 8) >>> 0;
            if (nodeChars + nodeLength > memory.length) return null;
        }

        if (nodeLength === key.length) {
            let equal = true;
            for (let i = 0; i < key.length; i++) {
                if (memory[nodeChars + i] !== memory[key.chars + i]) {
                    equal = false;
                    break;
                }
            }
            if (equal) return node;
        }

        const next = checkedU32(view, memory.length, (node + 0x60) >>> 0);
        if (next === null) return null;
        node = next;
    }
    return node === 0 ? 0 : null;
}

export const bfmeStringFindHandler: ThunkImplementation = (ctx, memory, args) =>
    findBfmeStringNode(memory, ctx.ecx, args[0] >>> 0) ?? 0;
