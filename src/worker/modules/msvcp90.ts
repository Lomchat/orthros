/**
 * MSVCP90 — MSVC 2008 C++ standard library (minimal HLE for SS2).
 * Implements std::basic_string<char> and std::allocator<char> exports.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Msvcrt } from "./msvcrt";
import {
    CppStringHeap,
    stringAppendCStr,
    stringAssignCStr,
    stringBegin,
    stringCompareLess,
    stringCopyConstruct,
    stringDestroy,
    stringEnd,
    stringInitEmpty,
    stringInitFromCStr,
    writeStringIterator,
} from "./crt-cppstring";

export class Msvcp90 implements IModule {
    name = "msvcp90";
    exports: Record<string, ThunkImplementation> = {};

    private heap!: CppStringHeap;
    private msvcrt!: Msvcrt;

    setMsvcrt(msvcrt: Msvcrt): void {
        this.msvcrt = msvcrt;
    }

    initialize(_process: Process): void {
        const msvcrt = this.msvcrt;
        this.heap = {
            alloc: (n) => {
                const fn = msvcrt.exports["malloc"];
                return (fn?.(null as any, null as any, [n >>> 0]) ?? 0) as number;
            },
            free: (p) => {
                const fn = msvcrt.exports["free"];
                fn?.(null as any, null as any, [p >>> 0]);
            },
        };

        this.exports["??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@XZ"] = (ctx, _mem, _args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringInitEmpty(thisPtr);
            return thisPtr;
        };

        this.exports["??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@PBD@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringInitFromCStr(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringCopyConstruct(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["??1?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@XZ"] = (ctx, _mem, _args) => {
            stringDestroy(ctx.ecx >>> 0, this.heap);
            return 0;
        };

        this.exports["??4?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAEAAV01@PBD@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringAssignCStr(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["??Y?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAEAAV01@PBD@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringAppendCStr(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["?begin@?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE?AV?$_String_iterator@DU?$char_traits@D@std@@V?$allocator@D@2@@2@XZ"] = (ctx, _mem, args) => {
            return writeStringIterator(args[0] ?? 0, stringBegin(ctx.ecx >>> 0));
        };

        this.exports["?end@?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE?AV?$_String_iterator@DU?$char_traits@D@std@@V?$allocator@D@2@@2@XZ"] = (ctx, _mem, args) => {
            return writeStringIterator(args[0] ?? 0, stringEnd(ctx.ecx >>> 0));
        };

        this.exports["?allocate@?$allocator@D@std@@QAEPADI@Z"] = (_ctx, _mem, args) => {
            return this.heap.alloc(args[0] ?? 0);
        };

        this.exports["?deallocate@?$allocator@D@std@@QAEXPADI@Z"] = (_ctx, _mem, args) => {
            this.heap.free(args[0] ?? 0);
            return 0;
        };

        this.exports["??$?MDU?$char_traits@D@std@@V?$allocator@D@1@@std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] =
            (_ctx, _mem, args) => stringCompareLess(args[0] ?? 0, args[1] ?? 0);
    }
}
