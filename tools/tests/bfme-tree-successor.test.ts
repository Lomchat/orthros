import { describe, expect, test } from 'bun:test';
import { bfmeTreeSuccessor } from '../../src/worker/core/hle-lib/libs/bfme/tree-successor';

function treeMemory() {
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    const link = (node: number, parent: number, left: number, right: number) => {
        view.setUint32(node + 0x04, parent, true);
        view.setUint32(node + 0x08, left, true);
        view.setUint32(node + 0x0c, right, true);
    };
    return { memory, link };
}

describe('BFME tree successor kernel', () => {
    test('descends to the leftmost node in the right subtree', () => {
        const { memory, link } = treeMemory();
        link(0x100, 0x700, 0, 0x300);
        link(0x300, 0x100, 0x200, 0x400);
        link(0x200, 0x300, 0, 0);
        expect(bfmeTreeSuccessor(memory, 0x100)).toBe(0x200);
    });

    test('ascends through right children and returns the first parent on the left', () => {
        const { memory, link } = treeMemory();
        link(0x100, 0x200, 0, 0);
        link(0x200, 0x300, 0, 0x100);
        link(0x300, 0x700, 0x200, 0x400);
        link(0x700, 0x700, 0x300, 0x700); // sentinel
        expect(bfmeTreeSuccessor(memory, 0x100)).toBe(0x300);
    });

    test('returns the sentinel after the rightmost node', () => {
        const { memory, link } = treeMemory();
        link(0x100, 0x700, 0, 0);
        link(0x700, 0x700, 0x100, 0x100);
        expect(bfmeTreeSuccessor(memory, 0x100)).toBe(0x700);
    });

    test('declines null, out-of-range and cyclic inputs', () => {
        const { memory, link } = treeMemory();
        link(0x100, 0x700, 0, 0x200);
        link(0x200, 0x100, 0x200, 0);
        expect(bfmeTreeSuccessor(memory, 0)).toBeNull();
        expect(bfmeTreeSuccessor(memory, 0xffc)).toBeNull();
        expect(bfmeTreeSuccessor(memory, 0x100)).toBeNull();
    });
});
