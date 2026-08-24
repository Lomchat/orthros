import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

const DEPTH = 0x3b8;
const STACK = 0x38;
const MATRIX_BYTES = 32;
const TRANSFORM_DEPTH = 0x3bc;
const TRANSFORM_SOURCE = 0x20;
const TRANSFORM_STACK = 0x238;
const TRANSFORM_BYTES = 24;

export function pushBfmeMatrix(memory: Uint8Array, object: number): number | null {
    if (object === 0 || object + DEPTH + 4 > memory.length) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const depth = view.getInt32(object + DEPTH, true);
    const destination = object + STACK + Math.imul(depth, MATRIX_BYTES);
    if (destination < 0 || destination + MATRIX_BYTES > memory.length || object + MATRIX_BYTES > memory.length) return null;
    memory.copyWithin(destination, object, object + MATRIX_BYTES);
    view.setInt32(object + DEPTH, (depth + 1) | 0, true);
    return object | 0;
}

export function popBfmeMatrix(memory: Uint8Array, object: number): number | null {
    if (object === 0 || object + DEPTH + 4 > memory.length) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const depth = (view.getInt32(object + DEPTH, true) - 1) | 0;
    const offset = Math.imul(depth, MATRIX_BYTES);
    const source = object + STACK + offset;
    if (source < 0 || source + MATRIX_BYTES > memory.length || object + MATRIX_BYTES > memory.length) return null;
    view.setInt32(object + DEPTH, depth, true);
    memory.copyWithin(object, source, source + MATRIX_BYTES);
    return offset | 0;
}

export function pushBfmeTransform(memory: Uint8Array, object: number): number | null {
    if (object === 0 || object + TRANSFORM_DEPTH + 4 > memory.length) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const depth = view.getInt32(object + TRANSFORM_DEPTH, true);
    const destination = object + TRANSFORM_STACK + Math.imul(depth, TRANSFORM_BYTES);
    const source = object + TRANSFORM_SOURCE;
    if (destination < 0 || destination + TRANSFORM_BYTES > memory.length
        || source + TRANSFORM_BYTES > memory.length) return null;
    memory.copyWithin(destination, source, source + TRANSFORM_BYTES);
    view.setInt32(object + TRANSFORM_DEPTH, (depth + 1) | 0, true);
    return destination | 0;
}

export function popBfmeTransform(memory: Uint8Array, object: number): number | null {
    if (object === 0 || object + TRANSFORM_DEPTH + 4 > memory.length) return null;
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const depth = (view.getInt32(object + TRANSFORM_DEPTH, true) - 1) | 0;
    const source = object + TRANSFORM_STACK + Math.imul(depth, TRANSFORM_BYTES);
    const destination = object + TRANSFORM_SOURCE;
    if (source < 0 || source + TRANSFORM_BYTES > memory.length
        || destination + TRANSFORM_BYTES > memory.length) return null;
    view.setInt32(object + TRANSFORM_DEPTH, depth, true);
    memory.copyWithin(destination, source, source + TRANSFORM_BYTES);
    return destination | 0;
}

export const bfmeMatrixPushHandler: ThunkImplementation = (ctx, memory) =>
    pushBfmeMatrix(memory, ctx.ecx >>> 0) ?? 0;

export const bfmeMatrixPopHandler: ThunkImplementation = (ctx, memory) =>
    popBfmeMatrix(memory, ctx.ecx >>> 0) ?? 0;

export const bfmeTransformPushHandler: ThunkImplementation = (ctx, memory) =>
    pushBfmeTransform(memory, ctx.ecx >>> 0) ?? 0;

export const bfmeTransformPopHandler: ThunkImplementation = (ctx, memory) =>
    popBfmeTransform(memory, ctx.ecx >>> 0) ?? 0;
