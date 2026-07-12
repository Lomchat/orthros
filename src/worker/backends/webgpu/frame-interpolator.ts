/**
 * Frame Interpolator — phase-blended present for fixed-rate guests (present mode "blend", C).
 *
 * A guest that renders at a sub-refresh rate (D2 ~25 fps on a 60 Hz display) cannot be shown
 * cleanly: 25 fps = 2.4 vsyncs, so each frame is held an irregular 2 or 3 vsyncs → pulldown
 * judder. Raising the guest's rate is impossible (classic D2 couples render rate to game speed).
 *
 * This module presents at the display's FULL refresh by crossfading the two most-recent guest
 * frames by sub-frame phase:
 *   - snapshot() copies each presented guest frame into a 2-deep history ring + timestamps it.
 *   - present() emits, every vsync, mix(prevFrame, newFrame, phase) where
 *       phase = clamp((now - arrivalOfNewFrame) / guestFrameInterval, 0, 1).
 * Motion is integrated as a smooth ramp instead of stepping 2↔3 vsyncs. Cost: ~one guest frame
 * of latency (the crossfade trails the newest frame) and slight motion softening — the accepted
 * trade for fixed-rate content on a mismatched refresh, and exactly what high-end emulators expose.
 *
 * Self-contained: owns a copy pipeline (any-format srcView → rgba8unorm history) and a blend
 * pipeline (2× rgba8unorm history → swapchain format). Gated entirely behind blend mode — when
 * disabled nothing here runs, so the default present path is untouched.
 */

import { Logger, LogCategory } from "../../core/logger";

export class FrameInterpolator {
    private device: GPUDevice;
    private queue: GPUQueue;
    private swapFormat: GPUTextureFormat;

    private copyPipeline: GPURenderPipeline | null = null;   // srcView → rgba8unorm history
    private blendPipeline: GPURenderPipeline | null = null;  // (histA, histB, phase) → swapchain
    private sampler: GPUSampler | null = null;
    private vertexBuffer: GPUBuffer | null = null;
    private phaseBuffer: GPUBuffer | null = null;            // 16 bytes: [phase, _, _, _]

    // 2-deep history ring. newIdx is the slot holding the newest snapshot.
    private histTex: Array<GPUTexture | null> = [null, null];
    private histView: Array<GPUTextureView | null> = [null, null];
    private newIdx = 0;
    private width = 0;
    private height = 0;
    private frames = 0;          // total snapshots taken (0/1 = not enough to blend)

    private arrivalMs = 0;       // wall-clock of the newest snapshot
    private intervalEma = 42;    // EMA of the guest's inter-frame interval (ms)

    // Cache: blend bind group is stable while the two history views are stable.
    private blendBindGroup: GPUBindGroup | null = null;
    private copyBindGroupCache = new WeakMap<GPUTextureView, GPUBindGroup>();

    constructor(device: GPUDevice, queue: GPUQueue, swapFormat: GPUTextureFormat) {
        this.device = device;
        this.queue = queue;
        this.swapFormat = swapFormat;
    }

    /** True once at least two frames have been captured (blend possible). */
    hasFrame(): boolean {
        return this.frames >= 1 && this.histView[this.newIdx] != null;
    }

    /**
     * Capture the just-presented guest frame (srcView, any sampleable rgba/bgra format) into the
     * next history slot and timestamp it. Owns its own encoder + submit (cheap fullscreen blit).
     */
    snapshot(srcView: GPUTextureView, width: number, height: number, nowMs: number): void {
        if (width <= 0 || height <= 0) return;
        this.ensurePipelines();
        if (width !== this.width || height !== this.height) {
            this.allocHistory(width, height);
        }
        if (!this.copyPipeline || !this.sampler) return;

        const dst = (this.newIdx ^ 1);   // write into the slot that currently holds the oldest
        const dstView = this.histView[dst];
        if (!dstView) return;

        let bindGroup = this.copyBindGroupCache.get(srcView);
        if (!bindGroup) {
            bindGroup = this.device.createBindGroup({
                layout: this.copyPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: srcView },
                ],
            });
            this.copyBindGroupCache.set(srcView, bindGroup);
        }

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: dstView, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
        });
        pass.setPipeline(this.copyPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer!);
        pass.draw(6, 1, 0, 0);
        pass.end();
        this.queue.submit([encoder.finish()]);

        // Advance the ring: the freshly written slot becomes the newest.
        this.newIdx = dst;
        this.blendBindGroup = null;  // history views rotated → rebuild blend bind group

        if (this.frames > 0 && this.arrivalMs > 0) {
            const dt = nowMs - this.arrivalMs;
            if (dt > 2 && dt < 200) this.intervalEma = this.intervalEma * 0.8 + dt * 0.2;
        }
        this.arrivalMs = nowMs;
        this.frames++;
    }

    /**
     * Record the interpolated present into `encoder`, drawing to `targetView` (the swapchain).
     * Blends the two newest snapshots by sub-frame phase; falls back to the single newest frame
     * until two have been captured.
     */
    present(targetView: GPUTextureView, encoder: GPUCommandEncoder, nowMs: number, clearColor?: GPUColor): void {
        if (!this.hasFrame() || !this.blendPipeline || !this.sampler) return;

        const newView = this.histView[this.newIdx]!;
        const oldView = this.histView[this.newIdx ^ 1] ?? newView; // before 2nd frame: blend with self

        const phase = this.frames >= 2
            ? Math.max(0, Math.min(1, (nowMs - this.arrivalMs) / Math.max(1, this.intervalEma)))
            : 1;
        this.queue.writeBuffer(this.phaseBuffer!, 0, new Float32Array([phase, 0, 0, 0]));

        if (!this.blendBindGroup) {
            this.blendBindGroup = this.device.createBindGroup({
                layout: this.blendPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: oldView },
                    { binding: 2, resource: newView },
                    { binding: 3, resource: { buffer: this.phaseBuffer! } },
                ],
            });
        }

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetView,
                ...(clearColor
                    ? { loadOp: "clear" as const, clearValue: clearColor, storeOp: "store" as const }
                    : { loadOp: "load" as const, storeOp: "store" as const }),
            }],
        });
        pass.setPipeline(this.blendPipeline);
        pass.setBindGroup(0, this.blendBindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer!);
        pass.draw(6, 1, 0, 0);
        pass.end();
    }

    reset(): void {
        this.frames = 0;
        this.arrivalMs = 0;
        this.newIdx = 0;
        this.blendBindGroup = null;
    }

    destroy(): void {
        for (let i = 0; i < 2; i++) {
            this.histTex[i]?.destroy();
            this.histTex[i] = null;
            this.histView[i] = null;
        }
        this.width = 0;
        this.height = 0;
        this.reset();
    }

    private allocHistory(width: number, height: number): void {
        for (let i = 0; i < 2; i++) {
            this.histTex[i]?.destroy();
            this.histTex[i] = this.device.createTexture({
                size: [width, height],
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.histView[i] = this.histTex[i]!.createView();
        }
        this.width = width;
        this.height = height;
        this.frames = 0;            // sizes changed → old history invalid
        this.blendBindGroup = null;
        this.copyBindGroupCache = new WeakMap();
        Logger.log(LogCategory.SYSTEM, `[FrameInterp] history allocated ${width}x${height}`);
    }

    private ensurePipelines(): void {
        if (this.copyPipeline && this.blendPipeline) return;
        if (!this.sampler) {
            this.sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
        }
        if (!this.vertexBuffer) {
            const verts = new Float32Array([
                -1, -1, 0, 1,   1, -1, 1, 1,   1, 1, 1, 0,
                -1, -1, 0, 1,   1,  1, 1, 0,  -1, 1, 0, 0,
            ]);
            this.vertexBuffer = this.device.createBuffer({
                size: verts.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.queue.writeBuffer(this.vertexBuffer, 0, verts);
        }
        if (!this.phaseBuffer) {
            this.phaseBuffer = this.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }

        const vsAttrs: GPUVertexBufferLayout = {
            arrayStride: 16,
            attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x2" },
                { shaderLocation: 1, offset: 8, format: "float32x2" },
            ],
        };

        if (!this.copyPipeline) {
            const copyShader = this.device.createShaderModule({
                code: `
                struct VO { @builtin(position) position: vec4f, @location(0) uv: vec2f }
                @vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VO {
                    var o: VO; o.position = vec4f(pos, 0.0, 1.0); o.uv = uv; return o;
                }
                @group(0) @binding(0) var s: sampler;
                @group(0) @binding(1) var t: texture_2d<f32>;
                @fragment fn fs(i: VO) -> @location(0) vec4f { return textureSample(t, s, i.uv); }
                `,
            });
            this.copyPipeline = this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module: copyShader, entryPoint: "vs", buffers: [vsAttrs] },
                fragment: { module: copyShader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
                primitive: { topology: "triangle-list" },
            });
        }

        if (!this.blendPipeline) {
            const blendShader = this.device.createShaderModule({
                code: `
                struct VO { @builtin(position) position: vec4f, @location(0) uv: vec2f }
                @vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VO {
                    var o: VO; o.position = vec4f(pos, 0.0, 1.0); o.uv = uv; return o;
                }
                @group(0) @binding(0) var s: sampler;
                @group(0) @binding(1) var texOld: texture_2d<f32>;
                @group(0) @binding(2) var texNew: texture_2d<f32>;
                struct Phase { v: vec4f }
                @group(0) @binding(3) var<uniform> phase: Phase;
                @fragment fn fs(i: VO) -> @location(0) vec4f {
                    let a = textureSample(texOld, s, i.uv);
                    let b = textureSample(texNew, s, i.uv);
                    return mix(a, b, phase.v.x);
                }
                `,
            });
            this.blendPipeline = this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module: blendShader, entryPoint: "vs", buffers: [vsAttrs] },
                fragment: { module: blendShader, entryPoint: "fs", targets: [{ format: this.swapFormat }] },
                primitive: { topology: "triangle-list" },
            });
        }
    }
}
