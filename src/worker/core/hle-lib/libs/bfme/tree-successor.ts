import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

const PARENT = 0x04;
const LEFT = 0x08;
const RIGHT = 0x0c;
const MAX_STEPS = 65_536;

/**
 * lotrbfme.exe 1.03 FR @ 0x00c2b870: advance an STL tree iterator to its
 * in-order successor. The node layout is parent/left/right at +4/+8/+12.
 *
 * This is intentionally read-only. Returning null on an invalid address or a
 * corrupt cycle lets callers decline the optimization without partially
 * mutating guest state.
 */
export function bfmeTreeSuccessor(memory: Uint8Array, start: number): number | null {
    let node = start >>> 0;
    if (!node) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const read = (address: number): number | null => {
        address >>>= 0;
        return address <= memory.length - 4 ? view.getUint32(address, true) : null;
    };

    const right = read(node + RIGHT);
    if (right === null) return null;
    if (right !== 0) {
        node = right;
        for (let steps = 0; steps < MAX_STEPS; steps++) {
            const left = read(node + LEFT);
            if (left === null) return null;
            if (left === 0) return node | 0;
            node = left;
        }
        return null;
    }

    let parent = read(node + PARENT);
    if (parent === null) return null;
    for (let steps = 0; steps < MAX_STEPS; steps++) {
        const parentRight = read(parent + RIGHT);
        if (parentRight === null) return null;
        if (node !== parentRight) {
            const nodeRight = read(node + RIGHT);
            if (nodeRight === null) return null;
            return (nodeRight === parent ? node : parent) | 0;
        }
        node = parent;
        parent = read(parent + PARENT)!;
        if (parent === null) return null;
    }
    return null;
}

export const bfmeTreeSuccessorHandler: ThunkImplementation = (_ctx, memory, args) =>
    bfmeTreeSuccessor(memory, args[0] >>> 0) ?? 0;
