/**
 * D3D9CommandRecorder - Records draw commands into a RenderFrame
 *
 * Separated from D3D9Device to enable command batching,
 * multi-threading preparation, and cleaner separation of concerns.
 */

import { d3d9PerfBackendInc } from "../../../modules/d3d9/d3d9-perf";
import { RenderFrame, RenderFramePool } from "../render-frame";

/** Extra vertex-stream binding (multi-stream D3D8 declarations): slot = stream number. */
export interface StreamVertexBinding {
    slot: number;
    buffer: GPUBuffer;
    offset: number;
    size: number;
}

export interface DrawCommand {
    pipelineId: number;
    gpuBuffer: GPUBuffer;
    bufferOffset: number;
    bufferSize: number;
    vertexCount: number;
    startVertex: number;
    /** Programmable (VS/PS) per-draw state index, or undefined for FFP. */
    bindStateIndex?: number;
    /** Fixed-function per-draw state index, or undefined for programmable draws. */
    fixedStateIndex?: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

export interface DrawIndexedCommand {
    pipelineId: number;
    vbGpuBuffer: GPUBuffer;
    vbOffset: number;
    vbSize: number;
    ibGpuBuffer: GPUBuffer;
    ibFormat: "uint16" | "uint32";
    indexCount: number;
    startIndex: number;
    baseVertex: number;
    bindStateIndex?: number;
    fixedStateIndex?: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

export class D3D9CommandRecorder {
    private frame: RenderFrame;
    private currentPipelineId: number | null = null;
    /** Last-emitted BindProgrammable state index (Phase C elision). Consecutive draws that
     *  captured the identical state share one slot (see D3D9Device.captureDrawState) — the
     *  redundant re-bind command is skipped. Reset on pipeline change (bind-group layout may
     *  differ per pipeline) and at finalize (executor bind caches reset per pass/frame). */
    private currentBindStateIndex: number | null = null;
    private currentFixedStateIndex: number | null = null;
    // Slot-0 vertex buffer and index buffer last set in this frame: consecutive
    // draws from one buffer (the UP arena, a mesh drawn in pieces) re-set them
    // otherwise, and each set is a WebGPU call at execute.
    private lastVb: GPUBuffer | null = null;
    private lastVbOffset = -1;
    private lastVbSize = -1;
    private lastIb: GPUBuffer | null = null;
    private lastIbFormat: string | null = null;
    private setVertexBuffer0(buffer: GPUBuffer, offset: number, size: number): void {
        if (this.lastVb === buffer && this.lastVbOffset === offset && this.lastVbSize === size) { d3d9PerfBackendInc("vbSetSkipped"); return; }
        this.frame.pushSetVertexBuffer(buffer, offset, size);
        this.lastVb = buffer; this.lastVbOffset = offset; this.lastVbSize = size;
    }
    /** A new render pass starts with no buffers bound: forget what was set. */
    private forgetBoundBuffers(): void {
        this.lastVb = null; this.lastVbOffset = -1; this.lastVbSize = -1;
        this.lastIb = null; this.lastIbFormat = null;
    }
    private setIndexBuffer(buffer: GPUBuffer, format: "uint16" | "uint32"): void {
        if (this.lastIb === buffer && this.lastIbFormat === format) { d3d9PerfBackendInc("ibSetSkipped"); return; }
        this.frame.pushSetIndexBuffer(buffer, format);
        this.lastIb = buffer; this.lastIbFormat = format;
    }
    private currentStencilReference: number | null = null;
    private drawCount = 0;

    constructor(private framePool: RenderFramePool) {
        this.frame = framePool.acquire();
    }

    /**
     * Set clear color for the frame
     */
    setClear(color: GPUColor, depth: number, stencil: number, flags: number): void {
        this.frame.setClear(color, depth, stencil, flags);
    }

    setStencilReference(reference: number): void {
        reference >>>= 0;
        if (reference === this.currentStencilReference) return;
        this.frame.pushSetStencilReference(reference);
        this.currentStencilReference = reference;
    }

    /**
     * Queue a buffer upload for the current frame
     */
    queueUpload(buffer: GPUBuffer, data: Uint8Array, destinationOffset = 0): void {
        this.frame.queueUpload(buffer, data, destinationOffset);
    }

    /** Queue a range whose backing store outlives the frame (a buffer's shadow copy). */
    queueUploadRef(buffer: GPUBuffer, data: Uint8Array, destinationOffset = 0): void {
        this.frame.queueUploadRef(buffer, data, destinationOffset);
    }

    /**
     * Record a non-indexed draw call
     */
    recordDraw(cmd: DrawCommand): void {
        if (this.currentPipelineId !== cmd.pipelineId) {
            this.frame.pushSetPipeline(cmd.pipelineId);
            this.currentPipelineId = cmd.pipelineId;
            this.currentBindStateIndex = null;
            this.currentFixedStateIndex = null;
        }

        if (cmd.bindStateIndex !== undefined && cmd.bindStateIndex !== this.currentBindStateIndex) {
            this.frame.pushBindProgrammable(cmd.bindStateIndex);
            this.currentBindStateIndex = cmd.bindStateIndex;
        }
        if (cmd.fixedStateIndex !== undefined && cmd.fixedStateIndex !== this.currentFixedStateIndex) {
            this.frame.pushBindFixedFunction(cmd.fixedStateIndex);
            this.currentFixedStateIndex = cmd.fixedStateIndex;
        }
        this.setVertexBuffer0(cmd.gpuBuffer, cmd.bufferOffset, cmd.bufferSize);
        if (cmd.extraStreams) {
            for (const s of cmd.extraStreams) {
                this.frame.pushSetVertexBuffer(s.buffer, s.offset, s.size, s.slot);
            }
        }
        this.frame.pushDraw(cmd.vertexCount, cmd.startVertex);
        this.drawCount++;
    }

    /**
     * Record an indexed draw call
     */
    recordDrawIndexed(cmd: DrawIndexedCommand): void {
        if (this.currentPipelineId !== cmd.pipelineId) {
            this.frame.pushSetPipeline(cmd.pipelineId);
            this.currentPipelineId = cmd.pipelineId;
            this.currentBindStateIndex = null;
            this.currentFixedStateIndex = null;
        }

        if (cmd.bindStateIndex !== undefined && cmd.bindStateIndex !== this.currentBindStateIndex) {
            this.frame.pushBindProgrammable(cmd.bindStateIndex);
            this.currentBindStateIndex = cmd.bindStateIndex;
        }
        if (cmd.fixedStateIndex !== undefined && cmd.fixedStateIndex !== this.currentFixedStateIndex) {
            this.frame.pushBindFixedFunction(cmd.fixedStateIndex);
            this.currentFixedStateIndex = cmd.fixedStateIndex;
        }
        this.setVertexBuffer0(cmd.vbGpuBuffer, cmd.vbOffset, cmd.vbSize);
        if (cmd.extraStreams) {
            for (const s of cmd.extraStreams) {
                this.frame.pushSetVertexBuffer(s.buffer, s.offset, s.size, s.slot);
            }
        }
        this.setIndexBuffer(cmd.ibGpuBuffer, cmd.ibFormat);
        this.frame.pushDrawIndexed(cmd.indexCount, cmd.startIndex, cmd.baseVertex);
        this.drawCount++;
    }

    /**
     * Finalize the current frame and prepare for the next one
     */
    finalize(): RenderFrame {
        const completedFrame = this.frame;
        this.frame = this.framePool.acquire();
        this.currentPipelineId = null;
        this.currentBindStateIndex = null;
        this.currentFixedStateIndex = null;
        this.currentStencilReference = null;
        this.forgetBoundBuffers();
        return completedFrame;
    }

    /**
     * Check if the current frame has any work to do
     */
    hasWork(): boolean {
        return this.frame.hasWork();
    }

    registerTemporaryBuffer(buffer: GPUBuffer): void {
        this.frame.registerTemporaryBuffer(buffer);
    }

    registerPooledBuffer(buffer: GPUBuffer): void {
        this.frame.registerPooledBuffer(buffer);
    }

    /**
     * Get the number of draw calls recorded in the current frame
     */
    getDrawCount(): number {
        return this.drawCount;
    }

    /**
     * Reset draw count (call after present)
     */
    resetDrawCount(): void {
        this.drawCount = 0;
    }

    /**
     * Get the current frame for direct manipulation (advanced use)
     */
    getCurrentFrame(): RenderFrame {
        return this.frame;
    }
}
