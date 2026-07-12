import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
    UNPACK_LZMA1,
    UNPACK_LZMA2,
    UNPACK_STORE,
    UnpackDecoder,
} from "@bottleship/formats/unpack";

const WASM_PATH = join(import.meta.dir, "../../public/unpack-streaming.wasm");
const FIXTURE_DIR = join(import.meta.dir, "fixtures/inno/lzma");

function readFixture(name: string): Uint8Array {
    return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

let decoder: UnpackDecoder;

beforeAll(async () => {
    if (!existsSync(WASM_PATH)) {
        throw new Error(
            `Missing ${WASM_PATH} — run: bun run build:inno-wasm`,
        );
    }
    decoder = new UnpackDecoder();
    await decoder.init(readFileSync(WASM_PATH).buffer);
});

describe("UnpackDecoder", () => {
    test("store (copy) round-trip", () => {
        const input = new TextEncoder().encode("stored plaintext");
        const out = decoder.decode(UNPACK_STORE, input);
        expect(new TextDecoder().decode(out)).toBe("stored plaintext");
    });

    test("LZMA1 hello fixture", () => {
        const compressed = readFixture("hello.lzma1");
        const props = readFixture("hello.props");
        const expected = readFixture("hello.txt");
        const out = decoder.decode(UNPACK_LZMA1, compressed, props);
        expect(out).toEqual(expected);
    });

    test("LZMA1 binary fixture (256 bytes)", () => {
        const compressed = readFixture("binary.lzma1");
        const props = readFixture("binary.props");
        const expected = readFixture("binary.txt");
        const out = decoder.decode(UNPACK_LZMA1, compressed, props);
        expect(out).toEqual(expected);
        expect(out.length).toBe(256);
    });

    test("LZMA2 hello fixture", () => {
        const compressed = readFixture("hello-lzma2.lzma2");
        const props = readFixture("hello-lzma2.props");
        const expected = readFixture("hello-lzma2.txt");
        const out = decoder.decode(UNPACK_LZMA2, compressed, props);
        expect(out).toEqual(expected);
    });
});
