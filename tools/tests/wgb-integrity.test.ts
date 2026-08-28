import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    integrityEtag,
    integrityUrlForWgb,
    parseWgbIntegrity,
    sha256Hex,
} from "../../src/worker/runtime/filesystem/wgb-integrity";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

describe("WGB integrity descriptors", () => {
    test("derives a sidecar URL without losing query identity", () => {
        expect(integrityUrlForWgb("/apps/game.wgb?v=7")).toBe("/apps/game.wgb.integrity.json?v=7");
        expect(integrityUrlForWgb("https://cdn.test/game.wgb?token=x"))
            .toBe("https://cdn.test/game.wgb.integrity.json?token=x");
    });

    test("validates geometry and creates the strong ETag", () => {
        const parsed = parseWgbIntegrity({
            version: 1,
            algorithm: "sha256",
            size: 5,
            sha256: h("abcde"),
            chunkSize: 4,
            chunks: [h("abcd"), h("e")],
            segmentSize: 4,
            segments: [h("abcd"), h("e")],
        });
        expect(integrityEtag(parsed)).toBe(`"sha256-${h("abcde")}"`);
        expect(() => parseWgbIntegrity({ ...parsed, chunks: [h("abcd")] })).toThrow("geometry");
    });

    test("hashes browser byte views with SHA-256", async () => {
        expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(h("abc"));
    });
});
