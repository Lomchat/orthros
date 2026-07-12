/**
 * EAGL token-dispatch guest filter — byte-layout + routing tests.
 *
 * The filter is hand-assembled x86 (token-dispatch-filter.ts); a mis-encoded
 * rel32 or a wrong ModRM silently corrupts control flow at 1M calls/s, so this
 * test (a) pins the encoding via a tiny symbolic executor that walks exactly
 * the instructions the assembler is allowed to emit, and (b) verifies the
 * routing decision — {1,2,8} → stub, class 6 → stub unless commit mode
 * ([ecx+0x84]) is 2 (state-block record → original), everything else →
 * trampoline, disarmed → trampoline, alias-node indirection honored —
 * against a synthetic guest memory image. Mirrors
 * thunk-stub-emitters.test.ts's role for the WBUF trampolines.
 */

import { describe, expect, test } from 'bun:test';
import {
    FILTER_ENABLED_FLAG_OFF,
    assembleTokenDispatchFilter,
    tokenDispatchFilterSize,
} from '../../src/worker/core/hle-lib/libs/eagl/token-dispatch-filter';

const FILTER = 0x2114_0000;
const CFG = 0x0060_0000;
const TBL = 0x006d_c274;
const STUB = 0x2100_0100;
const TRAMP = 0x2100_0200;
const NODE = 0x0070_0000;
const ALIAS = 0x0070_4000;

/** Build a 16MB-ish sparse memory via Map-backed accessor (only pages we touch). */
class MiniMem {
    private m = new Map<number, number>();
    read8(a: number): number { return this.m.get(a >>> 0) ?? 0; }
    write8(a: number, v: number): void { this.m.set(a >>> 0, v & 0xff); }
    read32(a: number): number {
        return (this.read8(a) | (this.read8(a + 1) << 8) | (this.read8(a + 2) << 16) | (this.read8(a + 3) << 24)) >>> 0;
    }
    write32(a: number, v: number): void {
        for (let i = 0; i < 4; i++) this.write8(a + i, (v >>> (i * 8)) & 0xff);
    }
    load(base: number, bytes: Uint8Array): void {
        for (let i = 0; i < bytes.length; i++) this.write8(base + i, bytes[i]);
    }
}

/**
 * Execute the filter symbolically: supports exactly the encodings the
 * assembler emits. Returns the final jump target ('stub' | 'tramp') plus a
 * trace. Throws on any unrecognized byte — encoding drift fails loudly.
 */
function runFilter(mem: MiniMem, entry: number, regs: { ecx: number; esp: number }): 'stub' | 'tramp' {
    let eip = entry >>> 0;
    let eax = 0, edx = 0;
    let zf = false;
    const esp = regs.esp >>> 0;
    const ecx = regs.ecx >>> 0;
    for (let steps = 0; steps < 64; steps++) {
        const b0 = mem.read8(eip), b1 = mem.read8(eip + 1);
        if (b0 === 0x80 && b1 === 0x3d) {           // cmp byte [imm32], imm8
            const addr = mem.read32(eip + 2), imm = mem.read8(eip + 6);
            zf = mem.read8(addr) === imm;
            eip += 7;
        } else if (b0 === 0x0f && (b1 === 0x84 || b1 === 0x85)) { // jz/jnz rel32
            const rel = mem.read32(eip + 2) | 0;
            const take = b1 === 0x84 ? zf : !zf;
            eip = take ? (eip + 6 + rel) >>> 0 : eip + 6;
        } else if (b0 === 0x83 && b1 === 0xb9) {    // cmp dword [ecx+disp32], imm8
            const disp = mem.read32(eip + 2) | 0;
            const imm = (mem.read8(eip + 6) << 24) >> 24;
            zf = (mem.read32((ecx + disp) >>> 0) | 0) === imm;
            eip += 7;
        } else if (b0 === 0x8b && b1 === 0x54 && mem.read8(eip + 2) === 0x24) { // mov edx,[esp+d8]
            edx = mem.read32(esp + mem.read8(eip + 3));
            eip += 4;
        } else if (b0 === 0x85 && b1 === 0xd2) {    // test edx, edx
            zf = edx === 0;
            eip += 2;
        } else if (b0 === 0x8b && b1 === 0x02) {    // mov eax, [edx]
            eax = mem.read32(edx);
            eip += 2;
        } else if (b0 === 0x83 && b1 === 0xf8) {    // cmp eax, imm8 (sign-extended)
            const imm = (mem.read8(eip + 2) << 24) >> 24;
            zf = (eax | 0) === imm;
            eip += 3;
        } else if (b0 === 0x75) {                   // jne rel8
            const rel = (mem.read8(eip + 1) << 24) >> 24;
            eip = zf ? eip + 2 : (eip + 2 + rel) >>> 0;
        } else if (b0 === 0x8b && b1 === 0x52) {    // mov edx, [edx+d8]
            edx = mem.read32(edx + mem.read8(eip + 2));
            eip += 3;
        } else if (b0 === 0x6b && b1 === 0xc0) {    // imul eax, eax, imm8
            eax = Math.imul(eax, mem.read8(eip + 2)) >>> 0;
            eip += 3;
        } else if (b0 === 0x8b && b1 === 0x80) {    // mov eax, [eax+imm32]
            eax = mem.read32((eax + mem.read32(eip + 2)) >>> 0);
            eip += 6;
        } else if (b0 === 0xc1 && b1 === 0xe8) {    // shr eax, imm8
            eax = eax >>> mem.read8(eip + 2);
            eip += 3;
        } else if (b0 === 0xe9) {                   // jmp rel32
            const rel = mem.read32(eip + 1) | 0;
            const target = (eip + 5 + rel) >>> 0;
            if (target === STUB) return 'stub';
            if (target === TRAMP) return 'tramp';
            throw new Error(`jmp to unexpected 0x${target.toString(16)}`);
        } else {
            throw new Error(`unrecognized byte 0x${b0.toString(16)} at +0x${(eip - entry).toString(16)}`);
        }
    }
    throw new Error('filter did not terminate in 64 steps');
}

const CTX = 0x0071_0000; // ECX = EAGL device ctx; commit mode at +0x84

function setup(opts: { armed: boolean; token: number; cls: number; alias?: boolean; mode?: number }): { mem: MiniMem; esp: number; ecx: number } {
    const mem = new MiniMem();
    mem.load(FILTER, assembleTokenDispatchFilter(FILTER, CFG, TBL, STUB, TRAMP));
    mem.write8(CFG + FILTER_ENABLED_FLAG_OFF, opts.armed ? 1 : 0);
    // token descriptor: class<<24 | enum
    mem.write32(TBL + opts.token * 0x1c, ((opts.cls << 24) | 0x000123) >>> 0);
    mem.write32(CTX + 0x84, opts.mode ?? 3); // commit mode (3 = direct apply)
    const esp = 0x0080_0000;
    mem.write32(esp + 4, NODE);       // arg0 = node
    mem.write32(esp + 8, 0xffffffff); // arg1 = stage (unused by filter)
    if (opts.alias) {
        mem.write32(NODE, 0xffffffff);    // node[0] = -1 → alias
        mem.write32(NODE + 0x64, ALIAS);  // node[0x19]
        mem.write32(ALIAS, opts.token);
    } else {
        mem.write32(NODE, opts.token);
    }
    return { mem, esp, ecx: CTX };
}

describe('eagl token-dispatch filter', () => {
    test('size is stable and address-independent', () => {
        const n = tokenDispatchFilterSize();
        expect(n).toBeGreaterThan(60);
        expect(assembleTokenDispatchFilter(0x9990_0000, CFG, TBL, STUB, TRAMP).length).toBe(n);
    });

    test('disarmed gate routes EVERYTHING to the original', () => {
        for (const cls of [1, 2, 8, 3, 6]) {
            const { mem, esp, ecx } = setup({ armed: false, token: 7, cls });
            expect(runFilter(mem, FILTER, { ecx, esp })).toBe('tramp');
        }
    });

    test('armed: classes 1/2/8 → stub', () => {
        for (const cls of [1, 2, 8]) {
            const { mem, esp, ecx } = setup({ armed: true, token: 7, cls });
            expect(runFilter(mem, FILTER, { ecx, esp })).toBe('stub');
        }
    });

    test('armed: classes 3/4/5/7/9/10 → original', () => {
        for (const cls of [3, 4, 5, 7, 9, 10]) {
            const { mem, esp, ecx } = setup({ armed: true, token: 7, cls });
            expect(runFilter(mem, FILTER, { ecx, esp })).toBe('tramp');
        }
    });

    test('armed: class 6 → stub in modes 1/3, original in record mode 2', () => {
        for (const mode of [1, 3]) {
            const { mem, esp, ecx } = setup({ armed: true, token: 7, cls: 6, mode });
            expect(runFilter(mem, FILTER, { ecx, esp })).toBe('stub');
        }
        const rec = setup({ armed: true, token: 7, cls: 6, mode: 2 });
        expect(runFilter(rec.mem, FILTER, { ecx: rec.ecx, esp: rec.esp })).toBe('tramp');
    });

    test('null node → original (same #PF surface as guest)', () => {
        const { mem, esp, ecx } = setup({ armed: true, token: 7, cls: 1 });
        mem.write32(esp + 4, 0);
        expect(runFilter(mem, FILTER, { ecx, esp })).toBe('tramp');
    });

    test('alias node (token -1 → node[0x19]) is followed', () => {
        const { mem, esp, ecx } = setup({ armed: true, token: 9, cls: 8, alias: true });
        expect(runFilter(mem, FILTER, { ecx, esp })).toBe('stub');
        // and a non-hot class through the alias goes to the original
        const t2 = setup({ armed: true, token: 9, cls: 4, alias: true });
        expect(runFilter(t2.mem, FILTER, { ecx: t2.ecx, esp: t2.esp })).toBe('tramp');
        // class 6 through the alias honors the mode gate
        const t3 = setup({ armed: true, token: 9, cls: 6, alias: true, mode: 2 });
        expect(runFilter(t3.mem, FILTER, { ecx: t3.ecx, esp: t3.esp })).toBe('tramp');
        const t4 = setup({ armed: true, token: 9, cls: 6, alias: true, mode: 3 });
        expect(runFilter(t4.mem, FILTER, { ecx: t4.ecx, esp: t4.esp })).toBe('stub');
    });

    test('token stride is 0x1c (descriptor for token N read at TBL+N*0x1c)', () => {
        const { mem, esp, ecx } = setup({ armed: true, token: 3, cls: 1 });
        // poison the neighbours — routing must still come from token 3's slot
        mem.write32(TBL + 2 * 0x1c, (4 << 24) >>> 0);
        mem.write32(TBL + 4 * 0x1c, (4 << 24) >>> 0);
        expect(runFilter(mem, FILTER, { ecx, esp })).toBe('stub');
    });
});
