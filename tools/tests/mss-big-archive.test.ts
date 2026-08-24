import { describe, expect, test } from "bun:test";
import { normalizeBigPath, parseBigDirectory } from "../../src/worker/modules/mss32/big-archive";

function be32(out: Uint8Array, at: number, value: number): void {
    new DataView(out.buffer).setUint32(at, value, false);
}

describe("EA BIG audio directory", () => {
    test("parses BIG4 offsets, sizes and case-insensitive Windows paths", () => {
        const name = "Data\\Audio\\Tracks\\ActionEdit03.mp3";
        const encoded = new TextEncoder().encode(name);
        const headerSize = 16 + 8 + encoded.length + 1;
        const bytes = new Uint8Array(headerSize);
        bytes.set(new TextEncoder().encode("BIG4"), 0);
        be32(bytes, 4, headerSize + 1234);
        be32(bytes, 8, 1);
        be32(bytes, 12, headerSize);
        be32(bytes, 16, headerSize);
        be32(bytes, 20, 1234);
        bytes.set(encoded, 24);

        const entry = parseBigDirectory(bytes).get("data\\audio\\tracks\\actionedit03.mp3");
        expect(entry).toEqual({ offset: headerSize, size: 1234, name });
    });

    test("normalizes slash and leading separator variants", () => {
        expect(normalizeBigPath("/DATA/Audio/Tracks/X.MP3")).toBe("data\\audio\\tracks\\x.mp3");
    });

    test("rejects truncated directories", () => {
        const bytes = new Uint8Array(16);
        bytes.set(new TextEncoder().encode("BIG4"));
        be32(bytes, 8, 1);
        be32(bytes, 12, 16);
        expect(() => parseBigDirectory(bytes)).toThrow("truncated");
    });
});
