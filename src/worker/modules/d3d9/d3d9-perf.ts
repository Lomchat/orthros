/**
 * D3D9 API call-mix + skip counters for dbg.d3d9Perf().
 * Zero-alloc hot path: plain number fields, no Maps on the setter path.
 */

export interface D3D9PerfSnapshot {
    api: Record<string, number>;
    skip: Record<string, number>;
    backend: Record<string, number>;
    stateTracker: Record<string, number>;
    wbuf: { hits: number; outTrapHits: number; coalescedSkips: number; registered: number } | null;
    /** Guest-side setter-shadow skip counters per shadowed setter (filled by dbg.d3d9Perf). */
    setterShadow?: Record<string, number> | null;
    /** State-block type/coverage distribution. liveBlocks filled by dbg.d3d9Perf. */
    stateBlocks: D3D9StateBlockPerf;
    devices: number;
}

export interface D3D9StateBlockPerf {
    creates: number;
    applies: number;
    captures: number;
    /** Applies/Captures served by the arena block slot (WASM diff/memcpy path). */
    wasmApplies: number;
    wasmCaptures: number;
    coverableBlocks: number;
    fallbackBlocks: number;
    coverableApplies: number;
    fallbackApplies: number;
    coverableCaptures: number;
    fallbackCaptures: number;
    maxEntries: number;
    maxVsConstRanges: number;
    maxPsConstRanges: number;
    /** blockType → count (0 = Begin/End, 1 = D3DSBT_ALL, 2 = PIXELSTATE, 3 = VERTEXSTATE). */
    byBlockType: Record<string, number>;
    /** Entry-op histogram summed over created blocks. */
    entryOps: Record<string, number>;
    liveBlocks: number;
}

const API_KEYS = [
    "setRenderState",
    "setTransform",
    "setFVF",
    "setSamplerState",
    "setTexture",
    "setTextureStageState",
    "setStreamSource",
    "setIndices",
    "setVertexShader",
    "setPixelShader",
    "setVertexDeclaration",
    "setVertexShaderConstantF",
    "setPixelShaderConstantF",
    "setMaterial",
    "setLight",
    "lightEnable",
    "drawPrimitive",
    "drawIndexedPrimitive",
    "drawPrimitiveUP",
    "drawIndexedPrimitiveUP",
    "clear",
    "present",
] as const;

const SKIP_KEYS = [
    "setRenderState",
    "setTransform",
    "setFVF",
    "setSamplerState",
    "setTexture",
    "setTextureStageState",
    "setStreamSource",
    "setIndices",
    "setVertexShader",
    "setPixelShader",
    "setVertexDeclaration",
    "vsConstantUnchanged",
    "psConstantUnchanged",
] as const;

const BACKEND_KEYS = [
    "pipelineCacheHits",
    "pipelineCacheMisses",
    "pipelineSets",
    "bindGroupSets",
    "bindGroupSetSkips",
    "bindGroupCacheHits",
    "progConstWrites",
    "progConstReuseHits",
    "bindStateElided",
    "drawCalls",
    "clearCalls",
    "progPipelineCacheHits",
    "progPipelineCacheMisses",
] as const;
type ApiKey = typeof API_KEYS[number];
type SkipKey = typeof SKIP_KEYS[number];
type BackendKey = typeof BACKEND_KEYS[number];

const api: Record<ApiKey, number> = {
    setRenderState: 0,
    setTransform: 0,
    setFVF: 0,
    setSamplerState: 0,
    setTexture: 0,
    setTextureStageState: 0,
    setStreamSource: 0,
    setIndices: 0,
    setVertexShader: 0,
    setPixelShader: 0,
    setVertexDeclaration: 0,
    setVertexShaderConstantF: 0,
    setPixelShaderConstantF: 0,
    setMaterial: 0,
    setLight: 0,
    lightEnable: 0,
    drawPrimitive: 0,
    drawIndexedPrimitive: 0,
    drawPrimitiveUP: 0,
    drawIndexedPrimitiveUP: 0,
    clear: 0,
    present: 0,
};

const skip: Record<SkipKey, number> = {
    setRenderState: 0,
    setTransform: 0,
    setFVF: 0,
    setSamplerState: 0,
    setTexture: 0,
    setTextureStageState: 0,
    setStreamSource: 0,
    setIndices: 0,
    setVertexShader: 0,
    setPixelShader: 0,
    setVertexDeclaration: 0,
    vsConstantUnchanged: 0,
    psConstantUnchanged: 0,
};

const backend: Record<BackendKey, number> = {
    pipelineCacheHits: 0,
    pipelineCacheMisses: 0,
    pipelineSets: 0,
    bindGroupSets: 0,
    bindGroupSetSkips: 0,
    bindGroupCacheHits: 0,
    progConstWrites: 0,
    progConstReuseHits: 0,
    bindStateElided: 0,
    drawCalls: 0,
    clearCalls: 0,
    progPipelineCacheHits: 0,
    progPipelineCacheMisses: 0,
};

const stateBlock = {
    creates: 0,
    applies: 0,
    captures: 0,
    wasmApplies: 0,
    wasmCaptures: 0,
    coverableBlocks: 0,
    fallbackBlocks: 0,
    coverableApplies: 0,
    fallbackApplies: 0,
    coverableCaptures: 0,
    fallbackCaptures: 0,
    maxEntries: 0,
    maxVsConstRanges: 0,
    maxPsConstRanges: 0,
};
let stateBlockByType: Record<string, number> = {};
let stateBlockOps: Record<string, number> = {};

export function d3d9PerfStateBlockCreated(
    blockType: number,
    entryCount: number,
    coverable: boolean,
    opCounts: Record<string, number>,
    vsConstRanges: number,
    psConstRanges: number,
): void {
    stateBlock.creates++;
    if (coverable) stateBlock.coverableBlocks++;
    else stateBlock.fallbackBlocks++;
    if (entryCount > stateBlock.maxEntries) stateBlock.maxEntries = entryCount;
    if (vsConstRanges > stateBlock.maxVsConstRanges) stateBlock.maxVsConstRanges = vsConstRanges;
    if (psConstRanges > stateBlock.maxPsConstRanges) stateBlock.maxPsConstRanges = psConstRanges;
    stateBlockByType[blockType] = (stateBlockByType[blockType] ?? 0) + 1;
    for (const op in opCounts) {
        stateBlockOps[op] = (stateBlockOps[op] ?? 0) + opCounts[op]!;
    }
}

export function d3d9PerfStateBlockApply(coverable: boolean): void {
    stateBlock.applies++;
    if (coverable) stateBlock.coverableApplies++;
    else stateBlock.fallbackApplies++;
}

export function d3d9PerfStateBlockCapture(coverable: boolean): void {
    stateBlock.captures++;
    if (coverable) stateBlock.coverableCaptures++;
    else stateBlock.fallbackCaptures++;
}

export function d3d9PerfStateBlockWasmApply(): void {
    stateBlock.wasmApplies++;
}

export function d3d9PerfStateBlockWasmCapture(): void {
    stateBlock.wasmCaptures++;
}

export function d3d9PerfInc(key: ApiKey): void {
    api[key]++;
}

export function d3d9PerfSkip(key: SkipKey): void {
    skip[key]++;
}

export function d3d9PerfBackendInc(key: BackendKey): void {
    backend[key]++;
}

export function resetD3D9Perf(): void {
    for (const k of API_KEYS) api[k] = 0;
    for (const k of SKIP_KEYS) skip[k] = 0;
    for (const k of BACKEND_KEYS) backend[k] = 0;
    for (const k in stateBlock) (stateBlock as Record<string, number>)[k] = 0;
    stateBlockByType = {};
    stateBlockOps = {};
}

function pickRecord<T extends string>(src: Record<T, number>, keys: readonly T[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = src[k];
    return out;
}

export function getD3D9PerfSnapshot(): D3D9PerfSnapshot {
    return {
        api: pickRecord(api, API_KEYS),
        skip: pickRecord(skip, SKIP_KEYS),
        backend: pickRecord(backend, BACKEND_KEYS),
        stateTracker: {},
        wbuf: null,
        stateBlocks: {
            ...stateBlock,
            byBlockType: { ...stateBlockByType },
            entryOps: { ...stateBlockOps },
            liveBlocks: 0,
        },
        devices: 0,
    };
}
