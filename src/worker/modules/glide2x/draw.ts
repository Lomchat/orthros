import { Mem } from "../../core/memory/mem-accessor";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { GlideContext } from "./context";
import { GR_CMP_ALWAYS, GR_VERTEX_SOW_OFFSET, GR_VERTEX_TOW_OFFSET } from "./constants";
import {
    blendIsOpaque,
    combineReferencesTexture,
    packBlend,
    packCombine,
} from "../../backends/webgpu/glide/glide-combine";

let vertexSampleBudget = 30;
// Second sampling wave: capture menu draws (post-intro, small textured quads)
let menuSampleBudget = 40;
let menuSamplesDoneForFrame = -1;

type DecodedVertex = {
    x: number;
    y: number;
    ooz: number;
    oow: number;
    r: number;
    g: number;
    b: number;
    a: number;
    sow: number;
    tow: number;
};

const floatBitsBuffer = new ArrayBuffer(4);
const floatBitsView = new DataView(floatBitsBuffer);
// Reinterpret a 32-bit register value as the IEEE-754 float the guest passed.
// Glide passes float args (e.g. grSplash x/y/w/h) by value on the stack; reading
// them as `| 0` integers yields garbage.
function dwordToFloat(value: number): number {
    floatBitsView.setUint32(0, value >>> 0, true);
    return floatBitsView.getFloat32(0, true);
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function normalizeColorComponent(v: number): number {
    if (!Number.isFinite(v)) return 255;
    if (v >= 0 && v <= 1.0) return (v * 255) | 0;
    return Math.max(0, Math.min(255, v | 0));
}

function packRgba(r: number, g: number, b: number, a: number): number {
    const rr = normalizeColorComponent(r);
    const gg = normalizeColorComponent(g);
    const bb = normalizeColorComponent(b);
    const aa = normalizeColorComponent(a);
    return ((aa << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
}

// The combine equation runs in WGSL (glide-shader-generator.ts); here we only
// decide whether a texture must be bound for this draw. If neither the color nor
// alpha combine references the texture, we skip binding it (the shader's texColor
// defaults to white and is ignored by the combine).
function drawUsesTexture(context: GlideContext): boolean {
    return (
        context.ffpState.textureEnabled &&
        combineReferencesTexture(context.runtime.colorCombine, context.runtime.alphaCombine)
    );
}

function readF32(ptr: number, offset: number, fallback: number): number {
    const v = Mem.readFloat32((ptr + offset) >>> 0);
    return v === null ? fallback : v;
}

function scoreColorValue(v: number): number {
    if (!Number.isFinite(v)) return 1000;
    if (v < -32 || v > 1024) return 200;
    return 0;
}

function scoreDepthValue(v: number): number {
    if (!Number.isFinite(v)) return 1000;
    if (Math.abs(v) > 1e7) return 200;
    return 0;
}

function decodeVertexForDraw(ptr: number): DecodedVertex {
    const x = readF32(ptr, 0x00, 0);
    const y = readF32(ptr, 0x04, 0);
    const a = readF32(ptr, 0x1c, 255);
    const sow = readF32(ptr, GR_VERTEX_SOW_OFFSET, 0);
    const tow = readF32(ptr, GR_VERTEX_TOW_OFFSET, 0);

    // Legacy Glide2 layout:
    // x y z r g b ooz a oow ...
    const legacy = {
        r: readF32(ptr, 0x0c, 255),
        g: readF32(ptr, 0x10, 255),
        b: readF32(ptr, 0x14, 255),
        ooz: readF32(ptr, 0x18, 0),
        oow: readF32(ptr, 0x20, 1),
    };

    // GLIDE3-style layout used by some Glide2 builds:
    // x y ooz oow r g b a z ...
    const glide3 = {
        ooz: readF32(ptr, 0x08, 0),
        oow: readF32(ptr, 0x0c, 1),
        r: readF32(ptr, 0x10, 255),
        g: readF32(ptr, 0x14, 255),
        b: readF32(ptr, 0x18, 255),
    };

    const legacyScore =
        scoreColorValue(legacy.r) +
        scoreColorValue(legacy.g) +
        scoreColorValue(legacy.b) +
        scoreDepthValue(legacy.ooz) +
        scoreDepthValue(legacy.oow);

    const glide3Score =
        scoreColorValue(glide3.r) +
        scoreColorValue(glide3.g) +
        scoreColorValue(glide3.b) +
        scoreDepthValue(glide3.ooz) +
        scoreDepthValue(glide3.oow);

    const pickLegacy = legacyScore <= glide3Score;
    return {
        x,
        y,
        ooz: pickLegacy ? legacy.ooz : glide3.ooz,
        oow: pickLegacy ? legacy.oow : glide3.oow,
        r: pickLegacy ? legacy.r : glide3.r,
        g: pickLegacy ? legacy.g : glide3.g,
        b: pickLegacy ? legacy.b : glide3.b,
        a,
        sow,
        tow,
    };
}

type IndexedVertexListMode =
    | { kind: "contiguous"; stride: number }
    | { kind: "pointer-table" };

function scoreVertexPtr(ptr: number): number {
    const x = Mem.readFloat32(ptr + 0x00);
    const y = Mem.readFloat32(ptr + 0x04);
    const sow = Mem.readFloat32(ptr + GR_VERTEX_SOW_OFFSET);
    const tow = Mem.readFloat32(ptr + GR_VERTEX_TOW_OFFSET);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
        return 1_000_000;
    }

    let penalty = 0;
    if (Math.abs(x) > 65536) penalty += 100;
    if (Math.abs(y) > 65536) penalty += 100;
    if (sow === null || !Number.isFinite(sow)) penalty += 20;
    if (tow === null || !Number.isFinite(tow)) penalty += 20;
    return penalty;
}

function resolveIndexedVertexPtr(basePtr: number, index: number, mode: IndexedVertexListMode): number {
    if (mode.kind === "pointer-table") {
        return Mem.readUint32((basePtr + index * 4) >>> 0) ?? 0;
    }
    return (basePtr + index * mode.stride) >>> 0;
}

function scoreIndexedMode(basePtr: number, indices: readonly number[], mode: IndexedVertexListMode): number {
    let score = 0;
    for (const index of indices) {
        const ptr = resolveIndexedVertexPtr(basePtr, index, mode);
        if (!ptr) {
            score += 10_000;
            continue;
        }
        score += scoreVertexPtr(ptr);
    }
    return score;
}

function chooseIndexedVertexListMode(basePtr: number, nVerts: number, indexList: readonly number[]): IndexedVertexListMode {
    const candidateIndices: number[] = [];
    for (let i = 0; i < indexList.length && candidateIndices.length < 8; i++) {
        const idx = indexList[i] ?? 0;
        if (idx < 0 || idx >= nVerts) continue;
        if (!candidateIndices.includes(idx)) candidateIndices.push(idx);
    }
    if (candidateIndices.length === 0) {
        const max = Math.min(nVerts, 8);
        for (let i = 0; i < max; i++) candidateIndices.push(i);
    }

    // Glide2 titles in the wild use both layouts: with 1 TMU (0x30) and with 2 TMUs (0x3c).
    const modes: IndexedVertexListMode[] = [
        { kind: "contiguous", stride: 0x30 },
        { kind: "contiguous", stride: 0x3c },
        { kind: "pointer-table" },
    ];

    let best = modes[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const mode of modes) {
        const score = scoreIndexedMode(basePtr, candidateIndices, mode);
        if (score < bestScore) {
            bestScore = score;
            best = mode;
        }
    }
    return best;
}

function pushVertexFromPtr(context: GlideContext, ptr: number): number {
    const v = decodeVertexForDraw(ptr >>> 0);
    const x = v.x;
    const y = v.y;
    const z = clamp01(v.ooz / 65535.0);
    const tmu0oow = readF32(ptr >>> 0, 0x2c, 0);
    const qRaw = tmu0oow || v.oow;
    const q = Number.isFinite(qRaw) && Math.abs(qRaw) > 1e-8 ? qRaw : 1.0;
    const u = v.sow;
    const vTex = v.tow;
    // Raw iterated color — the WGSL combine unit selects which inputs to use.
    const color = packRgba(v.r, v.g, v.b, v.a);
    const fid = context.frameSnapshot.frameId;
    if (vertexSampleBudget > 0 && fid <= 10) {
        vertexSampleBudget--;
        Logger.log(
            LogCategory.SYSTEM,
            `[Glide] pushVertex ptr=0x${ptr.toString(16)} xy=(${x.toFixed(3)},${y.toFixed(3)}) ` +
            `z=${z.toFixed(4)} sow=${v.sow.toFixed(2)} tow=${v.tow.toFixed(2)} ` +
            `oow=${v.oow.toFixed(4)} tmu0oow=${tmu0oow.toFixed(4)} q=${q.toFixed(4)} ` +
            `rgb=(${v.r.toFixed(1)},${v.g.toFixed(1)},${v.b.toFixed(1)}) a=${v.a.toFixed(1)} ` +
            `packed=0x${color.toString(16)} useTex=${drawUsesTexture(context)}`,
        );
    }
    // Menu-window sample: once post-intro (frameId > 200), capture up to menuSampleBudget
    // vertices spread across a few frames so we can see UV/XY for font glyphs.
    if (menuSampleBudget > 0 && fid > 200 && fid % 50 === 0) {
        if (menuSamplesDoneForFrame !== fid) {
            menuSamplesDoneForFrame = fid;
        }
        menuSampleBudget--;
        Logger.log(
            LogCategory.SYSTEM,
            `[Glide] menuVtx fid=${fid} ptr=0x${ptr.toString(16)} xy=(${x.toFixed(3)},${y.toFixed(3)}) ` +
            `sow=${v.sow.toFixed(2)} tow=${v.tow.toFixed(2)} oow=${v.oow.toFixed(4)} ` +
            `tmu0oow=${tmu0oow.toFixed(4)} q=${q.toFixed(4)} ` +
            `rgb=(${v.r.toFixed(1)},${v.g.toFixed(1)},${v.b.toFixed(1)}) a=${v.a.toFixed(1)} ` +
            `tex=${drawUsesTexture(context)}`,
        );
    }
    return context.stream.pushVertex(x, y, z, u, vTex, q, color);
}

let drawStateSampleBudget = 10;

function pushDraw(
    context: GlideContext,
    topology: "point-list" | "line-list" | "triangle-list",
    firstVertex: number,
    vertexCount: number,
    forceCullDisable: boolean = false,
): void {
    const rt = context.runtime;
    const tmu0 = context.tmus[0];
    // Glide filter mode: 0 = POINT_SAMPLED, 1 = BILINEAR. Treat BILINEAR as linear.
    // Games that don't call grTexFilterMode get whatever the TMU was last set to
    // (initial state is 0 = POINT, matching vendor gsst.c).
    const filterLinear = ((tmu0?.magFilter | 0) === 1) || ((tmu0?.minFilter | 0) === 1);
    const blend = rt.alphaBlend;
    const blendEnabled = !blendIsOpaque(blend.rgbSf, blend.rgbDf, blend.alphaSf, blend.alphaDf);
    // alphaTestFunction is the GR_CMP_* the game set (default GR_CMP_ALWAYS = no test).
    const alphaTestFunc = rt.alphaTestFunction | 0;
    const draw = {
        firstVertex,
        vertexCount,
        topology,
        textureHandle: context.ffpState.textureHandle,
        useTexture: drawUsesTexture(context),
        blendEnabled,
        depthTestEnabled: context.ffpState.depthTestEnabled,
        depthWriteEnabled: context.ffpState.depthWriteEnabled,
        depthFunction: rt.depthFunction,
        alphaTestEnabled: alphaTestFunc !== GR_CMP_ALWAYS,
        alphaRef: rt.alphaReference,
        cullMode: forceCullDisable ? 0 : rt.cullMode,
        constantColor: rt.constantColorValue >>> 0,
        clampS: (tmu0?.clampS | 0) !== 0,
        clampT: (tmu0?.clampT | 0) !== 0,
        filterLinear: filterLinear,
        // Real combine / blend / fog state for the WGSL pipeline.
        colorCombine: packCombine(rt.colorCombine),
        alphaCombine: packCombine(rt.alphaCombine),
        blend: packBlend(blend.rgbSf, blend.rgbDf, blend.alphaSf, blend.alphaDf),
        colorMaskRgb: rt.colorMask.rgb,
        colorMaskAlpha: rt.colorMask.alpha,
        alphaTestFunc,
        fogMode: rt.fogMode | 0,
        fogColor: rt.fogColor >>> 0,
    };
    const fidForLog = context.frameSnapshot.frameId;
    const shouldLogDraw = (drawStateSampleBudget > 0 && fidForLog <= 8)
        || (fidForLog > 100 && fidForLog <= 110 && drawStateSampleBudget > -20);
    if (shouldLogDraw) {
        drawStateSampleBudget--;
        const cc = context.runtime.colorCombine;
        const ac = context.runtime.alphaCombine;
        Logger.log(
            LogCategory.SYSTEM,
            `[Glide] pushDraw fid=${fidForLog} ${topology} verts=${vertexCount} useTex=${draw.useTexture} ` +
            `texHandle=${draw.textureHandle} blend=${draw.blendEnabled} depth=${draw.depthTestEnabled} ` +
            `alphaTest=${draw.alphaTestEnabled}(fn=${draw.alphaTestFunc}) alphaRef=${draw.alphaRef} ` +
            `clampST=${draw.clampS ? 1 : 0}${draw.clampT ? 1 : 0} ` +
            `filterLinear=${draw.filterLinear} ` +
            `constColor=0x${draw.constantColor.toString(16)} ` +
            `blend=0x${draw.blend.toString(16)}(en=${draw.blendEnabled ? 1 : 0}) ` +
            `fog(mode=${draw.fogMode}) ` +
            `cc(fn=${cc.function},fac=${cc.factor},loc=${cc.local},oth=${cc.other},inv=${cc.invert}) ` +
            `ac(fn=${ac.function},fac=${ac.factor},loc=${ac.local},oth=${ac.other},inv=${ac.invert}) ` +
            `chroma(mode=${context.runtime.chromaKeyMode},val=0x${context.runtime.chromaKeyValue.toString(16)})`,
        );
    }
    context.stream.pushDraw(draw);
    context.frameSnapshot.drawCalls++;
    context.frameSnapshot.frameCounters.vertexBytes += vertexCount * 28;
    context.frameSnapshot.lastDraw = {
        topology,
        vertexCount,
        textured: draw.useTexture,
        blend: draw.blendEnabled,
        depthTest: draw.depthTestEnabled,
        alphaTest: draw.alphaTestEnabled,
        timestamp: performance.now(),
    };
    context.diagnostics.push("draw", `${topology} vtx=${vertexCount}`);
}

function drawIndexedPolygon(context: GlideContext, nVerts: number, indexListPtr: number, vertexListPtr: number): void {
    if (nVerts < 3 || !vertexListPtr) return;
    const indexList: number[] = [];
    for (let i = 0; i < nVerts; i++) {
        if (indexListPtr) {
            indexList.push(Mem.readInt32(indexListPtr + i * 4) ?? i);
        } else {
            indexList.push(i);
        }
    }

    const listMode = chooseIndexedVertexListMode(vertexListPtr, nVerts, indexList);
    const first = context.stream.getVertexCount();
    for (let i = 1; i < nVerts - 1; i++) {
        const i0 = indexList[0] ?? 0;
        const i1 = indexList[i] ?? i;
        const i2 = indexList[i + 1] ?? (i + 1);
        pushVertexFromPtr(context, resolveIndexedVertexPtr(vertexListPtr, i0, listMode));
        pushVertexFromPtr(context, resolveIndexedVertexPtr(vertexListPtr, i1, listMode));
        pushVertexFromPtr(context, resolveIndexedVertexPtr(vertexListPtr, i2, listMode));
    }

    const vertexCount = (nVerts - 2) * 3;
    if (vertexCount > 0) {
        pushDraw(context, "triangle-list", first, vertexCount);
    }
}

function drawSimpleRect(context: GlideContext, x: number, y: number, w: number, h: number): void {
    const first = context.stream.getVertexCount();
    // grSplash draws with the constant color as the iterated color.
    const color = context.runtime.constantColorValue >>> 0;
    context.stream.pushVertex(x, y, 0, 0, 0, 1, color);
    context.stream.pushVertex(x + w, y, 0, 255, 0, 1, color);
    context.stream.pushVertex(x + w, y + h, 0, 255, 255, 1, color);
    context.stream.pushVertex(x, y, 0, 0, 0, 1, color);
    context.stream.pushVertex(x + w, y + h, 0, 255, 255, 1, color);
    context.stream.pushVertex(x, y + h, 0, 0, 255, 1, color);
    pushDraw(context, "triangle-list", first, 6);
}

export function createDrawExports(context: GlideContext): Record<string, ThunkImplementation> {
    return {
        "_grDrawPoint@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, ptr);
            pushDraw(context, "point-list", first, 1);
            return 0;
        },

        "_grDrawLine@8": (_ctx, _mem, args) => {
            const a = args[0] >>> 0;
            const b = args[1] >>> 0;
            if (!a || !b) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, a);
            pushVertexFromPtr(context, b);
            pushDraw(context, "line-list", first, 2);
            return 0;
        },

        "_grDrawTriangle@12": (_ctx, _mem, args) => {
            const a = args[0] >>> 0;
            const b = args[1] >>> 0;
            const c = args[2] >>> 0;
            if (!a || !b || !c) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, a);
            pushVertexFromPtr(context, b);
            pushVertexFromPtr(context, c);
            pushDraw(context, "triangle-list", first, 3);
            return 0;
        },

        "_grDrawPlanarPolygon@12": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, args[1] >>> 0, args[2] >>> 0);
            return 0;
        },

        "_grDrawPlanarPolygonVertexList@8": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, 0, args[1] >>> 0);
            return 0;
        },

        "_grDrawPolygon@12": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, args[1] >>> 0, args[2] >>> 0);
            return 0;
        },

        "_grDrawPolygonVertexList@8": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, 0, args[1] >>> 0);
            return 0;
        },

        "_grSplash@20": (_ctx, _mem, args) => {
            // grSplash(float x, float y, float width, float height, FxU32 frameNumber)
            const x = dwordToFloat(args[0] >>> 0);
            const y = dwordToFloat(args[1] >>> 0);
            const w = dwordToFloat(args[2] >>> 0);
            const h = dwordToFloat(args[3] >>> 0);
            drawSimpleRect(context, x, y, w, h);
            return 0;
        },

        "_grAADrawLine@8": (_ctx, _mem, args) => {
            const a = args[0] >>> 0;
            const b = args[1] >>> 0;
            if (!a || !b) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, a);
            pushVertexFromPtr(context, b);
            pushDraw(context, "line-list", first, 2, /*forceCullDisable*/ true);
            return 0;
        },

        "_grAADrawPoint@4": (_ctx, _mem, args) => {
            const ptr = args[0] >>> 0;
            if (!ptr) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, ptr);
            pushDraw(context, "point-list", first, 1, /*forceCullDisable*/ true);
            return 0;
        },

        "_grAADrawPolygon@12": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, args[1] >>> 0, args[2] >>> 0);
            return 0;
        },

        "_grAADrawPolygonVertexList@8": (_ctx, _mem, args) => {
            drawIndexedPolygon(context, args[0] | 0, 0, args[1] >>> 0);
            return 0;
        },

        // grAADrawTriangle(a, b, c, ab_antialias, bc_antialias, ca_antialias) = @24.
        // We don't emulate edge antialiasing flags (args[3..5]); draw as a normal tri.
        "_grAADrawTriangle@24": (_ctx, _mem, args) => {
            const a = args[0] >>> 0;
            const b = args[1] >>> 0;
            const c = args[2] >>> 0;
            if (!a || !b || !c) return 0;
            const first = context.stream.getVertexCount();
            pushVertexFromPtr(context, a);
            pushVertexFromPtr(context, b);
            pushVertexFromPtr(context, c);
            pushDraw(context, "triangle-list", first, 3, /*forceCullDisable*/ true);
            return 0;
        },
    };
}

