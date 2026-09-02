/**
 * D3D9StateTracker - Manages render state, transforms, and stream bindings
 *
 * Separated from D3D9Device to follow single-responsibility principle
 * and enable cleaner state management.
 */

const D3DRS_LIGHTING = 137;
const D3DRS_CULLMODE = 22;
const D3DRS_ZENABLE = 7;
const D3DRS_ZWRITEENABLE = 14;
const D3DCULL_NONE = 1;

const D3DTS_WORLD = 0x100;

/** Render states the fixed-function uniform block reads (SPECULARENABLE,
 *  TEXTUREFACTOR, COLORVERTEX, LIGHTING, AMBIENT, LOCALVIEWER, the four
 *  *MATERIALSOURCE, CLIPPLANEENABLE). Any other render state feeds the
 *  pipeline key, not the block, so it must not invalidate the block. */
const FFP_BLOCK_RENDER_STATES = new Uint8Array(256);
for (const rs of [29, 60, 134, 137, 139, 142, 145, 146, 147, 148, 152]) FFP_BLOCK_RENDER_STATES[rs] = 1;
const D3DTS_VIEW = 2;
const D3DTS_PROJECTION = 3;
const D3DTS_TEXTURE0 = 16;

export interface StreamSource {
    index: number;
    offset: number;
    stride: number;
}

export interface DirtyFlags {
    renderStates: boolean;
    transforms: boolean;
    fvf: boolean;
    streams: boolean;
    textures: boolean;
}

export class D3D9StateTracker {
    // Render states
    private renderStates: Int32Array = new Int32Array(256);

    // Transforms
    private worldMatrix: Float32Array;
    private viewMatrix: Float32Array;
    private projMatrix: Float32Array;
    private readonly worldViewCache = new Float32Array(16);
    private readonly mvpCache = new Float32Array(16);
    private worldViewDirty = true;
    private mvpDirty = true;
    private textureMatrices: Float32Array[];

    // FVF and stream bindings
    private fvf: number = 0;
    private streamSource: StreamSource | null = null;
    private indexSource: number | null = null;

    // Texture stages
    private textureStages: (number | null)[] = new Array(8).fill(null);

    // Dirty tracking
    private dirtyFlags: DirtyFlags = {
        renderStates: true,
        transforms: true,
        fvf: true,
        streams: true,
        textures: true,
    };

    // Cached pipeline key
    private pipelineKey: number | null = null;
    /** Bumped by every setter that changes state: a draw whose version
     *  matches the last fixed-function block's reuses that block. */
    version = 0;
    /** Bumped only by a world-matrix change: a draw whose other versions
     *  match patches the matrices of the last block instead of rebuilding. */
    worldVersion = 0;
    private pipelineKeyDirty = true;

    // Performance metrics
    public metrics = {
        pipelineChanges: 0,
        bindGroupChanges: 0,
        stateUpdates: 0,
        textureChanges: 0,
        transformUpdates: 0,
    };

    constructor() {
        this.worldMatrix = identityMatrix();
        this.viewMatrix = identityMatrix();
        this.projMatrix = identityMatrix();
        this.textureMatrices = Array.from({ length: 8 }, () => identityMatrix());
        this.seedRenderStateDefaults();
    }

    /**
     * Seed the non-zero D3D9 default render states the blend/lighting pipelines depend on.
     * The render-state array is zero-filled, but several defaults are non-zero (notably
     * COLORWRITEENABLE = all channels, and the FFP material-colour sources). None of the
     * seeded states are part of the FFP pipeline key (cull/z/lighting), so the key is
     * unaffected; the lighting *enable* default is intentionally left at 0 (games set it
     * explicitly — same choice as the D3D8 adapter) to avoid darkening titles that draw
     * pre-coloured FFP geometry without ever touching lighting state.
     */
    private seedRenderStateDefaults(): void {
        const D3DBLEND_ONE = 2, D3DBLEND_ZERO = 1, D3DBLENDOP_ADD = 1, ALL_CHANNELS = 0xf;
        this.renderStates[19] = D3DBLEND_ONE;    // D3DRS_SRCBLEND
        this.renderStates[20] = D3DBLEND_ZERO;   // D3DRS_DESTBLEND
        this.renderStates[171] = D3DBLENDOP_ADD; // D3DRS_BLENDOP
        this.renderStates[207] = D3DBLEND_ONE;   // D3DRS_SRCBLENDALPHA
        this.renderStates[208] = D3DBLEND_ZERO;  // D3DRS_DESTBLENDALPHA
        this.renderStates[209] = D3DBLENDOP_ADD; // D3DRS_BLENDOPALPHA
        this.renderStates[168] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE
        this.renderStates[190] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE1
        this.renderStates[191] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE2
        this.renderStates[192] = ALL_CHANNELS;   // D3DRS_COLORWRITEENABLE3
        this.renderStates[53] = 1;          // D3DRS_STENCILFAIL = KEEP
        this.renderStates[54] = 1;          // D3DRS_STENCILZFAIL = KEEP
        this.renderStates[55] = 1;          // D3DRS_STENCILPASS = KEEP
        this.renderStates[56] = 8;          // D3DRS_STENCILFUNC = ALWAYS
        this.renderStates[58] = 0xffffffff; // D3DRS_STENCILMASK
        this.renderStates[59] = 0xffffffff; // D3DRS_STENCILWRITEMASK
        this.renderStates[186] = 1;         // D3DRS_CCW_STENCILFAIL = KEEP
        this.renderStates[187] = 1;         // D3DRS_CCW_STENCILZFAIL = KEEP
        this.renderStates[188] = 1;         // D3DRS_CCW_STENCILPASS = KEEP
        this.renderStates[189] = 8;         // D3DRS_CCW_STENCILFUNC = ALWAYS
        // FFP lighting defaults (D3DMCS_*: MATERIAL=0, COLOR1=1, COLOR2=2). These let
        // unset values reflect the real D3D defaults so an explicit MATERIAL (0) is
        // distinguishable from "never set".
        this.renderStates[134] = 1;  // D3DRS_COLORVERTEX        = TRUE
        this.renderStates[142] = 1;  // D3DRS_LOCALVIEWER        = TRUE
        this.renderStates[145] = 1;  // D3DRS_DIFFUSEMATERIALSOURCE  = D3DMCS_COLOR1
        this.renderStates[146] = 2;  // D3DRS_SPECULARMATERIALSOURCE = D3DMCS_COLOR2
        // D3DRS_AMBIENTMATERIALSOURCE (147) / EMISSIVEMATERIALSOURCE (148) default to MATERIAL = 0.
        // Point-sprite size render states are FLOATS bit-cast into the DWORD. Seed the D3D
        // defaults so an explicit 0.0f (points suppressed / no lower clamp) is distinguishable
        // from "never set" — the point-sprite path reads these directly via rsFloat.
        this.renderStates[154] = 0x3F800000; // D3DRS_POINTSIZE     = 1.0f
        this.renderStates[155] = 0x3F800000; // D3DRS_POINTSIZE_MIN = 1.0f
        this.renderStates[166] = 0x46000000; // D3DRS_POINTSIZE_MAX = 8192.0f (advertised MaxPointSize)
    }

    // Render state management
    setRenderState(state: number, value: number): boolean {
        if (state < 0 || state >= this.renderStates.length) return false;
        if (this.renderStates[state] === value) return false;
        this.renderStates[state] = value;
        this.dirtyFlags.renderStates = true;
        this.pipelineKeyDirty = true;
        this.metrics.stateUpdates++;
        if (FFP_BLOCK_RENDER_STATES[state] === 1) this.version++;
        return true;
    }

    getRenderState(state: number): number {
        return this.renderStates[state] ?? 0;
    }

    // Transform management
    setTransform(type: number, matrix: Float32Array): boolean {
        let target: Float32Array;
        if (type === D3DTS_WORLD) {
            target = this.worldMatrix;
        } else if (type === D3DTS_VIEW) {
            target = this.viewMatrix;
        } else if (type === D3DTS_PROJECTION) {
            target = this.projMatrix;
        } else if (type >= D3DTS_TEXTURE0 && type < D3DTS_TEXTURE0 + 8) {
            target = this.textureMatrices[type - D3DTS_TEXTURE0];
        } else {
            return false;
        }
        for (let i = 0; i < 16; i++) {
            if (target[i] !== matrix[i]) break;
            if (i === 15) return false;
        }
        for (let i = 0; i < 16; i++) target[i] = matrix[i]!;
        this.dirtyFlags.transforms = true;
        this.metrics.transformUpdates++;
        if (type === D3DTS_WORLD) this.worldVersion++; else this.version++;
        if (type === D3DTS_WORLD || type === D3DTS_VIEW) this.worldViewDirty = true;
        if (type === D3DTS_WORLD || type === D3DTS_VIEW || type === D3DTS_PROJECTION) this.mvpDirty = true;
        return true;
    }

    getWorldMatrix(): Float32Array { return this.worldMatrix; }
    getViewMatrix(): Float32Array { return this.viewMatrix; }
    getProjectionMatrix(): Float32Array { return this.projMatrix; }
    getTextureMatrix(stage: number): Float32Array {
        return this.textureMatrices[stage] ?? this.textureMatrices[0];
    }

    /** world × view × projection. Returns an internal buffer, recomputed only after a
     *  transform change: callers copy it out, they never keep or mutate it. */
    getMVP(): Float32Array {
        if (this.mvpDirty) {
            multiplyMatricesInto(this.mvpCache, this.getWorldView(), this.projMatrix);
            this.mvpDirty = false;
        }
        return this.mvpCache;
    }

    /** world × view — eye/view-space transform used by FFP lighting for pos + normal.
     *  Same contract as getMVP(): an internal, read-only buffer. */
    getWorldView(): Float32Array {
        if (this.worldViewDirty) {
            multiplyMatricesInto(this.worldViewCache, this.worldMatrix, this.viewMatrix);
            this.worldViewDirty = false;
        }
        return this.worldViewCache;
    }

    // FVF management
    setFVF(fvf: number): boolean {
        if (this.fvf === fvf) return false;
        this.fvf = fvf;
        this.dirtyFlags.fvf = true;
        this.pipelineKeyDirty = true;
        this.version++;
        return true;
    }

    getFVF(): number { return this.fvf; }

    // Stream source management
    setStreamSource(index: number, offset: number, stride: number): boolean {
        const cur = this.streamSource;
        if (cur && cur.index === index && cur.offset === offset && cur.stride === stride) return false;
        this.streamSource = { index, offset, stride };
        this.dirtyFlags.streams = true;
        return true;
    }

    getStreamSource(): StreamSource | null { return this.streamSource; }

    clearStreamSource(): boolean {
        if (this.streamSource === null) return false;
        this.streamSource = null;
        this.dirtyFlags.streams = true;
        return true;
    }

    // Index source management
    setIndexSource(index: number | null): boolean {
        if (this.indexSource === index) return false;
        this.indexSource = index;
        this.dirtyFlags.streams = true;
        return true;
    }

    getIndexSource(): number | null { return this.indexSource; }

    // Texture stage management
    setTexture(stage: number, textureIndex: number | null): boolean {
        if (stage < 0 || stage >= this.textureStages.length) return false;
        const previous = this.textureStages[stage];
        if (previous === textureIndex) return false;
        this.textureStages[stage] = textureIndex;
        this.dirtyFlags.textures = true;
        this.metrics.textureChanges++;
        // The block only knows whether a stage has a texture; which one is a
        // bind-group matter. Binding a different texture must not rebuild it.
        if ((previous === null) !== (textureIndex === null)) this.version++;
        return true;
    }

    getTexture(stage: number): number | null {
        return this.textureStages[stage] ?? null;
    }

    // Pipeline key computation
    computePipelineKey(): number {
        if (!this.pipelineKeyDirty && this.pipelineKey !== null) {
            return this.pipelineKey;
        }

        const cullMode = this.renderStates[D3DRS_CULLMODE] ?? D3DCULL_NONE;
        const lighting = this.renderStates[D3DRS_LIGHTING] ?? 0;
        const zEnable = this.renderStates[D3DRS_ZENABLE] ?? 1; // Default to true in D3D
        const zWrite = this.renderStates[D3DRS_ZWRITEENABLE] ?? 1; // Default to true in D3D
        
        const lightingBit = lighting !== 0 ? 1 : 0;
        const zEnableBit = zEnable !== 0 ? 1 : 0;
        const zWriteBit = zWrite !== 0 ? 1 : 0;
        const fvfBits = this.fvf & 0xffff;

        // Key structure:
        // bits 0-15: FVF
        // bits 16-23: CullMode
        // bit 24: Lighting
        // bit 25: ZEnable
        // bit 26: ZWrite
        this.pipelineKey = (
            fvfBits | 
            ((cullMode & 0xff) << 16) | 
            (lightingBit << 24) | 
            (zEnableBit << 25) | 
            (zWriteBit << 26)
        ) >>> 0;
        
        this.pipelineKeyDirty = false;
        return this.pipelineKey;
    }

    // Dirty flag management
    isDirty(flag: keyof DirtyFlags): boolean {
        return this.dirtyFlags[flag];
    }

    clearDirty(flag: keyof DirtyFlags): void {
        this.dirtyFlags[flag] = false;
    }

    clearAllDirty(): void {
        this.dirtyFlags.renderStates = false;
        this.dirtyFlags.transforms = false;
        this.dirtyFlags.fvf = false;
        this.dirtyFlags.streams = false;
        this.dirtyFlags.textures = false;
    }

    // Reset state to defaults
    reset(): void {
        this.renderStates.fill(0);
        this.seedRenderStateDefaults();
        this.worldMatrix = identityMatrix();
        this.viewMatrix = identityMatrix();
        this.projMatrix = identityMatrix();
        this.worldViewDirty = true;
        this.mvpDirty = true;
        this.fvf = 0;
        this.streamSource = null;
        this.indexSource = null;
        this.textureStages.fill(null);
        this.pipelineKey = null;
        this.pipelineKeyDirty = true;
        this.clearAllDirty();
        this.resetMetrics();
    }

    // Performance metrics
    resetMetrics(): void {
        this.metrics.pipelineChanges = 0;
        this.metrics.bindGroupChanges = 0;
        this.metrics.stateUpdates = 0;
        this.metrics.textureChanges = 0;
        this.metrics.transformUpdates = 0;
    }

    getMetrics(): typeof this.metrics {
        return { ...this.metrics };
    }
}

// Matrix utilities
function identityMatrix(): Float32Array {
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);
}

function multiplyMatricesInto(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            out[row * 4 + col] =
                a[row * 4 + 0] * b[0 * 4 + col] +
                a[row * 4 + 1] * b[1 * 4 + col] +
                a[row * 4 + 2] * b[2 * 4 + col] +
                a[row * 4 + 3] * b[3 * 4 + col];
        }
    }
    return out;
}
