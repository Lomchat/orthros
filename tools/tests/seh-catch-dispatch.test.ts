/**
 * C++ EH catch dispatch — end-to-end unit tests for seh-dispatch.ts.
 *
 * Unlike the other crt-* tests (which only assert on JS-side register/memory
 * mutations), these tests EXECUTE the emitted trampolines with a micro x86
 * stepper that understands exactly the instruction set our emitter produces
 * (MOV r32,imm32 / PUSH / POP / PUSHAD / POPAD / CALL rel32 / JMP rel32 /
 * RET (n) / JMP EAX / OUT DX,EAX / MOV [EBP+d8],imm32|ESP), plus a "probe
 * region" of virtual guest functions (funclets, destructors, continuations)
 * that log their invocation and simulate returns/rethrows. The OUT hook feeds
 * the catch-completion hypercall back into sehOnCatchCompletion — so the full
 * throw → catch → rethrow → ... → continuation loop runs exactly as it does
 * live, including the gadget's saved-EAX patch for exception-object destruction.
 *
 * The centerpiece models the Max Payne level-load failure: a nested rethrow
 * chain (throw X → catch#1 rethrows → catch#2 runs destructors + rethrows →
 * catch#3 completes). The historical bug walked ESP above the stack top and
 * RET'd to a wild EIP; the assertions pin the CRT contract instead:
 * continuation resumes with ESP = [pRN-4] (the saved try-entry ESP) and
 * EBP = pRN + 12.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import {
    dispatchCxxException,
    sehOnCatchCompletion,
    getActiveCatchRecords,
    getActiveException,
    clearAllActiveExceptions,
} from "../../src/worker/core/seh-dispatch";
import { SEH_CATCH_COMPLETION_FUNCID } from "../../src/worker/core/thunking/thunk-memory-manager";

const MEM_SIZE = 0x200000;
const TEB = 0x1000;
const GADGET = 0x2000; // catch-completion gadget (byte-for-byte what ThunkMemoryManager writes)
const JMPEAX = 0x2100;
const CODE_BASE = 0x20000; // FuncInfo / ThrowInfo / handler thunks / real funclet code
const PROBE_BASE = 0x30000; // virtual guest functions, intercepted by the stepper
const STACK_TOP = 0x110000; // guest stack [0x100000, 0x110000)

type ProbeSpec =
    | { kind: "funclet-return"; continuation: number; log: string }
    | { kind: "dtor"; log: string }
    | { kind: "copy-ctor"; log: string } // __thiscall, 1 stack arg → RET 4
    | { kind: "rethrow"; log: string } // performs `throw;`
    | { kind: "throw-new"; pObj: number; pThrow: number; log: string }
    | { kind: "stop"; log: string }; // continuation landing point — halt

interface Cpu {
    reg32: Uint32Array;
    segment_offsets: Record<number, number>;
    instruction_pointer: Uint32Array;
}

let mem: Uint8Array;
let dv: DataView;
let cpu: Cpu;
let probes: Map<number, ProbeSpec>;
let log: string[];
let probeCursor: number;

function makeProbe(spec: ProbeSpec): number {
    const addr = probeCursor;
    probeCursor += 16;
    probes.set(addr, spec);
    return addr;
}

function push(v: number): void {
    cpu.reg32[4] = (cpu.reg32[4] - 4) >>> 0;
    dv.setUint32(cpu.reg32[4], v >>> 0, true);
}

function pop(): number {
    const v = dv.getUint32(cpu.reg32[4], true) >>> 0;
    cpu.reg32[4] = (cpu.reg32[4] + 4) >>> 0;
    return v;
}

/** Guest calls the _CxxThrowException thunk stub: dispatch + the stub's RET 8. */
function simulateThrowThunk(pObj: number, pThrow: number): boolean {
    const res = dispatchCxxException(mem, cpu, pObj, pThrow, 8);
    if (!res) {
        log.push(`UNHANDLED:0x${pObj.toString(16)}`);
        return false;
    }
    const target = dv.getUint32(cpu.reg32[4], true) >>> 0; // RET 8: EIP = [ESP]
    cpu.reg32[4] = (cpu.reg32[4] + 12) >>> 0; //          ESP += 4 + 8
    cpu.instruction_pointer[0] = target;
    return true;
}

/** Run the micro-stepper from the current EIP until a 'stop' probe (or failure). */
function run(maxSteps = 20000): void {
    for (let i = 0; i < maxSteps; i++) {
        const eip = cpu.instruction_pointer[0] >>> 0;
        const probe = probes.get(eip);
        if (probe) {
            log.push(probe.log);
            switch (probe.kind) {
                case "stop":
                    return;
                case "funclet-return":
                    cpu.reg32[0] = probe.continuation >>> 0;
                    cpu.instruction_pointer[0] = pop();
                    continue;
                case "dtor":
                    cpu.instruction_pointer[0] = pop();
                    continue;
                case "copy-ctor": {
                    const ra = pop();
                    pop(); // consume the pushed src arg (RET 4)
                    cpu.instruction_pointer[0] = ra;
                    continue;
                }
                case "rethrow":
                case "throw-new": {
                    const pObj = probe.kind === "rethrow" ? 0 : probe.pObj;
                    const pThrow = probe.kind === "rethrow" ? 0 : probe.pThrow;
                    // guest: push pThrowInfo; push pObj; call stub (ret addr pushed)
                    push(pThrow);
                    push(pObj);
                    push(0x0dead001);
                    if (!simulateThrowThunk(pObj, pThrow)) return;
                    continue;
                }
            }
        }
        const op = mem[eip];
        if (op >= 0xb8 && op <= 0xbf) { // MOV r32, imm32
            cpu.reg32[op - 0xb8] = dv.getUint32(eip + 1, true);
            cpu.instruction_pointer[0] = eip + 5;
        } else if (op === 0x68) { // PUSH imm32
            push(dv.getUint32(eip + 1, true));
            cpu.instruction_pointer[0] = eip + 5;
        } else if (op >= 0x50 && op <= 0x57) { // PUSH r32
            push(cpu.reg32[op - 0x50]);
            cpu.instruction_pointer[0] = eip + 1;
        } else if (op >= 0x58 && op <= 0x5f) { // POP r32
            cpu.reg32[op - 0x58] = pop();
            cpu.instruction_pointer[0] = eip + 1;
        } else if (op === 0x60) { // PUSHAD
            const origEsp = cpu.reg32[4];
            push(cpu.reg32[0]); push(cpu.reg32[1]); push(cpu.reg32[2]); push(cpu.reg32[3]);
            push(origEsp); push(cpu.reg32[5]); push(cpu.reg32[6]); push(cpu.reg32[7]);
            cpu.instruction_pointer[0] = eip + 1;
        } else if (op === 0x61) { // POPAD
            cpu.reg32[7] = pop(); cpu.reg32[6] = pop(); cpu.reg32[5] = pop();
            pop(); // ESP image discarded
            cpu.reg32[3] = pop(); cpu.reg32[2] = pop(); cpu.reg32[1] = pop(); cpu.reg32[0] = pop();
            cpu.instruction_pointer[0] = eip + 1;
        } else if (op === 0xe8) { // CALL rel32
            const rel = dv.getInt32(eip + 1, true);
            push(eip + 5);
            cpu.instruction_pointer[0] = (eip + 5 + rel) >>> 0;
        } else if (op === 0xe9) { // JMP rel32
            const rel = dv.getInt32(eip + 1, true);
            cpu.instruction_pointer[0] = (eip + 5 + rel) >>> 0;
        } else if (op === 0xc3) { // RET
            cpu.instruction_pointer[0] = pop();
        } else if (op === 0xc2) { // RET imm16
            const n = mem[eip + 1] | (mem[eip + 2] << 8);
            const ra = pop();
            cpu.reg32[4] = (cpu.reg32[4] + n) >>> 0;
            cpu.instruction_pointer[0] = ra;
        } else if (op === 0xff && mem[eip + 1] >= 0xe0 && mem[eip + 1] <= 0xe7) { // JMP r32
            cpu.instruction_pointer[0] = cpu.reg32[mem[eip + 1] - 0xe0] >>> 0;
        } else if (op === 0xef) { // OUT DX, EAX → hypercall
            if ((cpu.reg32[0] >>> 0) === SEH_CATCH_COMPLETION_FUNCID) {
                sehOnCatchCompletion(cpu);
            }
            cpu.instruction_pointer[0] = eip + 1;
        } else if (op === 0xc7 && mem[eip + 1] === 0x45) { // MOV [EBP+disp8], imm32
            const disp = (mem[eip + 2] << 24) >> 24;
            dv.setUint32((cpu.reg32[5] + disp) >>> 0, dv.getUint32(eip + 3, true), true);
            cpu.instruction_pointer[0] = eip + 7;
        } else if (op === 0x89 && mem[eip + 1] === 0x65) { // MOV [EBP+disp8], ESP
            const disp = (mem[eip + 2] << 24) >> 24;
            dv.setUint32((cpu.reg32[5] + disp) >>> 0, cpu.reg32[4] >>> 0, true);
            cpu.instruction_pointer[0] = eip + 3;
        } else {
            throw new Error(`stepper: unknown opcode 0x${op.toString(16)} at eip=0x${eip.toString(16)} log=[${log.join(",")}]`);
        }
    }
    throw new Error(`stepper: step limit, log=[${log.join(",")}]`);
}

// ---------------------------------------------------------------------------
// Guest structure builders
// ---------------------------------------------------------------------------

let codeCursor: number;

function alloc(n: number, align = 4): number {
    codeCursor = (codeCursor + align - 1) & ~(align - 1);
    const a = codeCursor;
    codeCursor += n;
    return a;
}

function buildTypeDescriptor(name: string): number {
    const a = alloc(8 + name.length + 1);
    dv.setUint32(a, 0x11111111, true); // pVFTable (nonzero)
    dv.setUint32(a + 4, 0, true);
    for (let i = 0; i < name.length; i++) mem[a + 8 + i] = name.charCodeAt(i);
    mem[a + 8 + name.length] = 0;
    return a;
}

function buildThrowInfo(typeDesc: number, pmfnUnwind = 0, size = 4, copyFn = 0): number {
    const ct = alloc(28); // CatchableType
    dv.setUint32(ct, 1, true);
    dv.setUint32(ct + 4, typeDesc, true);
    dv.setInt32(ct + 8, 0, true); // PMD.mdisp
    dv.setInt32(ct + 12, -1, true); // PMD.pdisp
    dv.setInt32(ct + 16, 0, true); // PMD.vdisp
    dv.setInt32(ct + 20, size, true);
    dv.setUint32(ct + 24, copyFn, true);
    const cta = alloc(8);
    dv.setInt32(cta, 1, true);
    dv.setUint32(cta + 4, ct, true);
    const ti = alloc(16);
    dv.setUint32(ti, 0, true);
    dv.setUint32(ti + 4, pmfnUnwind, true);
    dv.setUint32(ti + 8, 0, true);
    dv.setUint32(ti + 12, cta, true);
    return ti;
}

interface TryBlockSpec {
    tryLow: number;
    tryHigh: number;
    catchHigh: number;
    handlers: Array<{ adjectives: number; pType: number; dispCatchObj: number; addr: number }>;
}

function buildFuncInfo(unwindMap: Array<[number, number]>, tryBlocks: TryBlockSpec[]): number {
    const uw = alloc(unwindMap.length * 8);
    unwindMap.forEach(([toState, action], i) => {
        dv.setInt32(uw + i * 8, toState, true);
        dv.setUint32(uw + i * 8 + 4, action, true);
    });
    const handlerArrays = tryBlocks.map((tb) => {
        const ha = alloc(tb.handlers.length * 16);
        tb.handlers.forEach((h, j) => {
            dv.setUint32(ha + j * 16, h.adjectives, true);
            dv.setUint32(ha + j * 16 + 4, h.pType, true);
            dv.setInt32(ha + j * 16 + 8, h.dispCatchObj, true);
            dv.setUint32(ha + j * 16 + 12, h.addr, true);
        });
        return ha;
    });
    const tbm = alloc(tryBlocks.length * 20);
    tryBlocks.forEach((tb, i) => {
        dv.setInt32(tbm + i * 20, tb.tryLow, true);
        dv.setInt32(tbm + i * 20 + 4, tb.tryHigh, true);
        dv.setInt32(tbm + i * 20 + 8, tb.catchHigh, true);
        dv.setInt32(tbm + i * 20 + 12, tb.handlers.length, true);
        dv.setUint32(tbm + i * 20 + 16, handlerArrays[i], true);
    });
    const fi = alloc(28);
    dv.setUint32(fi, 0x19930520, true);
    dv.setInt32(fi + 4, unwindMap.length, true); // maxState
    dv.setUint32(fi + 8, uw, true);
    dv.setUint32(fi + 12, tryBlocks.length, true);
    dv.setUint32(fi + 16, tbm, true);
    dv.setUint32(fi + 20, 0, true);
    dv.setUint32(fi + 24, 0, true);
    return fi;
}

function buildHandlerThunk(funcInfo: number): number {
    const a = alloc(10);
    mem[a] = 0xb8; // MOV EAX, funcInfo
    dv.setUint32(a + 1, funcInfo, true);
    mem[a + 5] = 0xe9; // JMP __CxxFrameHandler (target irrelevant — never executed)
    dv.setInt32(a + 6, 0, true);
    return a;
}

/**
 * Build a VC7-shape EH frame inside the fake stack: {next, handlerThunk, state}
 * at pRN, saved try-entry ESP at [pRN-4] (the compiler's `mov [ebp-10h], esp`).
 */
function buildEhFrame(pRN: number, next: number, handlerThunk: number, state: number, savedTryEsp: number): void {
    dv.setUint32(pRN, next, true);
    dv.setUint32(pRN + 4, handlerThunk, true);
    dv.setInt32(pRN + 8, state, true);
    dv.setUint32(pRN - 4, savedTryEsp, true);
}

function writeCompletionGadget(): void {
    let o = GADGET;
    const fid = SEH_CATCH_COMPLETION_FUNCID >>> 0;
    mem[o++] = 0x50; // push eax
    mem[o++] = 0xb8; dv.setUint32(o, fid, true); o += 4; // mov eax, funcId
    mem[o++] = 0xba; dv.setUint32(o, 0xb077, true); o += 4; // mov edx, 0xB077
    mem[o++] = 0xef; // out dx, eax
    mem[o++] = 0x58; // pop eax
    mem[o++] = 0xff; mem[o++] = 0xe0; // jmp eax
    mem[JMPEAX] = 0xff;
    mem[JMPEAX + 1] = 0xe0;
}

// bun runs every test file in one process — restore the real (possibly undefined)
// System singleton after each test so the mock never leaks into other suites.
let savedSystemInstance: unknown;

afterEach(() => {
    (System as unknown as { instance: unknown }).instance = savedSystemInstance;
});

beforeEach(() => {
    savedSystemInstance = (System as unknown as { instance: unknown }).instance;
    mem = new Uint8Array(MEM_SIZE);
    dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    cpu = {
        reg32: new Uint32Array(8),
        segment_offsets: { 4: TEB },
        instruction_pointer: new Uint32Array(1),
    };
    probes = new Map();
    log = [];
    probeCursor = PROBE_BASE;
    codeCursor = CODE_BASE;
    writeCompletionGadget();
    clearAllActiveExceptions(TEB);
    // Inject a minimal System mock (private-static instance) — seh-dispatch reads
    // gadget addresses, the address space validator, memory, and the scheduler tid.
    (System as unknown as { instance: unknown }).instance = {
        process: {
            dispatcher: {
                getThunkMemoryRegions: () => ({
                    catchCompletionGadgetAddress: GADGET,
                    jmpEaxGadgetAddress: JMPEAX,
                    sehStackTop: 0,
                }),
            },
            addressSpace: {
                validateRange: (a: number, s: number) => a >= 0x800 && a + s <= MEM_SIZE,
            },
            getMemory: () => mem,
            moduleRegistry: null,
        },
        scheduler: { getCurrentThreadId: () => 1 },
    };
});

describe("seh catch dispatch", () => {
    test("Max Payne chain: throw → catch#1 rethrow → catch#2 dtors+rethrow → catch#3 completes with CRT ESP/EBP", () => {
        const typeDesc = buildTypeDescriptor(".?AVX_Level@@");
        const objDtor = makeProbe({ kind: "dtor", log: "obj-dtor" });
        const throwInfo = buildThrowInfo(typeDesc, objDtor);

        // Exception object lives in the thrower's frame, just above throwEsp.
        const pObj = 0x10a020;
        const throwEsp = 0x10a000;

        // Three catching frames up the stack, innermost (frame1) first in FS:[0].
        const f1 = { pRN: 0x10b000, savedEsp: 0x10afd0 };
        const f2 = { pRN: 0x10c000, savedEsp: 0x10bfd0 };
        const f3 = { pRN: 0x10d000, savedEsp: 0x10cfd0 };

        const funclet1 = makeProbe({ kind: "rethrow", log: "funclet1" });
        const funclet2 = makeProbe({ kind: "rethrow", log: "funclet2" });
        const cont3 = makeProbe({ kind: "stop", log: "continuation3" });
        const funclet3 = makeProbe({ kind: "funclet-return", continuation: cont3, log: "funclet3" });
        const dtorA = makeProbe({ kind: "dtor", log: "dtorA" });
        const dtorB = makeProbe({ kind: "dtor", log: "dtorB" });

        // frame1: single try [0..1], catch(...) funclet1, no destructors.
        // Catch state (2) unwinds to -1 (the catch's parent is the try's parent).
        const fi1 = buildFuncInfo(
            [[-1, 0], [-1, 0], [-1, 0]],
            [{ tryLow: 0, tryHigh: 1, catchHigh: 2, handlers: [{ adjectives: 0, pType: 0, dispCatchObj: 0, addr: funclet1 }] }],
        );
        // frame2: two live objects with destructors inside the try (states 1, 2),
        // so catch entry must run dtorB then dtorA (partial unwind trylevel→tryLow).
        const fi2 = buildFuncInfo(
            [[-1, 0], [0, dtorA], [1, dtorB], [-1, 0]],
            [{ tryLow: 0, tryHigh: 2, catchHigh: 3, handlers: [{ adjectives: 0, pType: 0, dispCatchObj: 0, addr: funclet2 }] }],
        );
        // frame3: catch by reference — funclet3 returns the continuation.
        const fi3 = buildFuncInfo(
            [[-1, 0], [-1, 0], [-1, 0]],
            [{ tryLow: 0, tryHigh: 1, catchHigh: 2, handlers: [{ adjectives: 8, pType: typeDesc, dispCatchObj: -0x20, addr: funclet3 }] }],
        );

        buildEhFrame(f1.pRN, f2.pRN, buildHandlerThunk(fi1), 1, f1.savedEsp);
        buildEhFrame(f2.pRN, f3.pRN, buildHandlerThunk(fi2), 2, f2.savedEsp);
        buildEhFrame(f3.pRN, 0xffffffff, buildHandlerThunk(fi3), 1, f3.savedEsp);
        dv.setUint32(TEB, f1.pRN, true);

        cpu.reg32[4] = throwEsp;
        const thrower = makeProbe({ kind: "throw-new", pObj, pThrow: throwInfo, log: "throw" });
        cpu.instruction_pointer[0] = thrower;
        run();

        expect(log).toEqual([
            "throw",
            "funclet1",         // catch#1 (no dtors) rethrows
            "dtorB", "dtorA",   // catch#2's partial unwind runs before its funclet
            "funclet2",         // catch#2 rethrows
            "funclet3",         // catch#3 catches the same object by reference
            "obj-dtor",         // normal completion destroys the exception object
            "continuation3",
        ]);
        // THE Max Payne assertions: continuation resumed with the CRT contract —
        // ESP = [pRN-4] (saved try-entry ESP), EBP = pRN + 12. Historically ESP
        // walked ~0x4000 above the stack top and RET'd to a wild EIP.
        expect(cpu.reg32[4] >>> 0).toBe(f3.savedEsp);
        expect(cpu.reg32[5] >>> 0).toBe(f3.pRN + 12);
        expect(cpu.reg32[4]).toBeLessThan(STACK_TOP);
        // catch(T&) stored a pointer to the exception object in the catch variable.
        expect(dv.getUint32(f3.pRN + 12 - 0x20, true)).toBe(pObj);
        // Records/active exceptions fully drained; PRN_STACK restored on all frames.
        expect(getActiveCatchRecords()).toEqual([]);
        expect(getActiveException(TEB)).toBeUndefined();
        expect(dv.getUint32(f3.pRN - 4, true)).toBe(f3.savedEsp);
        // Exited/skipped frames marked fully unwound.
        expect(dv.getInt32(f1.pRN + 8, true)).toBe(-1);
        expect(dv.getInt32(f2.pRN + 8, true)).toBe(-1);
    });

    test("normal catch: copy-ctor runs before dtors, object destroyed once on completion", () => {
        const typeDesc = buildTypeDescriptor(".?AVcString@@");
        const objDtor = makeProbe({ kind: "dtor", log: "obj-dtor" });
        const copyCtor = makeProbe({ kind: "copy-ctor", log: "copy-ctor" });
        const throwInfo = buildThrowInfo(typeDesc, objDtor, 8, copyCtor);

        const pObj = 0x109020;
        const throwEsp = 0x109000;
        const f1 = { pRN: 0x10b000, savedEsp: 0x10afd0 };

        const cont = makeProbe({ kind: "stop", log: "continuation" });
        const funclet = makeProbe({ kind: "funclet-return", continuation: cont, log: "funclet" });
        const dtorLocal = makeProbe({ kind: "dtor", log: "dtor-local" });

        // One local with dtor inside the try (state 1); catch-by-value with copy-ctor.
        const fi = buildFuncInfo(
            [[-1, 0], [0, dtorLocal], [-1, 0]],
            [{ tryLow: 0, tryHigh: 1, catchHigh: 2, handlers: [{ adjectives: 0, pType: typeDesc, dispCatchObj: -0x30, addr: funclet }] }],
        );
        buildEhFrame(f1.pRN, 0xffffffff, buildHandlerThunk(fi), 1, f1.savedEsp);
        dv.setUint32(TEB, f1.pRN, true);

        cpu.reg32[4] = throwEsp;
        cpu.instruction_pointer[0] = makeProbe({ kind: "throw-new", pObj, pThrow: throwInfo, log: "throw" });
        run();

        // CatchIt order: BuildCatchObject (copy) BEFORE the frame's partial unwind.
        expect(log).toEqual(["throw", "copy-ctor", "dtor-local", "funclet", "obj-dtor", "continuation"]);
        expect(cpu.reg32[4] >>> 0).toBe(f1.savedEsp);
        expect(cpu.reg32[5] >>> 0).toBe(f1.pRN + 12);
        expect(getActiveCatchRecords()).toEqual([]);
        expect(getActiveException(TEB)).toBeUndefined();
    });

    test("same-frame rethrow: enclosing try of the SAME frame catches after inner catch rethrows", () => {
        const typeDesc = buildTypeDescriptor(".?AVX@@");
        const throwInfo = buildThrowInfo(typeDesc);
        const pObj = 0x108020;
        const throwEsp = 0x108000;
        const f = { pRN: 0x10b000, savedEsp: 0x10afd0 };

        const funcletInner = makeProbe({ kind: "rethrow", log: "funclet-inner" });
        const contOuter = makeProbe({ kind: "stop", log: "continuation-outer" });
        const funcletOuter = makeProbe({ kind: "funclet-return", continuation: contOuter, log: "funclet-outer" });

        // States: 0 = outer try, 1 = inner try, 2 = inner catch body (parent 0),
        // 3 = outer catch body (parent -1). Try map: innermost first.
        const fi = buildFuncInfo(
            [[-1, 0], [0, 0], [0, 0], [-1, 0]],
            [
                { tryLow: 1, tryHigh: 1, catchHigh: 2, handlers: [{ adjectives: 0, pType: 0, dispCatchObj: 0, addr: funcletInner }] },
                { tryLow: 0, tryHigh: 2, catchHigh: 3, handlers: [{ adjectives: 0, pType: 0, dispCatchObj: 0, addr: funcletOuter }] },
            ],
        );
        buildEhFrame(f.pRN, 0xffffffff, buildHandlerThunk(fi), 1, f.savedEsp);
        dv.setUint32(TEB, f.pRN, true);

        cpu.reg32[4] = throwEsp;
        cpu.instruction_pointer[0] = makeProbe({ kind: "throw-new", pObj, pThrow: throwInfo, log: "throw" });
        run();

        expect(log).toEqual(["throw", "funclet-inner", "funclet-outer", "continuation-outer"]);
        expect(cpu.reg32[4] >>> 0).toBe(f.savedEsp);
        expect(cpu.reg32[5] >>> 0).toBe(f.pRN + 12);
        expect(getActiveCatchRecords()).toEqual([]);
        expect(getActiveException(TEB)).toBeUndefined();
    });

    test("CatchGuard: try nested INSIDE a catch body handles its throw; both catches complete LIFO", () => {
        const typeDesc = buildTypeDescriptor(".?AVX@@");
        const throwInfo = buildThrowInfo(typeDesc);
        const pObj = 0x107020;
        const throwEsp = 0x107000;
        const f = { pRN: 0x10b000, savedEsp: 0x10afd0 };

        // funclet1 is REAL guest code (not a probe): it saves its try-entry ESP to
        // [ebp-0x10] (= [pRN-4], what the compiler emits for a try inside a catch),
        // enters the inner try (state 3 → [ebp-4]), then throws.
        const contOuter = makeProbe({ kind: "stop", log: "continuation-outer" });
        const innerCont = makeProbe({ kind: "funclet-return", continuation: contOuter, log: "inner-continuation" });
        const funcletGuard = makeProbe({ kind: "funclet-return", continuation: innerCont, log: "funclet-guard" });
        const innerThrow = makeProbe({ kind: "throw-new", pObj, pThrow: throwInfo, log: "inner-throw" });

        const funclet1 = alloc(16);
        let o = funclet1;
        mem[o] = 0x89; mem[o + 1] = 0x65; mem[o + 2] = 0xf0; o += 3;       // mov [ebp-0x10], esp
        mem[o] = 0xc7; mem[o + 1] = 0x45; mem[o + 2] = 0xfc;               // mov [ebp-4], 3
        dv.setUint32(o + 3, 3, true); o += 7;
        mem[o] = 0xe9; dv.setInt32(o + 1, innerThrow - (o + 5), true);     // jmp inner-throw probe

        // States: 0 = outer try, 1 = (unused), 2 = catch body entry (tryHigh+1),
        // 3 = inner try (inside catch), 4 = inner catch body (parent 2).
        const fi = buildFuncInfo(
            [[-1, 0], [-1, 0], [-1, 0], [2, 0], [2, 0]],
            [
                { tryLow: 3, tryHigh: 3, catchHigh: 4, handlers: [{ adjectives: 0, pType: 0, dispCatchObj: 0, addr: funcletGuard }] },
                { tryLow: 0, tryHigh: 1, catchHigh: 4, handlers: [{ adjectives: 0, pType: 0, dispCatchObj: 0, addr: funclet1 }] },
            ],
        );
        buildEhFrame(f.pRN, 0xffffffff, buildHandlerThunk(fi), 0, f.savedEsp);
        dv.setUint32(TEB, f.pRN, true);

        cpu.reg32[4] = throwEsp;
        cpu.instruction_pointer[0] = makeProbe({ kind: "throw-new", pObj, pThrow: throwInfo, log: "outer-throw" });
        run();

        expect(log).toEqual([
            "outer-throw",
            "inner-throw",        // funclet1 (real code) entered inner try and threw
            "funclet-guard",      // caught INSIDE the catch body (CatchGuard), outer record kept
            "inner-continuation", // resumes inside funclet1, which then returns normally
            "continuation-outer",
        ]);
        expect(cpu.reg32[4] >>> 0).toBe(f.savedEsp);
        expect(cpu.reg32[5] >>> 0).toBe(f.pRN + 12);
        expect(getActiveCatchRecords()).toEqual([]);
        expect(getActiveException(TEB)).toBeUndefined();
        // PRN_STACK restored to the ORIGINAL frame value after both completions.
        expect(dv.getUint32(f.pRN - 4, true)).toBe(f.savedEsp);
    });

    test("new throw out of a catch destroys the old exception object before entering the next catch", () => {
        const typeX = buildTypeDescriptor(".?AVX@@");
        const typeY = buildTypeDescriptor(".?AVY@@");
        const objDtor1 = makeProbe({ kind: "dtor", log: "obj1-dtor" });
        const objDtor2 = makeProbe({ kind: "dtor", log: "obj2-dtor" });
        const throwInfo1 = buildThrowInfo(typeX, objDtor1);
        const throwInfo2 = buildThrowInfo(typeY, objDtor2);

        const pObj1 = 0x106020;
        const throwEsp = 0x106000;
        const f1 = { pRN: 0x10b000, savedEsp: 0x10afd0 };
        const f2 = { pRN: 0x10c000, savedEsp: 0x10bfd0 };

        // funclet1 throws a NEW exception (object lives in the funclet's frame — the
        // probe allocates it below the current ESP like a real local would be).
        const pObj2 = 0x105800;
        const funclet1 = makeProbe({ kind: "throw-new", pObj: pObj2, pThrow: throwInfo2, log: "funclet1-new-throw" });
        const cont2 = makeProbe({ kind: "stop", log: "continuation2" });
        const funclet2 = makeProbe({ kind: "funclet-return", continuation: cont2, log: "funclet2" });

        const fi1 = buildFuncInfo(
            [[-1, 0], [-1, 0], [-1, 0]],
            [{ tryLow: 0, tryHigh: 1, catchHigh: 2, handlers: [{ adjectives: 0, pType: typeX, dispCatchObj: 0, addr: funclet1 }] }],
        );
        const fi2 = buildFuncInfo(
            [[-1, 0], [-1, 0], [-1, 0]],
            [{ tryLow: 0, tryHigh: 1, catchHigh: 2, handlers: [{ adjectives: 0, pType: typeY, dispCatchObj: 0, addr: funclet2 }] }],
        );
        buildEhFrame(f1.pRN, f2.pRN, buildHandlerThunk(fi1), 1, f1.savedEsp);
        buildEhFrame(f2.pRN, 0xffffffff, buildHandlerThunk(fi2), 1, f2.savedEsp);
        dv.setUint32(TEB, f1.pRN, true);

        cpu.reg32[4] = throwEsp;
        cpu.instruction_pointer[0] = makeProbe({ kind: "throw-new", pObj: pObj1, pThrow: throwInfo1, log: "throw1" });
        run();

        expect(log).toEqual([
            "throw1",
            "funclet1-new-throw",
            "obj1-dtor",     // old exception dies when the new throw exits catch#1
            "funclet2",      // catch#2 catches the NEW exception
            "obj2-dtor",     // completion destroys the new object
            "continuation2",
        ]);
        expect(cpu.reg32[4] >>> 0).toBe(f2.savedEsp);
        expect(getActiveCatchRecords()).toEqual([]);
        expect(getActiveException(TEB)).toBeUndefined();
    });

    test("rethrow with no enclosing catch is reported unhandled (returns null), records drained", () => {
        const typeDesc = buildTypeDescriptor(".?AVX@@");
        const throwInfo = buildThrowInfo(typeDesc);
        const pObj = 0x104020;
        const throwEsp = 0x104000;
        const f1 = { pRN: 0x10b000, savedEsp: 0x10afd0 };

        const funclet1 = makeProbe({ kind: "rethrow", log: "funclet1" });
        const fi1 = buildFuncInfo(
            [[-1, 0], [-1, 0], [-1, 0]],
            [{ tryLow: 0, tryHigh: 1, catchHigh: 2, handlers: [{ adjectives: 0, pType: 0, dispCatchObj: 0, addr: funclet1 }] }],
        );
        buildEhFrame(f1.pRN, 0xffffffff, buildHandlerThunk(fi1), 1, f1.savedEsp);
        dv.setUint32(TEB, f1.pRN, true);

        cpu.reg32[4] = throwEsp;
        cpu.instruction_pointer[0] = makeProbe({ kind: "throw-new", pObj, pThrow: throwInfo, log: "throw" });
        run();

        expect(log).toEqual(["throw", "funclet1", `UNHANDLED:0x0`]);
        // The catch record was exited before the walk came up empty.
        expect(getActiveCatchRecords()).toEqual([]);
    });
});
