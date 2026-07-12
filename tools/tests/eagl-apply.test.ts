/**
 * EAGL apply-converter kernels (FUN_005c85c1 / FUN_005c8303 / FUN_005cad01) —
 * correctness against reference implementations transcribed 1:1 from the
 * Ghidra decompilation (re decompile, NFSU retail speed.exe, 2026-07-10),
 * independently of the kernels' shared engine.
 *
 * Covers: all modes per family, budget exhaustion mid-walk (sticky clamp),
 * multi-item src striding, transposed element order, by-ref cursor updates,
 * class-5 container recursion (incl. FUN_005cad01 recursing into the
 * REGISTER-layout FUN_005c8303), and the E_FAIL no-write paths.
 */

import { describe, expect, test } from 'bun:test';
import { ftolExact } from '../../src/worker/core/hle-lib/libs/eagl/kernel';
import {
    applyPackedKernel,
    applyRegisterFloatKernel,
    applyRegisterIntKernel,
} from '../../src/worker/core/hle-lib/libs/eagl/apply-kernels';
import { LiveShadowView } from '../../src/worker/core/hle-lib/shadow-validator';

const MEM = 0x40000;
const E_FAIL = 0x80004005;

// Guest layout for the tests: cursor cells + descriptor + data areas.
const DESC_CUR = 0x100, SRC_CUR = 0x104, DST_CUR = 0x108, BUDGET = 0x10c;
const DESC = 0x1000, SRC = 0x4000, DST = 0x10000;

interface Env { mem: Uint8Array; dv: DataView; view: LiveShadowView }

function mkEnv(): Env {
    const mem = new Uint8Array(MEM);
    const dv = new DataView(mem.buffer);
    dv.setUint32(DESC_CUR, DESC, true);
    dv.setUint32(SRC_CUR, SRC, true);
    dv.setUint32(DST_CUR, DST, true);
    return { mem, dv, view: new LiveShadowView(mem) };
}

function writeDesc(dv: DataView, at: number, d: { mode?: number; cls: number; items?: number; rows?: number; cols?: number }): void {
    dv.setUint32(at + 0x00, d.mode ?? 0, true);
    dv.setUint32(at + 0x04, d.cls >>> 0, true);
    dv.setUint32(at + 0x10, d.items ?? 0, true);
    dv.setUint32(at + 0x14, d.rows ?? 0, true);
    dv.setUint32(at + 0x18, d.cols ?? 0, true);
}

/* ─── Reference: transcribed straight from the Ghidra decompilation ───────── */

/** FUN_005c85c1 / FUN_005c8303 shared shape (register layout); `family`
 *  selects the element ops exactly as decompiled per function. */
function refRegister(dv: DataView, family: 'int' | 'float', depth = 0): number {
    if (depth > 16) throw new Error('ref recursion runaway');
    const d = dv.getUint32(DESC_CUR, true);
    const cls = dv.getInt32(d + 4, true);
    let items = dv.getUint32(d + 0x10, true);
    if (items === 0) items = 1;
    if (cls < 0) return E_FAIL | 0;
    if (cls < 4) {
        const rows = dv.getUint32(d + 0x14, true);
        const cols = dv.getUint32(d + 0x18, true);
        const mode = dv.getUint32(d, true);
        const regsInit = ((rows & 3) !== 0 ? 1 : 0) + (rows >>> 2);
        let regs = regsInit;
        let elems = rows;
        if (mode < 1 || mode > 3) return E_FAIL | 0;
        for (let i = 0; i < items; i++) {
            if (dv.getUint32(BUDGET, true) === 0) break;
            for (let j = 0; j < cols; j++) {
                const rem = dv.getUint32(BUDGET, true);
                if (rem === 0) break;
                if (rem < regsInit) { elems = rem * 4; regs = rem; }
                for (let e = 0; e < elems; e++) {
                    const s = dv.getUint32(SRC_CUR, true) + j * 4 + e * cols * 4;
                    const dst = dv.getUint32(DST_CUR, true) + e * 4;
                    if (family === 'int') {
                        if (mode === 1) dv.setFloat32(dst, dv.getInt32(s, true), true);
                        else if (mode === 2) {
                            let f = dv.getInt32(s, true);
                            let v = f as number;
                            if (f < 0) v = f + 4294967296;
                            dv.setFloat32(dst, v, true);
                        } else dv.setFloat32(dst, dv.getFloat32(s, true), true);
                    } else {
                        if (mode === 3) dv.setUint32(dst, ftolExact(dv.getFloat32(s, true)) >>> 0, true);
                        else dv.setUint32(dst, dv.getUint32(s, true), true);
                    }
                }
                dv.setUint32(DST_CUR, dv.getUint32(DST_CUR, true) + regs * 16, true);
                dv.setUint32(BUDGET, rem - regs, true);
            }
            dv.setUint32(SRC_CUR, dv.getUint32(SRC_CUR, true) + cols * rows * 4, true);
        }
        dv.setUint32(DESC_CUR, d + 0x1c, true);
        return 0;
    }
    if (cls === 5) {
        const children = dv.getUint32(d + 0x14, true);
        dv.setUint32(DESC_CUR, d + 0x18, true);
        let ret = 0;
        for (let i = 0; i < items; i++) {
            if (dv.getUint32(BUDGET, true) === 0) return ret;
            dv.setUint32(DESC_CUR, d + 0x18, true);
            for (let c = 0; c < children; c++) {
                if (dv.getUint32(BUDGET, true) === 0) break;
                ret = refRegister(dv, family, depth + 1);
                if (ret < 0) return ret;
            }
        }
        return ret;
    }
    return E_FAIL | 0;
}

/** FUN_005cad01 (packed layout; class-5 recurses into refRegister('float')). */
function refPacked(dv: DataView, depth = 0): number {
    if (depth > 16) throw new Error('ref recursion runaway');
    const d = dv.getUint32(DESC_CUR, true);
    const cls = dv.getInt32(d + 4, true);
    let items = dv.getUint32(d + 0x10, true);
    if (items === 0) items = 1;
    if (cls < 0) return E_FAIL | 0;
    if (cls < 4) {
        const rows = dv.getUint32(d + 0x14, true);
        const cols = dv.getUint32(d + 0x18, true);
        const mode = dv.getUint32(d, true);
        let n = rows;
        if (mode < 1 || mode > 3) return E_FAIL | 0;
        for (let i = 0; i < items; i++) {
            if (dv.getUint32(BUDGET, true) === 0) break;
            for (let j = 0; j < cols; j++) {
                const rem = dv.getUint32(BUDGET, true);
                if (rem === 0) break;
                if (rem < n) n = rem;
                for (let e = 0; e < n; e++) {
                    const s = dv.getUint32(SRC_CUR, true) + j * 4 + e * cols * 4;
                    const dst = dv.getUint32(DST_CUR, true) + e * 4;
                    if (mode === 3) dv.setUint32(dst, ftolExact(dv.getFloat32(s, true)) >>> 0, true);
                    else dv.setUint32(dst, dv.getUint32(s, true), true);
                }
                dv.setUint32(DST_CUR, dv.getUint32(DST_CUR, true) + n * 4, true);
                dv.setUint32(BUDGET, rem - n, true);
            }
            dv.setUint32(SRC_CUR, dv.getUint32(SRC_CUR, true) + cols * rows * 4, true);
        }
        dv.setUint32(DESC_CUR, d + 0x1c, true);
        return 0;
    }
    if (cls === 5) {
        const children = dv.getUint32(d + 0x14, true);
        dv.setUint32(DESC_CUR, d + 0x18, true);
        let ret = 0;
        for (let i = 0; i < items; i++) {
            if (dv.getUint32(BUDGET, true) === 0) return ret;
            dv.setUint32(DESC_CUR, d + 0x18, true);
            for (let c = 0; c < children; c++) {
                if (dv.getUint32(BUDGET, true) === 0) break;
                ret = refRegister(dv, 'float', depth + 1); // ← FUN_005c8303!
                if (ret < 0) return ret;
            }
        }
        return ret;
    }
    return E_FAIL | 0;
}

/* ─── Harness ─────────────────────────────────────────────────────────────── */

const ARGS = [DESC_CUR, SRC_CUR, DST_CUR, BUDGET];

function fillSrcMixed(dv: DataView, words: number, float: boolean): void {
    for (let i = 0; i < words; i++) {
        if (float) dv.setFloat32(SRC + i * 4, (((i * 53) % 613) - 306) / 7, true);
        else dv.setUint32(SRC + i * 4, (0x9e3779b9 * (i + 1)) >>> 0, true);
    }
}

function runBoth(
    kernel: (view: LiveShadowView, args: number[]) => number,
    ref: (dv: DataView) => number,
    setup: (env: Env) => void,
): void {
    const k = mkEnv(); const r = mkEnv();
    setup(k); setup(r);
    const kEax = kernel(k.view, ARGS);
    const rEax = ref(r.dv);
    expect(kEax >>> 0).toBe(rEax >>> 0);
    expect(k.mem).toEqual(r.mem); // includes cursor cells + all dst bytes
}

const FAMILIES: Array<{
    name: string;
    kernel: (view: LiveShadowView, args: number[]) => number;
    ref: (dv: DataView) => number;
    float: boolean;
}> = [
    { name: 'apply_reg_int (FUN_005c85c1)', kernel: applyRegisterIntKernel, ref: dv => refRegister(dv, 'int'), float: false },
    { name: 'apply_reg_float (FUN_005c8303)', kernel: applyRegisterFloatKernel, ref: dv => refRegister(dv, 'float'), float: true },
    { name: 'apply_packed (FUN_005cad01)', kernel: applyPackedKernel, ref: refPacked, float: true },
];

describe.each(FAMILIES)('$name vs decompile reference', ({ kernel, ref, float }) => {
    for (const mode of [1, 2, 3]) {
        for (const shape of [
            { rows: 4, cols: 4, items: 1, budget: 256 },
            { rows: 4, cols: 4, items: 3, budget: 256 },
            { rows: 3, cols: 2, items: 2, budget: 256 },  // regs=ceil(3/4)=1
            { rows: 16, cols: 1, items: 1, budget: 256 }, // multi-register column
            { rows: 4, cols: 4, items: 2, budget: 5 },    // budget exhaustion + sticky clamp
            { rows: 6, cols: 3, items: 1, budget: 2 },    // clamp below regsInit
            { rows: 1, cols: 8, items: 1, budget: 3 },    // per-column budget starvation
        ]) {
            test(`mode ${mode} rows=${shape.rows} cols=${shape.cols} items=${shape.items} budget=${shape.budget}`, () => {
                runBoth(kernel, ref, env => {
                    writeDesc(env.dv, DESC, { mode, cls: 1, items: shape.items, rows: shape.rows, cols: shape.cols });
                    env.dv.setUint32(BUDGET, shape.budget, true);
                    fillSrcMixed(env.dv, shape.items * shape.rows * shape.cols + 16, float);
                });
            });
        }
    }

    test('unknown mode → E_FAIL, cursors untouched', () => {
        runBoth(kernel, ref, env => {
            writeDesc(env.dv, DESC, { mode: 9, cls: 2, items: 1, rows: 4, cols: 4 });
            env.dv.setUint32(BUDGET, 64, true);
        });
    });

    test('bad class → E_FAIL, cursors untouched', () => {
        runBoth(kernel, ref, env => {
            writeDesc(env.dv, DESC, { mode: 1, cls: 7, items: 1, rows: 4, cols: 4 });
            env.dv.setUint32(BUDGET, 64, true);
        });
    });

    test('class 5 container: two children, replayed per item', () => {
        runBoth(kernel, ref, env => {
            // Container at DESC: 2 items × 2 children; children descriptors
            // inline at DESC+0x18 (0x1c apart, as the walk expects).
            writeDesc(env.dv, DESC, { cls: 5, items: 2, rows: 2 /* children */ });
            writeDesc(env.dv, DESC + 0x18, { mode: 1, cls: 0, items: 1, rows: 4, cols: 1 });
            writeDesc(env.dv, DESC + 0x18 + 0x1c, { mode: 3, cls: 0, items: 1, rows: 2, cols: 2 });
            env.dv.setUint32(BUDGET, 64, true);
            fillSrcMixed(env.dv, 64, float);
        });
    });

    test('class 5 with starving budget stops mid-children', () => {
        runBoth(kernel, ref, env => {
            writeDesc(env.dv, DESC, { cls: 5, items: 3, rows: 2 });
            writeDesc(env.dv, DESC + 0x18, { mode: 1, cls: 0, items: 1, rows: 4, cols: 1 });
            writeDesc(env.dv, DESC + 0x18 + 0x1c, { mode: 1, cls: 0, items: 1, rows: 4, cols: 1 });
            env.dv.setUint32(BUDGET, 3, true);
            fillSrcMixed(env.dv, 64, float);
        });
    });
});

describe('apply family cross-checks', () => {
    test('uint→float correction: 0xFFFFFFFF becomes 4294967295f, not -1f', () => {
        const k = mkEnv();
        writeDesc(k.dv, DESC, { mode: 2, cls: 0, items: 1, rows: 1, cols: 1 });
        k.dv.setUint32(BUDGET, 4, true);
        k.dv.setUint32(SRC, 0xFFFFFFFF, true);
        expect(applyRegisterIntKernel(k.view, ARGS)).toBe(0);
        expect(k.dv.getFloat32(DST, true)).toBe(4294967296); // f32 rounding of 2^32-1
    });

    test('int→float: negative stays negative', () => {
        const k = mkEnv();
        writeDesc(k.dv, DESC, { mode: 1, cls: 0, items: 1, rows: 1, cols: 1 });
        k.dv.setUint32(BUDGET, 4, true);
        k.dv.setInt32(SRC, -7, true);
        expect(applyRegisterIntKernel(k.view, ARGS)).toBe(0);
        expect(k.dv.getFloat32(DST, true)).toBe(-7);
    });

    test('float→int ftol: truncation + NaN→0 (float family, mode 3)', () => {
        const k = mkEnv();
        writeDesc(k.dv, DESC, { mode: 3, cls: 0, items: 1, rows: 4, cols: 1 });
        k.dv.setUint32(BUDGET, 4, true);
        k.dv.setFloat32(SRC + 0, 3.9, true);
        k.dv.setFloat32(SRC + 4, -3.9, true);
        k.dv.setFloat32(SRC + 8, NaN, true);
        k.dv.setFloat32(SRC + 12, 2e30, true);
        expect(applyRegisterFloatKernel(k.view, ARGS)).toBe(0);
        expect(k.dv.getInt32(DST + 0, true)).toBe(3);
        expect(k.dv.getInt32(DST + 4, true)).toBe(-3);
        expect(k.dv.getInt32(DST + 8, true)).toBe(0);
        expect(k.dv.getInt32(DST + 12, true)).toBe(0);
    });

    test('packed layout consumes budget in elements and packs dst', () => {
        const k = mkEnv();
        writeDesc(k.dv, DESC, { mode: 1, cls: 0, items: 1, rows: 3, cols: 2 });
        k.dv.setUint32(BUDGET, 100, true);
        fillSrcMixed(k.dv, 8, true);
        expect(applyPackedKernel(k.view, ARGS)).toBe(0);
        expect(k.dv.getUint32(BUDGET, true)).toBe(100 - 6);          // 2 cols × 3 elements
        expect(k.dv.getUint32(DST_CUR, true)).toBe(DST + 6 * 4);     // packed advance
    });

    test('register layout consumes budget in registers (ceil(rows/4))', () => {
        const k = mkEnv();
        writeDesc(k.dv, DESC, { mode: 1, cls: 0, items: 1, rows: 3, cols: 2 });
        k.dv.setUint32(BUDGET, 100, true);
        fillSrcMixed(k.dv, 8, true);
        expect(applyRegisterFloatKernel(k.view, ARGS)).toBe(0);
        expect(k.dv.getUint32(BUDGET, true)).toBe(100 - 2);          // 2 cols × 1 register
        expect(k.dv.getUint32(DST_CUR, true)).toBe(DST + 2 * 16);    // 16B per register
    });
});
