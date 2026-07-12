/**
 * Synchronous guest-function execution (Guarded Inner-Loop HLE).
 *
 * Runs a guest function — in practice a hook's relocated-prologue trampoline —
 * to completion INSIDE the current OUT-trap JS handler and returns its EAX,
 * with guest memory side effects applied. This replaces the suspended-thunk /
 * invokeCallback round-trip for shadow validation: no suspend, no scheduler
 * involvement, no completion path — the hook's thunk returns a plain sync
 * value once validation has compared the outputs.
 *
 * Mechanism (see run_guest_until in vendor/v86 cpu.rs):
 *   1. Snapshot the FULL CPU state (GPRs, EIP, materialized EFLAGS, x87, SSE).
 *   2. Build a call frame in the current thread's stack red zone below ESP:
 *      args pushed right-to-left, return address = a dedicated SENTINEL
 *      address that no code ever executes.
 *   3. Re-enter the v86 cycle loop (safe: port I/O is a JIT block boundary
 *      with registers flushed to memory) until EIP == sentinel.
 *   4. Read EAX, verify the callee's RET N left ESP exactly where the calling
 *      convention says, then restore the snapshot — the interrupted OUT stub
 *      continues as if nothing ran.
 *
 * Abort conditions (budget exhausted / HLT / EIP entered the thunk-stub region
 * = the callee tried to call a WinAPI import / ESP drift) restore the snapshot
 * and report failure — the caller must fall back and typically disable the
 * hook: they mean the callee is NOT the pure leaf the hook assumed. NOTE that
 * on abort the callee may have already written part of its output — callers
 * must overwrite the full output surface (e.g. run the kernel live) before
 * returning to the guest.
 */

import { saveCpuContext } from '../scheduler/scheduler-context';
import type { CpuContext } from '../scheduler/types';
import { fpuRestore, simdRestore } from '../fpu-helper';

/** Maximum dispatch-loop iterations before declaring the callee runaway. */
export const SYNC_CALL_DEFAULT_MAX_BLOCKS = 1_000_000;

export type SyncCallFailure =
    | 'no-export'        // run_guest_until missing from the wasm build
    | 'bad-stack'        // frame would fall outside guest memory
    | 'budget'           // max_blocks exhausted (runaway / not a leaf)
    | 'hlt'              // CPU entered HLT
    | 'thunk-entry'      // callee reached a thunk stub (WinAPI call attempt)
    | 'esp-drift';       // RET N did not clean what the convention promised

export type SyncCallResult =
    | { ok: true; eax: number }
    | { ok: false; reason: SyncCallFailure };

export interface SyncCallEnv {
    cpu: any;
    mem: Uint8Array;
    /** v86 wasm export run_guest_until(sentinel, exempt, maxBlocks, abortLo, abortHi). */
    runGuestUntil:
        | ((sentinel: number, exempt: number, maxBlocks: number, abortLo: number, abortHi: number) => number)
        | undefined;
    /** Return address the callee RETs to; never executed. */
    sentinelAddress: number;
    /** [lo, hi) region whose entry aborts the run (thunk/callback stubs). */
    abortLo: number;
    abortHi: number;
    /**
     * Optional thread pin held across the run (scheduler kernelPinCount — the
     * "JS-invoked guest code runs pinned" invariant). A recoverable guest #PF
     * inside the run re-enters the JS dispatcher via the #PF stub's OUT; the
     * pin keeps its post-thunk scheduler boundary from context-switching away
     * from under the re-entered cycle loop.
     */
    pin?: () => void;
    unpin?: () => void;
}

/** Bytes reserved between the live ESP and the synthetic frame. Generous:
 *  nothing below ESP is live x86 state, but interpreters/SEH scribble nearby. */
const STACK_RED_ZONE = 0x100;

/** Fill a sentinel slot with `JMP $` + NOPs — defensive only; run_guest_until
 *  stops on EIP equality before the address would ever execute. */
export function writeSentinelBytes(mem: Uint8Array, addr: number): void {
    mem[addr] = 0xEB;
    mem[addr + 1] = 0xFE;
    for (let i = 2; i < 16; i++) mem[addr + i] = 0x90;
}

/**
 * Call `target` with `args` synchronously on the current guest thread's stack.
 * On ANY outcome the CPU state visible to the interrupted thunk is restored
 * bit-exactly; only guest MEMORY written by the callee (and EAX in the result)
 * carries information out.
 */
export function callGuestFunctionSync(
    env: SyncCallEnv,
    target: number,
    args: number[],
    convention: 'stdcall' | 'cdecl',
    maxBlocks: number = SYNC_CALL_DEFAULT_MAX_BLOCKS,
): SyncCallResult {
    if (!env.runGuestUntil) return { ok: false, reason: 'no-export' };
    const { cpu, mem } = env;
    const reg32: Int32Array = cpu.reg32;

    // ── frame construction ──
    const espEntry = reg32[4] >>> 0;
    const frameBase = (espEntry - STACK_RED_ZONE) & ~3;
    const newEsp = frameBase - 4 * (args.length + 1);
    if (newEsp < 0x1000 || frameBase > mem.length) return { ok: false, reason: 'bad-stack' };

    // ── full snapshot (GPRs/EIP/materialized EFLAGS/x87/SSE) ──
    const saved: CpuContext = saveCpuContext(cpu);

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(newEsp, env.sentinelAddress >>> 0, true);
    for (let i = 0; i < args.length; i++) {
        view.setUint32(newEsp + 4 + i * 4, args[i] >>> 0, true);
    }
    reg32[4] = newEsp;
    cpu.instruction_pointer[0] = target >>> 0;

    // ── run to sentinel ──
    let code: number;
    env.pin?.();
    try {
        code = env.runGuestUntil(
            env.sentinelAddress >>> 0, target >>> 0, maxBlocks >>> 0,
            env.abortLo >>> 0, env.abortHi >>> 0) >>> 0;
    } catch (e) {
        restoreSnapshot(cpu, saved);
        console.error(`[HLE-sync-call] run_guest_until threw: ${e}`);
        return { ok: false, reason: 'budget' };
    } finally {
        env.unpin?.();
    }

    const eax = reg32[0] >>> 0;
    const espAfter = reg32[4] >>> 0;
    restoreSnapshot(cpu, saved);

    if (code !== 0) {
        return { ok: false, reason: code === 2 ? 'hlt' : code === 3 ? 'thunk-entry' : 'budget' };
    }
    const expectedEsp = convention === 'stdcall'
        ? (newEsp + 4 + args.length * 4) >>> 0  // RET N pops sentinel + args
        : (newEsp + 4) >>> 0;                   // RET pops sentinel only
    if (espAfter !== expectedEsp) {
        console.error(
            `[HLE-sync-call] ESP drift after 0x${target.toString(16)}: ` +
            `expected 0x${expectedEsp.toString(16)}, got 0x${espAfter.toString(16)} — ABI model wrong`);
        return { ok: false, reason: 'esp-drift' };
    }
    return { ok: true, eax };
}

/** Bit-exact restore of the snapshot taken at entry (mirrors the scheduler's
 *  applyContextState: authoritative EFLAGS ⇒ clear the lazy-flags dirty mask;
 *  x87 + SSE written back whole). `previous_ip` is deliberately not touched —
 *  it only feeds fault reporting and is refreshed at the next block entry. */
function restoreSnapshot(cpu: any, ctx: CpuContext): void {
    const reg: Int32Array = cpu.reg32;
    reg[0] = ctx.eax; reg[1] = ctx.ecx; reg[2] = ctx.edx; reg[3] = ctx.ebx;
    reg[4] = ctx.esp; reg[5] = ctx.ebp; reg[6] = ctx.esi; reg[7] = ctx.edi;
    cpu.instruction_pointer[0] = ctx.eip;
    cpu.flags[0] = ctx.eflags;
    if (cpu.flags_changed) cpu.flags_changed[0] = 0;
    if (ctx.fpu) fpuRestore({ cpu }, ctx.fpu);
    if (ctx.simd) simdRestore({ cpu }, ctx.simd);
}
