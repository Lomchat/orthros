/**
 * EAGL shader-constant converter — the exact kernel, in a dependency-free
 * module so it is unit-testable in isolation (tools/tests/eagl-converter.test.ts)
 * and importable by the descriptor without dragging worker singletons into a
 * test's import graph. RE spec + semantics documented in ./descriptor.ts.
 *
 * This JS kernel is the shadow-validated FALLBACK. Production execution is the
 * byte-identical Rust hypercall (cpu/hypercall.rs handler 128).
 */

import type { ShadowView } from '../../types';

const D3DERR_INVALIDCALL = 0x8876086C;

/** Classic CRT `_ftol` (truncate toward zero, EAX = low 32 bits of the i64). */
export function ftolExact(x: number): number {
    if (!Number.isFinite(x) || x >= 9223372036854775808 || x < -9223372036854775808) {
        return 0; // FPU integer-indefinite (0x8000000000000000) — low 32 bits are 0
    }
    const t = Math.trunc(x);
    if (t >= -2147483648 && t <= 4294967295) return t | 0; // fast path, no BigInt
    return Number(BigInt(t) & 0xFFFFFFFFn) | 0;
}

/** The exact kernel — mirrors the guest loops 1:1 (see descriptor header spec). */
export function convertKernel(view: ShadowView, args: number[]): number {
    const desc = args[0] >>> 0;
    const dst = args[1] >>> 0;
    const src = args[2] >>> 0;
    const count = args[3] >>> 0;

    const mode = view.readU32(desc);
    const rows = view.readU32(desc + 0x14);
    const cols = view.readU32(desc + 0x18);
    if (mode < 1 || mode > 3) return D3DERR_INVALIDCALL;

    const r = Math.min(rows, 4);
    const c = Math.min(cols, 4);
    const dstItemStride = rows * cols * 4;
    const dstRowStride = cols * 4;

    for (let i = 0; i < count; i++) {
        const srcItem = src + i * 0x40;
        const dstItem = dst + i * dstItemStride;
        for (let rr = 0; rr < r; rr++) {
            const s = srcItem + rr * 0x10;
            const d = dstItem + rr * dstRowStride;
            if (mode === 3) {
                for (let cc = 0; cc < c; cc++) view.writeU32(d + cc * 4, view.readU32(s + cc * 4));
            } else if (mode === 2) {
                for (let cc = 0; cc < c; cc++) view.writeU32(d + cc * 4, ftolExact(view.readF32(s + cc * 4)) >>> 0);
            } else {
                for (let cc = 0; cc < c; cc++) view.writeU32(d + cc * 4, ftolExact(view.readF32(s + cc * 4)) !== 0 ? 1 : 0);
            }
        }
    }
    return 0;
}
