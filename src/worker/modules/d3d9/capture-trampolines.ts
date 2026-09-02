// Guest-side WBUF-ring trampoline emitters for high-volume D3D9 setter/draw paths:
// value-shadow skip, owner-disarm scalar, struct-capture and DrawPrimitiveUP capture.
// Codegen primitives are module-agnostic; registrations are the D3D9 device wave.
// Byte layout pinned by tools/tests/thunk-stub-emitters.test.ts.
// Caller: thunk-dispatcher's register*WriteBufferFunction family, passing
// ThunkMemoryManager.stubAllocator.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';

const SURFACE_LOCK_INLINE_SLOTS = 1024;
const SURFACE_LOCK_INLINE_STRIDE = 32;
const SURFACE_LOCK_INLINE_PROBES = 8;
let surfaceLockInlineTableBase = 0;
let surfaceLockInlineMemory: (() => Uint8Array) | null = null;
const surfaceLockInlineByTexture = new Map<number, { surface: number; slot: number }>();

export function installSurfaceLockInlineTable(tableBase: number, getMemory: () => Uint8Array): void {
    surfaceLockInlineTableBase = tableBase >>> 0;
    surfaceLockInlineMemory = getMemory;
    surfaceLockInlineByTexture.clear();
}

export function registerSurfaceLockInlineMapping(
    surface: number,
    texture: number,
    guestPtr: number,
    pitch: number,
    bytesPerPixel: number,
    width: number,
    height: number,
): boolean {
    if (!surfaceLockInlineTableBase || !surfaceLockInlineMemory || guestPtr <= 0 || bytesPerPixel < 1 || bytesPerPixel > 4) return false;
    const mem = surfaceLockInlineMemory();
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const baseSlot = ((surface >>> 3) & (SURFACE_LOCK_INLINE_SLOTS - 1)) >>> 0;
    let slot = -1;
    let addr = 0;
    for (let probe = 0; probe < SURFACE_LOCK_INLINE_PROBES; probe++) {
        const candidateSlot = baseSlot + probe;
        const candidateAddr = surfaceLockInlineTableBase + candidateSlot * SURFACE_LOCK_INLINE_STRIDE;
        if (candidateAddr > mem.length - SURFACE_LOCK_INLINE_STRIDE) return false;
        const owner = view.getUint32(candidateAddr, true);
        if (owner === 0 || owner === (surface >>> 0)) {
            slot = candidateSlot;
            addr = candidateAddr;
            break;
        }
    }
    if (slot < 0) return false;
    const prior = surfaceLockInlineByTexture.get(texture >>> 0);
    if (prior && prior.surface !== (surface >>> 0)) {
        const priorAddr = surfaceLockInlineTableBase + prior.slot * SURFACE_LOCK_INLINE_STRIDE;
        view.setUint32(priorAddr, 0, true);
    }
    view.setUint32(addr + 0, surface >>> 0, true);
    view.setUint32(addr + 4, texture >>> 0, true);
    view.setUint32(addr + 8, guestPtr >>> 0, true);
    view.setUint32(addr + 12, pitch >>> 0, true);
    view.setUint32(addr + 16, bytesPerPixel >>> 0, true);
    view.setUint32(addr + 20, width >>> 0, true);
    view.setUint32(addr + 24, height >>> 0, true);
    view.setUint32(addr + 28, 0, true);
    surfaceLockInlineByTexture.set(texture >>> 0, { surface: surface >>> 0, slot });
    return true;
}

export function unregisterSurfaceLockInlineTexture(texture: number): void {
    const row = surfaceLockInlineByTexture.get(texture >>> 0);
    if (!row || !surfaceLockInlineMemory || !surfaceLockInlineTableBase) return;
    const mem = surfaceLockInlineMemory();
    const addr = surfaceLockInlineTableBase + row.slot * SURFACE_LOCK_INLINE_STRIDE;
    if (addr <= mem.length - SURFACE_LOCK_INLINE_STRIDE) {
        new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setUint32(addr, 0, true);
    }
    surfaceLockInlineByTexture.delete(texture >>> 0);
}

/** Copy a guest-authoritative burst back once, immediately before host/GPU use. */
let syncView: DataView | null = null;

export function syncSurfaceLockInlineTexture(texture: number, host: Uint8Array, memory: Uint8Array): boolean {
    const row = surfaceLockInlineByTexture.get(texture >>> 0);
    if (!row || !surfaceLockInlineTableBase) return false;
    const addr = surfaceLockInlineTableBase + row.slot * SURFACE_LOCK_INLINE_STRIDE;
    if (addr > memory.length - SURFACE_LOCK_INLINE_STRIDE) return false;
    // Per frame per locked texture: the view is kept as long as the guest
    // memory buffer is the same one (v86 replaces it when the memory grows).
    const buffer = memory.buffer;
    if (syncView === null || syncView.buffer !== buffer) {
        syncView = new DataView(buffer, memory.byteOffset, memory.byteLength);
    }
    const view = syncView;
    if (view.getUint32(addr, true) !== row.surface || view.getUint32(addr + 28, true) !== 2) return false;
    const guestPtr = view.getUint32(addr + 8, true);
    if (guestPtr > memory.length - host.length) return false;
    host.set(memory.subarray(guestPtr, guestPtr + host.length));
    view.setUint32(addr + 28, 0, true);
    return true;
}

export function writeSurfaceLockInlineTrampolines(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    lockFuncId: number,
    unlockFuncId: number,
): { lockAddr: number; unlockAddr: number; tableBase: number; codeRegionBase: number; codeRegionEnd: number } {
    const tableBytes = (SURFACE_LOCK_INLINE_SLOTS + SURFACE_LOCK_INLINE_PROBES - 1) * SURFACE_LOCK_INLINE_STRIDE;
    const tableBase = allocator.alloc(tableBytes, 'THUNK_DATA', 'rw');
    getMemory().fill(0, tableBase, tableBase + tableBytes);
    const codeRegionBase = allocator.alloc(768, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xff; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const relPatches: Array<{ at: number; target: () => number }> = [];
    const jcc = (opcode: number, target: () => number) => { w8(0x0f); w8(opcode); const at = off; w32(0); relPatches.push({ at, target }); };
    const fallback = (funcId: number, pop: number) => {
        w8(0xb8); w32(funcId); w8(0xba); w32(0xb077); w8(0xef);
        w8(0xc2); w8(pop & 0xff); w8((pop >>> 8) & 0xff);
    };

    const lockAddr = off;
    let lockFallback = 0;
    let lockFound = 0;
    w8(0x53);                                                   // push ebx
    w8(0x83); w8(0x7c); w8(0x24); w8(0x14); w8(0x00);         // cmp [esp+20],0 flags
    jcc(0x85, () => lockFallback);                              // jne fallback
    w8(0x8b); w8(0x4c); w8(0x24); w8(0x0c);                   // mov ecx,[esp+12] lockedRect
    w8(0x85); w8(0xc9); jcc(0x84, () => lockFallback);         // test/jz
    w8(0x8b); w8(0x4c); w8(0x24); w8(0x10);                   // mov ecx,[esp+16] rect
    w8(0x85); w8(0xc9); jcc(0x84, () => lockFallback);
    w8(0x8b); w8(0x54); w8(0x24); w8(0x08);                   // mov edx,[esp+8] surface
    w8(0x8b); w8(0xda);                                       // mov ebx,edx
    w8(0xc1); w8(0xeb); w8(0x03);                             // shr ebx,3
    w8(0x81); w8(0xe3); w32(SURFACE_LOCK_INLINE_SLOTS - 1);   // and ebx,mask
    w8(0xc1); w8(0xe3); w8(0x05);                             // shl ebx,5
    w8(0x81); w8(0xc3); w32(tableBase);                       // add ebx,table
    for (let probe = 0; probe < SURFACE_LOCK_INLINE_PROBES; probe++) {
        w8(0x39); w8(0x13); jcc(0x84, () => lockFound);       // cmp [ebx],edx / je found
        if (probe + 1 < SURFACE_LOCK_INLINE_PROBES) {
            w8(0x83); w8(0xc3); w8(SURFACE_LOCK_INLINE_STRIDE); // add ebx,32
        }
    }
    w8(0xe9); const lockMissPatch = off; w32(0);
    lockFound = off;
    w8(0x83); w8(0x7b); w8(0x1c); w8(0x01); jcc(0x84, () => lockFallback); // active?
    // Validate left/top/right/bottom against stored width/height.
    w8(0x8b); w8(0x01); w8(0x85); w8(0xc0); jcc(0x88, () => lockFallback); // left < 0
    w8(0x3b); w8(0x41); w8(0x08); jcc(0x8d, () => lockFallback);            // left >= right
    w8(0x8b); w8(0x51); w8(0x08); w8(0x3b); w8(0x53); w8(0x14); jcc(0x87, () => lockFallback); // right > width
    w8(0x8b); w8(0x51); w8(0x04); w8(0x85); w8(0xd2); jcc(0x88, () => lockFallback); // top < 0
    w8(0x3b); w8(0x51); w8(0x0c); jcc(0x8d, () => lockFallback);            // top >= bottom
    w8(0x8b); w8(0x41); w8(0x0c); w8(0x3b); w8(0x43); w8(0x18); jcc(0x87, () => lockFallback); // bottom > height
    // eax = top*pitch + left*bpp + guestBase
    w8(0x8b); w8(0x41); w8(0x04); w8(0x0f); w8(0xaf); w8(0x43); w8(0x0c);
    w8(0x8b); w8(0x09); w8(0x0f); w8(0xaf); w8(0x4b); w8(0x10);
    w8(0x03); w8(0xc1); w8(0x03); w8(0x43); w8(0x08);
    w8(0x8b); w8(0x54); w8(0x24); w8(0x0c);                   // lockedRect
    w8(0x8b); w8(0x4b); w8(0x0c); w8(0x89); w8(0x0a);        // pitch
    w8(0x89); w8(0x42); w8(0x04);                             // bits
    w8(0xc7); w8(0x43); w8(0x1c); w32(1);                    // state=active
    w8(0x5b); w8(0x31); w8(0xc0); w8(0xc2); w8(0x10); w8(0x00);
    lockFallback = off;
    w8(0x5b); fallback(lockFuncId, 16);
    dv.setInt32(lockMissPatch, lockFallback - (lockMissPatch + 4), true);

    const unlockAddr = off;
    let unlockFallback = 0;
    let unlockFound = 0;
    w8(0x53);
    w8(0x8b); w8(0x54); w8(0x24); w8(0x08);                   // surface
    w8(0x8b); w8(0xda); w8(0xc1); w8(0xeb); w8(0x03);
    w8(0x81); w8(0xe3); w32(SURFACE_LOCK_INLINE_SLOTS - 1);
    w8(0xc1); w8(0xe3); w8(0x05); w8(0x81); w8(0xc3); w32(tableBase);
    for (let probe = 0; probe < SURFACE_LOCK_INLINE_PROBES; probe++) {
        w8(0x39); w8(0x13); jcc(0x84, () => unlockFound);
        if (probe + 1 < SURFACE_LOCK_INLINE_PROBES) {
            w8(0x83); w8(0xc3); w8(SURFACE_LOCK_INLINE_STRIDE);
        }
    }
    w8(0xe9); const unlockMissPatch = off; w32(0);
    unlockFound = off;
    w8(0x83); w8(0x7b); w8(0x1c); w8(0x01); jcc(0x85, () => unlockFallback);
    w8(0xc7); w8(0x43); w8(0x1c); w32(2);                    // state=dirty/unlocked
    w8(0x5b); w8(0x31); w8(0xc0); w8(0xc2); w8(0x04); w8(0x00);
    unlockFallback = off;
    w8(0x5b); fallback(unlockFuncId, 4);
    dv.setInt32(unlockMissPatch, unlockFallback - (unlockMissPatch + 4), true);

    for (const patch of relPatches) dv.setInt32(patch.at, patch.target() - (patch.at + 4), true);
    installSurfaceLockInlineTable(tableBase, getMemory);
    return { lockAddr, unlockAddr, tableBase, codeRegionBase, codeRegionEnd: off };
}

/**
 * Describes a high-volume, idempotent stdcall setter that a module wants to short-circuit in
 * guest code via {@link writeShadowTrampoline}. Module-agnostic: the module
 * supplies the arg layout and the slot-folding rule; core only emits codegen from it.
 */
export interface ShadowTrampolineSpec {
    /** Total stdcall args (e.g. 3 for SetRenderState this/State/Value). */
    argCount: number;
    /** 0-based stdcall-arg index of the value to compare/shadow (e.g. 2 = Value). */
    valueArgIndex: number;
    /** Shadow table size (entries); must cover every reachable folded slot index. */
    slotCount: number;
    /**
     * Key args folded into the shadow slot: `slot = OR( (arg[argIndex] < max ? arg : →ring) << shift )`.
     * Each part is range-guarded to `< max` (out-of-range falls back to the ring-write path).
     * e.g. SetRenderState: [{argIndex:1, shift:0, max:256}];
     *      SetSamplerState: [{argIndex:1, shift:4, max:16}, {argIndex:2, shift:0, max:16}].
     */
    keyParts: Array<{ argIndex: number; shift: number; max: number }>;
    /**
     * Opt-in diagnostic counter for redundant calls. Disabled in production:
     * an atomic-looking guest `inc [memory]` on every skipped setter dirties a
     * page and is disproportionately expensive in the hottest render path.
     */
    countSkipsForDiagnostics?: boolean;
}

/**
 * GENERIC guest-side value-shadow trampoline emitter. Given a {@link ShadowTrampolineSpec},
 * emits an x86 trampoline that compares an incoming "value" argument against a per-owner
 * shadow table in guest RAM and RETs immediately (EAX = 0) on a match — no WBUF ring entry,
 * no JS drain, no downstream work. On a real change it updates the shadow and falls through
 * to the SAME ring-write as the generic WBUF trampoline (writeWriteBufTrampolines).
 *
 * This is a pure codegen primitive — it knows nothing about D3D9 (or any module). Callers
 * (a module registering its own high-volume idempotent setters) supply the arg layout, the
 * Value-arg index, and how to fold the key args into a shadow slot. The classic instance is a
 * COM `this`-keyed render/sampler state setter, but nothing here is graphics-specific.
 *
 * Coherence invariant the caller must uphold (the only way to behave wrong): the shadow must
 * NEVER report equality when the real state differs. The shadow starts at a SENTINEL so the
 * first set of every slot passes through; the caller re-seeds/invalidates it on any external
 * state reset. The single-owner fast path (lastOwnerGlobal) routes any other/unknown owner
 * straight to the ring-write (no shadow), keeping it generic and safe for multi-owner cases.
 *
 * On entry the setter's OUT-trap stub prologue has already run `mov eax, funcId`, so
 * EAX = funcId and the stdcall args are on the stack at [ESP+4..]. The caller points the
 * setter's stub JMP at the returned `trampAddr` (in place of the generic trampoline) when
 * enabled, and restores the generic target to disable (pure A/B). The returned code region
 * should be registered non-preemptible (the shadow cmp/mov RMW must not interleave a quantum
 * switch), mirroring the heap/getc inline stubs.
 *
 * @param lastOwnerGlobal guest-RAM addr of a shared u32 holding the "active owner" pointer
 *        (e.g. the bound COM device `this`); the caller owns/seeds it. Args matched against it
 *        come from stdcall arg 0. Pass 0 to disable the owner gate (always shadow).
 */
export function writeShadowTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
    lastOwnerGlobal: number,
    spec: ShadowTrampolineSpec,
): {
    trampAddr: number; shadowBase: number; slotCount: number; sentinel: number;
    skipCounterAddr: number;
    countsSkips: boolean;
    dataRegionBase: number; dataRegionEnd: number;
    codeRegionBase: number; codeRegionEnd: number;
} {
    const SENTINEL = 0x80000000; // "never set" marker; caller overwrites with seeded defaults
    const { argCount, valueArgIndex, slotCount, keyParts } = spec;

    // --- shadow table in guest RAM (THUNK_DATA, rw): [+0]=u32 skip counter, [+4..]=slots ---
    // The counter remains allocated for ABI/config compatibility with the EAGL
    // token hook, but the normal setter trampoline leaves it untouched unless
    // explicitly built in diagnostic mode.
    const DATA_SIZE = 4 + slotCount * 4;
    const dataRegionBase = allocator.alloc(DATA_SIZE, 'THUNK_DATA', 'rw');
    const skipCounterAddr = dataRegionBase;
    const shadowBase = dataRegionBase + 4;
    {
        const m = getMemory();
        const d = new DataView(m.buffer, m.byteOffset, m.byteLength);
        d.setUint32(skipCounterAddr, 0, true);
        for (let i = 0; i < slotCount; i++) d.setUint32(shadowBase + i * 4, SENTINEL, true);
    }

    // --- code region (THUNK_CODE, rx) ---
    const CODE_SIZE = 256;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    // cmp r/m32 (EDX or ECX) against an unsigned bound — imm8 form when it fits.
    const cmpEdxImm = (m: number) => { if (m <= 0x7F) { w8(0x83); w8(0xFA); w8(m); } else { w8(0x81); w8(0xFA); w32(m); } };
    const cmpEcxImm = (m: number) => { if (m <= 0x7F) { w8(0x83); w8(0xF9); w8(m); } else { w8(0x81); w8(0xF9); w32(m); } };
    const capacityLimit = capacity - 36;
    const stride = (argCount + 1) * 4;
    const retPop = argCount * 4;
    // Use only caller-clobbered EAX/ECX/EDX. In particular, addressing the
    // shadow as [EDX*4+disp32] avoids borrowing EBX and therefore removes a
    // push/pop pair from every setter call. EAX keeps funcId until the ring
    // entry tag is written; ECX is scratch/value/data pointer; EDX is slot/offset.
    const argDisp = (i: number) => 4 + i * 4;
    const valueDisp = argDisp(valueArgIndex);

    const trampStart = off;
    const ringPatch: number[] = []; // rel32 sites → .ringwrite (owner mismatch / out-of-range)

    // Owner gate: mov ecx,[esp+4] (arg0); cmp ecx,[lastOwnerGlobal]; jne .ringwrite
    if (lastOwnerGlobal !== 0) {
        w8(0x8B); w8(0x4C); w8(0x24); w8(argDisp(0));
        w8(0x3B); w8(0x0D); w32(lastOwnerGlobal);
        w8(0x0F); w8(0x85); ringPatch.push(off); w32(0);
    }

    // Compute shadow slot into EDX = OR over keyParts of (arg[part] range-guarded) << shift.
    // No key parts means a scalar setter with one implicit slot (e.g. SetFVF).
    if (keyParts.length === 0) { w8(0x31); w8(0xD2); } // xor edx,edx
    for (let pi = 0; pi < keyParts.length; pi++) {
        const part = keyParts[pi];
        if (pi === 0) {
            // mov edx, [esp+disp]
            w8(0x8B); w8(0x54); w8(0x24); w8(argDisp(part.argIndex));
            cmpEdxImm(part.max);
            // jae .ringwrite
            w8(0x0F); w8(0x83); ringPatch.push(off); w32(0);
            if (part.shift) { w8(0xC1); w8(0xE2); w8(part.shift); } // shl edx, shift
        } else {
            // mov ecx, [esp+disp]
            w8(0x8B); w8(0x4C); w8(0x24); w8(argDisp(part.argIndex));
            cmpEcxImm(part.max);
            // jae .ringwrite
            w8(0x0F); w8(0x83); ringPatch.push(off); w32(0);
            if (part.shift) { w8(0xC1); w8(0xE1); w8(part.shift); } // shl ecx, shift
            w8(0x09); w8(0xCA);                                     // or edx, ecx
        }
    }

    // mov ecx,[esp+valueDisp]; cmp [edx*4+shadowBase],ecx; je .skip;
    // mov [edx*4+shadowBase],ecx. Absolute indexed addressing avoids EBX.
    w8(0x8B); w8(0x4C); w8(0x24); w8(valueDisp);
    w8(0x39); w8(0x0C); w8(0x95); w32(shadowBase);
    w8(0x0F); w8(0x84); const skipPatch = off; w32(0);
    w8(0x89); w8(0x0C); w8(0x95); w32(shadowBase);

    // .ringwrite: (identical to the generic scalar trampoline; EAX still = funcId)
    const ringAddr = off;
    w8(0x8B); w8(0x15); w32(ctrlAddr);                 // mov edx, [ctrlAddr]
    w8(0x81); w8(0xFA); w32(capacityLimit);            // cmp edx, capacityLimit
    w8(0x0F); w8(0x8D); const ovfPatch = off; w32(0);  // jge .overflow
    w8(0xB9); w32(dataBase);                           // mov ecx, dataBase
    w8(0x03); w8(0xCA);                                // add ecx, edx
    w8(0x89); w8(0x01);                                // mov [ecx], eax (funcId)
    for (let i = 0; i < argCount; i++) {
        w8(0x8B); w8(0x44); w8(0x24); w8(argDisp(i));  // mov eax, [esp+4+i*4]
        w8(0x89); w8(0x41); w8((i + 1) * 4);           // mov [ecx+(i+1)*4], eax
    }
    w8(0x83); w8(0x05); w32(ctrlAddr); w8(stride);     // add dword [ctrlAddr], stride

    // .tail: return D3D_OK. No OUT occurs on this path, so loading
    // the hypercall port into volatile EDX is unnecessary.
    const tailAddr = off;
    w8(0x31); w8(0xC0);
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);

    // Production skip jumps straight to the shared tail: no guest-memory RMW,
    // and one fewer tiny basic block. Exact skip counting stays opt-in for a
    // focused diagnostic build.
    let skipAddr = tailAddr;
    if (spec.countSkipsForDiagnostics === true) {
        skipAddr = off;
        w8(0xFF); w8(0x05); w32(skipCounterAddr);  // inc dword [skipCounterAddr]
        w8(0x31); w8(0xC0);
        w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);
    }

    // .overflow: fall back to the ordinary OUT trap.
    const ovfAddr = off;
    w8(0xBA); w32(0xB077);
    w8(0xEF);
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);

    for (const p of ringPatch) dv.setInt32(p, ringAddr - (p + 4), true);
    dv.setInt32(skipPatch, skipAddr - (skipPatch + 4), true);
    dv.setInt32(ovfPatch, ovfAddr - (ovfPatch + 4), true);

    Logger.log(LogCategory.SYSTEM,
        `Shadow trampoline emitted: 0x${trampStart.toString(16)} ` +
        `(argCount=${argCount} valueArg=${valueArgIndex} slots=${slotCount} shadow@0x${shadowBase.toString(16)})`);

    return {
        trampAddr: trampStart, shadowBase, slotCount, sentinel: SENTINEL,
        skipCounterAddr, countsSkips: spec.countSkipsForDiagnostics === true,
        dataRegionBase, dataRegionEnd: dataRegionBase + DATA_SIZE,
        codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE,
    };
}

/**
 * GENERIC scalar WBUF trampoline that additionally DISARMS the setter-shadow owner gate
 * (one `mov dword [ownerGlobal], 0`) before writing its ring entry. For ring-deferred
 * operations that WRITE state the shadow tables mirror (the canonical case: D3D9
 * IDirect3DStateBlock9_Apply): with the owner zeroed, every subsequent shadowed setter
 * takes its owner-mismatch path straight to the ring (correct program order, no
 * stale-shadow skip) until the operation's DRAIN handler re-arms the owner
 * (dispatcher.setShadowOwner) after syncing the shadows. The overflow path falls back
 * to the OUT trap — the operation then runs synchronously at the trap (drain-first),
 * so no disarm is needed there and none is emitted on that path.
 *
 * Same entry contract as writeWriteBufTrampolines (EAX = funcId, stdcall args at
 * [ESP+4..]); scalar args only.
 */
export function writeOwnerDisarmScalarTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
    argCount: number,
    ownerGlobalAddr: number,
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const CODE_SIZE = 128;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const capacityLimit = capacity - 36;
    const bytesToPop = argCount * 4;

    const trampAddr = off;
    // pushfd; push edx; push ebx
    w8(0x9C); w8(0x52); w8(0x53);
    // mov edx, [ctrlAddr]; cmp edx, capacityLimit; jge .overflow
    w8(0x8B); w8(0x15); w32(ctrlAddr);
    w8(0x81); w8(0xFA); w32(capacityLimit);
    w8(0x0F); w8(0x8D); const jgePatchOff = off; w32(0);
    // mov dword [ownerGlobalAddr], 0 — disarm shadow skipping until drain re-arms
    w8(0xC7); w8(0x05); w32(ownerGlobalAddr); w32(0);
    // mov ebx, dataBase; add ebx, edx; mov [ebx], eax (funcId)
    w8(0xBB); w32(dataBase);
    w8(0x03); w8(0xDA);
    w8(0x89); w8(0x03);
    for (let i = 0; i < argCount; i++) {
        // mov eax, [esp + 16 + i*4]; mov [ebx + (i+1)*4], eax
        w8(0x8B); w8(0x44); w8(0x24); w8(16 + i * 4);
        w8(0x89); w8(0x43); w8((i + 1) * 4);
    }
    // add dword [ctrlAddr], stride
    w8(0x83); w8(0x05); w32(ctrlAddr); w8((argCount + 1) * 4);
    // pop ebx; pop edx; mov edx,0xB077; xor eax,eax; popfd; ret N
    w8(0x5B); w8(0x5A);
    w8(0xBA); w32(0xB077);
    w8(0x31); w8(0xC0);
    w8(0x9D);
    w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF);
    // .overflow: pop ebx; pop edx; popfd; mov edx,0xB077; out dx,eax; ret N
    const overflowAddr = off;
    w8(0x5B); w8(0x5A);
    w8(0x9D);
    w8(0xBA); w32(0xB077);
    w8(0xEF);
    w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF);
    dv.setInt32(jgePatchOff, overflowAddr - (jgePatchOff + 4), true);

    Logger.log(LogCategory.SYSTEM,
        `Owner-disarm WBUF trampoline emitted: 0x${trampAddr.toString(16)} ` +
        `(argCount=${argCount} owner@0x${ownerGlobalAddr.toString(16)})`);
    return { trampAddr, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}

/**
 * GENERIC capture-at-call WBUF trampoline for a stdcall function with one pointer-to-struct
 * argument of a FIXED byte size (SetTransform/SetMaterial/SetLight/SetViewport/SetClipPlane
 * class). Ring entry layout: [funcId][all scalar args verbatim, incl. the raw ptr slot]
 * [payloadDwords copied inline from *ptr] — so the drain-side stride is the standard
 * (argCountTable+1)*4 with argCountTable = argCount + payloadDwords, and the drain handler
 * reads the payload from the RING (guest RAM) instead of dereferencing the (possibly reused)
 * guest pointer. Null/out-of-RAM pointers and ring-full fall back to the OUT trap (the
 * FastPath handler stays registered and validates as before).
 *
 * The returned code region must be scheduler-registered non-preemptible by the caller (the
 * head read→bump RMW plus rep movsd must not interleave a quantum switch — same rule as the
 * shadow/heap stubs; the fixed trampoline block is covered by the parked-thread head-reset
 * deferral instead, which does not know about dynamically allocated regions).
 */
export function writeStructCaptureTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
    spec: { argCount: number; ptrArgIndex: number; payloadDwords: number },
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const { argCount, ptrArgIndex, payloadDwords } = spec;
    if (argCount < 1 || argCount > 8 || ptrArgIndex < 0 || ptrArgIndex >= argCount || payloadDwords < 1 || payloadDwords > 64) {
        throw new Error(`writeStructCaptureTrampoline: bad spec ${JSON.stringify(spec)}`);
    }
    const CODE_SIZE = 224;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

    const strideBytes = (1 + argCount + payloadDwords) * 4;
    const payloadBytes = payloadDwords * 4;
    const retPop = argCount * 4;
    // 6 pushes (flags,edx,ebx,ecx,esi,edi) + retAddr → stdcall arg i at [esp+28+4i].
    const argDisp = (i: number) => 28 + i * 4;
    const ramLimit = mem.length >>> 0;
    const ovfPatch: number[] = [];

    const trampStart = off;
    w8(0x9C); w8(0x52); w8(0x53); w8(0x51); w8(0x56); w8(0x57); // pushfd; push edx,ebx,ecx,esi,edi
    w8(0x89); w8(0xC7);                                          // mov edi, eax (funcId)
    w8(0x8B); w8(0x74); w8(0x24); w8(argDisp(ptrArgIndex));      // mov esi, [esp+ptrDisp]
    w8(0x85); w8(0xF6);                                          // test esi, esi
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);              // jz .ovf
    w8(0x81); w8(0xFE); w32(ramLimit - payloadBytes);            // cmp esi, ramLimit-payload
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);              // ja .ovf
    w8(0x8B); w8(0x15); w32(ctrlAddr);                           // mov edx, [ctrlAddr]
    w8(0x81); w8(0xFA); w32(capacity - strideBytes);             // cmp edx, capacity-stride
    w8(0x0F); w8(0x8D); ovfPatch.push(off); w32(0);              // jge .ovf
    w8(0xBB); w32(dataBase);                                     // mov ebx, dataBase
    w8(0x03); w8(0xDA);                                          // add ebx, edx
    w8(0x89); w8(0x3B);                                          // mov [ebx], edi (funcId)
    for (let i = 0; i < argCount; i++) {
        w8(0x8B); w8(0x44); w8(0x24); w8(argDisp(i));            // mov eax, [esp+disp]
        w8(0x89); w8(0x43); w8((i + 1) * 4);                     // mov [ebx+(i+1)*4], eax
    }
    w8(0x8D); w8(0x7B); w8((1 + argCount) * 4);                  // lea edi, [ebx+(1+argCount)*4]
    w8(0xB9); w32(payloadDwords);                                // mov ecx, payloadDwords
    w8(0xF3); w8(0xA5);                                          // rep movsd
    w8(0x81); w8(0x05); w32(ctrlAddr); w32(strideBytes);         // add dword [ctrlAddr], stride
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);            // pop edi,esi,ecx,ebx,edx
    w8(0xBA); w32(0xB077);                                       // mov edx, 0xB077
    w8(0x31); w8(0xC0);                                          // xor eax, eax
    w8(0x9D);                                                    // popfd
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);       // ret retPop

    const ovfAddr = off;                                         // .ovf: OUT-trap fallback
    w8(0x89); w8(0xF8);                                          // mov eax, edi (funcId)
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);
    w8(0x9D);                                                    // popfd
    w8(0xBA); w32(0xB077);
    w8(0xEF);                                                    // out dx, eax
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);
    for (const p of ovfPatch) dv.setInt32(p, ovfAddr - (p + 4), true);

    if (off > codeRegionBase + CODE_SIZE) throw new Error('writeStructCaptureTrampoline: code overflow');
    Logger.log(LogCategory.SYSTEM,
        `StructCapture trampoline: 0x${trampStart.toString(16)} (args=${argCount} ptrIdx=${ptrArgIndex} payload=${payloadDwords}dw stride=${strideBytes})`);
    return { trampAddr: trampStart, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}

/**
 * Capture-at-call WBUF trampoline for IDirect3DDevice9_DrawPrimitiveUP
 * (this, PrimitiveType, PrimitiveCount, pVertexStreamZeroData, VertexStreamZeroStride).
 * Computes vertexCount from (PrimitiveType, PrimitiveCount) in x86, copies
 * vertexCount×stride bytes inline into the ring. Ring entry (variable stride):
 * [funcId][this][primType][primCount][stride][byteCount][payload…] — drain stride is
 * 24 + byteCount (see WBUF_ARG_UP_DRAW in the dispatcher). Falls back to the OUT trap on:
 * unknown primType, primCount=0, stride 0/unaligned/>512, byteCount>64KiB, null/OOB
 * pointer, or ring-full. Register the code region non-preemptible (same rule as above).
 */
export function writeUpDrawCaptureTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const CODE_SIZE = 384;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const ramLimit = mem.length >>> 0;
    const ovfPatch: number[] = [];
    const havePatch: number[] = []; // rel8 sites → .have
    // 6 pushes + retAddr: this@28, primType@32, primCount@36, pData@40, stride@44.

    const trampStart = off;
    w8(0x9C); w8(0x52); w8(0x53); w8(0x51); w8(0x56); w8(0x57);
    w8(0x89); w8(0xC7);                                     // mov edi, eax (funcId)
    w8(0x8B); w8(0x44); w8(0x24); w8(32);                   // mov eax, [esp+32] primType
    w8(0x8B); w8(0x4C); w8(0x24); w8(36);                   // mov ecx, [esp+36] primCount
    w8(0x85); w8(0xC9);                                     // test ecx, ecx
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);         // jz .ovf
    // vertexCount by primType: 4→*3, 5/6→+2, 3→+1, 2→*2, else .ovf
    w8(0x83); w8(0xF8); w8(4); w8(0x75); w8(0x05);          // cmp eax,4; jne +5
    w8(0x8D); w8(0x0C); w8(0x49);                           //   lea ecx,[ecx+ecx*2]
    w8(0xEB); havePatch.push(off); w8(0);                   //   jmp .have
    w8(0x83); w8(0xF8); w8(5);                              // cmp eax,5
    const je5 = off + 1; w8(0x74); w8(0);                   // je .plus2
    w8(0x83); w8(0xF8); w8(6);                              // cmp eax,6
    const je6 = off + 1; w8(0x74); w8(0);                   // je .plus2
    w8(0x83); w8(0xF8); w8(3); w8(0x75); w8(0x03);          // cmp eax,3; jne +3
    w8(0x41);                                               //   inc ecx
    w8(0xEB); havePatch.push(off); w8(0);                   //   jmp .have
    w8(0x83); w8(0xF8); w8(2);                              // cmp eax,2
    w8(0x0F); w8(0x85); ovfPatch.push(off); w32(0);         // jne .ovf
    w8(0xD1); w8(0xE1);                                     // shl ecx,1
    w8(0xEB); havePatch.push(off); w8(0);                   // jmp .have
    const plus2Addr = off;                                  // .plus2:
    mem[je5] = plus2Addr - (je5 + 1);
    mem[je6] = plus2Addr - (je6 + 1);
    w8(0x83); w8(0xC1); w8(2);                              // add ecx,2
    const haveAddr = off;                                   // .have:
    for (const p of havePatch) mem[p] = haveAddr - (p + 1);
    w8(0x8B); w8(0x44); w8(0x24); w8(44);                   // mov eax, [esp+44] stride
    w8(0x85); w8(0xC0);                                     // test eax, eax
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);         // jz .ovf
    w8(0xA8); w8(0x03);                                     // test al, 3 (dword-multiple only)
    w8(0x0F); w8(0x85); ovfPatch.push(off); w32(0);         // jnz .ovf
    w8(0x3D); w32(512);                                     // cmp eax, 512
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0x0F); w8(0xAF); w8(0xC8);                           // imul ecx, eax → byteCount
    w8(0x81); w8(0xF9); w32(65536);                         // cmp ecx, 64KiB
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0x8B); w8(0x74); w8(0x24); w8(40);                   // mov esi, [esp+40] pData
    w8(0x85); w8(0xF6);                                     // test esi, esi
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);         // jz .ovf
    w8(0x81); w8(0xFE); w32(ramLimit);                      // cmp esi, ramLimit (kills lea wrap)
    w8(0x0F); w8(0x83); ovfPatch.push(off); w32(0);         // jae .ovf
    w8(0x8D); w8(0x04); w8(0x0E);                           // lea eax, [esi+ecx] (end)
    w8(0x3D); w32(ramLimit);                                // cmp eax, ramLimit
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0x8B); w8(0x15); w32(ctrlAddr);                      // mov edx, [ctrlAddr]
    w8(0x8D); w8(0x44); w8(0x0A); w8(24);                   // lea eax, [edx+ecx+24]
    w8(0x3D); w32(capacity);                                // cmp eax, capacity
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0xBB); w32(dataBase);                                // mov ebx, dataBase
    w8(0x03); w8(0xDA);                                     // add ebx, edx
    w8(0x89); w8(0x3B);                                     // mov [ebx], edi (funcId)
    w8(0x8B); w8(0x44); w8(0x24); w8(28); w8(0x89); w8(0x43); w8(4);   // this
    w8(0x8B); w8(0x44); w8(0x24); w8(32); w8(0x89); w8(0x43); w8(8);   // primType
    w8(0x8B); w8(0x44); w8(0x24); w8(36); w8(0x89); w8(0x43); w8(12);  // primCount
    w8(0x8B); w8(0x44); w8(0x24); w8(44); w8(0x89); w8(0x43); w8(16);  // stride
    w8(0x89); w8(0x4B); w8(20);                             // mov [ebx+20], ecx (byteCount)
    w8(0x8D); w8(0x7B); w8(24);                             // lea edi, [ebx+24]
    w8(0xC1); w8(0xE9); w8(2);                              // shr ecx, 2
    w8(0xF3); w8(0xA5);                                     // rep movsd
    w8(0x8B); w8(0x43); w8(20);                             // mov eax, [ebx+20]
    w8(0x83); w8(0xC0); w8(24);                             // add eax, 24
    w8(0x01); w8(0x05); w32(ctrlAddr);                      // add [ctrlAddr], eax
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);       // pops
    w8(0xBA); w32(0xB077);
    w8(0x31); w8(0xC0);                                     // xor eax, eax
    w8(0x9D);                                               // popfd
    w8(0xC2); w8(20); w8(0);                                // ret 20

    const ovfAddr = off;                                    // .ovf: OUT-trap fallback
    w8(0x89); w8(0xF8);                                     // mov eax, edi
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);
    w8(0x9D);
    w8(0xBA); w32(0xB077);
    w8(0xEF);
    w8(0xC2); w8(20); w8(0);
    for (const p of ovfPatch) dv.setInt32(p, ovfAddr - (p + 4), true);

    if (off > codeRegionBase + CODE_SIZE) throw new Error('writeUpDrawCaptureTrampoline: code overflow');
    Logger.log(LogCategory.SYSTEM, `UpDrawCapture trampoline: 0x${trampStart.toString(16)}`);
    return { trampAddr: trampStart, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}
