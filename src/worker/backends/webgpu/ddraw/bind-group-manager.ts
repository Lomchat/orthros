/**
 * Bind group management for DirectDraw WebGPU backend.
 * Handles bind group caching with LRU eviction to prevent memory leaks.
 * Caches samplers by (minFilter, magFilter) to support min≠mag (e.g. bilinear min, nearest mag).
 */

import { LruCache } from "../../../core/collections/lru-cache";
import { Logger, LogCategory } from "../../../core/logger";
import { System } from "../../../core/system";
import { DxSamplerCache } from "../shared/dx-sampler";
import {
    D3DTFN_POINT,
    D3DTFN_LINEAR,
    D3DTFN_ANISOTROPIC,
    D3DTFG_POINT,
    D3DTFG_LINEAR,
    D3DTFG_ANISOTROPIC,
    D3DTADDRESS_WRAP,
    D3DTADDRESS_MIRROR,
    D3DTADDRESS_CLAMP,
    D3DTADDRESS_BORDER,
    D3DTFP_NONE,
    D3DTFP_POINT,
    D3DTFP_LINEAR,
} from "../../../modules/ddraw/constants";
import { DEFAULT_UNIFORM_BUFFER_CONFIG, DEFAULT_STORAGE_BUFFER_CONFIG } from "./types";
import { FFP_LIGHTSET_BYTES } from "../d3d9/ffp-lighting";
import { MAX_FFP_SAMPLED_STAGES, StageSamplerState } from "./ffp-stages";
import { STAGE_BINDINGS } from "./shader-generator";

const UNIFORM_SLOT_SIZE = DEFAULT_UNIFORM_BUFFER_CONFIG.slotSize;
// Device-global FFP user clip planes (binding 6): 6 × vec4f = 96 bytes.
export const FFP_CLIP_PLANES_BYTES = 6 * 16;
const STORAGE_BUFFER_SIZE = DEFAULT_STORAGE_BUFFER_CONFIG.bufferSize;
const STORAGE_SLOT_SIZE = DEFAULT_STORAGE_BUFFER_CONFIG.slotSize;

/**
 * Map D3D filter enum to WebGPU filter. 0 or uninitialized → linear.
 * Anisotropic mode maps to linear (actual anisotropy is controlled by maxAnisotropy parameter).
 */
function toWebGPUFilter(d3d: number, isMag: boolean): GPUFilterMode {
    const point = isMag ? D3DTFG_POINT : D3DTFN_POINT;
    const aniso = isMag ? D3DTFG_ANISOTROPIC : D3DTFN_ANISOTROPIC;

    if (d3d === point) return "nearest";
    if (d3d === aniso) return "linear"; // Anisotropic uses linear filtering
    return "linear"; // Default
}

/** Map D3D address mode to WebGPU address mode. Default: clamp-to-edge. */
function toWebGPUAddressMode(d3d: number): GPUAddressMode {
    switch (d3d) {
        case D3DTADDRESS_WRAP: return "repeat";
        case D3DTADDRESS_MIRROR: return "mirror-repeat";
        case D3DTADDRESS_CLAMP: return "clamp-to-edge";
        case D3DTADDRESS_BORDER: return "clamp-to-edge"; // WebGPU has no clamp-to-border; approximate with clamp-to-edge
        default: return "clamp-to-edge"; // Default for uninitialized (DX7 default is WRAP, but clamp is safer)
    }
}

/** Map D3D mipmap filter enum to WebGPU mipmap filter. Default: none. */
function toWebGPUMipmapFilter(d3d: number): GPUMipmapFilterMode {
    switch (d3d) {
        case D3DTFP_POINT: return "nearest";
        case D3DTFP_LINEAR: return "linear";
        case D3DTFP_NONE:
        default: return "nearest"; // D3DTFP_NONE means no mipmap filtering (use nearest)
    }
}

/**
 * Manages GPU bind groups with caching and LRU eviction.
 * Caches samplers by (minFilter, magFilter) hash; supports min≠mag for DX7 games.
 */
export class BindGroupManager {
    private device: GPUDevice;

    // BindGroupLayout cache: key "0" | "1" | "11" | "111" (useTexture, useTexture1, useTexture2)
    private bindGroupLayoutCache = new Map<string, GPUBindGroupLayout>();

    // MegaBatch BindGroupLayout cache: key "mb_0" | "mb_1" | "mb_11" | "mb_111" (storage buffer version)
    private megaBatchLayoutCache = new Map<string, GPUBindGroupLayout>();

    // BindGroup cache: Pipeline -> Buffer -> TextureView -> Sampler -> BindGroup (single-texture)
    // Stage 1 (dual-texture) bind groups are not cached; create each time.
    private bindGroupCache = new WeakMap<
        GPURenderPipeline,
        Map<GPUBuffer, Map<GPUTextureView | null, LruCache<GPUSampler, GPUBindGroup>>>
    >();

    private readonly maxCacheSize: number;

    // Sampler factory/cache shared with the other DX backends (see shared/dx-sampler.ts).
    private samplers: DxSamplerCache;

    constructor(device: GPUDevice, maxCacheSize = 64) {
        this.device = device;
        this.maxCacheSize = maxCacheSize;
        this.samplers = new DxSamplerCache(device);
    }

    /**
     * Get or create the faithful sampler for D3D7 texture-stage filter/address/anisotropy state.
     * Decodes the D3D7 enums (note: D3D7 mip-filter is NONE=1/POINT=2/LINEAR=3) and delegates
     * descriptor construction + quality overrides + LOD clamping + caching to the shared
     * DxSamplerCache, which is also used by the D3D9 backend so behavior can't drift.
     */
    getOrCreateSampler(
        minFilter: number,
        magFilter: number,
        mipFilter: number = D3DTFP_NONE,
        addressU: number = D3DTADDRESS_CLAMP,
        addressV: number = D3DTADDRESS_CLAMP,
        maxAnisotropy: number = 1
    ): GPUSampler {
        const gameAnisotropic = (minFilter === D3DTFN_ANISOTROPIC || magFilter === D3DTFG_ANISOTROPIC);
        return this.samplers.acquire({
            min: toWebGPUFilter(minFilter, false),
            mag: toWebGPUFilter(magFilter, true),
            mip: toWebGPUMipmapFilter(mipFilter),
            // D3D7 mip enum: NONE=1, POINT=2, LINEAR=3. "No mip filtering" = anything that isn't POINT/LINEAR
            // (includes NONE and uninitialized 0) → the sampler is pinned to the base level (lodMaxClamp=0).
            mipNone: !(mipFilter === D3DTFP_POINT || mipFilter === D3DTFP_LINEAR),
            addressU: toWebGPUAddressMode(addressU),
            addressV: toWebGPUAddressMode(addressV),
            gameAnisotropy: gameAnisotropic ? maxAnisotropy : 1,
        });
    }

    /** Resolve the per-stage sampler from a StageSamplerState record. */
    getOrCreateStageSampler(s: StageSamplerState): GPUSampler {
        return this.getOrCreateSampler(s.minFilter, s.magFilter, s.mipFilter, s.addressU, s.addressV, s.maxAnisotropy);
    }

    /**
     * Get or create a bind group layout for the given sampled-stage mask.
     * Stages are independent: any subset of the sampleable stages may sample
     * (a stage can sample while stage 0 is untextured, e.g. SELECTARG2(CURRENT)
     * on stage 0 + textured stage 1).
     */
    getOrCreateBindGroupLayout(sampledMask: number): GPUBindGroupLayout {
        const key = String(sampledMask);
        let layout = this.bindGroupLayoutCache.get(key);
        if (layout) return layout;

        const entries: GPUBindGroupLayoutEntry[] = [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: {
                    type: "uniform",
                    hasDynamicOffset: true,
                    minBindingSize: UNIFORM_SLOT_SIZE,
                },
            },
        ];

        // Per-stage entries mirror the shader's independent binding declarations —
        // a mismatch here is a pipeline-layout validation error.
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            if ((sampledMask & (1 << s)) === 0) continue;
            const [samplerBinding, textureBinding] = STAGE_BINDINGS[s];
            entries.push(
                { binding: samplerBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                { binding: textureBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
            );
        }

        // Binding 5: the per-draw FFP light set (FfpLightSet), consumed by the vertex shader's
        // ffpComputeLighting. Dynamic offset (a 2nd dynamic binding after the binding-0 uniform
        // slot) so each draw selects its own light set. Always present → one layout per variant.
        entries.push({
            binding: 5,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: FFP_LIGHTSET_BYTES },
        });

        // Binding 6: device-global FFP user clip planes (FfpClipPlanes), read by the vertex
        // shader's clip-distance computation. Non-dynamic (device-global, not per-draw) and
        // always present so every FFP pipeline/bind-group shares one layout — a partial add
        // here vs. the shader declaration is a validation error.
        entries.push({
            binding: 6,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: FFP_CLIP_PLANES_BYTES },
        });

        layout = this.device.createBindGroupLayout({ entries });
        this.bindGroupLayoutCache.set(key, layout);
        return layout;
    }

    /**
     * Get or create a bind group for the given configuration.
     * Multi-texture (any stage above 0 sampling) bind groups are not cached.
     *
     * @param views    per-stage texture views (index = stage); stage 0 may fall back to
     *                 dummyTextureView, other stages must have been demoted if unresolvable.
     * @param samplers per-stage sampler parameters (index = stage)
     */
    getOrCreateBindGroup(
        pipeline: GPURenderPipeline,
        uniformBuffer: GPUBuffer,
        sampledMask: number,
        views: ReadonlyArray<GPUTextureView | null>,
        samplers: ReadonlyArray<StageSamplerState>,
        dummyTextureView: GPUTextureView | null,
        lightsBuffer: GPUBuffer | null = null,
        clipPlanesBuffer: GPUBuffer | null = null
    ): GPUBindGroup | null {
        const layout = this.getOrCreateBindGroupLayout(sampledMask);
        const useTexture = (sampledMask & 1) !== 0;
        const sampler0 = this.getOrCreateStageSampler(samplers[0]);
        const textureView0 = useTexture ? views[0] || dummyTextureView : null;

        // Multi-texture: no cache, create bind group each time.
        // The layout declares bindings for every sampling stage, so a missing view here
        // cannot produce a valid group — the executor demotes stages before the pipeline
        // is created; this guard only reports the (should-be-impossible) gap.
        if ((sampledMask & ~1) !== 0) {
            const entries: GPUBindGroupEntry[] = [
                { binding: 0, resource: { buffer: uniformBuffer, offset: 0, size: UNIFORM_SLOT_SIZE } },
            ];
            for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
                if ((sampledMask & (1 << s)) === 0) continue;
                const view = s === 0 ? textureView0 : views[s];
                if (!view) {
                    Logger.warn(
                        LogCategory.DDRAW,
                        `BindGroupManager: multi-texture bind group missing stage ${s} view ` +
                            `(sampledMask=0b${sampledMask.toString(2)}) — draw will be skipped`
                    );
                    return null;
                }
                const [samplerBinding, textureBinding] = STAGE_BINDINGS[s];
                entries.push(
                    { binding: samplerBinding, resource: s === 0 ? sampler0 : this.getOrCreateStageSampler(samplers[s]) },
                    { binding: textureBinding, resource: view },
                );
            }
            if (lightsBuffer) entries.push({ binding: 5, resource: { buffer: lightsBuffer, offset: 0, size: FFP_LIGHTSET_BYTES } });
            if (clipPlanesBuffer) entries.push({ binding: 6, resource: { buffer: clipPlanesBuffer, offset: 0, size: FFP_CLIP_PLANES_BYTES } });
            return this.device.createBindGroup({ layout, entries });
        }

        // Single-texture: use cache
        let bufferMap = this.bindGroupCache.get(pipeline);
        if (!bufferMap) {
            bufferMap = new Map();
            this.bindGroupCache.set(pipeline, bufferMap);
        }
        let textureMap = bufferMap.get(uniformBuffer);
        if (!textureMap) {
            textureMap = new Map();
            bufferMap.set(uniformBuffer, textureMap);
        }
        const textureKey = useTexture ? textureView0 : null;
        let samplerMap = textureMap.get(textureKey);
        if (!samplerMap) {
            samplerMap = new LruCache<GPUSampler, GPUBindGroup>({ maxEntries: this.maxCacheSize });
            textureMap.set(textureKey, samplerMap);
        }

        let bindGroup = samplerMap.get(sampler0);

        const system = System.getInstance();
        const ddraw = system.process?.getModule("ddraw") as any;

        if (bindGroup) {
            if (ddraw?.incrementFrameCounter) {
                ddraw.incrementFrameCounter("cacheHits");
            }

            return bindGroup;
        }

        if (ddraw?.incrementFrameCounter) {
            ddraw.incrementFrameCounter("cacheMisses");
        }

        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: uniformBuffer, offset: 0, size: UNIFORM_SLOT_SIZE } },
        ];
        if (useTexture && textureView0) {
            entries.push({ binding: 1, resource: sampler0 }, { binding: 2, resource: textureView0 });
        }
        if (lightsBuffer) entries.push({ binding: 5, resource: { buffer: lightsBuffer, offset: 0, size: FFP_LIGHTSET_BYTES } });
        if (clipPlanesBuffer) entries.push({ binding: 6, resource: { buffer: clipPlanesBuffer, offset: 0, size: FFP_CLIP_PLANES_BYTES } });
        bindGroup = this.device.createBindGroup({ layout, entries });
        samplerMap.set(sampler0, bindGroup);
        return bindGroup;
    }

    /**
     * Create a pipeline layout using the bind group layout
     */
    createPipelineLayout(sampledMask: number): GPUPipelineLayout {
        const bindGroupLayout = this.getOrCreateBindGroupLayout(sampledMask);
        return this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    }

    // ===== MegaBatch Support =====

    /**
     * Get or create a MegaBatch bind group layout for the given sampled-stage mask.
     * MegaBatch uses storage buffer (binding 0) instead of uniform buffer; per-stage
     * sampler/texture bindings follow STAGE_BINDINGS.
     */
    getOrCreateMegaBatchBindGroupLayout(sampledMask: number): GPUBindGroupLayout {
        const key = `mb_${sampledMask}`;
        let layout = this.megaBatchLayoutCache.get(key);
        if (layout) return layout;

        const entries: GPUBindGroupLayoutEntry[] = [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: {
                    type: "read-only-storage",
                    // MegaBatch draws index the STORAGE ring (512-byte DrawUniforms slots),
                    // not the legacy uniform ring — the two slot sizes differ.
                    minBindingSize: STORAGE_SLOT_SIZE,
                },
            },
        ];

        // Per-stage entries mirror the shader's independent binding declarations (see
        // getOrCreateBindGroupLayout) — no nesting.
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            if ((sampledMask & (1 << s)) === 0) continue;
            const [samplerBinding, textureBinding] = STAGE_BINDINGS[s];
            entries.push(
                { binding: samplerBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                { binding: textureBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
            );
        }

        layout = this.device.createBindGroupLayout({ entries });
        this.megaBatchLayoutCache.set(key, layout);
        return layout;
    }

    /**
     * Create a MegaBatch pipeline layout using storage buffer.
     */
    createMegaBatchPipelineLayout(sampledMask: number): GPUPipelineLayout {
        const bindGroupLayout = this.getOrCreateMegaBatchBindGroupLayout(sampledMask);
        return this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    }

    /**
     * Create a MegaBatch bind group.
     * Unlike regular bind groups, MegaBatch bind groups are NOT cached because:
     * 1. Storage buffer is bound without dynamic offset
     * 2. Each MegaBatch may use different portions of the storage buffer
     * 3. Storage buffer contents change frequently
     */
    createMegaBatchBindGroup(
        storageBuffer: GPUBuffer,
        sampledMask: number,
        views: ReadonlyArray<GPUTextureView | null>,
        samplers: ReadonlyArray<StageSamplerState>,
        dummyTextureView: GPUTextureView | null,
        storageOffset: number = 0,
        storageSize?: number
    ): GPUBindGroup {
        const layout = this.getOrCreateMegaBatchBindGroupLayout(sampledMask);

        const entries: GPUBindGroupEntry[] = [
            {
                binding: 0,
                resource: storageSize !== undefined
                    ? { buffer: storageBuffer, offset: storageOffset, size: storageSize }
                    : { buffer: storageBuffer, offset: storageOffset }
            },
        ];

        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            if ((sampledMask & (1 << s)) === 0) continue;
            const view = s === 0 ? (views[0] || dummyTextureView) : views[s];
            if (!view) continue; // demoted upstream; layout mismatch is reported by validation
            const [samplerBinding, textureBinding] = STAGE_BINDINGS[s];
            entries.push(
                { binding: samplerBinding, resource: this.getOrCreateStageSampler(samplers[s]) },
                { binding: textureBinding, resource: view }
            );
        }

        return this.device.createBindGroup({ layout, entries });
    }

    clearCache(): void {
        this.bindGroupLayoutCache.clear();
        this.megaBatchLayoutCache.clear();
        this.samplers.clear();
    }
}
