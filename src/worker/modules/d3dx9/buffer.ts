/**
 * ID3DXBuffer — the COM byte container D3DX hands back for assembled shaders,
 * error messages and the like. One vtable per process; each object owns a
 * guest allocation holding its bytes, freed with the last Release.
 */
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Mem } from '../../core/memory/mem-accessor';
import { allocateComObject, freeComObject } from '../../core/com/com-memory';
import { installComVtable } from '../../core/com/install-com-vtable';

const S_OK = 0;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;

interface BufferState { refCount: number; dataPtr: number; size: number; }

const buffers = new Map<number, BufferState>();
let vtableAddr = 0;
let owner: Process | null = null;

function guidOf(mem: Uint8Array, riid: number): string {
    const b = mem.subarray(riid, riid + 16);
    const hex = (i: number) => b[i]!.toString(16).padStart(2, '0');
    return `${hex(3)}${hex(2)}${hex(1)}${hex(0)}-${hex(5)}${hex(4)}-${hex(7)}${hex(6)}-${hex(8)}${hex(9)}-${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`;
}

/** Installs the vtable once for this process (re-entrant across restarts). */
export function ensureD3dxBufferVtable(process: Process): number {
    if (vtableAddr && owner === process) return vtableAddr;
    buffers.clear();
    const handlers: Record<string, ThunkImplementation> = {};
    handlers['XB_QueryInterface'] = (_ctx, mem, args) => {
        const self = args[0] >>> 0, riid = args[1] >>> 0, ppv = args[2] >>> 0;
        const state = buffers.get(self);
        if (!state || !riid || riid + 16 > mem.length || !ppv || ppv + 4 > mem.length) return E_POINTER;
        const iid = guidOf(mem, riid);
        // IUnknown or ID3DXBuffer.
        const ok = iid === '00000000-0000-0000-c000-000000000046' || iid === '8ba5fb08-5195-40e2-ac58-0d989c3a0102';
        Mem.writeUint32(ppv, ok ? self : 0);
        if (!ok) return E_NOINTERFACE;
        state.refCount++;
        return S_OK;
    };
    handlers['XB_AddRef'] = (_ctx, _mem, args) => {
        const state = buffers.get(args[0] >>> 0);
        return state ? ++state.refCount : 0;
    };
    handlers['XB_Release'] = (_ctx, _mem, args) => {
        const self = args[0] >>> 0;
        const state = buffers.get(self);
        if (!state) return 0;
        if (--state.refCount > 0) return state.refCount;
        buffers.delete(self);
        if (state.dataPtr) process.memory.free(state.dataPtr);
        freeComObject(process.memory, self);
        return 0;
    };
    handlers['XB_GetBufferPointer'] = (_ctx, _mem, args) => buffers.get(args[0] >>> 0)?.dataPtr ?? 0;
    handlers['XB_GetBufferSize'] = (_ctx, _mem, args) => buffers.get(args[0] >>> 0)?.size ?? 0;
    const installed = installComVtable(process, {
        moduleName: 'd3dx9_buffer',
        methods: [
            { name: 'XB_QueryInterface', argCount: 3, stackCleanupBytes: 12 },
            { name: 'XB_AddRef', argCount: 1, stackCleanupBytes: 4 },
            { name: 'XB_Release', argCount: 1, stackCleanupBytes: 4 },
            { name: 'XB_GetBufferPointer', argCount: 1, stackCleanupBytes: 4 },
            { name: 'XB_GetBufferSize', argCount: 1, stackCleanupBytes: 4 },
        ],
        handlers,
        logLabel: 'ID3DXBuffer',
    });
    vtableAddr = installed?.vtableAddr ?? 0;
    owner = process;
    return vtableAddr;
}

/** Creates an ID3DXBuffer holding a copy of `bytes`; returns the object pointer, 0 on failure. */
export function createD3dxBuffer(process: Process, bytes: Uint8Array): number {
    const vt = ensureD3dxBufferVtable(process);
    if (!vt) return 0;
    const size = bytes.byteLength;
    const dataPtr = size ? (process.memory.alloc(Math.max(4, (size + 3) & ~3), 'HEAP') >>> 0) : 0;
    if (size && !dataPtr) return 0;
    const view = Mem.getView();
    if (!view) { if (dataPtr) process.memory.free(dataPtr); return 0; }
    if (size) view.set(bytes, dataPtr);
    const objAddr = allocateComObject(process.memory, view, vt, 'THUNK_DATA');
    if (!objAddr) { if (dataPtr) process.memory.free(dataPtr); return 0; }
    buffers.set(objAddr, { refCount: 1, dataPtr, size });
    return objAddr;
}

/** Bytes of a live ID3DXBuffer (diagnostics/tests). */
export function readD3dxBuffer(objAddr: number): Uint8Array | null {
    const state = buffers.get(objAddr >>> 0);
    const view = Mem.getView();
    if (!state || !view) return null;
    return view.slice(state.dataPtr, state.dataPtr + state.size);
}

export function resetD3dxBuffers(): void {
    buffers.clear();
    vtableAddr = 0;
    owner = null;
}
