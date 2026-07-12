/**
 * COM object registries for D3D9 shader/declaration interfaces.
 * Maps guest COM pointers to internal device handles.
 */

import { RawVertexElement } from "./shader";

export type VertexDeclComMeta = {
    devicePtr: number;
    internalHandle: number;
    elements: RawVertexElement[];
};

export type ShaderComMeta = {
    devicePtr: number;
    internalHandle: number;
    /** Raw shader tokens (DWORD stream) for IDirect3D*Shader9::GetFunction */
    bytecode: Uint32Array;
};

export const vertexDeclComObjects = new Map<number, VertexDeclComMeta>();
export const vertexShaderComObjects = new Map<number, ShaderComMeta>();
export const pixelShaderComObjects = new Map<number, ShaderComMeta>();

export function clearD3D9ComObjectRegistries(): void {
    vertexDeclComObjects.clear();
    vertexShaderComObjects.clear();
    pixelShaderComObjects.clear();
}

export function resolveVertexDeclComPtr(comPtr: number): VertexDeclComMeta | null {
    return vertexDeclComObjects.get(comPtr) ?? null;
}

export function resolveVertexShaderComPtr(comPtr: number): ShaderComMeta | null {
    return vertexShaderComObjects.get(comPtr) ?? null;
}

export function resolvePixelShaderComPtr(comPtr: number): ShaderComMeta | null {
    return pixelShaderComObjects.get(comPtr) ?? null;
}
