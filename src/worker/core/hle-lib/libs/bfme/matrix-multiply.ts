import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

const FLOATS = 6;
const BYTES = FLOATS * 4;

/**
 * BFME 1.03 FR @ 0x00cd2d10. Compose two 2D affine matrices while retaining
 * the original function's alias-safe behavior: both inputs are snapshotted
 * before the first result is stored.
 *
 * The x87 implementation multiplies binary32 inputs in extended precision and
 * rounds only at each final FSTP. JavaScript binary64 has enough significand
 * bits to represent every binary32 product and each two/three-term sum used
 * here, so one final setFloat32 produces the same finite result.
 */
export function multiplyBfmeAffine(
    memory: Uint8Array,
    leftAddress: number,
    rightAddress: number,
    outputAddress: number,
): number | null {
    leftAddress >>>= 0;
    rightAddress >>>= 0;
    outputAddress >>>= 0;
    if (!leftAddress || !rightAddress || !outputAddress) return null;
    if (leftAddress + BYTES > memory.length || rightAddress + BYTES > memory.length
        || outputAddress + BYTES > memory.length) return null;

    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const left = Array.from({ length: FLOATS }, (_, i) => view.getFloat32(leftAddress + i * 4, true));
    const right = Array.from({ length: FLOATS }, (_, i) => view.getFloat32(rightAddress + i * 4, true));
    const result = [
        left[2] * right[1] + left[0] * right[0],
        left[3] * right[1] + left[1] * right[0],
        right[3] * left[2] + right[2] * left[0],
        right[3] * left[3] + right[2] * left[1],
        right[5] * left[2] + right[4] * left[0] + left[4],
        right[5] * left[3] + right[4] * left[1] + left[5],
    ];
    for (let i = 0; i < FLOATS; i++) view.setFloat32(outputAddress + i * 4, result[i], true);
    return outputAddress | 0;
}

export const bfmeMatrixMultiplyHandler: ThunkImplementation = (_ctx, memory, args) =>
    multiplyBfmeAffine(memory, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0) ?? 0;

/** Apply BFME's component-wise scale/translation helper at 0x00cd2bb0. */
export function adjustBfmeMatrix(memory: Uint8Array, object: number, adjustment: number): number | null {
    object >>>= 0;
    adjustment >>>= 0;
    if (!object || !adjustment || object + 32 > memory.length || adjustment + 32 > memory.length) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    // Each field is independent in the guest implementation, but snapshotting
    // also preserves correct behavior when both pointers alias exactly.
    const current = Array.from({ length: 8 }, (_, i) => view.getFloat32(object + i * 4, true));
    const delta = Array.from({ length: 8 }, (_, i) => view.getFloat32(adjustment + i * 4, true));
    for (let i = 0; i < 4; i++) view.setFloat32(object + i * 4, delta[i] * current[i], true);
    for (let i = 4; i < 8; i++) view.setFloat32(object + i * 4, delta[i] + current[i], true);
    return object | 0;
}

export const bfmeMatrixAdjustHandler: ThunkImplementation = (ctx, memory, args) =>
    adjustBfmeMatrix(memory, ctx.ecx >>> 0, args[0] >>> 0) ?? 0;
