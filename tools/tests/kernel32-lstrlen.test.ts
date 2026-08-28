import { describe, expect, it } from "bun:test";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { exports as kernel32Locale } from "../../src/worker/modules/kernel32/locale";

describe("kernel32 undecorated lstrlen alias", () => {
    it("is exported with the one-argument stdcall signature", () => {
        const descriptor = kernel32Module.functions.find((fn) => fn.name === "lstrlen");
        expect(descriptor?.params).toHaveLength(1);
        expect(descriptor?.callingConvention).toBe("stdcall");
    });

    it("uses the ANSI byte-counting semantics", () => {
        const mem = new Uint8Array(32);
        mem.set([0x42, 0x46, 0x4d, 0x45, 0x32, 0], 8);
        const result = kernel32Locale.lstrlen!(null as never, mem, [8]);
        expect(result).toBe(5);
        expect(kernel32Locale.lstrlen!(null as never, mem, [0])).toBe(0);
    });
});
