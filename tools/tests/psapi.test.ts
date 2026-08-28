import { describe, expect, test } from "bun:test";
import { Psapi } from "../../src/worker/modules/psapi";

function initializedPsapi() {
    const modules = [
        { name: "lotrbfme2ep1.exe", baseAddress: 0x400000, isExecutable: true },
        { name: "mss32.dll", baseAddress: 0x13000000, isExecutable: false },
    ];
    const process = {
        moduleRegistry: {
            getAllModules: () => modules,
            getByBase: (base: number) => modules.find((module) => module.baseAddress === base),
            getExecutableModule: () => modules[0],
        },
    } as any;
    const psapi = new Psapi();
    psapi.initialize(process);
    return psapi;
}

describe("psapi process and module enumeration", () => {
    test("returns the single emulated process ID", () => {
        const psapi = initializedPsapi();
        const memory = new Uint8Array(128);
        const result = psapi.exports.EnumProcesses({} as any, memory, [16, 4, 32]) as any;
        const view = new DataView(memory.buffer);

        expect(result).toEqual({ value: 1, stackCleanup: 12 });
        expect(view.getUint32(16, true)).toBe(1);
        expect(view.getUint32(32, true)).toBe(4);
    });

    test("reports all loaded module handles and the executable base name", () => {
        const psapi = initializedPsapi();
        const memory = new Uint8Array(256);
        const view = new DataView(memory.buffer);

        expect(psapi.exports.EnumProcessModules({} as any, memory, [1, 32, 8, 64]))
            .toEqual({ value: 1, stackCleanup: 16 });
        expect(view.getUint32(32, true)).toBe(0x400000);
        expect(view.getUint32(36, true)).toBe(0x13000000);
        expect(view.getUint32(64, true)).toBe(8);

        const result = psapi.exports.GetModuleBaseNameA({} as any, memory, [1, 0, 96, 64]) as any;
        expect(result.value).toBe("lotrbfme2ep1.exe".length);
        expect(new TextDecoder().decode(memory.subarray(96, 96 + result.value)))
            .toBe("lotrbfme2ep1.exe");
        expect(memory[96 + result.value]).toBe(0);
    });
});
