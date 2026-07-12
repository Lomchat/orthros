import { beforeEach, describe, expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { msvcr90Module } from "../../src/worker/api/msvcr90.api";
import { msvcrtModule } from "../../src/worker/api/msvcrt.api";
import { registerVc9AbiExports, type Vc9CrtHost } from "../../src/worker/modules/crt-vc9-abi";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

/** Exact decorated import names from VC9 boot log (source of truth). */
export const BOOT_LOG_VC9_SYMBOLS = [
    "_configthreadlocale",
    "_initterm_e",
    "_ismbblead",
    "_cexit",
    "_amsg_exit",
    "_decode_pointer",
    "_lock",
    "_encode_pointer",
    "_unlock",
    "sprintf_s",
    "_time64",
    "_localtime64",
    "asctime",
    "strncat_s",
    "_getdcwd",
    "_getdrive",
    "_stat64i32",
    "vfprintf",
    "_umask",
    "_findfirst64i32",
    "_findclose",
    "_findnext64i32",
    "_filelengthi64",
    "_fstat64i32",
    "_ftelli64",
    "fscanf",
    "_crt_debugger_hook",
    "_except_handler4_common",
    "?_type_info_dtor_internal_method@type_info@@QAEXXZ",
    "_invoke_watson",
    "_controlfp_s",
    "iswctype",
    "_setjmp3",
    "_CIatan",
    "_snprintf_s",
    "??_V@YAXPAX@Z",
    "_gcvt",
    "iswspace",
    "_fseeki64",
    "strncpy_s",
    "longjmp",
    "memchr",
    "memmove_s",
    "?what@exception@std@@UBEPBDXZ",
    "??1exception@std@@UAE@XZ",
    "??0exception@std@@QAE@XZ",
    "??0exception@std@@QAE@ABQBD@Z",
    "??0exception@std@@QAE@ABV01@@Z",
    "_invalid_parameter_noinfo",
    "strcspn",
    "setbuf",
] as const;

describe("msvcr90 ABI closure", () => {
    let registry: APIRegistry;

    beforeEach(() => {
        registry = APIRegistry.getInstance();
        // Bun test has no Vite import.meta.glob — register descriptors directly.
        registry.registerModule(msvcrtModule);
        registry.registerModule(msvcr90Module);
    });

    test("APIRegistry resolves argCount for every boot-log symbol", () => {
        for (const symbol of BOOT_LOG_VC9_SYMBOLS) {
            const count = registry.getArgCount("msvcr90", symbol);
            expect(count, `missing argCount for msvcr90:${symbol}`).toBeDefined();
            expect(count!).toBeGreaterThanOrEqual(0);
        }
    });

    test("ThunkGenerator produces msvcr90 stubs without throw", () => {
        const gen = new ThunkGenerator();
        const stubInfos = BOOT_LOG_VC9_SYMBOLS.map((name) => ({
            name,
            argCount: registry.getArgCount("msvcr90", name),
            stackCleanupBytes: registry.getStackCleanupBytes("msvcr90", name),
            callingConvention: registry.getCallingConvention("msvcr90", name),
        }));
        expect(() => gen.generateStubDll("msvcr90", stubInfos)).not.toThrow();
    });

    test("forwarding descriptors: __CxxFrameHandler3 in msvcr90, __CxxFrameHandler in msvcrt", () => {
        const msvcr90Names = new Set(msvcr90Module.functions.map((f) => f.name));
        const msvcrtNames = new Set(msvcrtModule.functions.map((f) => f.name));
        expect(msvcr90Names.has("__CxxFrameHandler3")).toBe(true);
        expect(msvcrtNames.has("__CxxFrameHandler")).toBe(true);
        expect(msvcrtNames.has("??1bad_cast@@UAE@XZ")).toBe(true);
        expect(msvcrtNames.has("_initterm_e")).toBe(true);
        expect(msvcrtNames.has("malloc")).toBe(true);
    });

    test("msvcrt resolves MSVC bad_cast destructor ABI", () => {
        const name = "??1bad_cast@@UAE@XZ";
        expect(registry.getArgCount("msvcrt", name)).toBe(0);
        expect(registry.getStackCleanupBytes("msvcrt", name)).toBe(0);
        expect(registry.getCallingConvention("msvcrt", name)).toBe("stdcall");

        const gen = new ThunkGenerator();
        expect(() => gen.generateStubDll("msvcrt", [{
            name,
            argCount: registry.getArgCount("msvcrt", name),
            stackCleanupBytes: registry.getStackCleanupBytes("msvcrt", name),
            callingConvention: registry.getCallingConvention("msvcrt", name),
        }])).not.toThrow();
    });

    test("msvcrt exports cover forward targets after VC9 registration", () => {
        const exports: Record<string, ThunkImplementation> = {
            malloc: () => 0,
            __CxxFrameHandler: () => 0,
        };
        const host: Vc9CrtHost = {
            process: {} as Vc9CrtHost["process"],
            initterm: () => ({ value: 0, skipStackCheck: true }),
            free: () => 0,
            controlfp: () => 0,
            readCString: () => "",
            writeCString: () => {},
            readWString: () => "",
            setErrno: () => true,
            exitProcess: () => ({ value: 0 }),
            terminateProcess: () => ({ value: 0, terminated: true }),
            getcwd: () => 0,
            snprintf: () => 0,
            vsnprintf: () => 0,
            strncpy: () => 0,
            strncat: () => 0,
            memmove: () => 0,
            sprintf: () => 0,
            computeCtypeFlags: () => 0,
            ischartype: () => 0,
        };
        registerVc9AbiExports(exports, host);
        expect(typeof exports["_initterm_e"]).toBe("function");
        expect(typeof exports["_encode_pointer"]).toBe("function");
        expect(typeof exports["_lock"]).toBe("function");
        expect(exports["_encode_pointer"](null as any, new Uint8Array(0), [0x12345])).toBe(0x12345);
        expect(exports["_lock"](null as any, new Uint8Array(0), [0])).toBe(0);
    });
});
