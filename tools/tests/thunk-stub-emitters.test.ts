// Byte-identity snapshot test for the PUBLIC x86 stub/trampoline emitters that used to
// live on ThunkMemoryManager. Each emitter is
// driven with fixed, representative arguments against a deterministic fake allocator and
// a zeroed guest memory; the SHA-256 of every emitted region plus the returned address
// structure is frozen below.
//
// These hashes pin the EXACT machine code bytes. If a hash changes, the emitter's codegen
// changed — for a mechanical move that means the move is broken. Fix the code, do NOT
// re-freeze the hashes (re-freezing is only legitimate for a deliberate codegen change,
// reviewed as such). To regenerate after a deliberate change:
//   SNAPSHOT_PRINT=1 bun test tools/tests/thunk-stub-emitters.test.ts

import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeHeapSlabStubs } from '../../src/worker/modules/kernel32/heap-slab-stubs';
import { writeCriticalSectionInlineStubs } from '../../src/worker/modules/kernel32/critical-section-inline-stubs';
import { writeTimeInlineStub } from '../../src/worker/modules/kernel32/time-inline-stubs';
import { writeSleepInlineStub } from '../../src/worker/modules/kernel32/sleep-inline-stubs';
import { writeCrtSlabStubs, writeGetcStub, writeCaseFoldStubs } from '../../src/worker/modules/crt-slab-stubs';
import {
    writeShadowTrampoline,
    writeOwnerDisarmScalarTrampoline,
    writeStructCaptureTrampoline,
    writeUpDrawCaptureTrampoline,
    writeSurfaceLockInlineTrampolines,
} from '../../src/worker/modules/d3d9/capture-trampolines';
import type { ShadowTrampolineSpec } from '../../src/worker/modules/d3d9/capture-trampolines';
import type { StubAllocator } from '../../src/worker/core/thunking/thunk-memory-manager';

const PRINT = !!process.env.SNAPSHOT_PRINT;

/** 1 MiB guest memory — small, but all fake-allocated addresses land inside it. */
const MEM_SIZE = 1 << 20;

interface Ctx {
    mem: Uint8Array;
    getMemory: () => Uint8Array;
    allocator: StubAllocator;
}

/** Fresh emitter context: zeroed memory + deterministic bump allocator from 0x1000. */
function mkCtx(): Ctx {
    const mem = new Uint8Array(MEM_SIZE);
    let bump = 0x1000;
    const allocator: StubAllocator = {
        alloc(size: number): number {
            const addr = bump;
            bump = (bump + size + 15) & ~15;
            return addr;
        },
    };
    return { mem, getMemory: () => mem, allocator };
}

function sha(mem: Uint8Array, base: number, end: number): string {
    return createHash('sha256').update(mem.subarray(base, end)).digest('hex');
}

interface Snapshot {
    result: unknown;
    hashes: Record<string, string>;
}

// Fixed representative arguments (arbitrary but stable guest addresses; they are baked
// into the emitted code as imm32/disp32, so they are part of the pinned bytes).
const SLAB_CTL = 0x20000;
const LUT = 0x20100;
const TRAP_A = 0x30000;
const TRAP_B = 0x30040;
const RING_CTRL = 0x40000;
const RING_DATA = 0x40010;
const RING_CAP = 0x8000;
const OWNER_GLOBAL = 0x20400;

/** SetSamplerState-shaped spec: two range-guarded key parts folded into one slot. */
const SAMPLER_SPEC: ShadowTrampolineSpec = {
    argCount: 4,
    valueArgIndex: 3,
    slotCount: 256,
    keyParts: [
        { argIndex: 1, shift: 4, max: 16 },
        { argIndex: 2, shift: 0, max: 16 },
    ],
};

/** BFME SetTextureStageState: 8 stages × 64 type slots (Type reaches 32). */
const TEXTURE_STAGE_SPEC: ShadowTrampolineSpec = {
    argCount: 4,
    valueArgIndex: 3,
    slotCount: 512,
    keyParts: [
        { argIndex: 1, shift: 6, max: 8 },
        { argIndex: 2, shift: 0, max: 64 },
    ],
};

const FVF_SPEC: ShadowTrampolineSpec = {
    argCount: 2,
    valueArgIndex: 1,
    slotCount: 1,
    keyParts: [],
};

/** SetRenderState-shaped spec: single key part with max > 0x7F (imm32 cmp form). */
const RENDERSTATE_SPEC: ShadowTrampolineSpec = {
    argCount: 3,
    valueArgIndex: 2,
    slotCount: 256,
    keyParts: [{ argIndex: 1, shift: 0, max: 256 }],
};

const cases: Record<string, (ctx: Ctx) => Snapshot> = {
    heapSlabStubs: (ctx) => {
        const r = writeHeapSlabStubs(ctx.allocator, ctx.getMemory, SLAB_CTL, LUT, TRAP_A, TRAP_B);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    criticalSectionInlineStubs: (ctx) => {
        const r = writeCriticalSectionInlineStubs(ctx.allocator, ctx.getMemory, TRAP_A, TRAP_B);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    timeInlineStub: (ctx) => {
        const r = writeTimeInlineStub(ctx.allocator, ctx.getMemory, 0x12345678);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    sleepInlineStub: (ctx) => {
        const r = writeSleepInlineStub(ctx.allocator, ctx.getMemory, TRAP_A, 0x578, 64);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.regionBase, r.regionEnd),
                control: sha(ctx.mem, r.controlAddr, r.controlAddr + 16),
            },
        };
    },
    crtSlabStubs: (ctx) => {
        const r = writeCrtSlabStubs(ctx.allocator, ctx.getMemory, SLAB_CTL, LUT, TRAP_A, TRAP_B);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    getcStub: (ctx) => {
        // Borland FILE layout: level @ +0, curp @ +20 (see msvcrt.getBorlandFileLayout).
        const r = writeGetcStub(ctx.allocator, ctx.getMemory, TRAP_A, 0, 20);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    caseFoldStubs: (ctx) => {
        const r = writeCaseFoldStubs(ctx.allocator, ctx.getMemory, LUT, LUT + 0x100, LUT + 0x200);
        return { result: r, hashes: { region: sha(ctx.mem, r.regionBase, r.regionEnd) } };
    },
    shadowTrampolineSampler: (ctx) => {
        const r = writeShadowTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, OWNER_GLOBAL, SAMPLER_SPEC);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd),
                data: sha(ctx.mem, r.dataRegionBase, r.dataRegionEnd),
            },
        };
    },
    shadowTrampolineRenderStateNoOwner: (ctx) => {
        // lastOwnerGlobal = 0 disables the owner gate (different codegen path).
        const r = writeShadowTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, 0, RENDERSTATE_SPEC);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd),
                data: sha(ctx.mem, r.dataRegionBase, r.dataRegionEnd),
            },
        };
    },
    shadowTrampolineTextureStage: (ctx) => {
        const r = writeShadowTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, OWNER_GLOBAL, TEXTURE_STAGE_SPEC);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd),
                data: sha(ctx.mem, r.dataRegionBase, r.dataRegionEnd),
            },
        };
    },
    shadowTrampolineFvf: (ctx) => {
        const r = writeShadowTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, OWNER_GLOBAL, FVF_SPEC);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd),
                data: sha(ctx.mem, r.dataRegionBase, r.dataRegionEnd),
            },
        };
    },
    ownerDisarmScalarTrampoline: (ctx) => {
        const r = writeOwnerDisarmScalarTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP, 1, OWNER_GLOBAL);
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    structCaptureTrampoline: (ctx) => {
        // SetTransform-shaped: (this, pMatrix) with a 16-dword payload.
        const r = writeStructCaptureTrampoline(
            ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP,
            { argCount: 2, ptrArgIndex: 1, payloadDwords: 16 });
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    upDrawCaptureTrampoline: (ctx) => {
        const r = writeUpDrawCaptureTrampoline(ctx.allocator, ctx.getMemory, RING_CTRL, RING_DATA, RING_CAP);
        return { result: r, hashes: { code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd) } };
    },
    surfaceLockInlineTrampolines: (ctx) => {
        const r = writeSurfaceLockInlineTrampolines(ctx.allocator, ctx.getMemory, 0x321, 0x322);
        return {
            result: r,
            hashes: {
                code: sha(ctx.mem, r.codeRegionBase, r.codeRegionEnd),
                table: sha(ctx.mem, r.tableBase, r.tableBase + 1024 * 32),
            },
        };
    },
};

// Frozen snapshots (generated on the pre-move code; MUST NOT change across the move).
const EXPECTED: Record<string, Snapshot> = {
    heapSlabStubs: {"result":{"heapAllocStub":4096,"heapFreeStub":4253,"regionBase":4096,"regionEnd":4608},"hashes":{"region":"2e61fc6d4a8d3740e739a1e0fca6d4c05725b6053c969c64a593e6a43f6574a5"}},
    criticalSectionInlineStubs: {"result":{"enterStub":4096,"leaveStub":4198,"regionBase":4096,"regionEnd":4352},"hashes":{"region":"ce8f37d53a59e5a4093ca7140ce464bfff7c66dd0e064db215f8f8b5b90dca0e"}},
    timeInlineStub: {"result":{"timeStub":4096,"regionBase":4096,"regionEnd":4160},"hashes":{"region":"eb726f318c4048fce0b95fa6c440c556441cd068f5654aef6c8d06cf259178d9"}},
    sleepInlineStub: {"result":{"sleepStub":4112,"controlAddr":4096,"slowTrapStub":196608,"functionId":1400,"regionBase":4112,"regionEnd":4240},"hashes":{"code":"890260c2e1c3f31773753ec01ca5b0971dc7055521c6029de56c5bd2eff79dba","control":"d962bee0c0be5c7ed5688aeced915bf6add12b016976c5f818a2efcad071e96a"}},
    crtSlabStubs: {"result":{"mallocStub":4096,"freeStub":4235,"regionBase":4096,"regionEnd":4608},"hashes":{"region":"de7b6017ea9cffbcc44163c6080690d0a9d212f9cc38f796c5936b412579fbaa"}},
    getcStub: {"result":{"getcStub":4096,"regionBase":4096,"regionEnd":4160},"hashes":{"region":"7164114dee4b9bf1cf713e04d53500a1cf0aa472b1aa6cdc1b8a3dfad854f2c0"}},
    caseFoldStubs: {"result":{"tolowerStub":4096,"toupperStub":4114,"isspaceStub":4132,"regionBase":4096,"regionEnd":4176},"hashes":{"region":"fdd80069f5ff319252bfe6fb61a65a8b75814b1798ac7d687437e988208f9dcf"}},
    shadowTrampolineSampler: {"result":{"trampAddr":5136,"shadowBase":4100,"slotCount":256,"sentinel":2147483648,"skipCounterAddr":4096,"countsSkips":false,"dataRegionBase":4096,"dataRegionEnd":5124,"codeRegionBase":5136,"codeRegionEnd":5392},"hashes":{"code":"7abd74e2bdce1e4254437e50bc14f0fa791f70d8ae2d8debc1b85af266681278","data":"496f0eda84c76c10945e95128f4f8b16a640633720f19ab135d044da70da04fc"}},
    shadowTrampolineRenderStateNoOwner: {"result":{"trampAddr":5136,"shadowBase":4100,"slotCount":256,"sentinel":2147483648,"skipCounterAddr":4096,"countsSkips":false,"dataRegionBase":4096,"dataRegionEnd":5124,"codeRegionBase":5136,"codeRegionEnd":5392},"hashes":{"code":"3c61427b912fc18da4260c8d4507eca4eef7157cb3f3ffd9f83b0d8aa63c2b1a","data":"496f0eda84c76c10945e95128f4f8b16a640633720f19ab135d044da70da04fc"}},
    shadowTrampolineTextureStage: {"result":{"trampAddr":6160,"shadowBase":4100,"slotCount":512,"sentinel":2147483648,"skipCounterAddr":4096,"countsSkips":false,"dataRegionBase":4096,"dataRegionEnd":6148,"codeRegionBase":6160,"codeRegionEnd":6416},"hashes":{"code":"9377c3c3aa7c19570ec7b3410eb7acb79d6cbe457d52801ff144d19b198ba85a","data":"37eacff5ffe6bcf80368235a5b0dc7d0bdb59b35a47dd72c5052578d57fae54b"}},
    shadowTrampolineFvf: {"result":{"trampAddr":4112,"shadowBase":4100,"slotCount":1,"sentinel":2147483648,"skipCounterAddr":4096,"countsSkips":false,"dataRegionBase":4096,"dataRegionEnd":4104,"codeRegionBase":4112,"codeRegionEnd":4368},"hashes":{"code":"d6b053e237e400891e8ddb3191b98eb7f28bbfcc0e5ea00c907d33855d776201","data":"e6ad6c9a3a3b7658c35bacf6553fcb8ffe34387534a648fe18f875b8f7a86ddb"}},
    ownerDisarmScalarTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4224},"hashes":{"code":"3872c71deed97fde2196b52379f1d1aa7abdf8847b81c6ffa488340c96ccc8c6"}},
    structCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4320},"hashes":{"code":"5ce49653ab8f3fa8c1218565df2c2234c05169a2d00d54a57c64d1602f2fbbed"}},
    upDrawCaptureTrampoline: {"result":{"trampAddr":4096,"codeRegionBase":4096,"codeRegionEnd":4480},"hashes":{"code":"b4d6979e6cae69666eaacb40eb06265e73b17a766266b692442734350baf3642"}},
    surfaceLockInlineTrampolines: {"result":{"lockAddr":37088,"unlockAddr":37369,"tableBase":4096,"codeRegionBase":37088,"codeRegionEnd":37522},"hashes":{"code":"33c2b685c1bff0d42f7fb7713b5cc578c3acb86d33f4d934c2ec3e99eb8eb301","table":"c35020473aed1b4642cd726cad727b63fff2824ad68cedd7ffb73c7cbd890479"}},
};

describe('thunk stub emitters — byte-identity snapshots', () => {
    for (const [name, run] of Object.entries(cases)) {
        it(name, () => {
            const actual = run(mkCtx());
            if (PRINT) {
                console.log(`    ${name}: ${JSON.stringify(actual)},`);
                return;
            }
            expect(actual).toEqual(EXPECTED[name]);
        });
    }
});

describe('inline time conversion', () => {
    it('matches floor(TSC * 1000 / 2^32) across both 32-bit words', () => {
        const values = [
            0n,
            1n,
            0xffff_ffffn,
            0x1_0000_0000n,
            0x1234_5678_9abc_def0n,
            0xffff_ffff_ffff_ffffn,
        ];
        for (const tsc of values) {
            const low = Number(tsc & 0xffff_ffffn) >>> 0;
            const high = Number(tsc >> 32n) >>> 0;
            const lowProductHigh = Math.floor((low * 1000) / 0x1_0000_0000);
            const emittedFormula = (Math.imul(high, 1000) + lowProductHigh) >>> 0;
            const exact = Number((tsc * 1000n >> 32n) & 0xffff_ffffn) >>> 0;
            expect(emittedFormula).toBe(exact);
        }
    });
});
