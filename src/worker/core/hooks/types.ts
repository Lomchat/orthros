/**
 * Universal guest hot-spot hook framework — shared types.
 *
 * A `HookSpec` targets ONE guest function by (module, rva) and replaces it with a
 * handler. Unlike hle-lib's library descriptors (which fingerprint a statically-
 * linked library via signatures), a hook is game-agnostic: you find a hot leaf
 * function with `dumpHotJitBlocks` (module:rva), Ghidra-decompile it, and write a
 * spec. The leverage is that these functions are per-engine / per-runtime, not
 * per-game — a Galaxy hook helps every UE1 game; a CRT memcpy hook helps every
 * MSVC game.
 */

import type { X86Context } from '../thunking/thunk-dispatcher';

/** What a hook handler receives — mirrors ThunkImplementation's (ctx, mem, args). */
export interface HookInvocation {
    /** CPU registers at call time. `ecx` is `this` for thiscall functions. */
    readonly ctx: X86Context;
    /**
     * Fresh guest memory view. NEVER cache it across calls — v86 can detach the
     * ArrayBuffer on restart. Guest address X maps to `mem[X]` (do NOT subtract
     * `mem.byteOffset`). For typed-array views: `new Int32Array(mem.buffer,
     * mem.byteOffset + X, n)`.
     */
    readonly mem: Uint8Array;
    /** Stack dword arguments (`args[0]` = first stacked arg). */
    readonly args: number[];
}

/** A guest-memory span a kernel writes — used by the dev-mode correctness oracle. */
export interface HookOutputRegion {
    /** Absolute guest address of the first written byte. */
    ptr: number;
    /** Number of bytes written. */
    len: number;
}

/**
 * A hot-spot hook handler: a bit-exact scalar port (the oracle + safe fallback)
 * plus an optional optimized path (TS-autovectorized, or WASM-SIMD). Both must
 * return the same value the guest function would (the EAX result) and leave
 * guest memory in the same state.
 */
export interface HookHandler {
    /**
     * Bit-exact reimplementation of the guest function. This is both the
     * correctness oracle (the simd path is diffed against it) and the safe
     * fallback (run when simd is absent/disabled or validate() fails).
     */
    scalar(inv: HookInvocation): number;

    /**
     * Optimized path. Gated by `HookSpec.enabled()` (and the runtime override);
     * the registry falls back to `scalar()` when this is absent or disabled.
     */
    simd?(inv: HookInvocation): number;

    /**
     * Dev-mode oracle support: the guest-memory region this kernel writes for a
     * given invocation, so the registry can run scalar+simd and byte-diff their
     * outputs. Return null to skip the diff for this call. Omit entirely for
     * handlers that have no simd path or write nowhere observable.
     */
    outputRegion?(inv: HookInvocation): HookOutputRegion | null;

    /**
     * Optional first-call sanity check (the libjpeg pattern): validate that
     * pointer args land in guest memory and counts are in range. Returning false
     * unpatches the hook (future calls run guest code) and falls this call back
     * to `scalar()`. `prologueVerify` is the primary version guard; this is a
     * secondary runtime defense, evaluated only on the first invocation.
     */
    validate?(inv: HookInvocation): boolean;
}

/** Calling convention + stack cleanup for the hooked function. */
export interface HookAbi {
    /**
     * 'cdecl' — caller cleans the stack (stub RET 0).
     * 'stdcall' — callee cleans (stub RET N, N from argCount*4 or cleanupBytes).
     * 'thiscall' — `this` in ECX, stack args callee-cleaned; provide cleanupBytes.
     */
    conv: 'cdecl' | 'stdcall' | 'thiscall';
    /** Number of 4-byte stack args. Used to derive RET N when cleanupBytes is omitted. */
    argCount?: number;
    /** Explicit callee cleanup bytes (RET N). Prefer over argCount*4 for thiscall / by-value structs. */
    cleanupBytes?: number;
}

/** Descriptor for one module:rva hot-spot hook. */
export interface HookSpec {
    /** Stable id, e.g. 'galaxy.outConvert', 'd3ddrv.uvgen', 'crt.memcpy'. */
    id: string;
    /** PE module name, case-insensitive; the '.dll' suffix is optional ('galaxy' or 'galaxy.dll'). */
    module: string;
    /** Offset of the target function entry from the module base (from dumpHotJitBlocks). */
    rva: number;
    /**
     * First N bytes of the target function from a Ghidra disasm — the VERSION
     * GUARD. Checked at patch time against guest memory at `base+rva`; a mismatch
     * logs and skips (we never patch a build we don't recognise). N can differ
     * from the 5 bytes the patch overwrites — make it long enough to be unique.
     */
    prologueVerify: number[];
    abi: HookAbi;
    handler: HookHandler;
    /**
     * Default runtime A/B state: true → run `simd()` (when present), false → run
     * `scalar()`. `setHookEnabled(id, bool)` overrides this live for FPS A/B.
     */
    enabled: () => boolean;
}

/** Per-hook runtime counters surfaced by `hookReport()`. */
export interface HookStats {
    id: string;
    module: string;
    rva: number;
    patched: boolean;
    /** Disabled at runtime after a validate() failure. */
    unpatched: boolean;
    hits: number;
    simdHits: number;
    scalarHits: number;
    /** Accumulated wall-clock spent inside the chosen path (ms). */
    selfTimeMs: number;
    /** Times the dev-mode oracle saw scalar≠simd output. Should stay 0. */
    oracleMismatches: number;
}
