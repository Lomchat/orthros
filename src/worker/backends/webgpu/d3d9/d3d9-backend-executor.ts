/**
 * D3D9BackendExecutor - Executes render frames on the WebGPU backend
 *
 * Separated from D3D9Device to isolate GPU-specific code
 * and enable potential backend switching in the future.
 */

import { WebGPUBackend } from "../webgpu-backend";
import { RenderFrame, RenderCommandType, ProgrammableDrawState, FixedFunctionDrawState } from "../render-frame";
import { frameProfiler } from "../../../core/frame-profiler";
import {
    d3d9PresentSourceTextureUsage,
    shouldUseDirectD3D9Presentation,
} from "./presentation-policy";
import { PROG_BIND } from "./shader";
import { d3d9WasmArena, ArenaCommandType } from "./d3d9-wasm-arena";

export interface PipelineInfo {
    pipeline: GPURenderPipeline;
    hasTexture: boolean;
    /** Programmable (VS/PS) pipelines bind via per-draw BindProgrammable. */
    programmable: boolean;
}

const UNIFORM_ALIGN = 256;
function alignUp(n: number, a: number): number { return Math.ceil(n / a) * a; }
function nextPowerOfTwo(n: number): number {
    let value = 256;
    while (value < n) value *= 2;
    return value;
}

// Fixed binding window for the dynamic-offset programmable uniform bindings.
// Sized to the worst case (VS: 256 vec4, PS: 224 vec4). A draw's actual block is
// usually far smaller; the shader reads only the constants it declares from the
// front of the window, so over-binding is harmless. Fixing the window size lets a
// single cached bind group serve every draw of a material — only the dynamic
// offset varies per draw (see bindProgrammable / acquireProgBindGroup).
const VS_BIND_SIZE = 256 * 4 * 4; // 4096 bytes
const PS_BIND_SIZE = 224 * 4 * 4; // 3584 bytes
const PROG_CACHE_N = 64;          // material-keyed programmable bind-group cache slots
const PROG_CONST_CACHE_N = 64;    // frame-local per-draw constant dynamic-offset cache slots

/** A growable per-frame uniform ring written at 256-aligned offsets. */
class UniformArena {
    buffer: GPUBuffer | null = null;
    private capacity = 0;
    private cursor = 0;

    constructor(private device: GPUDevice, private label: string) {}

    /** Ensure capacity (recreate if needed) and reset the write cursor. */
    begin(needed: number): void {
        const want = Math.max(needed, 256);
        if (!this.buffer || this.capacity < want) {
            this.buffer?.destroy();
            this.capacity = alignUp(want * 2, UNIFORM_ALIGN);
            this.buffer = this.device.createBuffer({
                label: this.label,
                size: this.capacity,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
        this.cursor = 0;
    }

    /** Bump-write the first `floatLen` floats of `data` (zero-alloc), returning the
     *  256-aligned byte offset used as the per-draw dynamic offset. */
    write(queue: GPUQueue, data: Float32Array, floatLen: number): number {
        const size = Math.max(16, floatLen * 4);
        const offset = this.cursor;
        if (floatLen > 0) {
            // Typed-array overload: dataOffset and size are in ELEMENTS, not bytes.
            queue.writeBuffer(this.buffer!, offset, data, 0, floatLen);
        }
        this.cursor = alignUp(offset + size, UNIFORM_ALIGN);
        return offset;
    }
}

export interface UniformData {
    viewportWidth: number;
    viewportHeight: number;
    mvp: Float32Array;
    /** Expanded fixed-function uniform block (viewport + MVP + worldView + material/lights +
     *  global ambient + control flags). Layout owned by d3d9/ffp-lighting.ts. The FFP shader
     *  path binds this whole block at @binding(0); the programmable path ignores it. */
    ffpBlock?: Float32Array;
    /** When a vertex shader is active, this contains c0..cN constant registers */
    vsConstants?: Float32Array;
    /** Number of vec4 constant registers to upload (determines buffer size) */
    vsConstantCount?: number;
}

export class D3D9BackendExecutor {
    private backend: WebGPUBackend;
    private gpuOpHistory: Array<{ at: number; op: string }> = [];
    private gpuScopedFrames = 0;
    private pipelines: GPURenderPipeline[] = [];
    private pipelineInfo: PipelineInfo[] = [];

    // Optimization caches
    private currentPipelineId: number | null = null;
    private bindGroupCache: Map<string, { bindGroup: GPUBindGroup; textureView: GPUTextureView | null }> = new Map();
    private fixedStateResources = new WeakMap<FixedFunctionDrawState, {
        buffer: GPUBuffer;
        size: number;
        pipelineId: number;
        textures: (GPUTextureView | null)[];
        samplers: GPUSampler[];
        bindGroup: GPUBindGroup;
    }>();
    private uniformBuffer: GPUBuffer | null = null;
    private uniformBufferSize = 0;
    private uniformData: Float32Array = new Float32Array(20);
    private sampler: GPUSampler | null = null;

    // Offscreen rendering
    private offscreenTexture: GPUTexture | null = null;
    private offscreenView: GPUTextureView | null = null;
    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    private offscreenSize: { width: number; height: number } | null = null;
    /**
     * D3DSWAPEFFECT_DISCARD invalidates the swap-chain contents after Present. The
     * stable WebGPU attachments otherwise retain old pixels/depth. Clear once on
     * the first swap-chain pass of the next game frame; subsequent partial
     * submissions in that same frame must continue to load the new contents.
     *
     * The depth side of this contract matters just as much as colour: BFME clears
     * only stencil during gameplay and expects the disposable auto depth-stencil
     * surface to start the next frame undefined. Retaining its previous depth while
     * clearing colour makes the new model passes fail Z and leaves black silhouettes.
     */
    private discardBackbufferColor = true;
    // Chromium's Linux/headless WebGPU canvas swapchain can destroy the entire
    // GPUDevice on the first D3D9 present. That environment keeps the game's
    // rendering on ordinary GPU textures and bridges completed frames to the page
    // as ImageBitmaps; normal desktop browsers use the direct swapchain. Only one
    // fallback readback may be in flight: dropping presentation frames is preferable
    // to stalling the guest or building an unbounded queue.
    private cpuPresentInFlight = false;
    private cpuPresentSequence = 0;
    private cpuPresentStartedAt = 0;
    private cpuPresentPhase = 0; // 0 idle, 1 GPU map, 2 ImageBitmap conversion
    private readonly defaultDirectPresentation = shouldUseDirectD3D9Presentation(
        undefined,
        typeof navigator === "undefined" ? "" : navigator.userAgent,
    );
    // Snapshot of the last COMPLETE presented frame. The offscreen is rendered incrementally
    // across a game frame's multiple submitFrame() passes (a backbuffer clear flushes to it
    // before the scene is redrawn — e.g. when render-to-texture passes sit between the clear and
    // the scene), so mid-frame the offscreen is transiently black. repaintLastFrame() re-presents
    // THIS snapshot (updated only at actual present) instead of the work-in-progress offscreen, so
    // the canvas never flashes the black intermediate at the RAF rate. See NFSU cube-reflection flicker.
    private presentedTexture: GPUTexture | null = null;
    private hasPresented = false;

    // Fallback texture for when no texture is bound
    private fallbackTexture: GPUTexture | null = null;
    private fallbackTextureView: GPUTextureView | null = null;
    // Cube fallback (1×1×6) for cube-sampler stages with no bound texture.
    private fallbackCubeTexture: GPUTexture | null = null;
    private fallbackCubeView: GPUTextureView | null = null;

    // Performance metrics
    public metrics = {
        pipelineSets: 0,
        bindGroupSets: 0,
        bindGroupSetSkips: 0,
        bindGroupCacheHits: 0,
        drawCalls: 0,
        clearCalls: 0,
        progConstWrites: 0,
        progConstReuseHits: 0,
        // The CPU/ImageBitmap presentation bridge is asynchronous and deliberately
        // keeps at most one readback in flight. These counters make its real output
        // cadence observable: guest Presents can stay fast while visible frames are
        // dropped here, outside the synchronous Present profiler category.
        cpuPresentEncoded: 0,
        cpuPresentDropped: 0,
        cpuPresentPublished: 0,
        cpuPresentFailed: 0,
        cpuPresentTimeouts: 0,
        cpuPresentMapMs: 0,
        cpuPresentBitmapMs: 0,
        directPresentFrames: 0,
    };

    constructor(backend: WebGPUBackend) {
        this.backend = backend;
        backend.getDevice()?.addEventListener("uncapturederror", (event: GPUUncapturedErrorEvent) => {
            this.traceGpu(`uncaptured: ${event.error.message}`);
        });
    }

    private traceGpu(op: string): void {
        this.gpuOpHistory.push({ at: performance.now(), op });
        if (this.gpuOpHistory.length > 128) this.gpuOpHistory.shift();
    }

    getGpuOpHistory(): Array<{ at: number; op: string }> {
        return this.gpuOpHistory.slice();
    }

    /**
     * Register a pipeline and return its ID
     */
    registerPipeline(pipeline: GPURenderPipeline, hasTexture: boolean, programmable = false): number {
        const id = this.pipelines.length;
        this.pipelines.push(pipeline);
        this.pipelineInfo.push({ pipeline, hasTexture, programmable });
        return id;
    }

    // ── Programmable (VS/PS) path ─────────────────────────────────────────
    // Bind-group/pipeline layouts vary only by the cube-sampler mask (which stages are
    // viewDimension:"cube" vs "2d"); cached per mask (mask 0 = the common all-2D layout).
    private progLayouts: Map<number, { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout }> = new Map();
    private vsArena: UniformArena | null = null;
    private psArena: UniformArena | null = null;

    // Material-keyed programmable bind-group cache. With dynamic offsets, the only
    // per-draw-varying part of the bind group is the uniform offset (passed at
    // setBindGroup), so a bind group can be reused across every draw sharing the
    // same (sampler + bound texture views). Direct compare on object identity →
    // correct-by-construction (a recreated view is a new object → miss → rebuild).
    // Invalidated only when an arena buffer is recreated (cached groups bind it).
    private progCacheSampler: (GPUSampler | null)[] = [];
    private progCacheViews: (GPUTextureView | null)[] = new Array(PROG_CACHE_N * PROG_BIND.MAX_TEX).fill(null);
    private progCacheGroup: GPUBindGroup[] = [];
    // Per-slot cube mask: a bind group built for one layout (cube mask) is incompatible with a
    // pipeline using a different mask, so the mask is part of the cache identity.
    private progCacheCubeMask: number[] = [];
    private progCacheLen = 0;
    private progCacheCursor = 0;
    private progCacheVsBuffer: GPUBuffer | null = null;
    private progCachePsBuffer: GPUBuffer | null = null;
    /** Reused [vsOffset, psOffset] dynamic-offset scratch (avoids a per-draw array alloc). */
    private dynOffsets: number[] = [0, 0];
    private progVsConstVersion: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progVsConstLen: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progVsConstOffset: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progVsConstCount = 0;
    private progVsConstCursor = 0;
    private progPsConstVersion: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progPsConstLen: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progPsConstOffset: number[] = new Array(PROG_CONST_CACHE_N).fill(0);
    private progPsConstCount = 0;
    private progPsConstCursor = 0;
    private lastBoundBindGroup: GPUBindGroup | null = null;
    private lastBindOffset0 = -1;
    private lastBindOffset1 = -1;
    /** Persistent COPY_SRC arenas. queue.writeBuffer is ordered on the GPU queue,
     * so one arena upload can feed every copy in a frame without per-draw calls or
     * per-frame mapped-buffer creation/destruction (which destabilises Chromium). */
    private geometryStagingBuffer: GPUBuffer | null = null;
    private geometryStagingSize = 0;
    private geometryStagingData = new Uint8Array(0);
    private fixedStagingBuffer: GPUBuffer | null = null;
    private fixedStagingSize = 0;
    private fixedStagingData = new Uint8Array(0);

    /**
     * Shared, explicit bind-group/pipeline layout for programmable pipelines, parameterised by
     * the cube-sampler mask. Fixed slots: vs-uniform, ps-uniform, sampler, MAX_TEX textures —
     * each texture slot is viewDimension:"cube" when its bit is set in cubeMask, else "2d".
     * Cached per mask (mask 0 is the common all-2D case).
     */
    getProgrammableLayout(cubeMask: number = 0): { bindGroupLayout: GPUBindGroupLayout; pipelineLayout: GPUPipelineLayout } {
        let layout = this.progLayouts.get(cubeMask);
        if (!layout) {
            const device = this.backend.getDevice()!;
            const entries: GPUBindGroupLayoutEntry[] = [
                { binding: PROG_BIND.VS_UNIFORM, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: true } },
                { binding: PROG_BIND.PS_UNIFORM, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
                { binding: PROG_BIND.SAMPLER, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ];
            for (let n = 0; n < PROG_BIND.MAX_TEX; n++) {
                entries.push({
                    binding: PROG_BIND.TEX_BASE + n,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float", viewDimension: ((cubeMask >> n) & 1) ? "cube" : "2d" },
                });
            }
            const bindGroupLayout = device.createBindGroupLayout({ entries });
            const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
            layout = { bindGroupLayout, pipelineLayout };
            this.progLayouts.set(cubeMask, layout);
        }
        return layout;
    }

    /**
     * Get pipeline by ID
     */
    getPipeline(id: number): GPURenderPipeline | null {
        return this.pipelines[id] ?? null;
    }

    /**
     * Get pipeline info by ID
     */
    getPipelineInfo(id: number): PipelineInfo | null {
        return this.pipelineInfo[id] ?? null;
    }

    /**
     * Get performance metrics
     */
    getMetrics(): typeof this.metrics & {
        cpuPresentInFlight: number;
        cpuPresentPhase: number;
        cpuPresentAgeMs: number;
    } {
        return {
            ...this.metrics,
            cpuPresentInFlight: this.cpuPresentInFlight ? 1 : 0,
            cpuPresentPhase: this.cpuPresentPhase,
            cpuPresentAgeMs: this.cpuPresentInFlight
                ? Math.max(0, performance.now() - this.cpuPresentStartedAt)
                : 0,
        };
    }

    /**
     * Reset performance metrics
     */
    resetMetrics(): void {
        this.metrics.pipelineSets = 0;
        this.metrics.bindGroupSets = 0;
        this.metrics.bindGroupSetSkips = 0;
        this.metrics.bindGroupCacheHits = 0;
        this.metrics.drawCalls = 0;
        this.metrics.clearCalls = 0;
        this.metrics.progConstWrites = 0;
        this.metrics.progConstReuseHits = 0;
        this.metrics.cpuPresentEncoded = 0;
        this.metrics.cpuPresentDropped = 0;
        this.metrics.cpuPresentPublished = 0;
        this.metrics.cpuPresentFailed = 0;
        this.metrics.cpuPresentTimeouts = 0;
        this.metrics.cpuPresentMapMs = 0;
        this.metrics.cpuPresentBitmapMs = 0;
        this.metrics.directPresentFrames = 0;
    }

    // ── WASM arena verify-only drain (dual-run scope cut) ────────────────────
    // Counters exposed via dbg.d3dArenaStats().
    private arenaDrainStats = {
        setPipelineCount: 0,
        pipelineHits: 0,
        pipelineMisses: 0,
        bindProgrammableCount: 0,
        drawCount: 0,
        drawIndexedCount: 0,
        drawUPCount: 0,
        drawIndexedUPCount: 0,
    };
    // Verify-only bookkeeping only: which arena pipelineKeys have been observed. This is
    // NOT a real GPURenderPipeline cache — the legacy caches (D3D9Device.progPipelineCache:
    // Map<string,number> + this.pipelines: GPURenderPipeline[] indexed by a sequential id)
    // are keyed by an entirely different id space than the arena's FNV-hashed pipelineKey,
    // so there is no existing Map<number, GPURenderPipeline> to look this hash up in. A real
    // (non-verify-only) bypass would need a NEW cache keyed on the arena's pipelineKey,
    // populated via the same pipeline-build code resolveProgrammablePipeline/registerPipeline
    // already use — deferred, out of scope here.
    private arenaSeenPipelineKeys = new Set<number>();

    getArenaDrainStats(): typeof this.arenaDrainStats {
        return { ...this.arenaDrainStats };
    }

    resetArenaDrainStats(): void {
        this.arenaDrainStats = {
            setPipelineCount: 0, pipelineHits: 0, pipelineMisses: 0,
            bindProgrammableCount: 0, drawCount: 0, drawIndexedCount: 0,
            drawUPCount: 0, drawIndexedUPCount: 0,
        };
        this.arenaSeenPipelineKeys.clear();
    }

    /**
     * Verify-only drain of the WASM arena's command SoA. Walks the same command shapes the
     * legacy RenderFrame consumer (execute() below) does, but NEVER touches a real
     * GPUCommandEncoder/pipeline/bind-group — it only proves out the lookup/decode path and
     * counts what it finds. Safe to call any time; flipping the kill switch that gates this
     * call (see D3D9Device.submitFrame) can never affect what actually renders.
     *
     * NOTE (gap, see report): readDrawState() doesn't currently return VS/PS shader handles,
     * only declHandle — a real bypass would need those too (resolveProgrammablePipeline needs
     * the CompiledVs/CompiledPs, not just a vertex declaration) to actually build a pipeline
     * on a miss. Deferred; out of scope for this verify-only pass.
     */
    drainArenaVerifyOnly(): void {
        const count = d3d9WasmArena.getCommandCount();
        if (count === 0) return;
        const types = d3d9WasmArena.getCommandTypes();
        const a = d3d9WasmArena.getCommandA();
        const b = d3d9WasmArena.getCommandB();
        for (let i = 0; i < count; i++) {
            switch (types[i]) {
                case ArenaCommandType.SetPipeline: {
                    this.arenaDrainStats.setPipelineCount++;
                    const pipelineKey = a[i]!;
                    if (this.arenaSeenPipelineKeys.has(pipelineKey)) {
                        this.arenaDrainStats.pipelineHits++;
                    } else {
                        this.arenaSeenPipelineKeys.add(pipelineKey);
                        this.arenaDrainStats.pipelineMisses++;
                        // Miss: pull the raw ingredients back (a real impl would build a
                        // GPURenderPipeline from these) — verify-only, just confirm they decode.
                        d3d9WasmArena.readDrawState(b[i]!);
                    }
                    break;
                }
                case ArenaCommandType.BindProgrammable: {
                    this.arenaDrainStats.bindProgrammableCount++;
                    d3d9WasmArena.readDrawState(a[i]!);
                    break;
                }
                case ArenaCommandType.Draw:
                    this.arenaDrainStats.drawCount++;
                    break;
                case ArenaCommandType.DrawIndexed:
                    this.arenaDrainStats.drawIndexedCount++;
                    break;
                case ArenaCommandType.DrawUP:
                    this.arenaDrainStats.drawUPCount++;
                    break;
                case ArenaCommandType.DrawIndexedUP:
                    this.arenaDrainStats.drawIndexedUPCount++;
                    break;
                // SetVertexBuffer / SetIndexBuffer: raw bufferId/offset/stride, no lookup to verify.
            }
        }
    }

    /**
     * Execute a render frame
     */
    execute(
        frame: RenderFrame,
        uniforms: UniformData,
        textureView: GPUTextureView | null,
        present: boolean,
        overlays?: {
            videoOverlayCanvas?: OffscreenCanvas | null;
            gdiOverlayCanvas?: OffscreenCanvas | null;
            // undefined = composite the whole GDI overlay (windowed / GDI desktop owns screen);
            // a rect list = 3D renderer owns the screen, composite only these live-dialog rects
            // ([] → nothing, so an occluded loading splash cannot cover the frame).
            gdiOverlayRects?: Array<{ x: number; y: number; w: number; h: number }>;
        },
        /** Render-to-texture target. When set, the pass renders into these views instead of the
         *  swap-chain offscreen and the canvas-copy / overlay compositing is skipped (RT passes
         *  never present). */
        target?: {
            colorView: GPUTextureView;
            depthView?: GPUTextureView;
            /** When set, used directly (shared FFP depth with stencil load/clear semantics). */
            depthStencil?: GPURenderPassDepthStencilAttachment;
        } | null,
    ): void {
        const device = this.backend.getDevice()!;
        const queue = this.backend.getQueue()!;
        const scoped = this.gpuScopedFrames++ < 64;
        if (scoped) {
            device.pushErrorScope("internal");
            device.pushErrorScope("out-of-memory");
            device.pushErrorScope("validation");
        }
        this.traceGpu(`execute begin present=${present ? 1 : 0} target=${target ? 1 : 0} cmds=${frame.commandTypes.length} draws=${frame.drawStateCount}`);

        // Reset state tracking for the new frame/renderPass
        this.currentPipelineId = null;
        this.resetProgConstOffsetCache();
        this.resetRenderPassBindCache();

        try {
            // Create the encoder early: both transient geometry and fixed-function
            // constants are staged with GPU copies instead of hundreds of individual
            // queue.writeBuffer calls.
            const encoder = device.createCommandEncoder();
            this.stageQueuedUploads(device, encoder, frame);

            // Pre-size the programmable per-draw uniform arenas for this frame.
            if (frame.drawStateCount > 0) {
                let vsNeeded = 0, psNeeded = 0;
                for (let i = 0; i < frame.drawStateCount; i++) {
                    const ds = frame.drawStates[i];
                    vsNeeded += alignUp(Math.max(16, ds.vsLen * 4), UNIFORM_ALIGN);
                    psNeeded += alignUp(Math.max(16, ds.psLen * 4), UNIFORM_ALIGN);
                }
                if (!this.vsArena) this.vsArena = new UniformArena(device, "vs-const-arena");
                if (!this.psArena) this.psArena = new UniformArena(device, "ps-const-arena");
                // Pad by one full binding window so the last block's dynamic-offset
                // range [offset, offset + *_BIND_SIZE) stays within the buffer.
                this.vsArena.begin(vsNeeded + VS_BIND_SIZE);
                this.psArena.begin(psNeeded + PS_BIND_SIZE);

                // Cached programmable bind groups bind the arena buffers; if begin()
                // recreated either buffer, the cache is stale → drop it.
                if (this.vsArena.buffer !== this.progCacheVsBuffer || this.psArena.buffer !== this.progCachePsBuffer) {
                    this.progCacheLen = 0;
                    this.progCacheCursor = 0;
                    this.progCacheVsBuffer = this.vsArena.buffer;
                    this.progCachePsBuffer = this.psArena.buffer;
                }
            }

            // Ensure offscreen target (swap-chain path only; RT passes bring their own views).
            if (!target) this.ensureOffscreenTarget();
            this.traceGpu(`target ready ${target ? "rt" : `${this.offscreenTexture?.width}x${this.offscreenTexture?.height}`}`);

            // Fixed-function draws each carry their own transform/material/light block.
            // Sending those blocks with one queue.writeBuffer call per draw is extremely
            // expensive in Chromium (BFME: ~147 calls / frame, roughly 35 ms). Populate one
            // mapped staging buffer and record GPU copies before opening the render pass.
            // The destination buffers remain stable, so their cached bind groups stay valid.
            this.stageFixedFunctionUniforms(device, encoder, frame);

            const clearTarget = (frame.clear.flags & 1) !== 0; // D3DCLEAR_TARGET
            const clearZ = (frame.clear.flags & 2) !== 0; // D3DCLEAR_ZBUFFER
            const clearStencil = (frame.clear.flags & 4) !== 0; // D3DCLEAR_STENCIL

            const discardColor = !target && this.discardBackbufferColor;
            if (discardColor) this.discardBackbufferColor = false;
            // The swap-chain discard boundary also invalidates the implicit depth
            // contents. WebGPU has no "undefined" attachment load operation, so a
            // depth clear to the conventional far value is the deterministic match.
            // Do this only on the first backbuffer submission after Present, exactly
            // like the colour discard; RT passes and later partial submits keep depth.
            const discardDepth = discardColor;
            const explicitColorClear = frame.hasClear && clearTarget;
            const colorAttachments: GPURenderPassColorAttachment[] = [{
                view: target ? target.colorView : this.offscreenView!,
                clearValue: explicitColorClear ? frame.clear.color : { r: 0, g: 0, b: 0, a: 1 },
                loadOp: (explicitColorClear || discardColor) ? "clear" : "load",
                storeOp: "store",
            }];

            const depthStencilAttachment: GPURenderPassDepthStencilAttachment = target?.depthStencil ?? {
                view: target ? target.depthView! : this.depthView!,
                depthClearValue: (frame.hasClear && clearZ) ? frame.clear.depth : 1,
                depthLoadOp: ((frame.hasClear && clearZ) || discardDepth) ? "clear" : "load",
                depthStoreOp: "store",
                stencilClearValue: frame.clear.stencil,
                stencilLoadOp: (frame.hasClear && clearStencil) ? "clear" : "load",
                stencilStoreOp: "store",
            };

            const renderPass = encoder.beginRenderPass({
                colorAttachments,
                depthStencilAttachment,
            });

            // Execute commands
            for (let i = 0; i < frame.commandTypes.length; i++) {
                const type = frame.commandTypes[i];
                switch (type) {
                    case RenderCommandType.SetPipeline: {
                        const newPipelineId = frame.commandA[i];
                        if (this.currentPipelineId !== newPipelineId) {
                            this.currentPipelineId = newPipelineId;
                            const pipeline = this.pipelines[newPipelineId];
                            renderPass.setPipeline(pipeline);
                            this.resetRenderPassBindCache();
                            this.metrics.pipelineSets++;
                        }
                        // Programmable pipelines bind per-draw via BindProgrammable.
                        if (!this.pipelineInfo[newPipelineId]?.programmable) {
                            this.bindUniforms(renderPass, newPipelineId, uniforms, textureView);
                        }
                        break;
                    }

                    case RenderCommandType.BindProgrammable: {
                        const ds = frame.drawStates[frame.commandA[i]];
                        if (ds) this.bindProgrammable(renderPass, queue, ds);
                        break;
                    }

                    case RenderCommandType.BindFixedFunction: {
                        const ds = frame.fixedStates[frame.commandA[i]];
                        if (ds && this.currentPipelineId !== null) {
                            this.bindFixedFunction(renderPass, queue, this.currentPipelineId, ds);
                        }
                        break;
                    }
                    case RenderCommandType.SetStencilReference: {
                        renderPass.setStencilReference(frame.commandA[i] >>> 0);
                        break;
                    }

                    case RenderCommandType.SetVertexBuffer: {
                        const vbIndex = frame.commandA[i];
                        const vbOffset = frame.commandB[i];
                        const vbSize = frame.commandC[i];
                        // commandD = vertex-buffer slot (D3D stream number); 0 for single-stream.
                        renderPass.setVertexBuffer(frame.commandD[i] | 0, frame.bufferRefs[vbIndex], vbOffset, vbSize);
                        break;
                    }

                    case RenderCommandType.SetIndexBuffer: {
                        const ibIndex = frame.commandA[i];
                        const ibFormatFlag = frame.commandB[i];
                        const ibFormat = ibFormatFlag === 16 ? "uint16" : "uint32";
                        renderPass.setIndexBuffer(frame.bufferRefs[ibIndex], ibFormat);
                        break;
                    }

                    case RenderCommandType.Draw: {
                        const vertexCount = frame.commandA[i];
                        const startVertex = frame.commandB[i];
                        renderPass.draw(vertexCount, 1, startVertex, 0);
                        this.metrics.drawCalls++;
                        break;
                    }

                    case RenderCommandType.DrawIndexed: {
                        const indexCount = frame.commandA[i];
                        const startIndex = frame.commandB[i];
                        const baseVertex = frame.commandC[i];
                        renderPass.drawIndexed(indexCount, 1, startIndex, baseVertex, 0);
                        this.metrics.drawCalls++;
                        break;
                    }
                }
            }

            renderPass.end();
            this.traceGpu("renderPass end");

            // Composite overlays on top of the main scene: video plane first, then GDI.
            // (Swap-chain path only — RT passes never composite overlays or present.)
            if (present && !target && overlays?.videoOverlayCanvas) {
                this.backend.blit(overlays.videoOverlayCanvas, this.offscreenView!, encoder);
            }
            if (present && !target && overlays?.gdiOverlayCanvas) {
                const rects = overlays.gdiOverlayRects;
                if (rects) {
                    // 3D renderer owns the screen: composite only live-dialog rects (never the
                    // whole overlay). An empty list intentionally composites nothing.
                    if (rects.length) this.backend.blitRects(overlays.gdiOverlayCanvas, this.offscreenView!, encoder, rects);
                } else {
                    this.backend.blit(overlays.gdiOverlayCanvas, this.offscreenView!, encoder);
                }
            }

            let cpuReadback: {
                buffer: GPUBuffer;
                width: number;
                height: number;
                paddedBytesPerRow: number;
                sequence: number;
            } | null = null;

            // Real desktop browsers present straight into their WebGPU swapchain:
            // the CPU/ImageBitmap bridge costs a full GPU readback and can lag or
            // freeze while guest Presents continue. HeadlessChrome/SwiftShader keeps
            // the bridge because its external swap texture destroys the GPUDevice.
            // __d3d9DirectPresent remains a hot boolean diagnostic override.
            const directPresentation = this.useDirectPresentation();
            if (present && !target && !(globalThis as any).__d3d9OffscreenOnly &&
                !directPresentation) {
                cpuReadback = this.encodeCpuPresentation(encoder);
                this.hasPresented = false;
                this.traceGpu(cpuReadback ? "cpu presentation encoded" : "cpu presentation dropped (in flight)");
            // Copy to the canvas when direct presentation was selected.
            } else if (present && !target && !(globalThis as any).__d3d9OffscreenOnly) {
                this.metrics.directPresentFrames++;
                const context = this.backend.getContext()!;
                const currentTexture = context.getCurrentTexture();
                this.traceGpu(`currentTexture ${currentTexture.width}x${currentTexture.height}`);
                const size = this.getCanvasSize();

                // Present through a render pass, like the proven D3D8/OpenGL/Glide
                // paths. Chromium's OffscreenCanvas swap texture is an external
                // instance: using it as COPY_DST caused the GPUDevice to be destroyed
                // immediately after BFME's first Present, despite COPY_DST being
                // advertised by configure(). Sampling the offscreen texture into a
                // RENDER_ATTACHMENT is portable and also routes final gamma/post-FX.
                const off = this.offscreenTexture!;
                this.backend.drawTexture(
                    this.offscreenView!,
                    currentTexture.createView(),
                    encoder,
                    true,
                    undefined,
                    undefined,
                    { r: 0, g: 0, b: 0, a: 1 },
                    false,
                    { srcW: off.width, srcH: off.height, outW: size.width, outH: size.height },
                );
                // The host no longer re-acquires the swap texture between game
                // presents, so a second "presentedTexture" snapshot is unnecessary.
                // Keeping this extra copy in the first BFME submit was the last
                // operation correlated with Chromium destroying the GPU device.
                // captureFrame safely reads the offscreen while the guest is paused.
                this.hasPresented = false;
            } else if (present && !target) {
                this.traceGpu("canvas present skipped (__d3d9OffscreenOnly)");
            }

            const submitStart = frameProfiler.startTimer();
            this.traceGpu("queue submit begin");
            queue.submit([encoder.finish()]);
            this.traceGpu("queue submit end");
            if (present && !target) this.discardBackbufferColor = true;
            frameProfiler.endTimer("gpu", submitStart);
            if (cpuReadback) void this.publishCpuPresentation(cpuReadback);
            if (scoped) {
                const validation = device.popErrorScope();
                const oom = device.popErrorScope();
                const internal = device.popErrorScope();
                void Promise.allSettled([validation, oom, internal]).then((results) => {
                    const labels = ["validation", "out-of-memory", "internal"];
                    for (let i = 0; i < results.length; i++) {
                        const r = results[i];
                        if (r.status === "fulfilled" && r.value) this.traceGpu(`scope ${labels[i]}: ${r.value.message}`);
                        else if (r.status === "rejected") this.traceGpu(`scope ${labels[i]} rejected: ${String(r.reason)}`);
                    }
                });
            }
        } finally {
            frame.releaseTemporaryBuffers();
        }
    }

    private encodeCpuPresentation(encoder: GPUCommandEncoder): {
        buffer: GPUBuffer;
        width: number;
        height: number;
        paddedBytesPerRow: number;
        sequence: number;
    } | null {
        if (this.cpuPresentInFlight || !this.offscreenTexture) {
            this.metrics.cpuPresentDropped++;
            return null;
        }
        const device = this.backend.getDevice();
        if (!device) return null;
        const { width, height } = this.getCanvasSize();
        const paddedBytesPerRow = alignUp(width * 4, 256);
        const buffer = device.createBuffer({
            label: "d3d9-cpu-present-readback",
            size: paddedBytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        encoder.copyTextureToBuffer(
            { texture: this.offscreenTexture },
            { buffer, bytesPerRow: paddedBytesPerRow },
            { width, height, depthOrArrayLayers: 1 },
        );
        this.cpuPresentInFlight = true;
        this.cpuPresentStartedAt = performance.now();
        this.cpuPresentPhase = 1;
        this.metrics.cpuPresentEncoded++;
        return { buffer, width, height, paddedBytesPerRow, sequence: ++this.cpuPresentSequence };
    }

    private useDirectPresentation(): boolean {
        const override = (globalThis as any).__d3d9DirectPresent;
        return typeof override === "boolean" ? override : this.defaultDirectPresentation;
    }

    private async publishCpuPresentation(readback: {
        buffer: GPUBuffer;
        width: number;
        height: number;
        paddedBytesPerRow: number;
        sequence: number;
    }): Promise<void> {
        try {
            const mapStartedAt = performance.now();
            await this.cpuPresentWithTimeout(
                readback.buffer.mapAsync(GPUMapMode.READ),
                1_000,
                "GPU readback map",
            );
            this.metrics.cpuPresentMapMs += performance.now() - mapStartedAt;
            const mapped = new Uint8Array(readback.buffer.getMappedRange());
            const pixels = new Uint8ClampedArray(readback.width * readback.height * 4);
            const rowBytes = readback.width * 4;
            // navigator.gpu.getPreferredCanvasFormat() is BGRA on Chromium. ImageData
            // is RGBA. Compact padded rows and exchange red/blue in one 32-bit pass,
            // avoiding the previous full-frame byte copy followed by a second pass.
            if (this.backend.getFormat()?.startsWith("bgra")) {
                const dst = new Uint32Array(pixels.buffer);
                const srcBuffer = mapped.buffer;
                const srcBase = mapped.byteOffset;
                for (let y = 0; y < readback.height; y++) {
                    const src = new Uint32Array(
                        srcBuffer,
                        srcBase + y * readback.paddedBytesPerRow,
                        readback.width,
                    );
                    const dstRow = y * readback.width;
                    for (let x = 0; x < readback.width; x++) {
                        const value = src[x];
                        dst[dstRow + x] = (value & 0xff00ff00) |
                            ((value & 0x000000ff) << 16) |
                            ((value >>> 16) & 0x000000ff);
                    }
                }
            } else {
                for (let y = 0; y < readback.height; y++) {
                    pixels.set(
                        mapped.subarray(y * readback.paddedBytesPerRow, y * readback.paddedBytesPerRow + rowBytes),
                        y * rowBytes,
                    );
                }
            }
            readback.buffer.unmap();

            this.cpuPresentPhase = 2;
            const bitmapStartedAt = performance.now();
            const bitmapPromise = createImageBitmap(new ImageData(pixels, readback.width, readback.height));
            let bitmap: ImageBitmap;
            try {
                bitmap = await this.cpuPresentWithTimeout(bitmapPromise, 1_000, "ImageBitmap conversion");
            } catch (error) {
                // A timed-out conversion may still resolve later. Close that orphan
                // immediately so recovery cannot leak one full framebuffer.
                void bitmapPromise.then((lateBitmap) => lateBitmap.close(), () => {});
                throw error;
            }
            this.metrics.cpuPresentBitmapMs += performance.now() - bitmapStartedAt;
            self.postMessage({
                type: "d3d9_cpu_frame",
                bitmap,
                width: readback.width,
                height: readback.height,
                sequence: readback.sequence,
            }, { transfer: [bitmap] });
            this.metrics.cpuPresentPublished++;
        } catch (error) {
            this.metrics.cpuPresentFailed++;
            this.traceGpu(`cpu presentation failed: ${String(error)}`);
        } finally {
            try { readback.buffer.destroy(); } catch { /* device may have been lost */ }
            this.cpuPresentInFlight = false;
            this.cpuPresentStartedAt = 0;
            this.cpuPresentPhase = 0;
        }
    }

    private cpuPresentWithTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                this.metrics.cpuPresentTimeouts++;
                reject(new Error(`${phase} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
        });
        return Promise.race([promise, timeout]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
        });
    }

    /**
     * Re-present the last rendered offscreen frame to the canvas without re-rendering.
     * Used by the GDI present loop when a hardware-3D presenter owns the screen: the
     * device presents at low fps, so the canvas would otherwise go black between presents.
     */
    repaintLastFrame(): void {
        // Re-present the last COMPLETE frame, not the live offscreen (which is transiently black
        // between a frame's backbuffer clear and its scene redraw — pronounced when render-to-
        // texture passes sit in that gap). Until the first present, nothing valid exists → skip,
        // leaving the canvas showing whatever was last committed.
        const source = this.hasPresented ? this.presentedTexture : null;
        if (!source) return;
        const device = this.backend.getDevice();
        const context = this.backend.getContext();
        if (!device || !context) return;
        const dest = context.getCurrentTexture();
        const encoder = device.createCommandEncoder();
        // Clamp to both textures — the canvas may have resized since `source` was
        // captured (resolution change), and an oversized copy throws "touches outside".
        encoder.copyTextureToTexture(
            { texture: source },
            { texture: dest },
            {
                width: Math.min(source.width, dest.width),
                height: Math.min(source.height, dest.height),
                depthOrArrayLayers: 1,
            },
        );
        device.queue.submit([encoder.finish()]);
    }

    /**
     * Capture the current offscreen texture to a blob
     */
    async captureFrame(): Promise<Blob> {
        const device = this.backend.getDevice()!;
        const queue = this.backend.getQueue()!;
        const size = this.getCanvasSize();
        const width = size.width;
        const height = size.height;

        const bytesPerPixel = 4;
        const unpaddedBytesPerRow = width * bytesPerPixel;
        const align = 256;
        const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / align) * align;
        const bufferSize = paddedBytesPerRow * height;

        const readback = device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        // Read the last COMPLETE presented frame when available (the live offscreen is transiently
        // black mid-frame), so screenshots/readback match what the user actually sees on the canvas.
        const captureSrc = (this.hasPresented && this.presentedTexture) ? this.presentedTexture : this.offscreenTexture!;
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: captureSrc },
            { buffer: readback, bytesPerRow: paddedBytesPerRow },
            { width, height, depthOrArrayLayers: 1 }
        );
        const submitStart = frameProfiler.startTimer();
        queue.submit([encoder.finish()]);
        frameProfiler.endTimer("gpu", submitStart);
        await queue.onSubmittedWorkDone();

        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const pixels = new Uint8ClampedArray(width * height * bytesPerPixel);
        for (let row = 0; row < height; row++) {
            const srcStart = row * paddedBytesPerRow;
            const srcEnd = srcStart + unpaddedBytesPerRow;
            pixels.set(mapped.subarray(srcStart, srcEnd), row * unpaddedBytesPerRow);
        }
        readback.unmap();

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("Failed to get 2D context for capture.");
        }

        const imageData = new ImageData(pixels, width, height);
        ctx.putImageData(imageData, 0, 0);
        return canvas.convertToBlob({ type: "image/png" });
    }

    /**
     * Get the canvas size
     */
    getCanvasSize(): { width: number; height: number } {
        const context = this.backend.getContext()!;
        const canvas = context.canvas as OffscreenCanvas;
        return { width: canvas.width, height: canvas.height };
    }

    private ensureOffscreenTarget(): void {
        const device = this.backend.getDevice()!;
        const format = this.backend.getFormat()!;
        const size = this.getCanvasSize();

        if (this.offscreenTexture &&
            this.offscreenSize &&
            this.offscreenSize.width === size.width &&
            this.offscreenSize.height === size.height) {
            return;
        }

        if (this.offscreenTexture) {
            this.offscreenTexture.destroy();
        }
        if (this.depthTexture) {
            this.depthTexture.destroy();
        }

        this.offscreenTexture = device.createTexture({
            size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
            format,
            usage: d3d9PresentSourceTextureUsage(GPUTextureUsage),
        });
        this.offscreenView = this.offscreenTexture.createView();

        // Last-complete-frame snapshot for repaintLastFrame (see field comment).
        this.presentedTexture?.destroy();
        this.presentedTexture = device.createTexture({
            size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.hasPresented = false;
        this.discardBackbufferColor = true;

        this.depthTexture = device.createTexture({
            size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
            format: "depth24plus-stencil8",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.offscreenSize = size;
    }

    // VS uniform buffer (larger, for vertex shader constants)
    private vsUniformBuffer: GPUBuffer | null = null;
    private vsUniformBufferSize: number = 0;
    private vsUniformData: Float32Array | null = null;

    private bindUniforms(
        renderPass: GPURenderPassEncoder,
        pipelineId: number,
        uniforms: UniformData,
        textureView: GPUTextureView | null
    ): void {
        const device = this.backend.getDevice()!;
        const queue = this.backend.getQueue()!;

        const isVsPath = uniforms.vsConstants && uniforms.vsConstantCount && uniforms.vsConstantCount > 0;
        let activeBuffer: GPUBuffer;

        if (isVsPath) {
            // VS path: viewport (vec2) + pad (vec2) + N vec4 constants
            const constCount = uniforms.vsConstantCount!;
            const bufferFloats = 4 + constCount * 4; // viewport+pad + constants
            const bufferBytes = bufferFloats * 4;

            // Ensure buffer is large enough
            if (!this.vsUniformBuffer || this.vsUniformBufferSize < bufferBytes) {
                this.vsUniformBuffer?.destroy();
                this.vsUniformBuffer = device.createBuffer({
                    size: bufferBytes,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                this.vsUniformBufferSize = bufferBytes;
                this.vsUniformData = new Float32Array(bufferFloats);
                // Invalidate bind group cache since buffer changed
                this.bindGroupCache.clear();
            }

            const data = this.vsUniformData!;
            data[0] = uniforms.viewportWidth;
            data[1] = uniforms.viewportHeight;
            data[2] = 0;
            data[3] = 0;
            // Copy constant registers
            data.set(uniforms.vsConstants!.subarray(0, constCount * 4), 4);
            queue.writeBuffer(this.vsUniformBuffer, 0, data.buffer, 0, bufferBytes);
            activeBuffer = this.vsUniformBuffer;
        } else {
            // FFP path: the expanded uniform block (viewport + MVP + worldView + material/lights;
            // layout owned by d3d9/ffp-lighting.ts). NO TRANSPOSE needed — WebGPU's column-major
            // read of D3D row-major bytes effectively transposes, matching M * v in the shader.
            const block = uniforms.ffpBlock;
            if (block) {
                if (!this.uniformBuffer || this.uniformBufferSize < block.byteLength) {
                    this.uniformBuffer?.destroy();
                    this.uniformBuffer = device.createBuffer({
                        size: block.byteLength,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    this.uniformBufferSize = block.byteLength;
                    // Cached FFP bind groups reference the old buffer — drop them.
                    this.bindGroupCache.clear();
                }
                queue.writeBuffer(this.uniformBuffer, 0, block);
            } else {
                // Defensive fallback: viewport (vec2) + pad (vec2) + mat4x4 MVP only.
                if (!this.uniformBuffer) {
                    this.uniformBuffer = device.createBuffer({
                        size: 80,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    this.uniformBufferSize = 80;
                }
                this.uniformData[0] = uniforms.viewportWidth;
                this.uniformData[1] = uniforms.viewportHeight;
                this.uniformData[2] = 0;
                this.uniformData[3] = 0;
                this.uniformData.set(uniforms.mvp, 4);
                queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer);
            }
            activeBuffer = this.uniformBuffer;
        }

        // Create cache key for bind group
        const info = this.pipelineInfo[pipelineId];
        const bufferKey = isVsPath ? 'vs' : 'ffp';
        const cacheKey = `${pipelineId}-${bufferKey}`;

        // Check cache first — texture view identity must match (same pipeline + different
        // bound texture would otherwise reuse a stale bind group).
        const cached = this.bindGroupCache.get(cacheKey);
        let bindGroup: GPUBindGroup;
        if (cached && cached.textureView === textureView) {
            bindGroup = cached.bindGroup;
            this.metrics.bindGroupCacheHits++;
        } else {
            // Build bind group
            const pipeline = this.pipelines[pipelineId];
            const layout = pipeline.getBindGroupLayout(0);
            const entries: GPUBindGroupEntry[] = [
                { binding: 0, resource: { buffer: activeBuffer } }
            ];

            if (info?.hasTexture) {
                const texture = textureView ?? this.getFallbackTextureView();
                for (let stage = 0; stage < 4; stage++) {
                    entries.push({ binding: 1 + stage * 2, resource: this.getSampler() });
                    entries.push({ binding: 2 + stage * 2, resource: stage === 0 ? texture : this.getFallbackTextureView() });
                }
            }

            bindGroup = device.createBindGroup({ layout, entries });
            this.bindGroupCache.set(cacheKey, { bindGroup, textureView });
        }

        this.setBindGroup0(renderPass, bindGroup);
    }

    /**
     * Build and bind the programmable bind group for one draw: per-draw VS/PS
     * constant blocks (written into the frame arenas) plus bound textures.
     */
    private bindProgrammable(
        renderPass: GPURenderPassEncoder,
        queue: GPUQueue,
        ds: ProgrammableDrawState,
    ): void {
        // Per-draw: bump constants into arenas unless this exact bank version/length
        // was already written in this frame. Dynamic offsets are frame-local because
        // UniformArena.begin() rewinds each execute() call.
        const vsOff = this.writeProgrammableConstants(this.vsArena!, queue, ds.vsConst, ds.vsLen, ds.vsVersion, true);
        const psOff = this.writeProgrammableConstants(this.psArena!, queue, ds.psConst, ds.psLen, ds.psVersion, false);

        const sampler = ds.sampler ?? this.getSampler();
        const bindGroup = this.acquireProgBindGroup(sampler, ds.textures, ds.cubeMask);

        this.setBindGroup0(renderPass, bindGroup, vsOff, psOff);
    }

    private bindFixedFunction(
        renderPass: GPURenderPassEncoder,
        _queue: GPUQueue,
        pipelineId: number,
        state: FixedFunctionDrawState,
    ): void {
        const device = this.backend.getDevice()!;
        const resource = this.ensureFixedStateResource(device, state);

        const info = this.pipelineInfo[pipelineId];
        const samplers = state.samplers.map(s => s ?? this.getSampler());
        const resourcesMatch = resource.textures.every((texture, i) => texture === state.textures[i]) &&
            resource.samplers.every((sampler, i) => sampler === samplers[i]);
        if (!resource.bindGroup || resource.pipelineId !== pipelineId ||
            !resourcesMatch) {
            const entries: GPUBindGroupEntry[] = [
                { binding: 0, resource: { buffer: resource.buffer } },
            ];
            if (info?.hasTexture) {
                for (let stage = 0; stage < 4; stage++) {
                    entries.push({ binding: 1 + stage * 2, resource: samplers[stage] });
                    entries.push({ binding: 2 + stage * 2, resource: state.textures[stage] ?? this.getFallbackTextureView() });
                }
            }
            resource.bindGroup = device.createBindGroup({
                layout: this.pipelines[pipelineId].getBindGroupLayout(0),
                entries,
            });
            resource.pipelineId = pipelineId;
            for (let stage = 0; stage < 4; stage++) {
                resource.textures[stage] = state.textures[stage];
                resource.samplers[stage] = samplers[stage];
            }
        } else {
            this.metrics.bindGroupCacheHits++;
        }
        this.setBindGroup0(renderPass, resource.bindGroup);
    }

    /** Ensure the persistent destination buffer + bind-group cache record for one pooled
     * fixed-function draw-state slot. RenderFrame reuses these state objects every frame,
     * so the resource reaches a true allocation-free steady state. */
    private ensureFixedStateResource(device: GPUDevice, state: FixedFunctionDrawState) {
        const byteSize = Math.max(16, state.uniformLen * 4);
        let resource = this.fixedStateResources.get(state);
        if (!resource || resource.size < byteSize) {
            resource?.buffer.destroy();
            const buffer = device.createBuffer({
                label: "d3d9-ffp-draw-uniforms",
                size: byteSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            resource = {
                buffer,
                size: byteSize,
                pipelineId: -1,
                textures: [null, null, null, null],
                samplers: [this.getSampler(), this.getSampler(), this.getSampler(), this.getSampler()],
                bindGroup: null as unknown as GPUBindGroup,
            };
            this.fixedStateResources.set(state, resource);
        }
        return resource;
    }

    /** Upload every fixed-function uniform block through one mapped staging allocation.
     * copyBufferToBuffer requires 4-byte-aligned offsets/sizes, naturally satisfied by the
     * Float32 blocks. The staging buffer is destroyed after queue.submit via the frame's
     * existing temporary-buffer lifetime. */
    private stageFixedFunctionUniforms(
        device: GPUDevice,
        encoder: GPUCommandEncoder,
        frame: RenderFrame,
    ): void {
        const count = frame.fixedStateCount;
        if (count <= 0) return;

        let totalBytes = 0;
        for (let i = 0; i < count; i++) {
            totalBytes += Math.max(16, frame.fixedStates[i].uniformLen * 4);
        }
        if (totalBytes <= 0) return;

        const required = alignUp(totalBytes, 4);
        if (!this.fixedStagingBuffer || this.fixedStagingSize < required) {
            this.fixedStagingBuffer?.destroy();
            this.fixedStagingSize = nextPowerOfTwo(required);
            this.fixedStagingBuffer = device.createBuffer({
                label: "d3d9-ffp-frame-staging",
                size: this.fixedStagingSize,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });
            this.fixedStagingData = new Uint8Array(this.fixedStagingSize);
        }
        const mapped = this.fixedStagingData;
        let offset = 0;
        for (let i = 0; i < count; i++) {
            const state = frame.fixedStates[i];
            const byteSize = Math.max(16, state.uniformLen * 4);
            const source = new Uint8Array(
                state.uniforms.buffer,
                state.uniforms.byteOffset,
                state.uniformLen * 4,
            );
            mapped.set(source, offset);
            // The remaining bytes (only possible for an empty block) stay zero-initialized.
            offset += byteSize;
        }
        this.backend.getQueue()!.writeBuffer(this.fixedStagingBuffer, 0, mapped.buffer, 0, required);

        offset = 0;
        for (let i = 0; i < count; i++) {
            const state = frame.fixedStates[i];
            const byteSize = Math.max(16, state.uniformLen * 4);
            const resource = this.ensureFixedStateResource(device, state);
            encoder.copyBufferToBuffer(this.fixedStagingBuffer, offset, resource.buffer, 0, byteSize);
            offset += byteSize;
        }
    }

    /** Upload all deferred vertex/index data through one mapped staging buffer.
     *
     * BFME records roughly one dynamic geometry upload for every draw. Chromium's
     * queue.writeBuffer path serialises each call and was costing another ~35 ms per
     * frame. A single mapped allocation followed by encoder copies preserves the
     * original ordering (including repeated writes to the same destination) while
     * reducing the JavaScript/WebGPU crossing to one operation per submission. */
    private stageQueuedUploads(
        device: GPUDevice,
        encoder: GPUCommandEncoder,
        frame: RenderFrame,
    ): void {
        const count = frame.uploadBuffers.length;
        if (count <= 0) return;

        let totalBytes = 0;
        for (let i = 0; i < count; i++) {
            totalBytes += alignUp(frame.uploadData[i].byteLength, 4);
        }
        if (totalBytes <= 0) return;

        if (!this.geometryStagingBuffer || this.geometryStagingSize < totalBytes) {
            this.geometryStagingBuffer?.destroy();
            this.geometryStagingSize = nextPowerOfTwo(totalBytes);
            this.geometryStagingBuffer = device.createBuffer({
                label: "d3d9-geometry-frame-staging",
                size: this.geometryStagingSize,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });
            this.geometryStagingData = new Uint8Array(this.geometryStagingSize);
        }
        const mapped = this.geometryStagingData;
        let offset = 0;
        for (let i = 0; i < count; i++) {
            const data = frame.uploadData[i];
            mapped.set(data, offset);
            offset += alignUp(data.byteLength, 4);
        }
        this.backend.getQueue()!.writeBuffer(this.geometryStagingBuffer, 0, mapped.buffer, 0, totalBytes);

        offset = 0;
        for (let i = 0; i < count; i++) {
            const byteLength = frame.uploadData[i].byteLength;
            if (byteLength > 0) {
                // WebGPU requires copy sizes to be multiples of four. D3D vertex and
                // index uploads are naturally aligned, but round defensively and rely
                // on the zero-filled staging padding for the final bytes.
                encoder.copyBufferToBuffer(
                    this.geometryStagingBuffer,
                    offset,
                    frame.uploadBuffers[i],
                    frame.uploadOffsets[i] ?? 0,
                    alignUp(byteLength, 4),
                );
            }
            offset += alignUp(byteLength, 4);
        }
    }

    private resetRenderPassBindCache(): void {
        this.lastBoundBindGroup = null;
        this.lastBindOffset0 = -1;
        this.lastBindOffset1 = -1;
    }

    private setBindGroup0(
        renderPass: GPURenderPassEncoder,
        bindGroup: GPUBindGroup,
        offset0 = -1,
        offset1 = -1,
    ): void {
        if (
            this.lastBoundBindGroup === bindGroup &&
            this.lastBindOffset0 === offset0 &&
            this.lastBindOffset1 === offset1
        ) {
            this.metrics.bindGroupSetSkips++;
            return;
        }

        if (offset0 >= 0) {
            this.dynOffsets[0] = offset0;
            this.dynOffsets[1] = offset1;
            renderPass.setBindGroup(0, bindGroup, this.dynOffsets);
        } else {
            renderPass.setBindGroup(0, bindGroup);
        }
        this.lastBoundBindGroup = bindGroup;
        this.lastBindOffset0 = offset0;
        this.lastBindOffset1 = offset1;
        this.metrics.bindGroupSets++;
    }

    private resetProgConstOffsetCache(): void {
        this.progVsConstCount = 0;
        this.progVsConstCursor = 0;
        this.progPsConstCount = 0;
        this.progPsConstCursor = 0;
    }

    private findProgConstOffset(version: number, floatLen: number, vertex: boolean): number {
        const versions = vertex ? this.progVsConstVersion : this.progPsConstVersion;
        const lens = vertex ? this.progVsConstLen : this.progPsConstLen;
        const offsets = vertex ? this.progVsConstOffset : this.progPsConstOffset;
        const count = vertex ? this.progVsConstCount : this.progPsConstCount;
        for (let i = 0; i < count; i++) {
            if (versions[i] === version && lens[i] === floatLen) {
                return offsets[i]!;
            }
        }
        return -1;
    }

    private rememberProgConstOffset(version: number, floatLen: number, offset: number, vertex: boolean): void {
        const versions = vertex ? this.progVsConstVersion : this.progPsConstVersion;
        const lens = vertex ? this.progVsConstLen : this.progPsConstLen;
        const offsets = vertex ? this.progVsConstOffset : this.progPsConstOffset;

        let slot: number;
        if (vertex) {
            slot = this.progVsConstCount < PROG_CONST_CACHE_N
                ? this.progVsConstCount++
                : (this.progVsConstCursor = (this.progVsConstCursor + 1) % PROG_CONST_CACHE_N);
        } else {
            slot = this.progPsConstCount < PROG_CONST_CACHE_N
                ? this.progPsConstCount++
                : (this.progPsConstCursor = (this.progPsConstCursor + 1) % PROG_CONST_CACHE_N);
        }

        versions[slot] = version;
        lens[slot] = floatLen;
        offsets[slot] = offset;
    }

    private writeProgrammableConstants(
        arena: UniformArena,
        queue: GPUQueue,
        data: Float32Array,
        floatLen: number,
        version: number | undefined,
        vertex: boolean,
    ): number {
        if (version !== undefined) {
            const cached = this.findProgConstOffset(version, floatLen, vertex);
            if (cached >= 0) {
                this.metrics.progConstReuseHits++;
                return cached;
            }
        }

        const offset = arena.write(queue, data, floatLen);
        this.metrics.progConstWrites++;
        if (version !== undefined) {
            this.rememberProgConstOffset(version, floatLen, offset, vertex);
        }
        return offset;
    }

    /**
     * Get-or-build the programmable bind group for a material (sampler + bound
     * texture views). Direct object-identity compare against a small ring of cached
     * slots — zero-alloc on a hit, and correct-by-construction (the cached group
     * binds the exact view objects; a recreated texture yields a new view → miss →
     * rebuild). The VS/PS uniform bindings use the fixed *_BIND_SIZE window at
     * offset 0; the per-draw offset is supplied as a dynamic offset by the caller.
     */
    private acquireProgBindGroup(sampler: GPUSampler, textures: (GPUTextureView | null)[], cubeMask: number = 0): GPUBindGroup {
        const MAX = PROG_BIND.MAX_TEX;
        for (let s = 0; s < this.progCacheLen; s++) {
            if (this.progCacheSampler[s] !== sampler || this.progCacheCubeMask[s] !== cubeMask) continue;
            const base = s * MAX;
            let match = true;
            for (let n = 0; n < MAX; n++) {
                if (this.progCacheViews[base + n] !== (textures[n] ?? null)) { match = false; break; }
            }
            if (match) { this.metrics.bindGroupCacheHits++; return this.progCacheGroup[s]; }
        }

        // Miss → build a new bind group and insert it (append, then round-robin evict). The
        // layout (and per-stage fallback dimension) is selected by cubeMask so the group stays
        // compatible with the cube-aware pipeline layout.
        const device = this.backend.getDevice()!;
        const { bindGroupLayout } = this.getProgrammableLayout(cubeMask);
        const fallback2d = this.getFallbackTextureView();
        const fallbackCube = cubeMask ? this.getFallbackCubeView() : fallback2d;
        const entries: GPUBindGroupEntry[] = [
            { binding: PROG_BIND.VS_UNIFORM, resource: { buffer: this.vsArena!.buffer!, offset: 0, size: VS_BIND_SIZE } },
            { binding: PROG_BIND.PS_UNIFORM, resource: { buffer: this.psArena!.buffer!, offset: 0, size: PS_BIND_SIZE } },
            { binding: PROG_BIND.SAMPLER, resource: sampler },
        ];
        for (let n = 0; n < MAX; n++) {
            const fallback = ((cubeMask >> n) & 1) ? fallbackCube : fallback2d;
            entries.push({ binding: PROG_BIND.TEX_BASE + n, resource: textures[n] ?? fallback });
        }
        const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries });

        const slot = this.progCacheLen < PROG_CACHE_N
            ? this.progCacheLen++
            : (this.progCacheCursor = (this.progCacheCursor + 1) % PROG_CACHE_N);
        this.progCacheSampler[slot] = sampler;
        this.progCacheCubeMask[slot] = cubeMask;
        const base = slot * MAX;
        for (let n = 0; n < MAX; n++) this.progCacheViews[base + n] = textures[n] ?? null;
        this.progCacheGroup[slot] = bindGroup;
        return bindGroup;
    }

    /** Fallback sampler for draws without resolved per-draw sampler state (e.g. the non-programmable
     *  path). Uses the faithful D3D9 default: linear filtering + WRAP addressing (NOT WebGPU's
     *  clamp-to-edge default). Per-draw programmable samplers come from the device (see ds.sampler). */
    private getSampler(): GPUSampler {
        if (!this.sampler) {
            this.sampler = this.backend.getDevice()!.createSampler({
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "repeat",
                addressModeV: "repeat",
                addressModeW: "repeat",
            });
        }
        return this.sampler;
    }

    private getFallbackTextureView(): GPUTextureView {
        if (!this.fallbackTexture) {
            const device = this.backend.getDevice()!;
            this.fallbackTexture = device.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.fallbackTextureView = this.fallbackTexture.createView();
            this.backend.getQueue()!.writeTexture(
                { texture: this.fallbackTexture },
                new Uint8Array([255, 255, 255, 255]),
                { bytesPerRow: 4 },
                { width: 1, height: 1, depthOrArrayLayers: 1 }
            );
        }
        return this.fallbackTextureView!;
    }

    /** 1×1×6 white cube for cube-sampler stages with no bound texture (keeps the bind group
     *  valid against a cube-dimension layout slot). */
    private getFallbackCubeView(): GPUTextureView {
        if (!this.fallbackCubeView) {
            const device = this.backend.getDevice()!;
            this.fallbackCubeTexture = device.createTexture({
                size: { width: 1, height: 1, depthOrArrayLayers: 6 },
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            const white = new Uint8Array([255, 255, 255, 255]);
            for (let face = 0; face < 6; face++) {
                this.backend.getQueue()!.writeTexture(
                    { texture: this.fallbackCubeTexture, origin: { x: 0, y: 0, z: face } },
                    white,
                    { bytesPerRow: 4 },
                    { width: 1, height: 1, depthOrArrayLayers: 1 }
                );
            }
            this.fallbackCubeView = this.fallbackCubeTexture.createView({ dimension: "cube", arrayLayerCount: 6 });
        }
        return this.fallbackCubeView;
    }
}

function transposeMatrix(m: Float32Array): Float32Array {
    return m; // Unused, just cleanup
}
