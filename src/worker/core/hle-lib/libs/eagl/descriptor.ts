/**
 * EAGL (EA Graphics Layer, shared across EA titles) — Guarded Inner-Loop HLE
 * descriptor. First hook: the shader-constant converter, named by trace2 on
 * NFS Underground retail: ~240K calls/s, ~16 elements/call, its loops + the
 * embedded CRT `_ftol` ≈ 20% of retired guest instructions in-race.
 *
 * RE-established semantics (re disasm speed.dll 0x5cbd17, stdcall ret 0x10):
 *
 *   u32 convert(desc*, dst*, src*, count)
 *     mode = u32[desc+0]        // 1=float→bool, 2=float→int (_ftol trunc), 3=u32 copy
 *     rows = u32[desc+0x14], cols = u32[desc+0x18]
 *     r = min(rows,4), c = min(cols,4)
 *     for item in [0,count):
 *       for rr in [0,r): for cc in [0,c):
 *         src cell: f32/u32 at  src + item*0x40 + rr*0x10 + cc*4   // fixed 4×4 staging
 *         dst cell: u32   at  dst + item*rows*cols*4 + rr*cols*4 + cc*4  // packed, UNclamped strides
 *     return 0; unknown mode → 0x8876086C (D3DERR_INVALIDCALL) with no writes
 *
 * `_ftol` here is the classic CRT truncation (FSTCW→FISTP qword, EAX = low 32
 * bits; NaN/overflow → FPU integer-indefinite → low32 = 0). Mode 1 collapses
 * the truncated int to 0/1 (`neg;sbb;neg`).
 *
 * Detection is v1-exact: the function's own first
 * 56 bytes, byte-exact. The twin function 0x1b0 later shares the first 16
 * bytes (identical prologue) — the tail of the pattern disambiguates.
 * Signature-tolerant matching comes only when a second EA title needs it.
 */

import type { LibDescriptor, ShadowSpec, ShadowView } from '../../types';
import {
    HANDLER_EAGL_APPLY_REG_INT,
    HANDLER_EAGL_SHADER_CONVERT,
    HANDLER_EAGL_TOKEN_DISPATCH,
} from '../../../cpu/hypercall-data';
import { convertKernel } from './kernel';
import { applyRegisterIntKernel } from './apply-kernels';
import {
    armTokenDispatchWhenReady,
    buildTokenDispatchFilter,
    tokenDispatchHandler,
} from './token-dispatch';

// First 56 bytes of the converter, read from live guest memory and verified
// instruction-by-instruction against `re disasm` (see header).
const CONVERTER_PATTERN = new Uint8Array([
    0x55, 0x8B, 0xEC, 0x83, 0xEC, 0x20,             // push ebp; mov ebp,esp; sub esp,0x20
    0x8B, 0x45, 0x08,                               // mov eax,[ebp+8]        (desc)
    0x8B, 0x48, 0x14,                               // mov ecx,[eax+0x14]     (rows)
    0x8B, 0x50, 0x18,                               // mov edx,[eax+0x18]     (cols)
    0x83, 0x65, 0xE4, 0x00,                         // and [ebp-0x1c],0       (result = 0; twin uses -0x20 here)
    0x53, 0x56,                                     // push ebx; push esi
    0x8B, 0x30,                                     // mov esi,[eax]          (mode)
    0x57,                                           // push edi
    0x6A, 0x04, 0x58,                               // push 4; pop eax
    0x3B, 0xC8,                                     // cmp ecx,eax
    0x89, 0x55, 0xE8,                               // mov [ebp-0x18],edx
    0x89, 0x45, 0xFC,                               // mov [ebp-4],eax
    0x77, 0x03,                                     // ja +3
    0x89, 0x4D, 0xFC,                               // mov [ebp-4],ecx        (min(rows,4))
    0x3B, 0xD0,                                     // cmp edx,eax
    0x89, 0x45, 0x08,                               // mov [ebp+8],eax
    0x77, 0x03,                                     // ja +3
    0x89, 0x55, 0x08,                               // mov [ebp+8],edx        (min(cols,4))
    0x4E,                                           // dec esi
    0x0F, 0x84, 0xF9, 0x00, 0x00, 0x00,             // jz mode-1 body
    0x4E, 0x74, 0x7C,                               // dec esi; jz mode-2 body
]);

// ── Shader-parameter APPLY converter family (second hook set) ───────────────
//
// Semantics + RE notes in ./apply-kernels.ts. All three are stdcall ret 0x10
// with 4 by-ref args (desc**/src**/dst**/budget*); detection is v1-exact on
// the first 56 bytes read from live guest memory (NFSU retail speed.exe) and
// verified against `re disasm`. Prologues are the 6-byte MSVC frame setup
// (push ebp; mov ebp,esp; sub esp,imm8) — trampoline-safe.

function hexPattern(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

// FUN_005c85c1 — int-source, register layout. Kept hooked as the documented
// kill-criterion example (measured ≈0 FPS — the apply-walk LEAVES are cold,
// the shells are the cost). Its float/packed siblings (handlers 130/131,
// FUN_005c8303/FUN_005cad01) measured 0 calls from content and were dropped
// from this descriptor; their JS kernels (apply-kernels.ts), unit tests and
// Rust handlers remain as reference implementations.
const APPLY_REG_INT_PATTERN = hexPattern(
    '558bec83ec208b55088b0a8b410453568b71105733ff3bf7897df08975f8' +
    '7507c745f8010000003bc70f8c7c02000083f8037e7183f8050f856e020000');

// FUN_005c97cb — the EAGL→D3D9 state-token dispatcher (thiscall RET 8; see
// ./token-dispatch.ts). First 79 bytes,
// byte-exact from live NFSU retail memory, verified against `re disasm`;
// stops right before the token-table disp32 (version-specific pointer, read
// out by the entry filter at patch time with an 8B 88 opcode check).
const TOKEN_DISPATCH_PATTERN = hexPattern(
    '558bec81ec38040000538b5d0833d22055f92055fa2055fb56578b7d0c83ffff' +
    '8bf18975fc8955e466c745f4ff00668955f6c645f8117508' +
    '8b430489450c8bf8833bff75038b5b648b036bc01c8b88');

// ── The commit-cluster (FUN_005d02d7) and pass-driver (FUN_005d01ec) phase-3
// batch hooks were built and correctness-validated but measured dead on NFSU
// (commit cluster −8% from in-batch evaluator callbacks → adverse selection;
// pass driver +0.1% on load-dense code the JIT already runs near native
// speed), so they were removed. Only the single-crossing token dispatch
// (handler 132) remains.

/**
 * Shared ShadowSpec for the apply family. Outputs = the four by-ref cursor
 * cells + a conservative dst span (budget is measured in registers for the
 * register layouts and elements for packed; ×16 over-approximates both —
 * unwritten scratch bytes compare equal trivially).
 */
function applyShadowSpec(kernel: (view: ShadowView, args: number[]) => number): ShadowSpec {
    return {
        validateInGame: true,
        n: 256,
        guard(args, view) {
            const descCur = args[0] >>> 0, srcCur = args[1] >>> 0;
            const dstCur = args[2] >>> 0, budget = args[3] >>> 0;
            if (descCur === 0 || srcCur === 0 || dstCur === 0 || budget === 0) return false;
            const d = view.readU32(descCur);
            if (d === 0) return false;
            const cls = view.readU32(d + 4) | 0;
            const budgetVal = view.readU32(budget);
            if (budgetVal > 4096) return false;
            const items = view.readU32(d + 0x10);
            if (items > 1024) return false;
            if (cls >= 0 && cls <= 3) {
                const mode = view.readU32(d);
                const rows = view.readU32(d + 0x14);
                const cols = view.readU32(d + 0x18);
                // mode outside 1..3 returns E_FAIL without writes — kernel
                // reproduces that exactly, so let it through.
                void mode;
                return rows <= 64 && cols <= 64;
            }
            if (cls === 5) {
                return view.readU32(d + 0x14) <= 64; // child count
            }
            return true; // other classes → E_FAIL, no writes; kernel matches
        },
        ranges(args, view) {
            const out = [
                { addr: args[0] >>> 0, len: 4 },
                { addr: args[1] >>> 0, len: 4 },
                { addr: args[2] >>> 0, len: 4 },
                { addr: args[3] >>> 0, len: 4 },
            ];
            const dstBase = view.readU32(args[2] >>> 0);
            const budgetVal = Math.min(view.readU32(args[3] >>> 0), 4096);
            if (dstBase !== 0 && budgetVal > 0) out.push({ addr: dstBase, len: budgetVal * 16 });
            return out;
        },
        kernel,
    };
}

export const eaglDescriptor: LibDescriptor = {
    id: 'eagl',
    displayName: 'EA Graphics Layer (inner-loop HLE)',
    minConfidence: 10,
    signatures: {
        shader_const_convert: {
            kind: 'bytes',
            pattern: CONVERTER_PATTERN,
            mask: 'x'.repeat(CONVERTER_PATTERN.length),
            section: '.text',
            weight: 12,
        },
    },
    functions: {
        shader_const_convert: {
            name: 'shader_const_convert',
            entryProbe: {
                kind: 'prologue',
                pattern: CONVERTER_PATTERN,
                mask: 'x'.repeat(CONVERTER_PATTERN.length),
                section: '.text',
            },
            callingConvention: 'stdcall',
            argCount: 4,
            required: true,
            prologueLen: 6, // push ebp; mov ebp,esp; sub esp,0x20 — instruction boundary
            // Production path: WASM hypercall (handler 128). The JS `shadow`
            // kernel below is the fall-through fallback (guard miss / disabled).
            hypercallHandlerId: HANDLER_EAGL_SHADER_CONVERT,
            shadow: {
                // In-game differential validation via the SYNCHRONOUS original-call
                // primitive (sync-guest-call.ts): first n calls run the original to a
                // sentinel inside the OUT trap, compare against the scratch kernel,
                // then promote to the WASM hypercall handler. (The old suspend/resume
                // round-trip was retired — it was built for guest-supplied callbacks,
                // not function-entry hooks.)
                validateInGame: true,
                n: 256,
                guard(args, view) {
                    const desc = args[0] >>> 0;
                    const dst = args[1] >>> 0;
                    const src = args[2] >>> 0;
                    const count = args[3] >>> 0;
                    if (desc === 0 || dst === 0 || src === 0) return false;
                    const rows = view.readU32(desc + 0x14);
                    const cols = view.readU32(desc + 0x18);
                    // Plausibility bounds — beyond these the strides run wild
                    // and the original should handle it (never seen in-game).
                    return rows <= 16 && cols <= 16 && count <= 4096;
                },
                ranges(args, view) {
                    const desc = args[0] >>> 0;
                    const dst = args[1] >>> 0;
                    const count = args[3] >>> 0;
                    const rows = view.readU32(desc + 0x14);
                    const cols = view.readU32(desc + 0x18);
                    const len = count * rows * cols * 4;
                    // One conservative span: unwritten gap bytes compare equal
                    // trivially (scratch starts as a copy of live memory).
                    return len > 0 ? [{ addr: dst, len }] : [];
                },
                kernel: convertKernel,
            },
        },
        apply_reg_int: {
            name: 'apply_reg_int',
            entryProbe: {
                kind: 'prologue',
                pattern: APPLY_REG_INT_PATTERN,
                mask: 'x'.repeat(APPLY_REG_INT_PATTERN.length),
                section: '.text',
            },
            callingConvention: 'stdcall',
            argCount: 4,
            required: false, // pattern is retail-exact; demo build may differ
            prologueLen: 6,
            hypercallHandlerId: HANDLER_EAGL_APPLY_REG_INT,
            shadow: applyShadowSpec(applyRegisterIntKernel),
        },
        state_token_dispatch: {
            name: 'state_token_dispatch',
            entryProbe: {
                kind: 'prologue',
                pattern: TOKEN_DISPATCH_PATTERN,
                mask: 'x'.repeat(TOKEN_DISPATCH_PATTERN.length),
                section: '.text',
            },
            // __thiscall RET 8: the stub is a plain stdcall RET-8 shape (2
            // stack args); ECX carries `this` untouched through filter + stub
            // and is read by the WASM/JS handlers directly.
            callingConvention: 'stdcall',
            argCount: 2,
            required: false,
            prologueLen: 9, // push ebp; mov ebp,esp; sub esp,0x438
            hypercallHandlerId: HANDLER_EAGL_TOKEN_DISPATCH,
            entryFilter: buildTokenDispatchFilter,
        },
    },
    handlers: {
        // Non-shadow hook: the JS fall-through for WASM handler-132 declines —
        // sync-original completion, never re-implementation.
        state_token_dispatch: tokenDispatchHandler,
    },
    onActivated(match) {
        if (match.functionMatches.some(f => f.name === 'state_token_dispatch')) {
            armTokenDispatchWhenReady();
        }
    },
};
