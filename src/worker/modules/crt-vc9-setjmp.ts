/**
 * VC9 setjmp/longjmp — guest jmp_buf layout (MSVC i386).
 *
 * jmp_buf is 16 × int: EBP, EBX, ESI, EDI, ESP, EIP, … (simplified layout for bring-up).
 */

import { Mem } from "../core/memory/mem-accessor";
import { dispatchLongjmpUnwind } from "../core/seh-dispatch";
import type { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { getCPU } from "../core/thunking/thunk-utils";
import type { Process } from "../core/process";

const JBLEN = 16;
const OFF_EBP = 0;
const OFF_EBX = 1;
const OFF_ESI = 2;
const OFF_EDI = 3;
const OFF_ESP = 4;
const OFF_EIP = 5;
// Real _JUMP_BUFFER's Registration field (the SEH frame live at setjmp() time) — same
// byte offset (24) in both the real MS layout and our simplified one, since only the
// first 6 slots (Ebp/Ebx/Edi/Esi/Esp/Eip, reordered here) are otherwise reused.
const OFF_REGISTRATION = 6;

export interface Vc9SetjmpHost {
    process: Process;
}

export function registerVc9SetjmpExports(exports: Record<string, ThunkImplementation>, host: Vc9SetjmpHost): void {
    exports["_setjmp3"] = (_ctx, _mem, args) => {
        const buf = args[0] ?? 0;
        // args[1] = security cookie — ignored on 32-bit bring-up
        if (!buf) return -1;
        const cpu = getCPU(host.process.v86);
        if (!cpu?.reg32) return -1;
        const reg = cpu.reg32;
        const esp = reg[4] >>> 0;
        const retAddr = Mem.readUint32(esp) ?? 0;
        Mem.writeUint32(buf + OFF_EBP * 4, reg[5] >>> 0);
        Mem.writeUint32(buf + OFF_EBX * 4, reg[3] >>> 0);
        Mem.writeUint32(buf + OFF_ESI * 4, reg[6] >>> 0);
        Mem.writeUint32(buf + OFF_EDI * 4, reg[7] >>> 0);
        Mem.writeUint32(buf + OFF_ESP * 4, esp >>> 0);
        Mem.writeUint32(buf + OFF_EIP * 4, retAddr);
        // Registration: the SEH frame live right now, so a later __CxxLongjmpUnwind
        // (compiler-injected at the longjmp() call site) knows how far to unwind.
        const tebAddr = cpu.segment_offsets?.[4] ?? 0;
        const sehHead = tebAddr ? (Mem.readUint32(tebAddr) ?? 0xFFFFFFFF) : 0xFFFFFFFF;
        Mem.writeUint32(buf + OFF_REGISTRATION * 4, sehHead >>> 0);
        return 0;
    };

    exports["longjmp"] = (_ctx, _mem, args): ThunkResult | number => {
        const buf = args[0] ?? 0;
        const val = args[1] ?? 1;
        if (!buf) return 0;
        const cpu = getCPU(host.process.v86);
        if (!cpu?.reg32) return 0;
        const reg = cpu.reg32;
        const ebp = Mem.readUint32(buf + OFF_EBP * 4) ?? 0;
        const ebx = Mem.readUint32(buf + OFF_EBX * 4) ?? 0;
        const esi = Mem.readUint32(buf + OFF_ESI * 4) ?? 0;
        const edi = Mem.readUint32(buf + OFF_EDI * 4) ?? 0;
        const esp = Mem.readUint32(buf + OFF_ESP * 4) ?? 0;
        const eip = Mem.readUint32(buf + OFF_EIP * 4) ?? 0;
        reg[5] = ebp | 0;
        reg[3] = ebx | 0;
        reg[6] = esi | 0;
        reg[7] = edi | 0;
        reg[4] = esp | 0;
        cpu.instruction_pointer[0] = eip;
        return { value: val >>> 0, skipStackCheck: true };
    };

    // void __cdecl __CxxLongjmpUnwind(const _JUMP_BUFFER *state) — compiler-injected call
    // right before a longjmp() call site, running destructors for C++ objects going out of
    // scope between here and state->Registration (the SEH frame live at setjmp() time).
    exports["__CxxLongjmpUnwind"] = (ctx, mem, args): ThunkResult | number => {
        const buf = args[0] ?? 0;
        if (!buf) return 0;
        const cpu = getCPU(host.process.v86);
        if (!cpu?.reg32) return 0;
        const tebAddr = cpu.segment_offsets?.[4] ?? 0;
        if (!tebAddr) return 0;
        const targetFrame = Mem.readUint32(buf + OFF_REGISTRATION * 4) ?? 0;
        if (!targetFrame || targetFrame === 0xFFFFFFFF) return 0;
        const result = dispatchLongjmpUnwind(mem, cpu, ctx.esp, tebAddr, targetFrame, 0);
        return result ?? 0;
    };
}
