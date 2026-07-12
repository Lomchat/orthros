/**
 * shader/index.ts — public API for the SM1.x → WGSL recompiler.
 *
 * Parses D3D9 vertex/pixel shader bytecode (CreateVertexShader /
 * CreatePixelShader) and links a VS + PS (+ active vertex declaration) into a
 * single WGSL module with a fixed, explicit bind-group layout:
 *
 *   @group(0) @binding(0)  var<uniform> vsc : VsUniforms   (VERTEX)
 *   @group(0) @binding(1)  var<uniform> psc : PsUniforms   (FRAGMENT)
 *   @group(0) @binding(2)  var samp : sampler              (FRAGMENT)
 *   @group(0) @binding(3+n) var texN : texture_2d<f32>     (FRAGMENT)
 */

import { parseShader, SmProgram } from "./sm-parser";
import { analyzeVs, emitVsMain, VsAnalysis } from "./vs-codegen";
import { analyzePs, emitPsMain, PsAnalysis } from "./ps-codegen";
import { colField, texField, AlphaTest, alphaTestSnippet } from "./sm-wgsl";
import { TexType } from "./sm-enums";

export { parseShader } from "./sm-parser";

/** Fixed bind-group binding indices for the programmable path. */
export const PROG_BIND = {
    VS_UNIFORM: 0,
    PS_UNIFORM: 1,
    SAMPLER: 2,
    TEX_BASE: 3,
    MAX_TEX: 8,
} as const;

/**
 * Raw D3DVERTEXELEMENT9 data as read from guest memory (shared with the
 * device + state modules).
 */
export interface RawVertexElement {
    stream: number;
    offset: number;
    type: number;       // D3DDECLTYPE
    usage: number;      // D3DDECLUSAGE
    usageIndex: number;
    /** D3D8 D3DVSD input register (v#) this element loads — set by the VSD parser only.
     *  D3D8 vs_1_1 bytecode carries no dcl instructions, so input locations come from here. */
    reg?: number;
}

export interface CompiledVs {
    prog: SmProgram;
    analysis: VsAnalysis;
}

export interface CompiledPs {
    prog: SmProgram;
    analysis: PsAnalysis;
}

export function compileVertexShader(tokens: Uint32Array): CompiledVs {
    const prog = parseShader(tokens);
    if (prog.isPixelShader) throw new Error("Expected a vertex shader");
    return { prog, analysis: analyzeVs(prog) };
}

export function compilePixelShader(tokens: Uint32Array): CompiledPs {
    const prog = parseShader(tokens);
    if (!prog.isPixelShader) throw new Error("Expected a pixel shader");
    return { prog, analysis: analyzePs(prog) };
}

/**
 * Bitmask (over PROG_BIND.MAX_TEX stages) of which fragment-sampler stages declare a CUBE
 * sampler. Drives the texture_cube<f32> WGSL declaration, the cube bind-group layout
 * (viewDimension:"cube"), and the per-draw cube view selection — all three must agree or
 * WebGPU rejects the pipeline/bind-group. Computed identically here and at draw time so the
 * pipeline layout and the bound group never drift.
 */
export function computeCubeMask(ps: CompiledPs | null): number {
    if (!ps) return 0;
    let mask = 0;
    for (const [stage, t] of ps.analysis.samplerTexType) {
        if (stage < PROG_BIND.MAX_TEX && t === TexType.CUBE) mask |= (1 << stage);
    }
    return mask;
}

export interface LinkResult {
    wgsl: string;
    vertexAttributes: GPUVertexAttribute[];
    arrayStride: number;          // fallback when SetStreamSource stride is 0
    /** One vertex-buffer layout per used stream, at index = stream slot (null holes).
     *  Single-stream links produce [{arrayStride, attributes}] identical to the two
     *  legacy fields above. Bind each stream with setVertexBuffer(streamIndex, …). */
    vertexBuffers: (GPUVertexBufferLayout | null)[];
    vsConstantCount: number;
    psConstantCount: number;
    hasTexture: boolean;
    /** Bitmask of cube-sampler stages (see computeCubeMask) — keys the bind-group layout. */
    cubeMask: number;
}

export interface LinkOptions {
    vs: CompiledVs;
    ps: CompiledPs | null;
    declElements: RawVertexElement[] | null;
    streamStride: number | null;
    /** Per-stream SetStreamSource strides (index = stream number; null/0 → fall back to the
     *  declaration's computed stride for that stream). Presence enables the multi-stream
     *  vertex-input path (D3D8 D3DVSD declarations); omit for the legacy single-stream
     *  (stream-0 only) layout the D3D9 device consumes. */
    streamStrides?: (number | null)[] | null;
    /** D3D9 fixed-function alpha test (emitted as a fragment discard), or null. */
    alphaTest?: AlphaTest | null;
    /** Effective cube-sampler mask override (shader dcl_cube ∪ cube textures bound at draw time).
     *  Lets ps_1_x / no-dcl shaders sample a bound cube map (NFSU reflections). Falls back to the
     *  PS's declared dcl_cube mask when omitted. */
    cubeMask?: number;
    /** Per-stage D3DTTFF_PROJECTED coordinate-count key (3 bits/stage, 0 = not projected). Drives
     *  the ps_1_1-1_3 / fixed-function projective texture divide (projected spotlights, planar
     *  reflections). SM2+ shaders project in-shader (texldp) and ignore this. */
    projectedStages?: number;
}

export function linkProgram(opts: LinkOptions): LinkResult {
    const { vs, ps, declElements, streamStride, alphaTest = null } = opts;
    const cubeMaskOverride = opts.cubeMask;
    const projectedStages = opts.projectedStages ?? 0;
    const vsA = vs.analysis;
    const psA = ps?.analysis ?? null;

    // ── Interpolant set (union of VS-written and PS-read) ──────────────────
    const interpColors: [boolean, boolean] = [
        vsA.writesColor[0] || (psA?.readsColor[0] ?? false),
        vsA.writesColor[1] || (psA?.readsColor[1] ?? false),
    ];
    const texcoordSet = new Set<number>(vsA.writesTexcoord);
    if (psA) for (const n of psA.readsTexcoord) texcoordSet.add(n);
    const interpTexcoords = [...texcoordSet].sort((a, b) => a - b);

    // ── Vertex input reconciliation against the active declaration ─────────
    const vin = buildVertexInputs(vsA, declElements, streamStride, opts.streamStrides ?? null);
    let { fields, attributes, vertexBuffers } = vin;
    const inputExprs = vin.inputExprs;
    let stride = vin.stride;
    if (fields.length === 0) {
        // Degenerate VS with no input registers — keep shader/layout consistent.
        fields = ["@location(0) _unused: vec4<f32>"];
        attributes = [{ shaderLocation: 0, offset: 0, format: "float32x4" }];
        if (stride <= 0) stride = 16;
        vertexBuffers = [{ arrayStride: stride, attributes }];
    }

    // ── Fragment sampler set ───────────────────────────────────────────────
    let fragSamplers: number[];
    if (ps) {
        fragSamplers = [...psA!.samplers].filter(n => n < PROG_BIND.MAX_TEX).sort((a, b) => a - b);
    } else if (vsA.writesTexcoord.size > 0) {
        fragSamplers = [Math.min(...vsA.writesTexcoord)];
    } else {
        fragSamplers = [];
    }
    const hasTexture = fragSamplers.length > 0;

    const vsConstantCount = vsA.constantCount;
    const psConstantCount = psA?.constantCount ?? 0;

    // ── Assemble module ────────────────────────────────────────────────────
    const lines: string[] = [];

    lines.push(`struct VsUniforms { c: array<vec4<f32>, ${Math.max(1, vsConstantCount)}>, }`);
    lines.push(`@group(0) @binding(${PROG_BIND.VS_UNIFORM}) var<uniform> vsc: VsUniforms;`);
    lines.push(`struct PsUniforms { c: array<vec4<f32>, ${Math.max(1, psConstantCount)}>, }`);
    lines.push(`@group(0) @binding(${PROG_BIND.PS_UNIFORM}) var<uniform> psc: PsUniforms;`);
    // Per-stage cube-sampler mask: a cube sampler declares texture_cube<f32> + samples with a
    // 3-component direction (ps-codegen). The bind-group layout's viewDimension must match. The
    // override (dcl_cube ∪ bound-cube at draw time) lets ps_1_x/no-dcl shaders sample a bound cube.
    const cubeMask = cubeMaskOverride ?? computeCubeMask(ps);
    if (hasTexture) {
        lines.push(`@group(0) @binding(${PROG_BIND.SAMPLER}) var samp: sampler;`);
        for (const n of fragSamplers) {
            const kind = (cubeMask >> n) & 1 ? "texture_cube<f32>" : "texture_2d<f32>";
            lines.push(`@group(0) @binding(${PROG_BIND.TEX_BASE + n}) var tex${n}: ${kind};`);
        }
    }
    lines.push("");

    lines.push(`struct VsInput {`);
    for (const f of fields) lines.push(`    ${f},`);
    lines.push(`}`);
    lines.push("");

    lines.push(`struct Interp {`);
    lines.push(`    @builtin(position) pos: vec4<f32>,`);
    if (interpColors[0]) lines.push(`    @location(0) ${colField(0)}: vec4<f32>,`);
    if (interpColors[1]) lines.push(`    @location(1) ${colField(1)}: vec4<f32>,`);
    for (const n of interpTexcoords) lines.push(`    @location(${2 + n}) ${texField(n)}: vec4<f32>,`);
    lines.push(`}`);
    lines.push("");

    lines.push(emitVsMain(vs.prog, vsA, {
        interpColors,
        interpTexcoords,
        inputExprs,
        constantCount: vsConstantCount,
    }));
    lines.push("");

    if (ps) {
        lines.push(emitPsMain(ps.prog, psA!, alphaTest, cubeMask, projectedStages));
    } else {
        const dftStage = hasTexture ? fragSamplers[0] : null;
        const dftCube = dftStage !== null && ((cubeMask >> dftStage) & 1) !== 0;
        const dftProjected = dftStage !== null && ((projectedStages >> dftStage) & 1) !== 0;
        lines.push(emitDefaultFragment(interpColors[0], dftStage, alphaTest, dftCube, dftProjected));
    }

    return {
        wgsl: lines.join("\n"),
        vertexAttributes: attributes,
        arrayStride: stride,
        vertexBuffers,
        vsConstantCount,
        psConstantCount,
        hasTexture,
        cubeMask,
    };
}

function emitDefaultFragment(hasColor: boolean, sampleStage: number | null, alphaTest: AlphaTest | null = null, sampleCube = false, projected = false): string {
    const col = hasColor ? `in.${colField(0)}` : `vec4<f32>(1.0)`;
    // D3DTTFF_PROJECTED on the sampled stage divides the coordinate by its .w component before
    // the fetch (the vertex shader places the projective q there) — see projectedStageKey.
    const tcRaw = sampleStage !== null ? `in.${texField(sampleStage)}` : "";
    const tc = sampleStage !== null && projected
        ? `((${tcRaw}) / (${tcRaw}).w)`
        : `(${tcRaw})`;
    const coord = sampleStage !== null
        ? (sampleCube ? `${tc}.xyz` : `${tc}.xy`)
        : "";
    const ret = sampleStage !== null
        ? `textureSample(tex${sampleStage}, samp, ${coord}) * ${col}`
        : col;
    const atest = alphaTestSnippet(alphaTest, "_c.a");
    if (!atest) {
        return `@fragment\nfn fs_main(in: Interp) -> @location(0) vec4<f32> {\n    return ${ret};\n}`;
    }
    return `@fragment\nfn fs_main(in: Interp) -> @location(0) vec4<f32> {\n    let _c = ${ret};\n    ${atest}\n    return _c;\n}`;
}

// ── Vertex declaration → WGSL input + attributes ──────────────────────────────

interface DeclTypeInfo {
    format: GPUVertexFormat;
    wgslType: string;
    size: number;
    /** expand(field) → a vec4<f32> WGSL expression. */
    expand(field: string): string;
}

function declTypeInfo(type: number): DeclTypeInfo {
    switch (type) {
        case 0:  return { format: "float32",   wgslType: "f32",        size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 0.0, 1.0)` }; // FLOAT1
        case 1:  return { format: "float32x2", wgslType: "vec2<f32>",  size: 8,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };       // FLOAT2
        case 2:  return { format: "float32x3", wgslType: "vec3<f32>",  size: 12, expand: f => `vec4<f32>(${f}, 1.0)` };            // FLOAT3
        case 3:  return { format: "float32x4", wgslType: "vec4<f32>",  size: 16, expand: f => f };                                  // FLOAT4
        case 4:  return { format: "unorm8x4",  wgslType: "vec4<f32>",  size: 4,  expand: f => `(${f}).zyxw` };                      // D3DCOLOR (BGRA→RGBA)
        case 5:  return { format: "uint8x4",   wgslType: "vec4<u32>",  size: 4,  expand: f => `vec4<f32>(${f})` };                  // UBYTE4
        case 6:  return { format: "sint16x2",  wgslType: "vec2<i32>",  size: 4,  expand: f => `vec4<f32>(vec2<f32>(${f}), 0.0, 1.0)` }; // SHORT2
        case 7:  return { format: "sint16x4",  wgslType: "vec4<i32>",  size: 8,  expand: f => `vec4<f32>(${f})` };                  // SHORT4
        case 8:  return { format: "unorm8x4",  wgslType: "vec4<f32>",  size: 4,  expand: f => f };                                  // UBYTE4N
        case 9:  return { format: "snorm16x2", wgslType: "vec2<f32>",  size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };        // SHORT2N
        case 10: return { format: "snorm16x4", wgslType: "vec4<f32>",  size: 8,  expand: f => f };                                  // SHORT4N
        case 11: return { format: "unorm16x2", wgslType: "vec2<f32>",  size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };        // USHORT2N
        case 12: return { format: "unorm16x4", wgslType: "vec4<f32>",  size: 8,  expand: f => f };                                  // USHORT4N
        case 15: return { format: "float16x2", wgslType: "vec2<f32>",  size: 4,  expand: f => `vec4<f32>(${f}, 0.0, 1.0)` };        // FLOAT16_2
        case 16: return { format: "float16x4", wgslType: "vec4<f32>",  size: 8,  expand: f => f };                                  // FLOAT16_4
        default: return { format: "float32x4", wgslType: "vec4<f32>",  size: 16, expand: f => f };                                  // fallback
    }
}

function buildVertexInputs(
    vsA: VsAnalysis,
    declElements: RawVertexElement[] | null,
    streamStride: number | null,
    streamStrides: (number | null)[] | null,
): {
    fields: string[];
    attributes: GPUVertexAttribute[];
    inputExprs: Map<number, string>;
    stride: number;
    vertexBuffers: (GPUVertexBufferLayout | null)[];
} {
    const multiStream = streamStrides !== null;
    const fields: string[] = [];
    const inputExprs = new Map<number, string>();
    const perStreamAttrs = new Map<number, GPUVertexAttribute[]>();
    const perStreamMaxEnd = new Map<number, number>();
    let tightOffset = 0;

    // D3D8 vs_1_1 bytecode has no dcl instructions: the D3DVSD declaration itself maps
    // each element to its input register (D3DVSD_REG). When the shader analysis found no
    // input dcls but the declaration carries register numbers, synthesize the input list
    // from the declaration (locations = v# register numbers).
    type InputSpec = { reg: number; elem: RawVertexElement | null };
    let specs: InputSpec[];
    if (vsA.inputDcls.length > 0) {
        specs = vsA.inputDcls.map(dcl => ({
            reg: dcl.reg,
            elem: declElements?.find(
                e => (multiStream || e.stream === 0) && e.usage === dcl.usage && e.usageIndex === dcl.usageIndex,
            ) ?? null,
        }));
    } else if (multiStream && declElements) {
        specs = declElements.filter(e => e.reg !== undefined).map(e => ({ reg: e.reg!, elem: e }));
    } else {
        specs = [];
    }

    for (const spec of specs) {
        const field = `in.v${spec.reg}`;
        let info: DeclTypeInfo;
        let offset: number;
        let stream = 0;

        if (spec.elem) {
            info = declTypeInfo(spec.elem.type);
            offset = spec.elem.offset;
            stream = multiStream ? spec.elem.stream : 0;
        } else {
            // No matching declaration element — tight-pack as float4.
            info = declTypeInfo(3);
            offset = tightOffset;
            tightOffset += info.size;
        }

        fields.push(`@location(${spec.reg}) v${spec.reg}: ${info.wgslType}`);
        let attrs = perStreamAttrs.get(stream);
        if (!attrs) {
            attrs = [];
            perStreamAttrs.set(stream, attrs);
        }
        attrs.push({ shaderLocation: spec.reg, offset, format: info.format });
        inputExprs.set(spec.reg, info.expand(field));
        perStreamMaxEnd.set(stream, Math.max(perStreamMaxEnd.get(stream) ?? 0, offset + info.size));
    }

    // Legacy single-buffer view = stream 0 (identical to the pre-multi-stream layout).
    const attributes = perStreamAttrs.get(0) ?? [];
    const maxEnd0 = perStreamMaxEnd.get(0) ?? 0;
    const stride0Source = multiStream ? (streamStrides![0] ?? null) : streamStride;
    let stride = stride0Source && stride0Source > 0 ? stride0Source : maxEnd0;
    if (stride <= 0) stride = 16;

    // Per-stream buffer layouts at slot = stream number (null holes for unused slots).
    let maxStream = 0;
    for (const s of perStreamAttrs.keys()) maxStream = Math.max(maxStream, s);
    const vertexBuffers: (GPUVertexBufferLayout | null)[] = [];
    for (let s = 0; s <= maxStream; s++) {
        const attrs = perStreamAttrs.get(s);
        if (!attrs || attrs.length === 0) {
            vertexBuffers.push(null);
            continue;
        }
        if (s === 0) {
            vertexBuffers.push({ arrayStride: stride, attributes: attrs });
            continue;
        }
        const provided = streamStrides?.[s] ?? null;
        let sStride = provided && provided > 0 ? provided : (perStreamMaxEnd.get(s) ?? 0);
        if (sStride <= 0) sStride = 16;
        vertexBuffers.push({ arrayStride: sStride, attributes: attrs });
    }

    return { fields, attributes, inputExprs, stride, vertexBuffers };
}
