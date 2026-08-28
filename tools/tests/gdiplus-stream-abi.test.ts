import { describe, expect, test } from "bun:test";
import { gdiplusModule } from "../../src/worker/api/gdiplus.api";
import { ole32Module } from "../../src/worker/api/ole32.api";

describe("GDI+ stream image ABI", () => {
    test("declares both two-argument launcher imports", () => {
        for (const name of ["GdipCreateBitmapFromStream", "GdipCreateBitmapFromStreamICM"]) {
            const descriptor = gdiplusModule.functions.find((fn) => fn.name === name);
            expect(descriptor?.callingConvention).toBe("stdcall");
            expect(descriptor?.params).toHaveLength(2);
        }
    });
});

describe("OLE HGLOBAL stream ABI", () => {
    test("declares CreateStreamOnHGlobal with three arguments", () => {
        const descriptor = ole32Module.functions.find((fn) => fn.name === "CreateStreamOnHGlobal");
        expect(descriptor?.callingConvention).toBe("stdcall");
        expect(descriptor?.params).toHaveLength(3);
    });
});
