import { describe, expect, test } from "bun:test";
import {
    SUN_TYPELIB,
    BLOWFISH_CLSID,
    IBLOCK_CIPHER_IID,
    matchSunTypeLibPath,
} from "../../src/worker/core/com/typelib/sun-tlb";
import {
    normalizeGuid,
    TKIND_COCLASS,
    TKIND_INTERFACE,
    writeGuidToMem,
    readGuidFromMem,
} from "../../src/worker/core/com/typelib/typelib-types";
import { verifyComVtableSlot, COM_STUB_PROLOGUE } from "../../src/worker/core/com/com-memory";

describe("SUN.TLB static descriptor", () => {
    test("has at least one type entry", () => {
        expect(SUN_TYPELIB.types.length).toBeGreaterThanOrEqual(1);
    });

    test("includes Blowfish coclass", () => {
        const blowfish = SUN_TYPELIB.types.find((t) => normalizeGuid(t.guid) === normalizeGuid(BLOWFISH_CLSID));
        expect(blowfish).toBeDefined();
        expect(blowfish!.kind).toBe(TKIND_COCLASS);
        expect(blowfish!.name).toBe("BlowfishCipher");
    });

    test("includes IBlockCipher interface", () => {
        const iface = SUN_TYPELIB.types.find((t) => normalizeGuid(t.guid) === normalizeGuid(IBLOCK_CIPHER_IID));
        expect(iface).toBeDefined();
        expect(iface!.kind).toBe(TKIND_INTERFACE);
    });

    test("matchSunTypeLibPath accepts common paths", () => {
        expect(matchSunTypeLibPath("SUN.TLB")).toBe(true);
        expect(matchSunTypeLibPath("C:\\Game\\SUN.TLB")).toBe(true);
        expect(matchSunTypeLibPath("OTHER.TLB")).toBe(false);
    });

    test("libid is non-empty GUID", () => {
        expect(SUN_TYPELIB.libid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
});

describe("typelib GUID helpers", () => {
    test("writeGuidToMem / readGuidFromMem roundtrip", () => {
        const mem = new Uint8Array(32);
        const guid = BLOWFISH_CLSID;
        writeGuidToMem(mem, 0, guid);
        expect(readGuidFromMem(mem, 0)).toBe(normalizeGuid(guid));
    });
});

describe("verifyComVtableSlot", () => {
    test("accepts MOV EAX prologue", () => {
        const mem = new Uint8Array(16);
        mem[4] = COM_STUB_PROLOGUE;
        expect(verifyComVtableSlot(mem, 4)).toBe(true);
    });

    test("rejects invalid stub bytes", () => {
        const mem = new Uint8Array(16);
        mem[8] = 0xef;
        expect(verifyComVtableSlot(mem, 8)).toBe(false);
    });

    test("rejects zero address", () => {
        expect(verifyComVtableSlot(new Uint8Array(16), 0)).toBe(false);
    });
});
