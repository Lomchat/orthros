/**
 * Faithful inet_addr (src/worker/modules/wsa-stub-shared.ts parseInetAddr).
 * Result is in_addr.s_addr in NETWORK byte order → on x86 little-endian, "1.2.3.4" = 0x04030201.
 */
import { describe, expect, test } from "bun:test";
import { parseInetAddr } from "../../src/worker/modules/wsa-stub-shared";

const NONE = 0xffffffff;

describe("parseInetAddr", () => {
    test("dotted quad → network-order LE uint32", () => {
        expect(parseInetAddr("1.2.3.4") >>> 0).toBe(0x04030201);
        expect(parseInetAddr("127.0.0.1") >>> 0).toBe(0x0100007f);
        expect(parseInetAddr("192.168.0.1") >>> 0).toBe(0x0100a8c0);
        expect(parseInetAddr("0.0.0.0") >>> 0).toBe(0);
    });
    test("255.255.255.255 → INADDR_NONE (the historical quirk)", () => {
        expect(parseInetAddr("255.255.255.255") >>> 0).toBe(NONE);
    });
    test("malformed → INADDR_NONE", () => {
        expect(parseInetAddr("") >>> 0).toBe(NONE);
        expect(parseInetAddr("not.an.ip.addr") >>> 0).toBe(NONE);
        expect(parseInetAddr("1.2.3.4.5") >>> 0).toBe(NONE);
        expect(parseInetAddr("256.1.1.1") >>> 0).toBe(NONE);
        expect(parseInetAddr("1..2.3") >>> 0).toBe(NONE);
    });
    test("short forms (a / a.b / a.b.c)", () => {
        // a.b.c.d packing: single 32-bit value spreads across all four octets
        expect(parseInetAddr("16909060") >>> 0).toBe(0x04030201);   // == 0x01020304
        // a.(24-bit): 10.65535 → 10.0.255.255
        expect(parseInetAddr("10.65535") >>> 0).toBe((10 | (0 << 8) | (0xff << 16) | (0xff << 24)) >>> 0);
        // a.b.(16-bit): 192.168.258 → 192.168.1.2
        expect(parseInetAddr("192.168.258") >>> 0).toBe((192 | (168 << 8) | (1 << 16) | (2 << 24)) >>> 0);
    });
    test("hex and octal parts", () => {
        expect(parseInetAddr("0x7f.0.0.1") >>> 0).toBe(0x0100007f); // 0x7f = 127
        expect(parseInetAddr("0177.0.0.1") >>> 0).toBe(0x0100007f); // 0177 octal = 127
    });
});
