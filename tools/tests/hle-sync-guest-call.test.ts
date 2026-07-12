/**
 * Guarded Inner-Loop HLE — synchronous guest-call primitive unit tests.
 *
 * run_guest_until itself is wasm (exercised in-game); here we verify the TS
 * wrapper's contract with a scripted mock: frame construction (args pushed
 * right-to-left below a red zone, sentinel as return address), EAX capture,
 * ESP-drift detection per calling convention, abort taxonomy, and — the load-
 * bearing invariant — that the interrupted CPU state is restored bit-exactly
 * on every path, success and failure alike.
 */

import { describe, expect, test } from 'bun:test';
import {
    callGuestFunctionSync,
    writeSentinelBytes,
    type SyncCallEnv,
} from '../../src/worker/core/hle-lib/sync-guest-call';

const MEM_SIZE = 0x40000;
const SENTINEL = 0x21008;
const TARGET = 0x30000;
const ABORT_LO = 0x21000;
const ABORT_HI = 0x22000;

function mkCpu() {
    const reg32 = new Int32Array(8);
    reg32[0] = 0x11111111; reg32[1] = 0x22222222; reg32[2] = 0x33333333; reg32[3] = 0x44444444;
    reg32[4] = 0x20000;    reg32[5] = 0x55555555; reg32[6] = 0x66666666; reg32[7] = 0x77777777;
    return {
        reg32,
        instruction_pointer: new Int32Array([0x12345]),
        flags: new Int32Array([0x246]),
        flags_changed: new Int32Array([0xFF]),
        get_eflags() { return 0x257; }, // materialized value ≠ raw flags[0]
    };
}

function snapshotCpu(cpu: ReturnType<typeof mkCpu>) {
    return {
        regs: Array.from(cpu.reg32),
        eip: cpu.instruction_pointer[0],
    };
}

function expectRestored(cpu: ReturnType<typeof mkCpu>, snap: { regs: number[]; eip: number }) {
    expect(Array.from(cpu.reg32)).toEqual(snap.regs);
    expect(cpu.instruction_pointer[0]).toBe(snap.eip);
    // Materialized EFLAGS is authoritative + lazy mask cleared.
    expect(cpu.flags[0]).toBe(0x257);
    expect(cpu.flags_changed[0]).toBe(0);
}

/** Build an env whose runGuestUntil simulates a callee via `body`. */
function mkEnv(
    cpu: ReturnType<typeof mkCpu>,
    mem: Uint8Array,
    body: (view: DataView) => number,
): SyncCallEnv {
    return {
        cpu,
        mem,
        sentinelAddress: SENTINEL,
        abortLo: ABORT_LO,
        abortHi: ABORT_HI,
        runGuestUntil: (sentinel, exempt, _maxBlocks, lo, hi) => {
            expect(sentinel).toBe(SENTINEL);
            expect(exempt).toBe(TARGET);
            expect(lo).toBe(ABORT_LO);
            expect(hi).toBe(ABORT_HI);
            const view = new DataView(mem.buffer);
            return body(view);
        },
    };
}

/** Simulate a well-behaved stdcall callee: consume frame, RET N, land on sentinel. */
function stdcallBody(cpu: ReturnType<typeof mkCpu>, argCount: number, eax: number) {
    return (view: DataView): number => {
        const esp = cpu.reg32[4] >>> 0;
        expect(cpu.instruction_pointer[0] >>> 0).toBe(TARGET);
        expect(view.getUint32(esp, true)).toBe(SENTINEL);   // return address
        cpu.reg32[0] = eax | 0;
        cpu.reg32[4] = esp + 4 + argCount * 4;              // RET argCount*4
        cpu.instruction_pointer[0] = SENTINEL;
        return 0;
    };
}

describe('writeSentinelBytes', () => {
    test('writes JMP $ + NOP padding', () => {
        const mem = new Uint8Array(64);
        writeSentinelBytes(mem, 16);
        expect(mem[16]).toBe(0xEB);
        expect(mem[17]).toBe(0xFE);
        expect(mem[31]).toBe(0x90);
    });
});

describe('callGuestFunctionSync', () => {
    test('pushes args right-to-left below the red zone and returns EAX', () => {
        const cpu = mkCpu();
        const mem = new Uint8Array(MEM_SIZE);
        const args = [0xAAAA0001, 0xBBBB0002, 0xCCCC0003, 0x00000004];
        let seenArgs: number[] = [];
        const env = mkEnv(cpu, mem, view => {
            const esp = cpu.reg32[4] >>> 0;
            // Frame sits at least a red zone below the entry ESP.
            expect(esp).toBeLessThanOrEqual(0x20000 - 0x100 - (args.length + 1) * 4);
            seenArgs = args.map((_, i) => view.getUint32(esp + 4 + i * 4, true));
            return stdcallBody(cpu, args.length, 0x5A5A5A5A)(view);
        });
        const snap = snapshotCpu(cpu);
        const res = callGuestFunctionSync(env, TARGET, args, 'stdcall');
        expect(res).toEqual({ ok: true, eax: 0x5A5A5A5A });
        expect(seenArgs.map(a => a >>> 0)).toEqual(args);
        expectRestored(cpu, snap);
    });

    test('cdecl callee (RET without cleanup) passes the drift check', () => {
        const cpu = mkCpu();
        const mem = new Uint8Array(MEM_SIZE);
        const env = mkEnv(cpu, mem, () => {
            const esp = cpu.reg32[4] >>> 0;
            cpu.reg32[0] = 7;
            cpu.reg32[4] = esp + 4; // RET pops only the sentinel
            cpu.instruction_pointer[0] = SENTINEL;
            return 0;
        });
        const snap = snapshotCpu(cpu);
        const res = callGuestFunctionSync(env, TARGET, [1, 2], 'cdecl');
        expect(res).toEqual({ ok: true, eax: 7 });
        expectRestored(cpu, snap);
    });

    test('detects ESP drift (wrong RET N) and restores state', () => {
        const cpu = mkCpu();
        const mem = new Uint8Array(MEM_SIZE);
        const env = mkEnv(cpu, mem, () => {
            const esp = cpu.reg32[4] >>> 0;
            cpu.reg32[4] = esp + 4; // cleaned nothing — but we said stdcall(2)
            cpu.instruction_pointer[0] = SENTINEL;
            return 0;
        });
        const snap = snapshotCpu(cpu);
        const res = callGuestFunctionSync(env, TARGET, [1, 2], 'stdcall');
        expect(res).toEqual({ ok: false, reason: 'esp-drift' });
        expectRestored(cpu, snap);
    });

    test.each([
        [1, 'budget'],
        [2, 'hlt'],
        [3, 'thunk-entry'],
    ] as Array<[number, string]>)('maps abort code %d to %s and restores state', (code, reason) => {
        const cpu = mkCpu();
        const mem = new Uint8Array(MEM_SIZE);
        const env = mkEnv(cpu, mem, () => {
            cpu.reg32[0] = 0xDEAD; // clobber en route — must be rolled back
            cpu.reg32[4] -= 64;
            return code;
        });
        const snap = snapshotCpu(cpu);
        const res = callGuestFunctionSync(env, TARGET, [1], 'stdcall');
        expect(res).toEqual({ ok: false, reason } as any);
        expectRestored(cpu, snap);
    });

    test('missing wasm export fails cleanly without touching the CPU', () => {
        const cpu = mkCpu();
        const mem = new Uint8Array(MEM_SIZE);
        const snap = snapshotCpu(cpu);
        const res = callGuestFunctionSync(
            { cpu, mem, runGuestUntil: undefined, sentinelAddress: SENTINEL, abortLo: 0, abortHi: 0 },
            TARGET, [1], 'stdcall');
        expect(res).toEqual({ ok: false, reason: 'no-export' });
        expect(Array.from(cpu.reg32)).toEqual(snap.regs);
        expect(cpu.flags_changed[0]).toBe(0xFF); // untouched — no snapshot/restore ran
    });

    test('rejects a frame that would underflow guest memory', () => {
        const cpu = mkCpu();
        cpu.reg32[4] = 0x1080; // red zone pushes the frame below 0x1000
        const mem = new Uint8Array(MEM_SIZE);
        const env = mkEnv(cpu, mem, () => 0);
        const res = callGuestFunctionSync(env, TARGET, [1, 2, 3, 4], 'stdcall');
        expect(res).toEqual({ ok: false, reason: 'bad-stack' });
    });
});
