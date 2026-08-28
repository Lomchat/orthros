/**
 * ID3DXEffect compatibility object.
 *
 * Orthros does not compile the legacy FX language yet, but the COM ABI must be
 * exact: games call these methods by vtable slot, so an omitted entry shifts
 * every later call and corrupts the guest stack. The order below follows
 * D3DX9Effect.h for SDK 27.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { IUnknown } from '../../api/types';
import { InterfaceDescriptor, ModuleDescriptor } from '../../api/types';
import { createComObject } from '../d3d9/shared-state';
import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { D3D_OK } from '../d3d9/resource-registry';

const D3DERR_INVALIDCALL = 0x8876086c;

export const ID3DX_EFFECT_METHOD_SPECS: ReadonlyArray<readonly [string, number]> = [
    // ID3DXBaseEffect
    ['GetDesc', 2], ['GetParameterDesc', 3], ['GetTechniqueDesc', 3], ['GetPassDesc', 3],
    ['GetFunctionDesc', 3], ['GetParameter', 3], ['GetParameterByName', 3],
    ['GetParameterBySemantic', 3], ['GetParameterElement', 3], ['GetTechnique', 2],
    ['GetTechniqueByName', 2], ['GetPass', 3], ['GetPassByName', 3], ['GetFunction', 2],
    ['GetFunctionByName', 2], ['GetAnnotation', 3], ['GetAnnotationByName', 3],
    ['SetValue', 4], ['GetValue', 4], ['SetBool', 3], ['GetBool', 3], ['SetBoolArray', 4],
    ['GetBoolArray', 4], ['SetInt', 3], ['GetInt', 3], ['SetIntArray', 4], ['GetIntArray', 4],
    ['SetFloat', 3], ['GetFloat', 3], ['SetFloatArray', 4], ['GetFloatArray', 4],
    ['SetVector', 3], ['GetVector', 3], ['SetVectorArray', 4], ['GetVectorArray', 4],
    ['SetMatrix', 3], ['GetMatrix', 3], ['SetMatrixArray', 4], ['GetMatrixArray', 4],
    ['SetMatrixPointerArray', 4], ['GetMatrixPointerArray', 4], ['SetMatrixTranspose', 3],
    ['GetMatrixTranspose', 3], ['SetMatrixTransposeArray', 4], ['GetMatrixTransposeArray', 4],
    ['SetMatrixTransposePointerArray', 4], ['GetMatrixTransposePointerArray', 4],
    ['SetString', 3], ['GetString', 3], ['SetTexture', 3], ['GetTexture', 3],
    ['GetPixelShader', 3], ['GetVertexShader', 3], ['SetArrayRange', 4],
    // ID3DXEffect (SDK 27)
    ['GetPool', 2], ['SetTechnique', 2], ['GetCurrentTechnique', 1], ['ValidateTechnique', 2],
    ['FindNextValidTechnique', 3], ['IsParameterUsed', 3], ['Begin', 3], ['BeginPass', 2],
    ['CommitChanges', 1], ['EndPass', 1], ['End', 1], ['GetDevice', 2], ['OnLostDevice', 1],
    ['OnResetDevice', 1], ['SetStateManager', 2], ['GetStateManager', 2],
    ['BeginParameterBlock', 1], ['EndParameterBlock', 1], ['ApplyParameterBlock', 2],
    ['DeleteParameterBlock', 2], ['CloneEffect', 3], ['SetRawValue', 5],
];

function makeMethod(name: string, argCount: number) {
    return {
        name,
        params: Array.from({ length: argCount }, (_, i) => ({ name: `arg${i}`, type: 'u32' as const })),
        returnType: 'u32' as const,
        callingConvention: 'stdcall' as const,
    };
}

const ID3DXEffect: InterfaceDescriptor = {
    name: 'ID3DXEffect',
    inherits: 'IUnknown',
    iid: 'F6CEB4B3-4E4C-40DD-B883-8D8DE5EA0CD5',
    methods: [
        ...IUnknown.methods,
        ...ID3DX_EFFECT_METHOD_SPECS.map(([name, count]) => makeMethod(name, count)),
    ],
};

const effectModuleDescriptor: ModuleDescriptor = {
    name: 'd3dx9',
    functions: [],
    interfaces: [ID3DXEffect],
};

type EffectState = {
    device: number;
    technique: number;
    pass: number;
    namedHandles: Map<string, number>;
};

let effectVtable: VTableInfo | null = null;
const effectStates = new Map<number, EffectState>();

function ensureEffectVtable(process: Process): number {
    if (!effectVtable) {
        const tables = createVTablesFromDescriptor(process, effectModuleDescriptor);
        effectVtable = tables['ID3DXEffect'] ?? null;
    }
    return effectVtable?.address ?? 0;
}

function writeZeros(ptr: number, bytes: number): boolean {
    if (!ptr) return false;
    for (let offset = 0; offset < bytes; offset += 4) {
        if (!Mem.writeUint32(ptr + offset, 0)) return false;
    }
    return true;
}

export function createEffectExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const ok = () => D3D_OK;
    const stateFor = (args: number[]) => effectStates.get(args[0] >>> 0);

    exports['ID3DXEffect_QueryInterface'] = (_ctx, _mem, args) => {
        const self = args[0] >>> 0;
        const ppv = args[2] >>> 0;
        if (!self || !ppv) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(ppv, self) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_AddRef'] = () => 2;
    exports['ID3DXEffect_Release'] = () => 1;

    for (const [name] of ID3DX_EFFECT_METHOD_SPECS) exports[`ID3DXEffect_${name}`] = ok;

    exports['ID3DXEffect_GetDesc'] = (_ctx, _mem, args) => {
        const out = args[1] >>> 0;
        if (!stateFor(args) || !writeZeros(out, 16)) return D3DERR_INVALIDCALL;
        // Creator=NULL, Parameters=0, Techniques=1, Functions=0.
        return Mem.writeUint32(out + 8, 1) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_GetParameterDesc'] = (_ctx, _mem, args) =>
        stateFor(args) && writeZeros(args[2] >>> 0, 44) ? D3D_OK : D3DERR_INVALIDCALL;
    exports['ID3DXEffect_GetTechniqueDesc'] = (_ctx, _mem, args) => {
        const state = stateFor(args);
        const out = args[2] >>> 0;
        if (!state || (args[1] >>> 0) !== state.technique || !writeZeros(out, 12)) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(out + 4, 1) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_GetPassDesc'] = (_ctx, _mem, args) => {
        const state = stateFor(args);
        return state && (args[1] >>> 0) === state.pass && writeZeros(args[2] >>> 0, 16)
            ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_GetFunctionDesc'] = (_ctx, _mem, args) =>
        stateFor(args) && writeZeros(args[2] >>> 0, 8) ? D3D_OK : D3DERR_INVALIDCALL;

    exports['ID3DXEffect_GetTechnique'] = (_ctx, _mem, args) => {
        const state = stateFor(args);
        return state && (args[1] >>> 0) === 0 ? state.technique : 0;
    };
    exports['ID3DXEffect_GetTechniqueByName'] = (_ctx, _mem, args) => stateFor(args)?.technique ?? 0;
    exports['ID3DXEffect_GetPass'] = (_ctx, _mem, args) => {
        const state = stateFor(args);
        return state && (args[1] >>> 0) === state.technique && (args[2] >>> 0) === 0 ? state.pass : 0;
    };
    exports['ID3DXEffect_GetPassByName'] = (_ctx, _mem, args) => stateFor(args)?.pass ?? 0;

    const namedHandle = (mem: Uint8Array, args: number[], namePtrIndex: number): number => {
        const state = stateFor(args);
        const namePtr = args[namePtrIndex] >>> 0;
        if (!state || !namePtr) return 0;
        const name = Marshaler.readString(mem, namePtr);
        if (!name) return 0;
        const existing = state.namedHandles.get(name);
        if (existing) return existing;
        const handle = process.memory.alloc(4);
        Mem.writeUint32(handle, 0);
        state.namedHandles.set(name, handle);
        return handle;
    };
    exports['ID3DXEffect_GetParameterByName'] = (_ctx, mem, args) => namedHandle(mem, args, 2);
    exports['ID3DXEffect_GetParameterBySemantic'] = (_ctx, mem, args) => namedHandle(mem, args, 2);
    exports['ID3DXEffect_GetParameter'] = () => 0;
    exports['ID3DXEffect_GetParameterElement'] = (_ctx, _mem, args) => args[1] >>> 0;

    exports['ID3DXEffect_SetTechnique'] = (_ctx, _mem, args) => {
        const state = stateFor(args);
        if (!state || !(args[1] >>> 0)) return D3DERR_INVALIDCALL;
        state.technique = args[1] >>> 0;
        return D3D_OK;
    };
    exports['ID3DXEffect_GetCurrentTechnique'] = (_ctx, _mem, args) => stateFor(args)?.technique ?? 0;
    exports['ID3DXEffect_ValidateTechnique'] = (_ctx, _mem, args) =>
        stateFor(args) && (args[1] >>> 0) ? D3D_OK : D3DERR_INVALIDCALL;
    exports['ID3DXEffect_FindNextValidTechnique'] = (_ctx, _mem, args) => {
        const state = stateFor(args);
        const out = args[2] >>> 0;
        return state && out && Mem.writeUint32(out, state.technique) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_IsParameterUsed'] = (_ctx, _mem, args) => stateFor(args) ? 1 : 0;
    exports['ID3DXEffect_Begin'] = (_ctx, _mem, args) => {
        const passes = args[1] >>> 0;
        return stateFor(args) && passes && Mem.writeUint32(passes, 1) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_GetDevice'] = (_ctx, _mem, args) => {
        const state = stateFor(args);
        const out = args[1] >>> 0;
        return state && out && Mem.writeUint32(out, state.device) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_GetPool'] = (_ctx, _mem, args) => {
        const out = args[1] >>> 0;
        return stateFor(args) && out && Mem.writeUint32(out, 0) ? D3D_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXEffect_GetStateManager'] = (_ctx, _mem, args) => {
        const out = args[1] >>> 0;
        return stateFor(args) && out && Mem.writeUint32(out, 0) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    const createEffect = (device: number, ppEffect: number, ppErrors: number): number => {
        if (!ppEffect) return D3DERR_INVALIDCALL;
        const vtableAddr = ensureEffectVtable(process);
        if (!vtableAddr) return D3DERR_INVALIDCALL;
        const effectPtr = createComObject(vtableAddr);
        const technique = process.memory.alloc(4);
        const pass = process.memory.alloc(4);
        Mem.writeUint32(technique, 0);
        Mem.writeUint32(pass, 0);
        effectStates.set(effectPtr, { device, technique, pass, namedHandles: new Map() });
        if (ppErrors) Mem.writeUint32(ppErrors, 0);
        return Mem.writeUint32(ppEffect, effectPtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['D3DXCreateEffect'] = (_ctx, _mem, args) =>
        createEffect(args[0] >>> 0, args[7] >>> 0, args[8] >>> 0);
    exports['D3DXCreateEffectFromFileA'] = (_ctx, _mem, args) =>
        createEffect(args[0] >>> 0, args[6] >>> 0, args[7] >>> 0);

    return exports;
}

export function resetEffectState(): void {
    effectVtable = null;
    effectStates.clear();
}
