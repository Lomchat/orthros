/**
 * D3DX9.dll API descriptor.
 * Versioned redist names (d3dx9_24 … d3dx9_43) alias to this module via dll-aliases.ts.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const d3dx9Module: ModuleDescriptor = {
    name: "d3dx9",
    functions: [
        makeFunc("DebugSetMute", 1),
        makeFunc("D3DXDebugMute", 1),
        makeFunc("D3DXCheckVersion", 4),
        // System Shock 2 startup probes these via GetProcAddress after LoadLibrary.
        makeFunc("D3DXLoadSurfaceFromSurface", 8),
        makeFunc("D3DXLoadSurfaceFromFileInMemory", 9),
        makeFunc("D3DXLoadSurfaceFromMemory", 10),
        makeFunc("D3DXCreateEffect", 9),
        makeFunc("D3DXCreateEffectFromFileA", 8),
        makeFunc("D3DXAssembleShader", 7),
        makeFunc("D3DXGetShaderInputSemantics", 3),
        makeFunc("D3DXGetFVFVertexSize", 1),
        makeFunc("D3DXFilterTexture", 4),
        makeFunc("D3DXPlaneIntersectLine", 4),
        makeFunc("D3DXPlaneFromPointNormal", 3),
        makeFunc("D3DXTessellateNPatches", 7),
        makeFunc("D3DXSavePRTCompBufferToFileW", 3),
        makeFunc("D3DXMatrixIdentity", 1),
        makeFunc("D3DXMatrixMultiply", 3),
        makeFunc("D3DXMatrixTranslation", 4),
        makeFunc("D3DXMatrixScaling", 4),
        makeFunc("D3DXMatrixInverse", 3),
        makeFunc("D3DXMatrixTranspose", 2),
        makeFunc("D3DXMatrixRotationX", 2),
        makeFunc("D3DXMatrixRotationY", 2),
        makeFunc("D3DXMatrixRotationZ", 2),
        makeFunc("D3DXMatrixRotationAxis", 3),
        makeFunc("D3DXMatrixPerspectiveFovLH", 5),
        makeFunc("D3DXMatrixLookAtLH", 4),
        makeFunc("D3DXVec3Normalize", 2),
        makeFunc("D3DXVec3TransformCoord", 3),
        makeFunc("D3DXVec3TransformCoordArray", 6),
        makeFunc("D3DXVec3Transform", 3),
        makeFunc("D3DXVec4Transform", 3),
        makeFunc("D3DXVec3CatmullRom", 6),
        makeFunc("D3DXQuaternionSlerp", 4),
        makeFunc("D3DXCreateTexture", 8),
        makeFunc("D3DXCreateTextureFromFileA", 4),
        makeFunc("D3DXCreateTextureFromFileW", 4),
        makeFunc("D3DXCreateTextureFromFileInMemory", 5),
        makeFunc("D3DXCreateTextureFromFileExA", 14),
        makeFunc("D3DXCreateTextureFromFileExW", 14),
        makeFunc("D3DXCreateTextureFromFileInMemoryEx", 15),
        makeFunc("D3DXGetImageInfoFromFileA", 3),
        makeFunc("D3DXGetImageInfoFromFileW", 3),
        makeFunc("D3DXGetImageInfoFromFileInMemory", 3),
        makeFunc("D3DXCreateCubeTextureFromFileInMemoryEx", 14),
        makeFunc("D3DXCreateVolumeTexture", 9),
        makeFunc("D3DXCreateVolumeTextureFromFileInMemoryEx", 16),
        makeFunc("D3DXLoadVolumeFromFileInMemory", 9),
        makeFunc("D3DXCheckTextureRequirements", 7),
        makeFunc("D3DXCreateFontA", 7),
        makeFunc("D3DXCreateFontW", 7),
        makeFunc("D3DXCreateFontIndirectA", 4),
        makeFunc("D3DXCreateFontIndirectW", 4),
        makeFunc("D3DXCreateSprite", 2),
    ],
};
