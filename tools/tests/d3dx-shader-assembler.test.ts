import { describe, expect, test } from "bun:test";
import { assembleShader, ShaderAssemblyError } from "../../src/worker/modules/d3dx9/shader-assembler";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import { Op, RegType, SrcMod } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";

const END = 0x0000ffff;
function regBits(type: number, num: number): number {
    return (((type & 0x7) << 28) | (((type >>> 3) & 0x3) << 11) | (num & 0x7ff)) >>> 0;
}
function dst(type: number, num: number, mask = 0xf, shift = 0, sat = false): number {
    return (regBits(type, num) | (mask << 16) | ((shift & 0xf) << 24) | (sat ? 1 << 20 : 0)) >>> 0;
}
function src(type: number, num: number, swizzle = 0xe4, mod = 0, relative = false): number {
    return (regBits(type, num) | (swizzle << 16) | ((mod & 0xf) << 24) | (relative ? 1 << 13 : 0)) >>> 0;
}
const f32 = (v: number): number => new Uint32Array(new Float32Array([v]).buffer)[0]!;

describe("D3DX shader assembler", () => {
    test("ps.1.1 terrain-style shader: exact tokens and a parse round trip", () => {
        const text = [
            "ps.1.1",
            "; two texture stages modulated with the diffuse colour",
            "def c0, 1.0, 0.5, 0.25, 0",
            "tex t0",
            "tex t1",
            "mul r0, t0, v0   // diffuse",
            "mad_sat r0.rgb, r0, t1_bx2, c0",
            "+mov r0.a, v0.a",
        ].join("\n");
        const tokens = assembleShader(text);
        expect(Array.from(tokens)).toEqual([
            0xffff0101,
            Op.DEF, dst(RegType.CONST, 0), f32(1), f32(0.5), f32(0.25), f32(0),
            Op.TEX, dst(RegType.TEXTURE, 0),
            Op.TEX, dst(RegType.TEXTURE, 1),
            Op.MUL, dst(RegType.TEMP, 0), src(RegType.TEXTURE, 0), src(RegType.INPUT, 0),
            Op.MAD, dst(RegType.TEMP, 0, 0x7, 0, true), src(RegType.TEMP, 0), src(RegType.TEXTURE, 1, 0xe4, SrcMod.SIGN), src(RegType.CONST, 0),
            (Op.MOV | 0x40000000) >>> 0, dst(RegType.TEMP, 0, 0x8), src(RegType.INPUT, 0, 0xff),
            END,
        ]);
        const prog = parseShader(tokens);
        expect(prog.isPixelShader).toBe(true);
        // def becomes a constant, not an instruction.
        expect(prog.instructions.map((i) => i.opcode)).toEqual([Op.TEX, Op.TEX, Op.MUL, Op.MAD, Op.MOV]);
        expect([...prog.samplersUsed].sort()).toEqual([0, 1]);
    });

    test("vs_1_1: declarations, relative constants, swizzles, output registers", () => {
        const tokens = assembleShader([
            "vs_1_1",
            "dcl_position v0",
            "dcl_texcoord1 v2",
            "mov a0.x, c4.x",
            "m4x4 oPos, v0, c[a0.x + 8]",
            "mov oT1.xy, v2",
            "add oD0, -v0.zyxw, c3.w",
        ].join("\n"));
        expect(tokens[0]).toBe(0xfffe0101);
        expect(Array.from(tokens.slice(1, 4))).toEqual([Op.DCL, 0x80000000 >>> 0, dst(RegType.INPUT, 0)]);
        expect(Array.from(tokens.slice(4, 7))).toEqual([Op.DCL, (0x80000000 | 5 | (1 << 16)) >>> 0, dst(RegType.INPUT, 2)]);
        expect(Array.from(tokens.slice(7, 10))).toEqual([Op.MOV, dst(RegType.ADDR, 0, 0x1), src(RegType.CONST, 4, 0x00)]);
        expect(Array.from(tokens.slice(10, 14))).toEqual([Op.M4x4, dst(RegType.RASTOUT, 0), src(RegType.INPUT, 0), src(RegType.CONST, 8, 0xe4, 0, true)]);
        expect(Array.from(tokens.slice(14, 17))).toEqual([Op.MOV, dst(RegType.TEXCRDOUT, 1, 0x3), src(RegType.INPUT, 2)]);
        // -v0.zyxw: swizzle z,y,x,w = 2 | 1<<2 | 0<<4 | 3<<6
        expect(Array.from(tokens.slice(17, 21))).toEqual([Op.ADD, dst(RegType.ATTROUT, 0), src(RegType.INPUT, 0, 2 | (1 << 2) | (3 << 6), SrcMod.NEG), src(RegType.CONST, 3, 0xff)]);
        expect(tokens[tokens.length - 1]).toBe(END);
        const prog = parseShader(tokens);
        expect(prog.isPixelShader).toBe(false);
    });

    test("ps_1_4 phase, texld, and result shifts", () => {
        const tokens = assembleShader("ps_1_4\ntexld r0, t0\nphase\nmul_x2 r0, r0, 1-r1\ncnd_d2 r0, r0.a, r1, c0");
        expect(Array.from(tokens)).toEqual([
            0xffff0104,
            Op.TEX, dst(RegType.TEMP, 0), src(RegType.TEXTURE, 0),
            Op.PHASE,
            Op.MUL, dst(RegType.TEMP, 0, 0xf, 1), src(RegType.TEMP, 0), src(RegType.TEMP, 1, 0xe4, SrcMod.COMP),
            Op.CND, dst(RegType.TEMP, 0, 0xf, 0xf), src(RegType.TEMP, 0, 0xff), src(RegType.TEMP, 1), src(RegType.CONST, 0),
            END,
        ]);
    });

    test("SM2: parameter counts in the instruction token, sampler declarations", () => {
        const tokens = assembleShader("ps_2_0\ndcl_2d s0\ndcl t0.xy\ntexld r0, t0, s0\nmov oC0, r0");
        expect(tokens[0]).toBe(0xffff0200);
        expect(tokens[1]).toBe((Op.DCL | (2 << 24)) >>> 0);
        expect(tokens[2]).toBe((0x80000000 | (2 << 27)) >>> 0);
        expect(tokens[7]).toBe((Op.TEX | (3 << 24)) >>> 0);
        expect(tokens[11]).toBe((Op.MOV | (2 << 24)) >>> 0);
        expect(tokens[12]).toBe(dst(RegType.COLOROUT, 0));
    });

    test("errors name the line", () => {
        expect(() => assembleShader("ps.1.1\nmov r0, q7")).toThrow(ShaderAssemblyError);
        try { assembleShader("ps.1.1\ntex t0\nfrob r0, r1"); } catch (e) {
            expect((e as ShaderAssemblyError).line).toBe(3);
            expect(String((e as Error).message)).toContain("unknown instruction 'frob'");
        }
        expect(() => assembleShader("mov r0, r1")).toThrow(/version/);
        expect(() => assembleShader("ps.1.1\nmov r0.xzy, r1")).toThrow(/write mask/);
    });
});
