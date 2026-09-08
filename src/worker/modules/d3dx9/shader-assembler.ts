/**
 * shader-assembler.ts — D3DXAssembleShader for shader model 1.x–3.0 text.
 *
 * Turns the D3DX assembly dialect (`ps.1.1`, `vs_1_1`, `def`, `dcl_*`, source
 * and destination modifiers, swizzles, `c[a0.x + n]`) into the D3D9 token
 * stream that CreateVertexShader / CreatePixelShader consume (the SM1.x → WGSL
 * recompiler parses it back). Errors carry the line number, as D3DX's error
 * buffer does.
 */
import { Op, RegType, SrcMod, Usage } from "../../backends/webgpu/d3d9/shader/sm-enums";

export class ShaderAssemblyError extends Error {
    constructor(message: string, readonly line: number) {
        super(`(${line}): ${message}`);
    }
}

const END_TOKEN = 0x0000ffff;

/** Opcodes by mnemonic; the tex family of ps.1.x carries its own names. */
const OPCODES: Record<string, Op> = {
    nop: Op.NOP, mov: Op.MOV, add: Op.ADD, sub: Op.SUB, mad: Op.MAD, mul: Op.MUL, rcp: Op.RCP,
    rsq: Op.RSQ, dp3: Op.DP3, dp4: Op.DP4, min: Op.MIN, max: Op.MAX, slt: Op.SLT, sge: Op.SGE,
    exp: Op.EXP, log: Op.LOG, lit: Op.LIT, dst: Op.DST, lrp: Op.LRP, frc: Op.FRC,
    m4x4: Op.M4x4, m4x3: Op.M4x3, m3x4: Op.M3x4, m3x3: Op.M3x3, m3x2: Op.M3x2,
    call: Op.CALL, callnz: Op.CALLNZ, loop: Op.LOOP, ret: Op.RET, endloop: Op.ENDLOOP, label: Op.LABEL,
    pow: Op.POW, crs: Op.CRS, sgn: Op.SGN, abs: Op.ABS, nrm: Op.NRM, sincos: Op.SINCOS,
    rep: Op.REP, endrep: Op.ENDREP, if: Op.IF, else: Op.ELSE, endif: Op.ENDIF, break: Op.BREAK,
    mova: Op.MOVA, defb: Op.DEFB, defi: Op.DEFI,
    texcoord: Op.TEXCOORD, texcrd: Op.TEXCOORD, texkill: Op.TEXKILL, tex: Op.TEX, texld: Op.TEX,
    texbem: Op.TEXBEM, texbeml: Op.TEXBEML, texreg2ar: Op.TEXREG2AR, texreg2gb: Op.TEXREG2GB,
    texm3x2pad: Op.TEXM3x2PAD, texm3x2tex: Op.TEXM3x2TEX, texm3x3pad: Op.TEXM3x3PAD,
    texm3x3tex: Op.TEXM3x3TEX, texm3x3spec: Op.TEXM3x3SPEC, texm3x3vspec: Op.TEXM3x3VSPEC,
    expp: Op.EXPP, logp: Op.LOGP, cnd: Op.CND, def: Op.DEF, texreg2rgb: Op.TEXREG2RGB,
    texdp3tex: Op.TEXDP3TEX, texm3x2depth: Op.TEXM3x2DEPTH, texdp3: Op.TEXDP3, texm3x3: Op.TEXM3x3,
    texdepth: Op.TEXDEPTH, cmp: Op.CMP, bem: Op.BEM, dp2add: Op.DP2ADD, dsx: Op.DSX, dsy: Op.DSY,
    texldd: Op.TEXLDD, setp: Op.SETP, texldl: Op.TEXLDL, breakp: Op.BREAKP, phase: Op.PHASE,
};

/** Instructions with no destination register (parameters are all sources). */
const NO_DEST = new Set<Op>([Op.NOP, Op.RET, Op.ENDLOOP, Op.ENDREP, Op.ELSE, Op.ENDIF, Op.BREAK, Op.PHASE,
    Op.TEXKILL, Op.CALL, Op.CALLNZ, Op.LOOP, Op.REP, Op.IF, Op.IFC, Op.BREAKC, Op.LABEL, Op.BREAKP]);

const USAGES: Record<string, Usage | number> = {
    position: 0, blendweight: 1, blendindices: 2, normal: 3, psize: 4, texcoord: 5, tangent: 6,
    binormal: 7, tessfactor: 8, positiont: 9, color: 10, fog: 11, depth: 12, sample: 13,
};

/** Sampler/texture declaration kinds for `dcl_2d s0` and friends (D3DSAMPLER_TEXTURE_TYPE). */
const SAMPLER_KINDS: Record<string, number> = { "2d": 2, cube: 3, volume: 4 };

const COMPONENT: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

interface Register { type: RegType; num: number; relative: boolean; }

function regBits(type: number, num: number): number {
    return (((type & 0x7) << 28) | (((type >>> 3) & 0x3) << 11) | (num & 0x7ff)) >>> 0;
}

function parseRegister(text: string, isPs: boolean, line: number): Register {
    let t = text.trim();
    let relative = false;
    // c[a0.x + 12] / c[a0.x] / c[aL + n]: relative constant addressing.
    const rel = /^([a-z]+)\s*\[\s*(a0(?:\.[xyzw])?|aL)\s*(?:\+\s*(\d+))?\s*\]$/i.exec(t);
    if (rel) { t = `${rel[1]}${rel[3] ?? "0"}`; relative = true; }
    const m = /^([a-zA-Z]+)(\d*)$/.exec(t);
    if (!m) throw new ShaderAssemblyError(`bad register '${text}'`, line);
    const name = m[1]!.toLowerCase(), num = m[2] ? Number(m[2]) : 0;
    const named: Record<string, [RegType, number]> = {
        opos: [RegType.RASTOUT, 0], ofog: [RegType.RASTOUT, 1], opts: [RegType.RASTOUT, 2],
        od: [RegType.ATTROUT, num], ot: [RegType.TEXCRDOUT, num], oc: [RegType.COLOROUT, num],
        odepth: [RegType.DEPTHOUT, 0], al: [RegType.LOOP, 0], vpos: [RegType.MISCTYPE, 0], vface: [RegType.MISCTYPE, 1],
    };
    if (named[name]) return { type: named[name]![0], num: named[name]![1], relative };
    switch (name) {
        case "r": return { type: RegType.TEMP, num, relative };
        case "v": return { type: RegType.INPUT, num, relative };
        case "c": return { type: RegType.CONST, num, relative };
        case "t": return { type: isPs ? RegType.TEXTURE : RegType.TEXCRDOUT, num, relative };
        case "a": return { type: RegType.ADDR, num, relative };
        case "s": return { type: RegType.SAMPLER, num, relative };
        case "i": return { type: RegType.CONSTINT, num, relative };
        case "b": return { type: RegType.CONSTBOOL, num, relative };
        case "o": return { type: RegType.OUTPUT, num, relative };
        case "p": return { type: RegType.PREDICATE, num, relative };
        case "l": return { type: RegType.LABEL, num, relative };
    }
    throw new ShaderAssemblyError(`unknown register '${text}'`, line);
}

/** `.xyz` / `.rgb` write mask, letters in order. */
function parseWriteMask(text: string, line: number): number {
    let mask = 0, last = -1;
    for (const ch of text) {
        const c = COMPONENT[ch];
        if (c === undefined || c <= last) throw new ShaderAssemblyError(`bad write mask '.${text}'`, line);
        mask |= 1 << c; last = c;
    }
    return mask;
}

/** Swizzle: 1–4 components, the last one replicated (D3DX rule). */
function parseSwizzle(text: string, line: number): number {
    if (text.length < 1 || text.length > 4) throw new ShaderAssemblyError(`bad swizzle '.${text}'`, line);
    const comps: number[] = [];
    for (const ch of text) {
        const c = COMPONENT[ch];
        if (c === undefined) throw new ShaderAssemblyError(`bad swizzle '.${text}'`, line);
        comps.push(c);
    }
    while (comps.length < 4) comps.push(comps[comps.length - 1]!);
    return comps[0]! | (comps[1]! << 2) | (comps[2]! << 4) | (comps[3]! << 6);
}

function encodeDest(text: string, isPs: boolean, shift: number, sat: boolean, line: number): number {
    const dot = text.indexOf(".");
    const regText = dot < 0 ? text : text.slice(0, dot);
    const reg = parseRegister(regText, isPs, line);
    let mask = 0xf;
    if (dot >= 0) mask = parseWriteMask(text.slice(dot + 1), line);
    if (reg.type === RegType.ADDR && !isPs && dot < 0) mask = 0xf;
    return (regBits(reg.type, reg.num) | (mask << 16) | ((shift & 0xf) << 24) | (sat ? 1 << 20 : 0)) >>> 0;
}

const SRC_SUFFIX: Record<string, SrcMod> = {
    bias: SrcMod.BIAS, bx2: SrcMod.SIGN, x2: SrcMod.X2, dz: SrcMod.DZ, db: SrcMod.DZ, dw: SrcMod.DW, da: SrcMod.DW, abs: SrcMod.ABS,
};

function encodeSource(text: string, isPs: boolean, line: number): number {
    let t = text.trim();
    let neg = false, comp = false, not = false;
    if (t.startsWith("1-") || t.startsWith("1 -")) { comp = true; t = t.replace(/^1\s*-\s*/, ""); }
    else if (t.startsWith("-")) { neg = true; t = t.slice(1).trim(); }
    else if (t.startsWith("!")) { not = true; t = t.slice(1).trim(); }
    // Swizzle after the register (and after a _modifier suffix): r0_bx2.xyz.
    let swizzle = 0xe4;
    const dot = t.lastIndexOf(".");
    // A relative form c[a0.x+1] contains a dot inside brackets; only a dot past the closing bracket is a swizzle.
    const close = t.lastIndexOf("]");
    if (dot >= 0 && dot > close) { swizzle = parseSwizzle(t.slice(dot + 1), line); t = t.slice(0, dot); }
    let mod: SrcMod = SrcMod.NONE;
    const us = t.lastIndexOf("_");
    if (us > 0 && us > close) {
        const suffix = t.slice(us + 1).toLowerCase();
        const m = SRC_SUFFIX[suffix];
        if (m === undefined) throw new ShaderAssemblyError(`unknown source modifier '_${suffix}'`, line);
        mod = m; t = t.slice(0, us);
    }
    if (comp) { if (mod !== SrcMod.NONE) throw new ShaderAssemblyError("'1-' cannot combine with a modifier", line); mod = SrcMod.COMP; }
    else if (not) mod = SrcMod.NOT;
    else if (neg) {
        if (mod === SrcMod.NONE) mod = SrcMod.NEG;
        else if (mod === SrcMod.BIAS) mod = SrcMod.BIASNEG;
        else if (mod === SrcMod.SIGN) mod = SrcMod.SIGNNEG;
        else if (mod === SrcMod.X2) mod = SrcMod.X2NEG;
        else if (mod === SrcMod.ABS) mod = SrcMod.ABSNEG;
        else throw new ShaderAssemblyError(`'-' cannot combine with that modifier`, line);
    }
    const reg = parseRegister(t, isPs, line);
    return (regBits(reg.type, reg.num) | (swizzle << 16) | ((mod & 0xf) << 24) | (reg.relative ? 1 << 13 : 0)) >>> 0;
}

function parseFloat32Bits(text: string, line: number): number {
    const t = text.trim().replace(/f$/i, "");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) throw new ShaderAssemblyError(`bad number '${text}'`, line);
    const f = new Float32Array([Number(t)]);
    return new Uint32Array(f.buffer)[0]!;
}

/** Split on commas outside brackets. */
function splitOperands(text: string): string[] {
    const out: string[] = []; let depth = 0, cur = "";
    for (const ch of text) {
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
        else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/**
 * Assemble D3DX shader text into D3D9 bytecode tokens. Throws
 * ShaderAssemblyError with the 1-based line on the first error.
 */
export function assembleShader(source: string): Uint32Array {
    const tokens: number[] = [];
    const lines = source.split(/\r?\n/);
    let isPs = false, major = 0, minor = 0, seenVersion = false;
    for (let li = 0; li < lines.length; li++) {
        const lineNo = li + 1;
        let text = lines[li]!;
        const semi = text.indexOf(";"), slashes = text.indexOf("//");
        let cut = text.length;
        if (semi >= 0) cut = Math.min(cut, semi);
        if (slashes >= 0) cut = Math.min(cut, slashes);
        text = text.slice(0, cut).trim();
        if (!text) continue;
        if (!seenVersion) {
            const v = /^(ps|vs)[._](\d)[._](\d|x|sw)$/i.exec(text);
            if (!v) throw new ShaderAssemblyError(`expected a version (ps.1.1 / vs_1_1), got '${text}'`, lineNo);
            isPs = v[1]!.toLowerCase() === "ps"; major = Number(v[2]);
            minor = v[3] === "x" ? 1 : v[3] === "sw" ? 0 : Number(v[3]);
            if (v[3] === "x") minor = 0xff;
            tokens.push((((isPs ? 0xffff : 0xfffe) << 16) | (major << 8) | minor) >>> 0);
            seenVersion = true;
            continue;
        }
        // Optional co-issue marker.
        let coissue = false;
        if (text.startsWith("+")) { coissue = true; text = text.slice(1).trim(); }
        const sp = text.search(/\s/);
        const head = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
        const rest = sp < 0 ? "" : text.slice(sp + 1).trim();
        const operands = splitOperands(rest);
        // dcl_position v0 / dcl_texcoord1 v2 / dcl_2d s0 / dcl t0.
        if (head === "dcl" || head.startsWith("dcl_")) {
            if (operands.length !== 1) throw new ShaderAssemblyError("dcl takes one register", lineNo);
            const dest = encodeDest(operands[0]!, isPs, 0, false, lineNo);
            const spec = head === "dcl" ? "" : head.slice(4);
            let dclToken = 0;
            if (spec) {
                const sk = SAMPLER_KINDS[spec];
                if (sk !== undefined) dclToken = (sk << 27) >>> 0;
                else {
                    const um = /^([a-z]+)(\d*)$/.exec(spec);
                    const usage = um ? USAGES[um[1]!] : undefined;
                    if (usage === undefined) throw new ShaderAssemblyError(`unknown declaration '${head}'`, lineNo);
                    dclToken = (usage | ((um![2] ? Number(um![2]) : 0) << 16)) >>> 0;
                }
            }
            tokens.push(instrToken(Op.DCL, 2, major, coissue), (dclToken | 0x80000000) >>> 0, dest);
            continue;
        }
        // Opcode with modifiers: mul_x2_sat, texld_pp, dp3_sat, add_d2.
        const parts = head.split("_");
        const name = parts[0]!;
        const op = OPCODES[name];
        if (op === undefined) throw new ShaderAssemblyError(`unknown instruction '${name}'`, lineNo);
        let shift = 0, sat = false;
        for (const mod of parts.slice(1)) {
            switch (mod) {
                case "sat": sat = true; break;
                case "x2": shift = 1; break;
                case "x4": shift = 2; break;
                case "x8": shift = 3; break;
                case "d2": shift = 0xf; break;
                case "d4": shift = 0xe; break;
                case "d8": shift = 0xd; break;
                case "pp": break; // partial precision: no token bit in SM1/2 that the recompiler reads
                default: throw new ShaderAssemblyError(`unknown instruction modifier '_${mod}'`, lineNo);
            }
        }
        if (op === Op.DEF) {
            if (operands.length !== 5) throw new ShaderAssemblyError("def takes a register and four numbers", lineNo);
            tokens.push(instrToken(op, 5, major, coissue), encodeDest(operands[0]!, isPs, 0, false, lineNo));
            for (let k = 1; k <= 4; k++) tokens.push(parseFloat32Bits(operands[k]!, lineNo));
            continue;
        }
        if (op === Op.DEFI || op === Op.DEFB) {
            const n = op === Op.DEFI ? 4 : 1;
            if (operands.length !== n + 1) throw new ShaderAssemblyError(`${name} takes a register and ${n} integer(s)`, lineNo);
            tokens.push(instrToken(op, n + 1, major, coissue), encodeDest(operands[0]!, isPs, 0, false, lineNo));
            for (let k = 1; k <= n; k++) {
                const t = operands[k]!.toLowerCase();
                const v = t === "true" ? 1 : t === "false" ? 0 : Number(t);
                if (!Number.isFinite(v)) throw new ShaderAssemblyError(`bad integer '${operands[k]}'`, lineNo);
                tokens.push(v >>> 0);
            }
            continue;
        }
        if (op === Op.PHASE || op === Op.NOP || op === Op.RET || op === Op.ENDLOOP || op === Op.ENDREP
            || op === Op.ELSE || op === Op.ENDIF || op === Op.BREAK) {
            if (operands.length) throw new ShaderAssemblyError(`${name} takes no operand`, lineNo);
            tokens.push(instrToken(op, 0, major, coissue));
            continue;
        }
        if (operands.length === 0) throw new ShaderAssemblyError(`${name} needs operands`, lineNo);
        const params: number[] = [];
        if (NO_DEST.has(op)) {
            for (const o of operands) params.push(encodeSource(o, isPs, lineNo));
        } else {
            params.push(encodeDest(operands[0]!, isPs, shift, sat, lineNo));
            for (const o of operands.slice(1)) params.push(encodeSource(o, isPs, lineNo));
        }
        tokens.push(instrToken(op, params.length, major, coissue), ...params);
    }
    if (!seenVersion) throw new ShaderAssemblyError("empty shader", lines.length);
    tokens.push(END_TOKEN);
    return Uint32Array.from(tokens);
}

/** Instruction token: opcode, parameter count in bits 24–27 from SM 2.0 on, co-issue bit 30. */
function instrToken(op: Op, paramCount: number, major: number, coissue: boolean): number {
    return ((op & 0xffff) | (major >= 2 ? (paramCount & 0xf) << 24 : 0) | (coissue ? 0x40000000 : 0)) >>> 0;
}
