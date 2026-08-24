import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

function u32(memory: Uint8Array): DataView {
    return new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
}

export function releaseSharedStringbase(memory: Uint8Array, object: number): number | null {
    object >>>= 0;
    if (object === 0 || object + 4 > memory.length) return null;
    const view = u32(memory);
    const storage = view.getUint32(object, true) >>> 0;
    if (storage === 0) { view.setUint32(object, 0, true); return 0; }
    if (storage + 4 > memory.length) return null;
    const refs = view.getUint32(storage, true) >>> 0;
    if (refs <= 1) return null; // the original must call the guest allocator/free path
    view.setUint32(storage, (refs - 1) >>> 0, true);
    view.setUint32(object, 0, true);
    return 0;
}

export function copyStringbaseRef(memory: Uint8Array, destination: number, source: number): number | null {
    destination >>>= 0; source >>>= 0;
    if (!destination || !source || destination + 4 > memory.length || source + 4 > memory.length) return null;
    const view = u32(memory);
    const storage = view.getUint32(source, true) >>> 0;
    if (storage && storage + 4 > memory.length) return null;
    view.setUint32(destination, storage, true);
    if (storage) view.setUint32(storage, (view.getUint32(storage, true) + 1) >>> 0, true);
    return destination;
}

export function assignSharedStringbase(memory: Uint8Array, destination: number, source: number): number | null {
    destination >>>= 0; source >>>= 0;
    if (!destination || !source || destination + 4 > memory.length || source + 4 > memory.length) return null;
    if (destination === source) return destination;
    const view = u32(memory);
    const oldStorage = view.getUint32(destination, true) >>> 0;
    const newStorage = view.getUint32(source, true) >>> 0;
    if ((oldStorage && oldStorage + 4 > memory.length) || (newStorage && newStorage + 4 > memory.length)) return null;
    if (oldStorage === newStorage) return destination;
    if (oldStorage) {
        const refs = view.getUint32(oldStorage, true) >>> 0;
        if (refs <= 1) return null;
        view.setUint32(oldStorage, (refs - 1) >>> 0, true);
    }
    view.setUint32(destination, newStorage, true);
    if (newStorage) view.setUint32(newStorage, (view.getUint32(newStorage, true) + 1) >>> 0, true);
    return destination;
}

export const bfmeStringReleaseHandler: ThunkImplementation = (ctx, memory) =>
    releaseSharedStringbase(memory, ctx.ecx) ?? 0;
export const bfmeStringCopyHandler: ThunkImplementation = (ctx, memory, args) =>
    copyStringbaseRef(memory, ctx.ecx, args[0] >>> 0) ?? 0;
export const bfmeStringAssignHandler: ThunkImplementation = (ctx, memory, args) =>
    assignSharedStringbase(memory, ctx.ecx, args[0] >>> 0) ?? 0;
