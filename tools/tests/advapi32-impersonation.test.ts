import { describe, expect, test } from "bun:test";
import { advapi32Module } from "../../src/worker/api/advapi32.api";
import { createImpersonationExports } from "../../src/worker/modules/advapi32";

describe("advapi32 self impersonation", () => {
    test("declares the Win32 stdcall ABIs", () => {
        const impersonate = advapi32Module.functions.find((fn) => fn.name === "ImpersonateSelf");
        const revert = advapi32Module.functions.find((fn) => fn.name === "RevertToSelf");

        expect(impersonate?.callingConvention).toBe("stdcall");
        expect(impersonate?.params).toHaveLength(1);
        expect(revert?.callingConvention).toBe("stdcall");
        expect(revert?.params).toHaveLength(0);
    });

    test("acknowledges both guest-only token transitions", () => {
        const exports = createImpersonationExports();
        const mem = new Uint8Array();

        expect(exports.ImpersonateSelf!({} as never, mem, [2])).toEqual({
            value: 1,
            stackCleanup: 4,
        });
        expect(exports.RevertToSelf!({} as never, mem, [])).toEqual({
            value: 1,
            stackCleanup: 0,
        });
    });
});
