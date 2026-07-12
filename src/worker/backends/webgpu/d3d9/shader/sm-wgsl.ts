/**
 * sm-wgsl.ts — shared WGSL emission helpers for the SM1.x → WGSL recompiler.
 *
 * Provides the register-read / register-write plumbing used by both the vertex
 * (vs-codegen.ts) and pixel (ps-codegen.ts) generators: source-operand
 * expressions (swizzle + the full D3D9 source-modifier set), and masked
 * destination stores (result shift + saturate).
 */

import { SmSource, SmDest, SmRegister, SmInstruction } from "./sm-parser";
import { SrcMod, Op, opName } from "./sm-enums";

// Inter-stage interpolant @location convention (shared by VS out / PS in).
export const LOC_COLOR0 = 0;
export const LOC_COLOR1 = 1;
export const LOC_TEXCOORD_BASE = 2; // texcoord N → location 2+N

/** Interpolant struct field names (must match between VS out and PS in). */
export function colField(i: number): string { return `col${i}`; }
export function texField(i: number): string { return `tex${i}`; }

/**
 * Codegen context: knows how to name registers for the current stage.
 * `readReg` returns a vec4<f32> *expression* (before swizzle/modifiers);
 * `writeRegName` returns the lvalue base (a vec4<f32> var/member), or null to
 * drop the write (e.g. oPts / unsupported outputs).
 */
export interface ShaderCtx {
    isPs: boolean;
    major: number;
    minor: number;
    readReg(reg: SmRegister): string;
    writeRegName(reg: SmRegister): string | null;
}

const COMP = ["x", "y", "z", "w"];

/**
 * D3D9 fixed-function alpha test (D3DRS_ALPHATESTENABLE/ALPHAFUNC/ALPHAREF).
 * `func` is a D3DCMPFUNC (1=NEVER..8=ALWAYS); `ref` is the 0..255 alpha reference.
 */
export interface AlphaTest { func: number; ref: number; }

const CMP_OP: Record<number, string> = { 2: "<", 3: "==", 4: "<=", 5: ">", 6: "!=", 7: ">=" };

/**
 * WGSL statements that discard the fragment per the D3D9 alpha test, or "" when no
 * test applies. WebGPU has no fixed-function alpha test, so it must be emitted as a
 * shader `discard` after the pixel color is computed. Uses 8-bit-RT precision: the
 * float alpha is scaled to the 16-bit range and rounded, and the 0..255 ref is
 * bit-replicated to 16 bits, so EQUAL/NOTEQUAL and boundary comparisons match real
 * 8-bit render-target hardware. `alphaExpr` is a WGSL f32 expression for the output
 * alpha (0..1).
 */
export function alphaTestSnippet(at: AlphaTest | null, alphaExpr: string): string {
    if (!at) return "";
    const { func } = at;
    if (func === 8 || func === 0) return "";   // ALWAYS / unset → keep everything
    if (func === 1) return "discard;";          // NEVER → discard everything
    const op = CMP_OP[func];
    if (!op) return "";
    const refInt = (((at.ref & 0xff) << 8) | (at.ref & 0xff)) >>> 0; // 8→16-bit replicate
    return `{ let _atA = round((${alphaExpr}) * 65535.0); if (!(_atA ${op} ${refInt}.0)) { discard; } }`;
}

function applySwizzle(expr: string, sw: number): string {
    const c0 = COMP[sw & 3];
    const c1 = COMP[(sw >>> 2) & 3];
    const c2 = COMP[(sw >>> 4) & 3];
    const c3 = COMP[(sw >>> 6) & 3];
    if (c0 === "x" && c1 === "y" && c2 === "z" && c3 === "w") return expr;
    return `(${expr}).${c0}${c1}${c2}${c3}`;
}

/** Build a vec4<f32> WGSL expression for a source operand (swizzle + modifiers). */
export function srcExpr(src: SmSource, ctx: ShaderCtx): string {
    let e = ctx.readReg(src.reg);
    const m = src.modifier;

    // Pre-swizzle modifiers (component divide).
    if (m === SrcMod.DZ) e = `((${e}) / (${e}).z)`;
    else if (m === SrcMod.DW) e = `((${e}) / (${e}).w)`;

    e = applySwizzle(e, src.swizzle);

    switch (m) {
        case SrcMod.NEG:     e = `(-(${e}))`; break;
        case SrcMod.BIAS:    e = `((${e}) - vec4<f32>(0.5))`; break;
        case SrcMod.BIASNEG: e = `(-((${e}) - vec4<f32>(0.5)))`; break;
        case SrcMod.SIGN:    e = `((${e}) * 2.0 - vec4<f32>(1.0))`; break;
        case SrcMod.SIGNNEG: e = `(-((${e}) * 2.0 - vec4<f32>(1.0)))`; break;
        case SrcMod.COMP:    e = `(vec4<f32>(1.0) - (${e}))`; break;
        case SrcMod.X2:      e = `((${e}) * 2.0)`; break;
        case SrcMod.X2NEG:   e = `(-((${e}) * 2.0))`; break;
        case SrcMod.ABS:     e = `abs(${e})`; break;
        case SrcMod.ABSNEG:  e = `(-abs(${e}))`; break;
        default: break; // NONE / DZ / DW / NOT
    }
    return e;
}

/** WGSL float literal for a result-shift multiplier. */
function shiftMultiplier(shift: number): string {
    if (shift > 0) return (1 << shift).toFixed(1);          // _x2/_x4/_x8 → 2.0/4.0/8.0
    return (1 / (1 << -shift)).toString();                   // _d2/_d4/_d8 → 0.5/0.25/0.125
}

/**
 * Emit a masked destination store of a vec4 result, applying the result shift
 * and saturate modifiers. `forceSaturate` is used for oFog.
 */
export function emitStore(
    dst: SmDest,
    valueVec4: string,
    ctx: ShaderCtx,
    lines: string[],
    uid: number,
    forceSaturate = false,
): void {
    const name = ctx.writeRegName(dst.reg);
    if (name === null || dst.writeMask === 0) return;

    let v = valueVec4;
    if (dst.shift !== 0) v = `((${v}) * ${shiftMultiplier(dst.shift)})`;
    if (dst.saturate || forceSaturate) v = `clamp(${v}, vec4<f32>(0.0), vec4<f32>(1.0))`;

    // Prefix avoids colliding with register names (r#, t#, oPos, dc#, …).
    const tmp = `_st${uid}`;
    lines.push(`let ${tmp} = ${v};`);
    if (dst.writeMask & 1) lines.push(`${name}.x = ${tmp}.x;`);
    if (dst.writeMask & 2) lines.push(`${name}.y = ${tmp}.y;`);
    if (dst.writeMask & 4) lines.push(`${name}.z = ${tmp}.z;`);
    if (dst.writeMask & 8) lines.push(`${name}.w = ${tmp}.w;`);
}

/** Number of set bits in a 4-bit write mask. */
export function maskCount(mask: number): number {
    return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}

/**
 * dst.N = dot(src0[.xyz], cReg[N][.xyz]) for matrix-multiply macro ops.
 * `rows` rows starting at src1's register; `dim` = 3 (dot3) or 4 (dot4).
 */
function matrixResult(instr: SmInstruction, ctx: ShaderCtx, rows: number, dim: number): string {
    const s0 = srcExpr(instr.src[0], ctx);
    const base = instr.src[1].reg;
    const rowExprs: string[] = [];
    for (let r = 0; r < 4; r++) {
        if (r < rows) {
            const cReg = ctx.readReg({ type: base.type, num: base.num + r, relative: base.relative });
            rowExprs.push(dim === 4
                ? `dot(${s0}, ${cReg})`
                : `dot((${s0}).xyz, (${cReg}).xyz)`);
        } else {
            rowExprs.push("0.0");
        }
    }
    return `vec4<f32>(${rowExprs.join(", ")})`;
}

/**
 * Emit a shared arithmetic/logic instruction (opcodes common to VS and PS).
 * Returns true if handled; false if the opcode is not a generic ALU op
 * (caller handles stage-specific opcodes — a0 writes, tex*, flow control).
 */
export function emitAlu(instr: SmInstruction, ctx: ShaderCtx, lines: string[], uid: number): boolean {
    const { opcode, dst, src } = instr;
    if (!dst) return false;

    const a = () => srcExpr(src[0], ctx);
    const b = () => srcExpr(src[1], ctx);
    const c = () => srcExpr(src[2], ctx);

    let r: string | null = null;
    switch (opcode) {
        case Op.MOV:  r = a(); break;
        case Op.ADD:  r = `(${a()} + ${b()})`; break;
        case Op.SUB:  r = `(${a()} - ${b()})`; break;
        case Op.MUL:  r = `(${a()} * ${b()})`; break;
        case Op.MAD:  r = `(${a()} * ${b()} + ${c()})`; break;
        case Op.LRP:  r = `mix(${c()}, ${b()}, ${a()})`; break; // lerp factor = src0
        case Op.MIN:  r = `min(${a()}, ${b()})`; break;
        case Op.MAX:  r = `max(${a()}, ${b()})`; break;
        case Op.FRC:  r = `fract(${a()})`; break;
        case Op.ABS:  r = `abs(${a()})`; break;
        case Op.DP3:  r = `vec4<f32>(dot((${a()}).xyz, (${b()}).xyz))`; break;
        case Op.DP4:  r = `vec4<f32>(dot(${a()}, ${b()}))`; break;
        case Op.DP2ADD: r = `vec4<f32>(dot((${a()}).xy, (${b()}).xy) + (${c()}).x)`; break;
        case Op.RCP:  r = `vec4<f32>(1.0 / (${a()}).x)`; break;
        case Op.RSQ:  r = `vec4<f32>(inverseSqrt(abs((${a()}).x)))`; break;
        case Op.EXP:  r = `vec4<f32>(exp2((${a()}).x))`; break;
        case Op.LOG:  r = `vec4<f32>(log2(abs((${a()}).x)))`; break;
        case Op.EXPP: { const s = a(); r = `vec4<f32>(exp2(floor((${s}).x)), fract((${s}).x), exp2((${s}).x), 1.0)`; break; }
        case Op.LOGP: r = `vec4<f32>(log2(abs((${a()}).x)))`; break;
        case Op.POW:  r = `vec4<f32>(pow(abs((${a()}).x), (${b()}).x))`; break;
        case Op.SLT:  r = `select(vec4<f32>(0.0), vec4<f32>(1.0), ${a()} < ${b()})`; break;
        case Op.SGE:  r = `select(vec4<f32>(0.0), vec4<f32>(1.0), ${a()} >= ${b()})`; break;
        case Op.CMP:  r = `select(${c()}, ${b()}, ${a()} >= vec4<f32>(0.0))`; break;
        case Op.CND:  r = `select(${c()}, ${b()}, ${a()} > vec4<f32>(0.5))`; break;
        case Op.CRS:  r = `vec4<f32>(cross((${a()}).xyz, (${b()}).xyz), 1.0)`; break;
        case Op.NRM:  { const s = a(); r = `vec4<f32>((${s}).xyz * inverseSqrt(dot((${s}).xyz, (${s}).xyz)), 1.0)`; break; }
        case Op.SGN:  r = `sign(${a()})`; break;
        case Op.SINCOS: { const s = a(); r = `vec4<f32>(cos((${s}).x), sin((${s}).x), 0.0, 0.0)`; break; }
        case Op.LIT:  { const s = a(); r = `vec4<f32>(1.0, max((${s}).x, 0.0), select(0.0, pow(max((${s}).y, 0.0), clamp((${s}).w, -128.0, 128.0)), (${s}).x > 0.0), 1.0)`; break; }
        case Op.DST:  { const s0 = a(); const s1 = b(); r = `vec4<f32>(1.0, (${s0}).y * (${s1}).y, (${s0}).z, (${s1}).w)`; break; }
        case Op.M4x4: r = matrixResult(instr, ctx, 4, 4); break;
        case Op.M4x3: r = matrixResult(instr, ctx, 3, 4); break;
        case Op.M3x4: r = matrixResult(instr, ctx, 4, 3); break;
        case Op.M3x3: r = matrixResult(instr, ctx, 3, 3); break;
        case Op.M3x2: r = matrixResult(instr, ctx, 2, 3); break;
        default: return false;
    }

    lines.push(`// ${opName(opcode)}`);
    emitStore(dst, r, ctx, lines, uid);
    return true;
}
