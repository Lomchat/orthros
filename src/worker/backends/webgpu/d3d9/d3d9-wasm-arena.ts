/**
 * D3D9WasmArena — JS-side zero-copy wrapper over the Rust-resident D3D9 state mirror +
 * command arena (vendor/v86/src/rust/cpu/d3d9_arena.rs).
 *
 * Mirrors the exact pattern PreemptionManager/HypercallDataManager use for
 * HYPERCALL_PAGE: a plain WASM static, exposed via an exported pointer-getter, read
 * through typed-array views built once at boot and refreshed if WASM memory grows.
 *
 * IMPORTANT: byte offsets are NEVER hardcoded here — they're read at boot from
 * get_d3d9_arena_layout_ptr() (see d3d9_arena.rs's LAYOUT_TABLE, the single source of
 * truth). This is deliberate: a hand-duplicated-offset mismatch between Rust and JS is
 * exactly the bug class the layout table exists to prevent.
 *
 * Scope: the
 * PROGRAMMABLE (VS+PS-bound) draw path only. Setters are plain data writes (no WASM
 * call); draws call one exported Rust function that derives pipeline/bind-group keys
 * and appends to the command SoA. FFP draws are declined by the Rust side (returns -1)
 * — callers must fall back to the legacy TS path for those.
 */

// Layout-table indices — ORDER must match d3d9_arena.rs's LAYOUT_TABLE exactly (the
// table is the contract; these indices just name its slots for readability).
const enum LayoutIdx {
    RenderStates = 0,
    SamplerStage0 = 1,
    StreamSource = 2,
    IndexBuffer = 3,
    VsHandle = 4,
    PsHandle = 5,
    DeclHandle = 6,
    Fvf = 7,
    TextureBoundIds = 8,
    TextureCubeFlags = 9,
    ShaderConstLenVs = 10,
    ShaderConstLenPs = 11,
    VsConstants = 12,
    PsConstants = 13,
    VsConstVersion = 14,
    PsConstVersion = 15,
    CmdTypes = 16,
    CmdA = 17,
    CmdB = 18,
    CmdC = 19,
    PipelineKey = 20,
    BindGroupKey = 21,
    CommandCount = 22,
    BumpArena = 23,
    BumpCursor = 24,
    CommandsEmitted = 25,
    ArenaHighWater = 26,
    OverflowCount = 27,
    FfpFallbackCount = 28,
    MismatchCount = 29,
    CmdCap = 30,
    ArenaSize = 31,
    // State-block slots — see arena.rs's slot layout comment.
    BlockSlots = 32,
    BlockSlotSize = 33,
    BlockSlotCount = 34,
    BlockChanged = 35,
    BlockChangedCap = 36,
    SlotMaskRs = 37,       // intra-slot offsets from here down
    SlotMaskSamp = 38,
    SlotVsRanges = 39,
    SlotPsRanges = 40,
    SlotRsValues = 41,
    SlotSampValues = 42,
    SlotConstPool = 43,
}

const LAYOUT_LEN = 44;

// RenderCommandType — must match render-frame.ts's RenderCommandType for 1-6; 7-8 are
// arena-only additions for UP draws (see d3d9_arena.rs's CMD_DRAW_UP/CMD_DRAW_INDEXED_UP
// doc comment for the payload-shape rationale).
export const enum ArenaCommandType {
    SetPipeline = 1,
    SetVertexBuffer = 2,
    Draw = 3,
    SetIndexBuffer = 4,
    DrawIndexed = 5,
    BindProgrammable = 6,
    DrawUP = 7,
    DrawIndexedUP = 8,
}

export interface ArenaStats {
    commandsEmitted: number;
    commandCount: number;
    arenaHighWaterMark: number;
    bumpHighWaterMark: number;
    overflowCount: number;
    ffpFallbackCount: number;
    mismatchCount: number;
}

class D3D9WasmArena {
    private wasmExports: any = null;
    private wasmMemoryObj: any = null;
    private wasmMemory: ArrayBuffer | null = null;
    private base = 0;
    private initialized = false;

    // Typed views, rebuilt on init and on buffer-grow (refresh()).
    private renderStates!: Int32Array;
    private samplerStage0!: Int32Array;
    private streamSource!: Uint32Array; // [bufferId, offset, stride]
    private indexBuffer!: Uint32Array; // [bufferId, format]
    private handles!: Uint32Array; // [vsHandle, psHandle, declHandle, fvf]
    private textureBoundIds!: Uint32Array; // [8]
    private textureCubeFlags!: Uint8Array; // [4096]
    private shaderConstLenVs!: Uint16Array; // [1024]
    private shaderConstLenPs!: Uint16Array; // [1024]
    private vsConstants!: Float32Array;
    private psConstants!: Float32Array;
    private constVersions!: Uint32Array; // [vsConstVersion, psConstVersion]
    private commandTypes!: Uint32Array;
    private commandA!: Uint32Array;
    private commandB!: Uint32Array;
    private commandC!: Uint32Array;
    private pipelineKeys!: Uint32Array;
    private bindGroupKeys!: Uint32Array;
    private commandCountView!: Uint32Array; // [commandCount] — single word
    // [commandsEmitted, arenaHighWaterMark, overflowCount, ffpFallbackCount, mismatchCount]
    // NOTE: NOT contiguous with commandCountView — the 16MB bump arena sits between them
    // in the Rust layout (OFF_COMMAND_COUNT precedes the bump arena; these 5 counters
    // come after it), so they need separate views.
    private counters!: Uint32Array;
    private bumpArenaBase = 0;
    private cmdCap = 0;

    // State-block slots. Slot allocation is managed HERE (JS) — the wasm side
    // only ever gets a slot index; freeSlots resets wholesale on device teardown.
    private blockSlotsBase = 0;
    private blockSlotSize = 0;
    private blockSlotCount = 0;
    private blockChangedCap = 0;
    private slotOff = { maskRs: 0, maskSamp: 0, vsRanges: 0, psRanges: 0, rsValues: 0, sampValues: 0, constPool: 0 };
    private blockChanged!: Uint32Array;
    private freeSlots: number[] = [];

    isInitialized(): boolean {
        return this.initialized;
    }

    initialize(cpu: any): void {
        this.wasmExports = cpu?.wm?.exports;
        if (!this.wasmExports?.get_d3d9_arena_ptr || !this.wasmExports?.get_d3d9_arena_layout_ptr) {
            return;
        }
        this.freeSlots = [];
        this.base = this.wasmExports.get_d3d9_arena_ptr();
        // cpu.wasm_memory IS cpu.wm.exports.memory (same stable WebAssembly.Memory object,
        // see cpu.js) — storing wasmExports.memory is enough; no need to keep `cpu` around.
        this.wasmMemoryObj = cpu?.wasm_memory ?? this.wasmExports?.memory;
        this.wasmMemory = this.wasmMemoryObj?.buffer ?? null;
        if (!this.wasmMemory) return;

        const layoutPtr = this.wasmExports.get_d3d9_arena_layout_ptr();
        const layout = new Uint32Array(this.wasmMemory, layoutPtr, LAYOUT_LEN);
        this.cmdCap = layout[LayoutIdx.CmdCap];
        this.buildViews(layout);
        for (let i = this.blockSlotCount - 1; i >= 0; i--) this.freeSlots.push(i);
        this.initialized = true;
    }

    /**
     * Rebuild every typed view if WASM memory has grown since the last check (growth
     * detaches the old ArrayBuffer — every existing typed-array view over it becomes
     * unusable, throwing on the next read/write, e.g. `set on a detached ArrayBuffer`).
     * `wasmMemoryObj` is the STABLE WebAssembly.Memory object — `.buffer` is what changes
     * on grow, so comparing it is enough to detect staleness. Called at the top of every
     * public method that touches a typed view (cheap: one object/reference comparison on
     * the hit path) — self-healing, no caller needs to remember to call this.
     */
    private ensureFresh(): void {
        if (!this.initialized) return;
        const buf = this.wasmMemoryObj?.buffer;
        if (buf && buf !== this.wasmMemory) {
            this.wasmMemory = buf;
            const layoutPtr = this.wasmExports.get_d3d9_arena_layout_ptr();
            const layout = new Uint32Array(buf, layoutPtr, LAYOUT_LEN);
            this.buildViews(layout);
        }
    }

    private buildViews(layout: Uint32Array): void {
        const buf = this.wasmMemory!;
        const b = this.base;
        const cap = this.cmdCap;
        this.renderStates = new Int32Array(buf, b + layout[LayoutIdx.RenderStates], 256);
        this.samplerStage0 = new Int32Array(buf, b + layout[LayoutIdx.SamplerStage0], 16);
        this.streamSource = new Uint32Array(buf, b + layout[LayoutIdx.StreamSource], 3);
        this.indexBuffer = new Uint32Array(buf, b + layout[LayoutIdx.IndexBuffer], 2);
        this.handles = new Uint32Array(buf, b + layout[LayoutIdx.VsHandle], 4); // vs,ps,decl,fvf are contiguous
        this.textureBoundIds = new Uint32Array(buf, b + layout[LayoutIdx.TextureBoundIds], 8);
        this.textureCubeFlags = new Uint8Array(buf, b + layout[LayoutIdx.TextureCubeFlags], 4096);
        this.shaderConstLenVs = new Uint16Array(buf, b + layout[LayoutIdx.ShaderConstLenVs], 1024);
        this.shaderConstLenPs = new Uint16Array(buf, b + layout[LayoutIdx.ShaderConstLenPs], 1024);
        this.vsConstants = new Float32Array(buf, b + layout[LayoutIdx.VsConstants], 256 * 4);
        this.psConstants = new Float32Array(buf, b + layout[LayoutIdx.PsConstants], 224 * 4);
        this.constVersions = new Uint32Array(buf, b + layout[LayoutIdx.VsConstVersion], 2);
        this.commandTypes = new Uint32Array(buf, b + layout[LayoutIdx.CmdTypes], cap);
        this.commandA = new Uint32Array(buf, b + layout[LayoutIdx.CmdA], cap);
        this.commandB = new Uint32Array(buf, b + layout[LayoutIdx.CmdB], cap);
        this.commandC = new Uint32Array(buf, b + layout[LayoutIdx.CmdC], cap);
        this.pipelineKeys = new Uint32Array(buf, b + layout[LayoutIdx.PipelineKey], cap);
        this.bindGroupKeys = new Uint32Array(buf, b + layout[LayoutIdx.BindGroupKey], cap);
        // commandCount sits right before the (16MB) bump arena; the other 5 counters
        // sit AFTER it — NOT contiguous with commandCount, so these are separate views.
        this.commandCountView = new Uint32Array(buf, b + layout[LayoutIdx.CommandCount], 1);
        this.counters = new Uint32Array(buf, b + layout[LayoutIdx.CommandsEmitted], 5);
        this.bumpArenaBase = layout[LayoutIdx.BumpArena];

        this.blockSlotsBase = layout[LayoutIdx.BlockSlots];
        this.blockSlotSize = layout[LayoutIdx.BlockSlotSize];
        this.blockSlotCount = layout[LayoutIdx.BlockSlotCount];
        this.blockChangedCap = layout[LayoutIdx.BlockChangedCap];
        this.slotOff = {
            maskRs: layout[LayoutIdx.SlotMaskRs],
            maskSamp: layout[LayoutIdx.SlotMaskSamp],
            vsRanges: layout[LayoutIdx.SlotVsRanges],
            psRanges: layout[LayoutIdx.SlotPsRanges],
            rsValues: layout[LayoutIdx.SlotRsValues],
            sampValues: layout[LayoutIdx.SlotSampValues],
            constPool: layout[LayoutIdx.SlotConstPool],
        };
        this.blockChanged = new Uint32Array(buf, b + layout[LayoutIdx.BlockChanged], this.blockChangedCap * 2);
    }

    // ---- Setters — plain writes into shared memory, no WASM call. ----

    setRenderState(state: number, value: number): void {
        this.ensureFresh();
        if (state >= 0 && state < 256) this.renderStates[state] = value;
    }

    /** Only stage 0 is mirrored (the programmable path resolves ONE shared sampler from
     *  stage 0 — see d3d9-backend-executor.ts resolveStageSampler(0)). Calls for other
     *  stages are silently dropped; they don't affect the programmable-path bind key. */
    setSamplerState(stage: number, type: number, value: number): void {
        this.ensureFresh();
        if (stage === 0 && type >= 0 && type < 16) this.samplerStage0[type] = value;
    }

    setStreamSource(bufferId: number, offset: number, stride: number): void {
        this.ensureFresh();
        this.streamSource[0] = bufferId >>> 0;
        this.streamSource[1] = offset >>> 0;
        this.streamSource[2] = stride >>> 0;
    }

    setIndices(bufferId: number, format: number): void {
        this.ensureFresh();
        this.indexBuffer[0] = bufferId >>> 0;
        this.indexBuffer[1] = format >>> 0;
    }

    setVertexShader(handle: number): void { this.ensureFresh(); this.handles[0] = handle >>> 0; }
    setPixelShader(handle: number): void { this.ensureFresh(); this.handles[1] = handle >>> 0; }
    setVertexDeclaration(handle: number): void { this.ensureFresh(); this.handles[2] = handle >>> 0; }
    setFvf(fvf: number): void { this.ensureFresh(); this.handles[3] = fvf >>> 0; }

    /** `textureId` is the internal numeric id the existing TS resource store already
     *  resolves a COM pointer to (NOT the raw guest COM pointer) — same id space
     *  bindGroupKey derivation dedupes on in the legacy path. */
    setTexture(stage: number, textureId: number): void {
        this.ensureFresh();
        if (stage >= 0 && stage < 8) this.textureBoundIds[stage] = textureId >>> 0;
    }

    /** Called once at CreateCubeTexture (low-frequency, not hot-path) so the Rust side
     *  can maintain cubeMask without knowing anything about GPUTexture objects. */
    markTextureCube(textureId: number, isCube: boolean): void {
        this.ensureFresh();
        if (textureId > 0 && textureId < 4096) this.textureCubeFlags[textureId] = isCube ? 1 : 0;
    }

    /** Called once at CreateVertexShader/CreatePixelShader (low-frequency) so draw-time
     *  constant capture knows how many floats to copy for this shader handle. */
    setShaderConstLen(isVertexShader: boolean, handle: number, floatCount: number): void {
        this.ensureFresh();
        const table = isVertexShader ? this.shaderConstLenVs : this.shaderConstLenPs;
        if (handle >= 0 && handle < 1024) table[handle % 1024] = Math.min(floatCount, 0xffff);
    }

    /** Writes `data` (float32 values) starting at register `startFloat` into the shared
     *  constant bank, and bumps the version counter — mirrors
     *  d3d9-device.ts's vsConstantsVersion/psConstantsVersion bump on real writes. */
    setVertexShaderConstantF(startFloat: number, data: Float32Array): void {
        this.ensureFresh();
        this.vsConstants.set(data, startFloat);
        this.constVersions[0] = (this.constVersions[0] + 1) >>> 0;
    }

    setPixelShaderConstantF(startFloat: number, data: Float32Array): void {
        this.ensureFresh();
        this.psConstants.set(data, startFloat);
        this.constVersions[1] = (this.constVersions[1] + 1) >>> 0;
    }

    // ---- Draws — call into the Rust key-derivation/SoA-emission function. ----

    /** Returns the derived pipelineKey (>=0), or -1 if declined (FFP draw, or arena
     *  full this frame — caller must fall back to the legacy TS path either way). */
    recordDraw(topology: number, vertexCount: number, startVertex: number, stride: number, forceCullNone: boolean): number {
        return this.wasmExports.d3d9_record_draw(topology, vertexCount >>> 0, startVertex >>> 0, stride >>> 0, forceCullNone ? 1 : 0);
    }

    recordDrawIndexed(topology: number, indexCount: number, startIndex: number, baseVertex: number, stride: number, forceCullNone: boolean): number {
        return this.wasmExports.d3d9_record_draw_indexed(topology, indexCount >>> 0, startIndex >>> 0, baseVertex >>> 0, stride >>> 0, forceCullNone ? 1 : 0);
    }

    /** `guestVertexPtr` must be the raw guest address — Rust copies `byteLen` bytes out
     *  immediately (capture-at-call), same timing guarantee as the legacy path. */
    recordDrawUP(topology: number, vertexCount: number, guestVertexPtr: number, stride: number, byteLen: number, forceCullNone: boolean): number {
        return this.wasmExports.d3d9_record_draw_up(topology, vertexCount >>> 0, guestVertexPtr | 0, stride >>> 0, byteLen >>> 0, forceCullNone ? 1 : 0);
    }

    recordDrawIndexedUP(
        topology: number, indexCount: number,
        guestIndexPtr: number, indexByteLen: number, indexIs16Bit: boolean,
        guestVertexPtr: number, stride: number, vertexByteLen: number,
        forceCullNone: boolean,
    ): number {
        return this.wasmExports.d3d9_record_draw_indexed_up(
            topology, indexCount >>> 0,
            guestIndexPtr | 0, indexByteLen >>> 0, indexIs16Bit ? 1 : 0,
            guestVertexPtr | 0, stride >>> 0, vertexByteLen >>> 0,
            forceCullNone ? 1 : 0,
        );
    }

    resetFrame(): void {
        this.wasmExports?.d3d9_reset_frame?.();
    }

    // ---- State-block slots ----

    /** Take a free block slot, or -1 when the pool is exhausted (caller falls back to
     *  the JS entry path — never an error). */
    allocBlockSlot(): number {
        if (!this.initialized) return -1;
        return this.freeSlots.pop() ?? -1;
    }

    releaseBlockSlot(slot: number): void {
        if (slot >= 0 && slot < this.blockSlotCount) this.freeSlots.push(slot);
    }

    /** Reset the whole pool (device teardown / resetD3D9SharedState — every block ptr
     *  is dropped wholesale there, so slot ownership resets with it). */
    resetBlockSlots(): void {
        this.freeSlots = [];
        for (let i = this.blockSlotCount - 1; i >= 0; i--) this.freeSlots.push(i);
    }

    /** Fresh typed views over one slot (creation-time only — not a hot path). */
    blockSlotViews(slot: number): {
        maskRs: Uint32Array; maskSamp: Uint32Array;
        vsRanges: Uint16Array; psRanges: Uint16Array;
        rsValues: Int32Array; sampValues: Int32Array; constPool: Float32Array;
    } {
        this.ensureFresh();
        const buf = this.wasmMemory!;
        const s = this.base + this.blockSlotsBase + slot * this.blockSlotSize;
        return {
            maskRs: new Uint32Array(buf, s + this.slotOff.maskRs, 8),
            maskSamp: new Uint32Array(buf, s + this.slotOff.maskSamp, 1),
            vsRanges: new Uint16Array(buf, s + this.slotOff.vsRanges, 8),
            psRanges: new Uint16Array(buf, s + this.slotOff.psRanges, 8),
            rsValues: new Int32Array(buf, s + this.slotOff.rsValues, 256),
            sampValues: new Int32Array(buf, s + this.slotOff.sampValues, 16),
            constPool: new Float32Array(buf, s + this.slotOff.constPool, 512),
        };
    }

    /** Refresh the slot's recorded values from the live mirror (Capture semantics). */
    blockCapture(slot: number): void {
        this.ensureFresh();
        this.wasmExports.d3d9_block_capture(slot >>> 0);
    }

    /** Diff slot vs mirror; returns the number of changed-list pairs (read via
     *  changedPairs()). The mirror is NOT written — the caller replays each delta
     *  through the ordinary device setters. */
    blockApply(slot: number): number {
        this.ensureFresh();
        return this.wasmExports.d3d9_block_apply(slot >>> 0) >>> 0;
    }

    /** The changed-list written by the last blockApply: [kind<<16|idx, value] pairs. */
    changedPairs(): Uint32Array {
        this.ensureFresh();
        return this.blockChanged;
    }

    // ---- Cross-check / observability ----

    incrementMismatchCount(): void {
        this.ensureFresh();
        this.counters[4] += 1; // [commandsEmitted, arenaHighWater, overflow, ffpFallback, mismatch]
    }

    stats(): ArenaStats {
        this.ensureFresh();
        return {
            commandCount: this.commandCountView[0],
            commandsEmitted: this.counters[0],
            arenaHighWaterMark: this.counters[1],
            bumpHighWaterMark: this.counters[1],
            overflowCount: this.counters[2],
            ffpFallbackCount: this.counters[3],
            mismatchCount: this.counters[4],
        };
    }

    // ---- Executor adapter access (read-only views over the command SoA) ----

    getCommandCount(): number { this.ensureFresh(); return this.commandCountView[0]; }
    getCommandTypes(): Uint32Array { this.ensureFresh(); return this.commandTypes; }
    getCommandA(): Uint32Array { this.ensureFresh(); return this.commandA; }
    getCommandB(): Uint32Array { this.ensureFresh(); return this.commandB; }
    getCommandC(): Uint32Array { this.ensureFresh(); return this.commandC; }
    getPipelineKeys(): Uint32Array { this.ensureFresh(); return this.pipelineKeys; }
    getBindGroupKeys(): Uint32Array { this.ensureFresh(); return this.bindGroupKeys; }

    /** Read `len` bytes back out of the bump arena at `offset` (for uploading captured
     *  UP vertex/index data). */
    readBumpBytes(offset: number, len: number): Uint8Array {
        this.ensureFresh();
        return new Uint8Array(this.wasmMemory!, this.base + this.bumpArenaBase + offset, len);
    }

    /**
     * Decode a draw-state slot captured by d3d9_arena.rs's capture_draw_state (referenced
     * by CMD_SET_PIPELINE's commandB and CMD_BIND_PROGRAMMABLE's commandA). The executor
     * needs this on a pipeline/bind-group cache MISS — pipelineKey/bindGroupKey are only
     * hashes, this is where the raw ingredients to actually build a GPURenderPipeline /
     * bind group (and this draw's VS/PS constants) live, captured at call time so a
     * mid-frame state change after this draw can't corrupt what a later miss reconstructs.
     * Layout MUST match d3d9_arena.rs's capture_draw_state doc comment exactly.
     */
    readDrawState(offset: number): {
        cubeMask: number;
        bindGroupKey: number;
        textureIds: Uint32Array;
        cullMode: number;
        zEnable: boolean;
        zWrite: boolean;
        topology: number;
        forceCullNone: boolean;
        blendKey: number;
        blendAlphaKey: number;
        alphaKey: number;
        declHandle: number;
        vsConstants: Float32Array;
        psConstants: Float32Array;
    } {
        this.ensureFresh();
        const buf = this.wasmMemory!;
        const base = this.base + this.bumpArenaBase + offset;
        const head = new DataView(buf, base, 64);
        const vsLen = head.getUint16(0, true);
        const psLen = head.getUint16(2, true);
        const renderBits0 = head.getUint32(44, true);
        return {
            cubeMask: head.getUint32(4, true),
            bindGroupKey: head.getUint32(8, true),
            textureIds: new Uint32Array(buf, base + 12, 8),
            cullMode: renderBits0 & 0xff,
            zEnable: ((renderBits0 >>> 8) & 1) !== 0,
            zWrite: ((renderBits0 >>> 9) & 1) !== 0,
            topology: (renderBits0 >>> 16) & 0xff,
            forceCullNone: ((renderBits0 >>> 24) & 1) !== 0,
            blendKey: head.getUint32(48, true),
            blendAlphaKey: head.getUint32(52, true),
            alphaKey: head.getUint32(56, true),
            declHandle: head.getUint32(60, true),
            vsConstants: new Float32Array(buf, base + 64, vsLen),
            psConstants: new Float32Array(buf, base + 64 + vsLen * 4, psLen),
        };
    }
}

export const d3d9WasmArena = new D3D9WasmArena();

// ---------------------------------------------------------------------------
// Dual-run kill switch.
// Default OFF: setters/draws always mirror into the arena (cheap, harmless), but
// this flag additionally gates the executor's verify-only arena-drain exercise
// (see D3D9BackendExecutor.drainArenaVerifyOnly). It does NOT enable real bypass
// rendering — flipping it never changes what's actually drawn to the screen.
// ---------------------------------------------------------------------------
let d3dWasmPathEnabled = false;

export function isWasmPathEnabled(): boolean {
    return d3dWasmPathEnabled;
}

export function setWasmPathEnabled(on: boolean): void {
    d3dWasmPathEnabled = on;
}

// Separate from d3dWasmPathEnabled on purpose: drainArenaVerifyOnly's job was validating the
// arena mechanism BEFORE real bypass existed (resolveProgrammablePipeline's arenaKey fast
// path). Now that real bypass is live, auto-running the verify-only drain on every bypass
// frame is pure overhead with no remaining purpose — it doesn't affect correctness (it never
// touched the encoder), it just taxes the exact perf number bypass mode is meant to improve.
// Default OFF; opt in via dbg.d3dArenaVerifyDrain(true) only when specifically diagnosing the
// arena's command-SoA decode path itself.
let arenaVerifyDrainEnabled = false;

export function isArenaVerifyDrainEnabled(): boolean {
    return arenaVerifyDrainEnabled;
}

export function setArenaVerifyDrainEnabled(on: boolean): void {
    arenaVerifyDrainEnabled = on;
}

// State-block arena slots. Default ON. Checked at block CREATION time only:
// flipping it off stops NEW blocks from taking slots (they fall back to the JS entry
// path); blocks that already own a slot keep using it — their slot values refresh on
// every Capture, so mid-run flips can't apply stale data. dbg.d3dWasmBlocks toggles.
let wasmBlocksEnabled = true;

export function isWasmBlocksEnabled(): boolean {
    return wasmBlocksEnabled;
}

export function setWasmBlocksEnabled(on: boolean): void {
    wasmBlocksEnabled = on;
}
