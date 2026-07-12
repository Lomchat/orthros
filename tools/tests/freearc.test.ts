/**
 * FreeArc reader — pure-logic unit tests (packages/formats/src/freearc).
 *
 * Covers the spec-derived pure pieces: magic detection, method/pipeline parsing, size
 * tokens, and LZMA props synthesis. The footer→directory→file-table parser is verified by
 * integration against a real disc archive (GTAIII data004.pak: 1 file "gta3.exe", CRC OK),
 * which needs a multi-MB fixture and so isn't unit-tested here.
 */
import { describe, expect, test } from "bun:test";
import {
    detectFreeArc,
    parseFreeArcMethod,
    parseFreeArcPipeline,
    parseFreeArcSize,
    lzmaPropsByte,
    lzmaPropsFor,
} from "@bottleship/formats/freearc";

describe("detectFreeArc", () => {
    test("matches the ArC\\x01 magic", () => {
        expect(detectFreeArc(new Uint8Array([0x41, 0x72, 0x43, 0x01, 0, 0]))).toBe(true);
    });
    test("rejects non-FreeArc bytes (incl. a Quake-style PACK)", () => {
        expect(detectFreeArc(new Uint8Array([0x50, 0x41, 0x43, 0x4b]))).toBe(false); // "PACK"
        expect(detectFreeArc(new Uint8Array([0x41, 0x72, 0x43]))).toBe(false); // too short
    });
});

describe("parseFreeArcSize", () => {
    test("decodes byte/k/m/g suffixes", () => {
        expect(parseFreeArcSize("1mb")).toBe(1024 * 1024);
        expect(parseFreeArcSize("200mb")).toBe(200 * 1024 * 1024);
        expect(parseFreeArcSize("64k")).toBe(64 * 1024);
        expect(parseFreeArcSize("512")).toBe(512);
        expect(parseFreeArcSize("1g")).toBe(1024 * 1024 * 1024);
    });
});

describe("parseFreeArcMethod", () => {
    test("recognizes storing", () => {
        expect(parseFreeArcMethod("storing")).toEqual({ kind: "store" });
    });
    test("parses lzma dict + defaults (lc=3,lp=0,pb=2)", () => {
        expect(parseFreeArcMethod("lzma:1mb:normal:bt4:32")).toEqual({
            kind: "lzma", dictSize: 1024 * 1024, lc: 3, lp: 0, pb: 2,
        });
    });
    test("honors explicit lc/lp/pb overrides (GTA3 uses lc8)", () => {
        const m = parseFreeArcMethod("lzma:200mb:normal:bt4:273:mc10000:lc8");
        expect(m).toEqual({ kind: "lzma", dictSize: 200 * 1024 * 1024, lc: 8, lp: 0, pb: 2 });
    });
    test("flags unknown codecs as unsupported", () => {
        expect(parseFreeArcMethod("ppmd:o12:m256")).toEqual({ kind: "unsupported", raw: "ppmd:o12:m256" });
    });
});

describe("parseFreeArcPipeline", () => {
    test("splits a srep+lzma pipeline into filters + base", () => {
        const p = parseFreeArcPipeline("srep+lzma:200mb:normal:bt4:273:mc10000:lc8");
        expect(p.filters).toEqual(["srep"]);
        expect(p.base).toEqual({ kind: "lzma", dictSize: 200 * 1024 * 1024, lc: 8, lp: 0, pb: 2 });
    });
    test("a bare codec has no filters", () => {
        const p = parseFreeArcPipeline("lzma:1mb");
        expect(p.filters).toEqual([]);
        expect(p.base.kind).toBe("lzma");
    });
    test("multi-filter pipeline keeps compression order", () => {
        expect(parseFreeArcPipeline("delta+srep+lzma:8mb").filters).toEqual(["delta", "srep"]);
    });
});

describe("lzma props synthesis", () => {
    test("default 3/0/2 → 0x5D", () => {
        expect(lzmaPropsByte(3, 0, 2)).toBe(0x5d);
    });
    test("lc8/0/2 → 0x62", () => {
        expect(lzmaPropsByte(8, 0, 2)).toBe(0x62);
    });
    test("lzmaPropsFor packs [propsByte, dictSize LE32]", () => {
        const props = lzmaPropsFor({ kind: "lzma", dictSize: 1024 * 1024, lc: 3, lp: 0, pb: 2 });
        expect(Array.from(props)).toEqual([0x5d, 0x00, 0x00, 0x10, 0x00]);
    });
});
