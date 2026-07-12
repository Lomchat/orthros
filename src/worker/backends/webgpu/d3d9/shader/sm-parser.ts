/**
 * sm-parser.ts — Direct3D 9 shader bytecode (DXSO) → typed IR.
 *
 * Decodes the DWORD token stream produced by D3DXAssembleShader / fxc into a
 * structured program. Handles both vertex and pixel shaders, SM1.x (no length
 * field — walked via the fixed operand table) and SM2/3 (length field in token).
 *
 * The register-type field is split across two bit-fields per the D3D9 ABI:
 *   regType = ((token >> 28) & 0x7) | (((token >> 11) & 0x3) << 3)
 * (bits 28-30 are the LOW three bits, bits 11-12 the HIGH two). Getting this
 * wrong silently remaps every register class — see d3d9types.h D3DSP_REGTYPE_*.
 */

import {
    Op, RegType, DEFAULT_LEN, NO_DST, opName,
} from "./sm-enums";

// ── IR types ──────────────────────────────────────────────────────────────────

export interface SmRegister {
    type: RegType;
    num: number;
    /** Constant-relative addressing (c[a0.x + num]) — SM1.x implies a0. */
    relative: boolean;
}

export interface SmDest {
    reg: SmRegister;
    writeMask: number;      // bit0=x … bit3=w
    shift: number;          // signed result shift: +1=_x2 … -3=_d8
    saturate: boolean;      // _sat
}

export interface SmSource {
    reg: SmRegister;
    swizzle: number;        // 8 bits, 2 per component
    modifier: number;       // SrcMod
}

export interface SmInstruction {
    opcode: Op;
    coissue: boolean;       // "+" co-issued (ps_1_x .rgb/.a pairing)
    specificData: number;   // bits 16-23 (comparison / texld mode)
    dst: SmDest | null;
    src: SmSource[];
}

export interface SmDcl {
    usage: number;
    usageIndex: number;
    textureType: number;
    reg: SmRegister;
}

export interface SmDef {
    reg: SmRegister;
    values: Float32Array;   // 4 floats (int defs reinterpreted as float bits → use rawInt)
    rawInt: Int32Array;     // 4 ints (for defi/defb)
    kind: "f" | "i" | "b";
}

export interface SmProgram {
    isPixelShader: boolean;
    major: number;
    minor: number;
    instructions: SmInstruction[];
    declarations: SmDcl[];
    definitions: SmDef[];
    /** Highest temp register index referenced (-1 if none). */
    maxTemp: number;
    /** Highest float-constant register index referenced (-1 if none). */
    maxConst: number;
    /** Texture/sampler stages referenced (PS) or input regs (VS). */
    samplersUsed: Set<number>;
    inputRegs: Set<number>;
    /** True if any constant source uses relative (a0) addressing. */
    usesRelativeConst: boolean;
}

/** Output rows (= consecutive const regs read) for matrix-multiply macro ops. */
const MATRIX_ROWS: Record<number, number> = {
    [Op.M4x4]: 4, [Op.M4x3]: 3, [Op.M3x4]: 4, [Op.M3x3]: 3, [Op.M3x2]: 2,
};

// ── Bit decoders ──────────────────────────────────────────────────────────────

function decodeRegType(token: number): RegType {
    return (((token >>> 28) & 0x7) | (((token >>> 11) & 0x3) << 3)) as RegType;
}

function decodeRegNum(token: number): number {
    return token & 0x7FF;
}

function makeRegister(token: number): SmRegister {
    return {
        type: decodeRegType(token),
        num: decodeRegNum(token),
        relative: (token & (1 << 13)) !== 0,
    };
}

function decodeDst(token: number): SmDest {
    let shift = (token >>> 24) & 0xF;
    if (shift & 0x8) shift -= 16; // sign-extend 4-bit two's complement
    return {
        reg: makeRegister(token),
        writeMask: (token >>> 16) & 0xF,
        shift,
        saturate: (token & (1 << 20)) !== 0,
    };
}

function decodeSrc(token: number): SmSource {
    return {
        reg: makeRegister(token),
        swizzle: (token >>> 16) & 0xFF,
        modifier: (token >>> 24) & 0xF,
    };
}

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a D3D9 shader bytecode token stream.
 * @param tokens Uint32Array of DWORD tokens read from guest memory.
 */
export function parseShader(tokens: Uint32Array): SmProgram {
    if (tokens.length < 2) throw new Error("Shader bytecode too short");

    const version = tokens[0] >>> 0;
    const progType = (version >>> 16) & 0xFFFF;
    const isPixelShader = progType === 0xFFFF;
    if (progType !== 0xFFFF && progType !== 0xFFFE) {
        throw new Error(`Not a shader: version 0x${version.toString(16)}`);
    }
    const major = (version >>> 8) & 0xFF;
    const minor = version & 0xFF;

    const instructions: SmInstruction[] = [];
    const declarations: SmDcl[] = [];
    const definitions: SmDef[] = [];
    let maxTemp = -1;
    let maxConst = -1;
    let usesRelativeConst = false;
    const samplersUsed = new Set<number>();
    const inputRegs = new Set<number>();

    const trackReg = (reg: SmRegister) => {
        if (reg.type === RegType.TEMP && reg.num > maxTemp) maxTemp = reg.num;
        if (reg.type === RegType.CONST) {
            if (reg.num > maxConst) maxConst = reg.num;
            if (reg.relative) usesRelativeConst = true;
        }
        if (reg.type === RegType.INPUT) inputRegs.add(reg.num);
    };

    let i = 1; // skip version token
    let guard = 0;
    const ps14 = isPixelShader && major === 1 && minor === 4;

    while (i < tokens.length) {
        if (++guard > 100000) throw new Error("Shader parse runaway");
        const instrToken = tokens[i] >>> 0;
        const opcode = (instrToken & 0xFFFF) as Op;

        if (opcode === Op.END || instrToken === 0x0000FFFF) break;

        if (opcode === Op.COMMENT) {
            const len = (instrToken >>> 16) & 0x7FFF;
            i += 1 + len;
            continue;
        }
        if (opcode === Op.PHASE) {
            // ps_1_4 phase separator — no operands, no emitted code.
            i += 1;
            continue;
        }

        i += 1; // consume instruction token

        // Operand length
        let length: number;
        if (major >= 2) {
            length = (instrToken >>> 24) & 0xF;
        } else {
            const base = DEFAULT_LEN[opcode];
            if (base === undefined) {
                throw new Error(`Unknown opcode ${opName(opcode)} (0x${opcode.toString(16)}) at token ${i - 1}`);
            }
            length = base;
            if (ps14 && (opcode === Op.TEX || opcode === Op.TEXCOORD)) length += 1;
        }

        // DCL — [dcl token][dst token]
        if (opcode === Op.DCL) {
            const dclToken = tokens[i++] >>> 0;
            const regToken = tokens[i++] >>> 0;
            const reg = makeRegister(regToken);
            declarations.push({
                usage: dclToken & 0xF,
                usageIndex: (dclToken >>> 16) & 0xF,
                textureType: (dclToken >>> 27) & 0xF,
                reg,
            });
            if (reg.type === RegType.SAMPLER) samplersUsed.add(reg.num);
            trackReg(reg);
            continue;
        }

        // DEF / DEFI — [dst token][4 value tokens]; DEFB — [dst token][1 value]
        if (opcode === Op.DEF || opcode === Op.DEFI || opcode === Op.DEFB) {
            const regToken = tokens[i++] >>> 0;
            const reg = makeRegister(regToken);
            const valueCount = opcode === Op.DEFB ? 1 : 4;
            const raw = new Uint32Array(4);
            for (let v = 0; v < valueCount; v++) raw[v] = tokens[i++] >>> 0;
            definitions.push({
                reg,
                values: new Float32Array(raw.buffer.slice(0)),
                rawInt: new Int32Array(raw.buffer.slice(0)),
                kind: opcode === Op.DEF ? "f" : opcode === Op.DEFI ? "i" : "b",
            });
            if (reg.type === RegType.CONST && reg.num > maxConst) maxConst = reg.num;
            continue;
        }

        // Generic instruction: optional dst + N source operands
        const hasDst = !NO_DST.has(opcode);
        let dst: SmDest | null = null;
        let consumed = 0;

        if (hasDst) {
            dst = decodeDst(tokens[i++] >>> 0);
            consumed += 1;
            trackReg(dst.reg);
            if (dst.reg.type === RegType.SAMPLER) samplersUsed.add(dst.reg.num);
            // ps_1_1-1_3 implicit sampler = texture-coord register number for tex.
            if (isPixelShader && major === 1 && !ps14 &&
                (opcode === Op.TEX || opcode === Op.TEXCOORD) &&
                dst.reg.type === RegType.TEXTURE) {
                samplersUsed.add(dst.reg.num);
            }
        }

        const srcCount = Math.max(0, length - consumed);
        const src: SmSource[] = [];
        for (let s = 0; s < srcCount; s++) {
            const srcToken = tokens[i++] >>> 0;
            const operand = decodeSrc(srcToken);
            // SM2+ relative addressing consumes an extra token (the rel register).
            if (major >= 2 && operand.reg.relative) i++;
            trackReg(operand.reg);
            if (operand.reg.type === RegType.SAMPLER) samplersUsed.add(operand.reg.num);
            src.push(operand);
        }

        // ps_1_4 texld / SM2+ texld: sampler is an explicit source register.
        if (opcode === Op.TEX && isPixelShader) {
            if (ps14 && src.length >= 1 && dst) samplersUsed.add(dst.reg.num);
            if (major >= 2 && src.length >= 2) samplersUsed.add(src[1].reg.num);
        }

        // Matrix-multiply macro ops read N consecutive constant registers from
        // the base in src[1]; extend maxConst so the WGSL array covers them.
        const rows = MATRIX_ROWS[opcode];
        if (rows && src.length >= 2 && src[1].reg.type === RegType.CONST && !src[1].reg.relative) {
            const top = src[1].reg.num + rows - 1;
            if (top > maxConst) maxConst = top;
        }

        instructions.push({
            opcode,
            coissue: (instrToken & 0x40000000) !== 0,
            specificData: (instrToken >>> 16) & 0xFF,
            dst,
            src,
        });
    }

    return {
        isPixelShader,
        major,
        minor,
        instructions,
        declarations,
        definitions,
        maxTemp,
        maxConst,
        samplersUsed,
        inputRegs,
        usesRelativeConst,
    };
}
