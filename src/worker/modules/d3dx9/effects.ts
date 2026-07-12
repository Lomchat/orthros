/**
 * Minimal ID3DXEffect COM object for games that compile/load .fx at runtime.
 * Shader compilation is not implemented; state-setting calls are accepted as no-ops.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { IUnknown } from '../../api/types';
import { InterfaceDescriptor, ModuleDescriptor } from '../../api/types';
import { createComObject } from '../d3d9/shared-state';
import { Mem } from '../../core/memory/mem-accessor';
import { D3D_OK } from '../d3d9/resource-registry';

const D3DERR_INVALIDCALL = 0x8876086c;

const effectMethodSpecs = [
    'GetDevice', 'GetDesc', 'GetTechnique', 'GetTechniqueDesc', 'GetPass', 'GetPassDesc',
    'GetFunction', 'GetFunctionDesc', 'GetParameter', 'GetParameterDesc', 'GetParameterByName',
    'GetParameterBySemantic', 'GetAnnotation', 'GetAnnotationByName', 'SetValue', 'SetBool',
    'SetBoolArray', 'SetFloat', 'SetFloatArray', 'SetInt', 'SetIntArray', 'SetMatrix',
    'SetMatrixArray', 'SetMatrixPointerArray', 'SetMatrixTranspose', 'SetMatrixTransposeArray',
    'SetMatrixTransposePointerArray', 'SetString', 'SetTexture', 'SetVector', 'SetVectorArray',
    'SetTechnique', 'GetCurrentTechnique', 'ValidateTechnique', 'FindNextValidTechnique',
    'IsParameterUsed', 'GetParameterName', 'CloneEffect', 'CommitChanges',
    'Begin', 'BeginPass', 'EndPass', 'End', 'OnLostDevice', 'OnResetDevice',
    'SetStateManager', 'GetStateManager',
] as const;

function makeMethod(name: string, argCount: number) {
    return {
        name,
        params: Array.from({ length: argCount }, (_, i) => ({ name: `arg${i}`, type: 'u32' as const })),
        returnType: 'u32' as const,
        callingConvention: 'stdcall' as const,
    };
}

const effectMethods = effectMethodSpecs.map((name) => {
    // Arg counts include implicit `this` pointer (stdcall COM convention in this HLE).
    const counts: Record<string, number> = {
        GetDevice: 2, GetDesc: 2, GetTechnique: 3, GetTechniqueDesc: 3, GetPass: 4, GetPassDesc: 4,
        GetFunction: 3, GetFunctionDesc: 3, GetParameter: 3, GetParameterDesc: 3, GetParameterByName: 3,
        GetParameterBySemantic: 3, GetAnnotation: 4, GetAnnotationByName: 4, SetValue: 4, SetBool: 3,
        SetBoolArray: 4, SetFloat: 3, SetFloatArray: 4, SetInt: 3, SetIntArray: 4, SetMatrix: 3,
        SetMatrixArray: 4, SetMatrixPointerArray: 4, SetMatrixTranspose: 3, SetMatrixTransposeArray: 4,
        SetMatrixTransposePointerArray: 4, SetString: 3, SetTexture: 3, SetVector: 3, SetVectorArray: 4,
        SetTechnique: 2, GetCurrentTechnique: 2, ValidateTechnique: 2, FindNextValidTechnique: 3,
        IsParameterUsed: 3, GetParameterName: 3, CloneEffect: 3, CommitChanges: 1,
        Begin: 3, BeginPass: 2, EndPass: 1, End: 1, OnLostDevice: 1, OnResetDevice: 1,
        SetStateManager: 2, GetStateManager: 2,
    };
    return makeMethod(name, counts[name] ?? 2);
});

const ID3DXEffect: InterfaceDescriptor = {
    name: 'ID3DXEffect',
    inherits: 'IUnknown',
    iid: '0FEFB326-3976-4A02-9F4A-2AE3090E9F3A',
    methods: [
        ...IUnknown.methods,
        ...effectMethods,
    ],
};

const effectModuleDescriptor: ModuleDescriptor = {
    name: 'd3dx9',
    functions: [],
    interfaces: [ID3DXEffect],
};

let effectVtable: VTableInfo | null = null;

function ensureEffectVtable(process: Process): number {
    if (!effectVtable) {
        const tables = createVTablesFromDescriptor(process, effectModuleDescriptor);
        effectVtable = tables['ID3DXEffect'] ?? null;
    }
    return effectVtable?.address ?? 0;
}

export function createEffectExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const ok = () => D3D_OK;

    exports['ID3DXEffect_QueryInterface'] = ok;
    exports['ID3DXEffect_AddRef'] = () => 2;
    exports['ID3DXEffect_Release'] = () => 1;

    for (const spec of effectMethodSpecs) {
        exports[`ID3DXEffect_${spec}`] = ok;
    }

    exports['D3DXCreateEffect'] = (_ctx, _mem, args) => {
        const ppEffect = args[7] >>> 0;
        if (!ppEffect) return D3DERR_INVALIDCALL;

        const vtableAddr = ensureEffectVtable(process);
        if (!vtableAddr) return D3DERR_INVALIDCALL;

        const effectPtr = createComObject(vtableAddr);
        return Mem.writeUint32(ppEffect, effectPtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    return exports;
}

export function resetEffectState(): void {
    effectVtable = null;
}
