/**
 * D3D8 state block recording, capture, and replay.
 *
 * D3D8 state blocks are DWORD tokens (not COM objects like D3D9):
 *   BeginStateBlock  — start journaling Set* calls (they are NOT applied while recording)
 *   EndStateBlock    — stop journaling, return a token
 *   ApplyStateBlock  — replay the journaled state onto the device
 *   CaptureStateBlock— refresh the journaled entries from the CURRENT device state
 *   CreateStateBlock — snapshot a predefined state group (ALL/PIXELSTATE/VERTEXSTATE)
 *   DeleteStateBlock — free the token
 *
 * Shares the keyed-dedup recorder with the D3D9 backend (state-block-recorder.ts);
 * the entry set differs because D3D8 binds resources by DWORD handle/COM pointer and
 * parses material/light structs at the thunk boundary.
 */

import type { D3D8DeviceAdapter } from "./d3d8-device-adapter";
import type { Viewport } from "../ddraw/types";
import type { D3DMaterial7Data, D3DLight7Data } from "../../../modules/ddraw/d3d/types";

export const D3DSBT_ALL = 1;
export const D3DSBT_PIXELSTATE = 2;
export const D3DSBT_VERTEXSTATE = 3;

export type D3D8StateBlockEntry =
    | { op: "renderState"; state: number; value: number }
    | { op: "textureStageState"; stage: number; type: number; value: number }
    | { op: "texture"; stage: number; texPtr: number }
    | { op: "transform"; state: number; matrix: Float32Array }
    | { op: "viewport"; vp: Viewport }
    | { op: "material"; mat: D3DMaterial7Data }
    | { op: "light"; index: number; light: D3DLight7Data }
    | { op: "lightEnable"; index: number; enable: boolean }
    | { op: "clipPlane"; index: number; plane: Float32Array }
    | { op: "vertexShader"; token: number }   // SetVertexShader DWORD: FVF (bit0=0) or handle (bit0=1)
    | { op: "pixelShader"; handle: number }
    | { op: "vsConstant"; start: number; data: Float32Array }
    | { op: "psConstant"; start: number; data: Float32Array }
    | { op: "streamSource"; stream: number; vb: number; stride: number }
    | { op: "indices"; ib: number; baseVertex: number };

export function d3d8EntryKey(entry: D3D8StateBlockEntry): string {
    switch (entry.op) {
        case "renderState": return `rs:${entry.state}`;
        case "textureStageState": return `tss:${entry.stage}:${entry.type}`;
        case "texture": return `tex:${entry.stage}`;
        case "transform": return `xf:${entry.state}`;
        case "viewport": return "vp";
        case "material": return "mat";
        case "light": return `light:${entry.index}`;
        case "lightEnable": return `le:${entry.index}`;
        case "clipPlane": return `clip:${entry.index}`;
        case "vertexShader": return "vs";
        case "pixelShader": return "ps";
        case "vsConstant": return `vsc:${entry.start}:${entry.data.length}`;
        case "psConstant": return `psc:${entry.start}:${entry.data.length}`;
        case "streamSource": return `stream:${entry.stream}`;
        case "indices": return "ib";
    }
}

export function applyD3D8StateBlockEntries(device: D3D8DeviceAdapter, entries: D3D8StateBlockEntry[]): void {
    for (const entry of entries) {
        switch (entry.op) {
            case "renderState":
                device.setRenderState(entry.state, entry.value);
                break;
            case "textureStageState":
                device.setTextureStageState(entry.stage, entry.type, entry.value);
                break;
            case "texture": {
                // Resolve by COM handle; a texture released since recording drops to NULL.
                const surface = entry.texPtr !== 0 ? (device.texSurfaces.get(entry.texPtr) ?? null) : null;
                device.setTexture(entry.stage, surface, surface ? entry.texPtr : 0);
                break;
            }
            case "transform":
                device.setTransform(entry.state, entry.matrix);
                break;
            case "viewport":
                device.viewport = { ...entry.vp };
                break;
            case "material":
                device.setMaterial(entry.mat);
                break;
            case "light":
                device.setLight(entry.index, entry.light);
                break;
            case "lightEnable":
                device.lightEnable(entry.index, entry.enable);
                break;
            case "clipPlane":
                device.setClipPlane(entry.index, entry.plane);
                break;
            case "vertexShader":
                if ((entry.token & 1) === 0) device.setFVF(entry.token);
                else device.setVertexShaderHandle(entry.token);
                break;
            case "pixelShader":
                device.setPixelShader(entry.handle);
                break;
            case "vsConstant":
                device.shaders.setVertexShaderConstantFromArray(entry.start, entry.data);
                break;
            case "psConstant":
                device.shaders.setPixelShaderConstantFromArray(entry.start, entry.data);
                break;
            case "streamSource":
                device.setStreamSource(entry.stream, entry.vb, entry.stride);
                break;
            case "indices":
                device.indexIB = entry.ib;
                device.baseVertexIndex = entry.baseVertex;
                break;
        }
    }
}

/** CaptureStateBlock: refresh each recorded entry's VALUE from current device state. */
export function refreshD3D8CapturedEntries(device: D3D8DeviceAdapter, entries: D3D8StateBlockEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        switch (entry.op) {
            case "renderState":
                entries[i] = { op: "renderState", state: entry.state, value: device.getRenderState(entry.state) };
                break;
            case "textureStageState":
                entries[i] = {
                    op: "textureStageState", stage: entry.stage, type: entry.type,
                    value: device.getTextureStageState(entry.stage, entry.type),
                };
                break;
            case "texture":
                entries[i] = { op: "texture", stage: entry.stage, texPtr: device.getTextureComPtr(entry.stage) };
                break;
            case "transform": {
                const m = device.getTransform(entry.state);
                if (m) entries[i] = { op: "transform", state: entry.state, matrix: new Float32Array(m) };
                break;
            }
            case "viewport":
                entries[i] = { op: "viewport", vp: { ...device.viewport } };
                break;
            case "material":
                entries[i] = { op: "material", mat: device.getMaterial() };
                break;
            case "light": {
                const light = device.getLight(entry.index);
                if (light) entries[i] = { op: "light", index: entry.index, light };
                break;
            }
            case "lightEnable":
                entries[i] = { op: "lightEnable", index: entry.index, enable: device.isLightEnabled(entry.index) };
                break;
            case "clipPlane": {
                const plane = device.getClipPlane(entry.index);
                if (plane) entries[i] = { op: "clipPlane", index: entry.index, plane: new Float32Array(plane) };
                break;
            }
            case "vertexShader":
                entries[i] = { op: "vertexShader", token: device.getActiveVertexToken() };
                break;
            case "pixelShader":
                entries[i] = { op: "pixelShader", handle: device.getPixelShaderHandle() };
                break;
            case "vsConstant": {
                const data = new Float32Array(entry.data.length);
                data.set(device.shaders.vsConstants.subarray(entry.start * 4, entry.start * 4 + data.length));
                entries[i] = { op: "vsConstant", start: entry.start, data };
                break;
            }
            case "psConstant": {
                const data = new Float32Array(entry.data.length);
                data.set(device.shaders.psConstants.subarray(entry.start * 4, entry.start * 4 + data.length));
                entries[i] = { op: "psConstant", start: entry.start, data };
                break;
            }
            case "streamSource": {
                const src = device.getStreamSource(entry.stream);
                entries[i] = { op: "streamSource", stream: entry.stream, vb: src.vb, stride: src.stride };
                break;
            }
            case "indices":
                entries[i] = { op: "indices", ib: device.indexIB, baseVertex: device.baseVertexIndex };
                break;
        }
    }
}

/**
 * CreateStateBlock: snapshot a predefined group. The pixel/vertex split follows the
 * same pragmatic grouping as the D3D9 backend (render states + texture stages +
 * textures + PS on the pixel side; transforms + lighting + VS + streams on the
 * vertex side); D3DSBT_ALL is the union plus viewport and indices.
 */
export function captureD3D8StateToEntries(device: D3D8DeviceAdapter, blockType: number): D3D8StateBlockEntry[] {
    const entries: D3D8StateBlockEntry[] = [];
    const includePixel = blockType === D3DSBT_ALL || blockType === D3DSBT_PIXELSTATE;
    const includeVertex = blockType === D3DSBT_ALL || blockType === D3DSBT_VERTEXSTATE;

    if (includePixel) {
        for (let state = 0; state < 256; state++) {
            entries.push({ op: "renderState", state, value: device.getRenderState(state) });
        }
        for (let stage = 0; stage < 8; stage++) {
            for (let type = 0; type < 32; type++) {
                entries.push({
                    op: "textureStageState", stage, type,
                    value: device.getTextureStageState(stage, type),
                });
            }
            const texPtr = device.getTextureComPtr(stage);
            if (texPtr !== 0) entries.push({ op: "texture", stage, texPtr });
        }
        const ps = device.getPixelShaderHandle();
        entries.push({ op: "pixelShader", handle: ps });
        entries.push({ op: "psConstant", start: 0, data: new Float32Array(device.shaders.psConstants) });
    }

    if (includeVertex) {
        for (const { state, matrix } of device.getAllTransforms()) {
            entries.push({ op: "transform", state, matrix: new Float32Array(matrix) });
        }
        entries.push({ op: "material", mat: device.getMaterial() });
        for (const { index, light } of device.getAllLights()) {
            entries.push({ op: "light", index, light });
        }
        for (const index of device.getEnabledLightIndices()) {
            entries.push({ op: "lightEnable", index, enable: true });
        }
        for (const { index, plane } of device.getAllClipPlanes()) {
            entries.push({ op: "clipPlane", index, plane: new Float32Array(plane) });
        }
        entries.push({ op: "vertexShader", token: device.getActiveVertexToken() });
        entries.push({ op: "vsConstant", start: 0, data: new Float32Array(device.shaders.vsConstants) });
        for (let s = 0; s < 16; s++) {
            const src = device.getStreamSource(s);
            if (src.vb !== 0) entries.push({ op: "streamSource", stream: s, vb: src.vb, stride: src.stride });
        }
    }

    if (blockType === D3DSBT_ALL) {
        entries.push({ op: "viewport", vp: { ...device.viewport } });
        if (device.indexIB !== 0) {
            entries.push({ op: "indices", ib: device.indexIB, baseVertex: device.baseVertexIndex });
        }
    }

    return entries;
}
