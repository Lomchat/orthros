/**
 * EAGL shader-parameter APPLY converters — exact kernels for the second hook
 * family (Track 1 step 2). Named by post-hook trace2 on NFSU retail: the
 * shader-parameter apply walk FUN_005cdca7 dispatches per-element into thin
 * state-resolving wrappers → these three pure converters.
 *
 * RE-established semantics (re decompile/disasm speed.exe, 2026-07-10; all
 * three stdcall ret 0x10, same 4-by-ref-arg ABI):
 *
 *   int apply(desc** descCursor, src** srcCursor, dst** dstCursor, u32* budget)
 *
 *   desc = *descCursor:
 *     [+0x00] mode   1|2|3 (per family below)
 *     [+0x04] class  0..3 = convert, 5 = container (recurse), else E_FAIL
 *     [+0x10] items  (0 → 1)
 *     [+0x14] rows   (elements per column; for class 5: CHILD COUNT)
 *     [+0x18] cols   (for class 5: children descriptor array starts here)
 *
 *   Convert classes walk `items` matrices column-by-column, TRANSPOSED
 *   (src element = *srcCursor + (j + e*cols)*4), writing `rows` elements per
 *   column into the constant staging buffer, consuming a by-ref budget:
 *
 *     register layout (FUN_005c85c1 / FUN_005c8303): budget counts 4-float
 *       REGISTERS; per column dst advances ceil(rows/4)*16 bytes and budget
 *       drops by ceil(rows/4). When the remaining budget dips below the
 *       register count the clamp (regs=rem, elems=rem*4) STICKS for the rest
 *       of the call — faithful to the guest's spilled locals.
 *     packed layout (FUN_005cad01): budget counts ELEMENTS; per column dst
 *       advances n*4 and budget drops by n, n=rows clamped by remaining
 *       budget (clamp equally sticky).
 *
 *   After each item the src cursor advances rows*cols*4; on success the desc
 *   cursor advances 0x1c and EAX=0. Bad class/mode → 0x80004005 (E_FAIL),
 *   cursors untouched.
 *
 *   Element ops by family:
 *     int-source (FUN_005c85c1):  1 = i32→f32 (FILD/FSTP), 2 = u32→f32
 *       (FILD + conditional +2^32, single f32 rounding), 3 = f32 copy
 *       (FLD/FSTP float).
 *     float-source (FUN_005c8303, FUN_005cad01): 1|2 = raw u32 copy (MOV),
 *       3 = f32→i32 via CRT _ftol (truncate; NaN/overflow → low32 = 0).
 *
 *   Class 5 recursion: children = u32[desc+0x14], *descCursor = desc+0x18,
 *   re-set at EVERY item; recurse per child while budget lasts, abort on
 *   negative return, return the LAST child's result (0 if none ran).
 *   FUN_005c85c1 and FUN_005c8303 recurse into themselves; FUN_005cad01
 *   recurses into FUN_005c8303 (register layout!) — transcribed faithfully.
 */

import type { ShadowView } from '../../types';
import { ftolExact } from './kernel';

const E_FAIL = -0x7fffbffb; // 0x80004005 as i32

/** Container nesting cap — EAGL trees are 1-2 deep; a runaway means a garbage
 *  descriptor, and throwing routes the call to the auto-disable path. */
const MAX_APPLY_DEPTH = 8;

type ApplyFamily = 'int' | 'float';
type ApplyLayout = 'register' | 'packed';

function applyEngine(
    view: ShadowView,
    args: number[],
    family: ApplyFamily,
    layout: ApplyLayout,
    depth: number,
): number {
    if (depth > MAX_APPLY_DEPTH) {
        throw new Error(`EAGL apply: descriptor nesting deeper than ${MAX_APPLY_DEPTH}`);
    }
    const descCur = args[0] >>> 0;
    const srcCur = args[1] >>> 0;
    const dstCur = args[2] >>> 0;
    const budget = args[3] >>> 0;

    const d = view.readU32(descCur);
    const cls = view.readU32(d + 4) | 0;
    let items = view.readU32(d + 0x10);
    if (items === 0) items = 1;

    if (cls >= 0 && cls <= 3) {
        const mode = view.readU32(d);
        const rows = view.readU32(d + 0x14);
        const cols = view.readU32(d + 0x18);
        if (mode < 1 || mode > 3) return E_FAIL;

        // Sticky clamp state (the guest's spilled locals, set once per call).
        let regs = ((rows >>> 2) + ((rows & 3) !== 0 ? 1 : 0)) >>> 0; // register layout
        let elems = rows >>> 0;                                       // elements per column
        let n = rows >>> 0;                                           // packed layout

        for (let i = 0; i < items; i++) {
            if (view.readU32(budget) === 0) break;
            const srcBase = view.readU32(srcCur);
            for (let j = 0; j < cols; j++) {
                const rem = view.readU32(budget);
                if (rem === 0) break;
                let count: number;
                let dstStep: number;
                let budgetStep: number;
                if (layout === 'register') {
                    if (rem < regs) { elems = rem * 4; regs = rem; }
                    count = elems; dstStep = regs * 16; budgetStep = regs;
                } else {
                    if (rem < n) { n = rem; }
                    count = n; dstStep = n * 4; budgetStep = n;
                }
                const dstBase = view.readU32(dstCur);
                for (let e = 0; e < count; e++) {
                    const s = srcBase + (j + e * cols) * 4;
                    const dst = dstBase + e * 4;
                    if (family === 'int') {
                        if (mode === 1) {
                            view.writeF32(dst, view.readU32(s) | 0);        // FILD i32 → FSTP f32
                        } else if (mode === 2) {
                            view.writeF32(dst, view.readU32(s));            // u32 → f32 (FADD 2^32)
                        } else {
                            view.writeF32(dst, view.readF32(s));            // FLD/FSTP f32 copy
                        }
                    } else {
                        if (mode === 3) {
                            view.writeU32(dst, ftolExact(view.readF32(s)) >>> 0); // _ftol
                        } else {
                            view.writeU32(dst, view.readU32(s));            // MOV copy
                        }
                    }
                }
                view.writeU32(dstCur, (dstBase + dstStep) >>> 0);
                view.writeU32(budget, (rem - budgetStep) >>> 0);
            }
            view.writeU32(srcCur, (srcBase + cols * rows * 4) >>> 0);
        }
        view.writeU32(descCur, (d + 0x1c) >>> 0);
        return 0;
    }

    if (cls === 5) {
        const children = view.readU32(d + 0x14);
        view.writeU32(descCur, (d + 0x18) >>> 0);
        let ret = 0;
        for (let i = 0; i < items; i++) {
            if (view.readU32(budget) === 0) return ret;
            view.writeU32(descCur, (d + 0x18) >>> 0);
            for (let c = 0; c < children; c++) {
                if (view.readU32(budget) === 0) break;
                // FUN_005cad01's container recurses into the REGISTER-layout
                // float engine (FUN_005c8303); the other two recurse into
                // themselves. Transcribed as-is.
                ret = layout === 'packed'
                    ? applyEngine(view, args, 'float', 'register', depth + 1)
                    : applyEngine(view, args, family, layout, depth + 1);
                if (ret < 0) return ret;
            }
        }
        return ret;
    }

    return E_FAIL;
}

/** FUN_005c85c1 — int-source, register-layout apply (WASM handler 129). */
export function applyRegisterIntKernel(view: ShadowView, args: number[]): number {
    return applyEngine(view, args, 'int', 'register', 0) >>> 0;
}

/** FUN_005c8303 — float-source, register-layout apply (WASM handler 130). */
export function applyRegisterFloatKernel(view: ShadowView, args: number[]): number {
    return applyEngine(view, args, 'float', 'register', 0) >>> 0;
}

/** FUN_005cad01 — float-source, packed-layout apply (WASM handler 131). */
export function applyPackedKernel(view: ShadowView, args: number[]): number {
    return applyEngine(view, args, 'float', 'packed', 0) >>> 0;
}
