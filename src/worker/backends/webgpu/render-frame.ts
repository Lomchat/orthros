import { PROG_BIND } from "./d3d9/shader";

export const enum RenderCommandType {
    SetPipeline = 1,
    SetVertexBuffer = 2,
    Draw = 3,
    SetIndexBuffer = 4,
    DrawIndexed = 5,
    BindProgrammable = 6,
    BindFixedFunction = 7,
    SetStencilReference = 9,
}

export type RenderClear = {
    color: GPUColor;
    depth: number;
    stencil: number;
    flags: number;
};

/**
 * Per-draw uniform + texture snapshot for the programmable (VS/PS) path.
 * Captured at draw-record time so each draw replays with its own constants and
 * bound textures, rather than a single frame-wide snapshot.
 */
export interface ProgrammableDrawState {
    /** Reused VS constant scratch (grows on demand); only the first `vsLen` floats are valid. */
    vsConst: Float32Array;
    /** Uint32 view over vsConst for bit-exact copy/hash without per-draw view allocation. */
    vsBits: Uint32Array;
    vsLen: number;
    /** Frame-local content key for the valid prefix. Undefined means "not cacheable". */
    vsVersion?: number;
    /** Reused PS constant scratch (grows on demand); only the first `psLen` floats are valid. */
    psConst: Float32Array;
    /** Uint32 view over psConst for bit-exact copy/hash without per-draw view allocation. */
    psBits: Uint32Array;
    psLen: number;
    /** Frame-local content key for the valid prefix. Undefined means "not cacheable". */
    psVersion?: number;
    /** Bound texture views per stage (length PROG_BIND.MAX_TEX; null → fallback). Reused in place. */
    textures: (GPUTextureView | null)[];
    /** Resolved GPU sampler for the shared programmable sampler binding.
     *  null → executor falls back to its default. */
    sampler: GPUSampler | null;
    /** Bitmask of cube-sampler stages for this draw (matches the pipeline's bind-group layout). */
    cubeMask: number;
}

/** Per-draw fixed-function snapshot. D3D9 applications routinely change their
 * texture, sampler, matrices and lighting between draws in one BeginScene/Present.
 * Keeping these frame-wide makes every draw replay with the final state. */
export interface FixedFunctionDrawState {
    uniforms: Float32Array;
    uniformLen: number;
    textures: (GPUTextureView | null)[];
    samplers: (GPUSampler | null)[];
}

export class RenderFrame {
    hasClear = false;
    clear: RenderClear = { color: { r: 0, g: 0, b: 0, a: 1 }, depth: 1.0, stencil: 0, flags: 0 };

    commandTypes: number[] = [];
    commandA: number[] = [];
    commandB: number[] = [];
    commandC: number[] = [];
    /** Vertex-buffer slot for SetVertexBuffer commands (= D3D stream number); 0 otherwise. */
    commandD: number[] = [];

    bufferRefs: GPUBuffer[] = [];
    uploadBuffers: GPUBuffer[] = [];
    uploadData: Uint8Array[] = [];
    /** Destination byte offset paired with each deferred buffer upload. */
    uploadOffsets: number[] = [];
    temporaryBuffers: GPUBuffer[] = [];
    /** Buffers acquired from a reuse pool (DrawPrimitiveUP vertex data). Unlike
     *  temporaryBuffers, these are NOT destroyed at frame end — the owner returns
     *  them to its pool after submit (see D3D9Device.submitFrame). */
    pooledBuffers: GPUBuffer[] = [];
    /** Pooled programmable draw-state slots. Length is the high-water mark; the
     *  live count for THIS frame is `drawStateCount`. Slots persist across frames
     *  so steady-state capture allocates nothing (see nextDrawState). */
    drawStates: ProgrammableDrawState[] = [];
    drawStateCount = 0;
    fixedStates: FixedFunctionDrawState[] = [];
    fixedStateCount = 0;

    reset(): void {
        this.hasClear = false;
        this.commandTypes.length = 0;
        this.commandA.length = 0;
        this.commandB.length = 0;
        this.commandC.length = 0;
        this.commandD.length = 0;
        this.bufferRefs.length = 0;
        this.uploadBuffers.length = 0;
        this.uploadData.length = 0;
        this.uploadOffsets.length = 0;
        this.temporaryBuffers.length = 0;
        this.pooledBuffers.length = 0;
        // Rewind the draw-state pool without dropping the slots (keeps their
        // constant scratch + texture arrays for reuse). Stale texture refs in
        // slots beyond drawStateCount are overwritten on reuse by nextDrawState's filler.
        this.drawStateCount = 0;
        this.fixedStateCount = 0;
    }

    setClear(color: GPUColor, depth: number, stencil: number, flags: number): void {
        this.clear.color = color;
        this.clear.depth = depth;
        this.clear.stencil = stencil;
        this.clear.flags = flags;
        this.hasClear = true;
    }

    pushSetStencilReference(reference: number): void {
        this.commandTypes.push(RenderCommandType.SetStencilReference);
        this.commandA.push(reference >>> 0);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    pushSetPipeline(pipelineId: number): void {
        this.commandTypes.push(RenderCommandType.SetPipeline);
        this.commandA.push(pipelineId);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    pushSetVertexBuffer(buffer: GPUBuffer, offset: number, size: number, slot = 0): void {
        const index = this.bufferRefs.length;
        this.bufferRefs.push(buffer);
        this.commandTypes.push(RenderCommandType.SetVertexBuffer);
        this.commandA.push(index);
        this.commandB.push(offset);
        this.commandC.push(size);
        this.commandD.push(slot);
    }

    pushDraw(vertexCount: number, startVertex: number): void {
        this.commandTypes.push(RenderCommandType.Draw);
        this.commandA.push(vertexCount);
        this.commandB.push(startVertex);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    pushSetIndexBuffer(buffer: GPUBuffer, format: "uint16" | "uint32"): void {
        const index = this.bufferRefs.length;
        this.bufferRefs.push(buffer);
        this.commandTypes.push(RenderCommandType.SetIndexBuffer);
        this.commandA.push(index);
        this.commandB.push(format === "uint16" ? 16 : 32);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    pushDrawIndexed(indexCount: number, startIndex: number, baseVertex: number): void {
        this.commandTypes.push(RenderCommandType.DrawIndexed);
        this.commandA.push(indexCount);
        this.commandB.push(startIndex);
        this.commandC.push(baseVertex);
        this.commandD.push(0);
    }

    /**
     * Acquire a pooled programmable draw-state slot, sized for `vsLen`/`psLen`
     * floats of constants. Slots persist across frames (reset() only rewinds the
     * count), so steady-state capture does zero per-draw allocation: the constant
     * scratch buffers grow on demand and the texture array is reused in place.
     * The caller fills the returned slot; its frame-local index is `drawStateCount`
     * read BEFORE this call (or drawStateCount-1 after).
     */
    nextDrawState(vsLen: number, psLen: number): ProgrammableDrawState {
        let s = this.drawStates[this.drawStateCount];
        if (!s) {
            const vsConst = new Float32Array(Math.max(4, vsLen));
            const psConst = new Float32Array(Math.max(4, psLen));
            s = {
                vsConst,
                vsBits: new Uint32Array(vsConst.buffer),
                vsLen: 0,
                vsVersion: undefined,
                psConst,
                psBits: new Uint32Array(psConst.buffer),
                psLen: 0,
                psVersion: undefined,
                textures: new Array(PROG_BIND.MAX_TEX).fill(null),
                sampler: null,
                cubeMask: 0,
            };
            this.drawStates[this.drawStateCount] = s;
        }
        if (s.vsConst.length < vsLen) {
            s.vsConst = new Float32Array(vsLen);
            s.vsBits = new Uint32Array(s.vsConst.buffer);
        }
        if (s.psConst.length < psLen) {
            s.psConst = new Float32Array(psLen);
            s.psBits = new Uint32Array(s.psConst.buffer);
        }
        s.vsLen = vsLen;
        s.psLen = psLen;
        s.vsVersion = undefined;
        s.psVersion = undefined;
        this.drawStateCount++;
        return s;
    }

    /** Undo the most recent nextDrawState() (identical-consecutive-state elision,
     *  wasm-resident-d3d-command-path Phase C). The slot stays pooled and is handed
     *  out again on the next capture — the earlier, still-referenced slots are untouched. */
    rollbackDrawState(): void {
        if (this.drawStateCount > 0) this.drawStateCount--;
    }

    pushBindProgrammable(stateIndex: number): void {
        this.commandTypes.push(RenderCommandType.BindProgrammable);
        this.commandA.push(stateIndex);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    nextFixedState(uniformLen: number): FixedFunctionDrawState {
        let s = this.fixedStates[this.fixedStateCount];
        if (!s) {
            s = {
                uniforms: new Float32Array(uniformLen),
                uniformLen,
                textures: [null, null, null, null],
                samplers: [null, null, null, null],
            };
            this.fixedStates[this.fixedStateCount] = s;
        } else if (s.uniforms.length < uniformLen) {
            s.uniforms = new Float32Array(uniformLen);
        }
        s.uniformLen = uniformLen;
        this.fixedStateCount++;
        return s;
    }

    pushBindFixedFunction(stateIndex: number): void {
        this.commandTypes.push(RenderCommandType.BindFixedFunction);
        this.commandA.push(stateIndex);
        this.commandB.push(0);
        this.commandC.push(0);
        this.commandD.push(0);
    }

    queueUpload(buffer: GPUBuffer, data: Uint8Array, destinationOffset = 0): void {
        this.uploadBuffers.push(buffer);
        this.uploadOffsets.push(destinationOffset >>> 0);
        // IMPORTANT: Make a copy! The source data may be a view into a shared
        // conversion buffer that gets overwritten by subsequent DrawPrimitiveUP calls.
        this.uploadData.push(new Uint8Array(data));
    }

    registerTemporaryBuffer(buffer: GPUBuffer): void {
        this.temporaryBuffers.push(buffer);
    }

    /** Track a pooled buffer for post-submit reclaim (returned to the pool, not destroyed). */
    registerPooledBuffer(buffer: GPUBuffer): void {
        this.pooledBuffers.push(buffer);
    }

    releaseTemporaryBuffers(): void {
        for (const buffer of this.temporaryBuffers) {
            buffer.destroy();
        }
        this.temporaryBuffers.length = 0;
    }

    hasWork(): boolean {
        return this.hasClear || this.commandTypes.length > 0 || this.uploadBuffers.length > 0;
    }
}

export class RenderFramePool {
    private frames: RenderFrame[] = [];
    private nextIndex = 0;

    constructor(size: number = 2) {
        for (let i = 0; i < size; i++) {
            this.frames.push(new RenderFrame());
        }
    }

    acquire(): RenderFrame {
        const frame = this.frames[this.nextIndex];
        this.nextIndex = (this.nextIndex + 1) % this.frames.length;
        frame.reset();
        return frame;
    }
}
