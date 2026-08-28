import { describe, expect, test } from 'bun:test';
import { invertMatrix4, multiplyMatrices } from '../../src/worker/modules/d3dx9/math';

function expectMatrixClose(actual: Float32Array, expected: readonly number[], digits = 5): void {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < actual.length; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

describe('D3DX matrix math', () => {
    test('inverts identity and reports determinant one', () => {
        const identity = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]);
        const result = invertMatrix4(identity);
        expect(result).not.toBeNull();
        expect(result!.determinant).toBeCloseTo(1, 7);
        expectMatrixClose(result!.inverse, identity);
    });

    test('inverts a general affine matrix and multiplies back to identity', () => {
        const matrix = new Float32Array([
            2, 0.5, 0, 0,
            0, 3, -0.25, 0,
            0.75, 0, 4, 0,
            12, -7, 2.5, 1,
        ]);
        const result = invertMatrix4(matrix);
        expect(result).not.toBeNull();
        expect(result!.determinant).toBeCloseTo(23.90625, 5);
        expectMatrixClose(multiplyMatrices(matrix, result!.inverse), [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ], 4);
    });

    test('rejects a singular matrix', () => {
        const singular = new Float32Array([
            1, 2, 3, 4,
            2, 4, 6, 8,
            0, 1, 0, 0,
            0, 0, 0, 1,
        ]);
        expect(invertMatrix4(singular)).toBeNull();
    });
});
