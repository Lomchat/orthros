/**
 * Native x86 _EH_prolog — MSVC SEH frame setup (Wine except_i386.c).
 * Called with the scope-table pointer in EAX; must run as guest code, not a JS thunk.
 */
import { Process } from "../core/process";
import { Logger, LogCategory } from "../core/logger";

/** Wine msvcrt _EH_prolog — sets up FS:[0] exception registration frame. */
export function ensureNativeEHProlog(process: Process): number {
    const CODE_SIZE = 32;
    const addr = process.memory.alloc(CODE_SIZE, "THUNK_CODE", "rx");
    if (!addr) return 0;

    const mem = process.getCurrentMemory();
    if (!mem) return 0;

    let off = addr;
    const w = (b: number) => { mem[off++] = b; };
    const w4 = (b0: number, b1: number, b2: number, b3: number) => {
        mem[off++] = b0; mem[off++] = b1; mem[off++] = b2; mem[off++] = b3;
    };

    w(0x6a); w(0xff);                         // push -1
    w(0x50);                                   // push eax
    w(0x64); w(0xff); w(0x35); w4(0x00, 0x00, 0x00, 0x00); // push dword ptr fs:[0]
    w(0x64); w(0x89); w(0x25); w4(0x00, 0x00, 0x00, 0x00); // mov dword ptr fs:[0], esp
    w(0x8b); w(0x44); w(0x24); w(0x0c);       // mov eax, [esp+0xc]
    w(0x89); w(0x6c); w(0x24); w(0x0c);       // mov [esp+0xc], ebp
    w(0x8d); w(0x6c); w(0x24); w(0x0c);       // lea ebp, [esp+0xc]
    w(0x50);                                   // push eax (scope table)
    w(0xc3);                                   // ret

    Logger.log(LogCategory.SYSTEM, `MSVCRT _EH_prolog native stub at 0x${addr.toString(16)}`);
    return addr;
}
