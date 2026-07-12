import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { scanfCore } from "../../src/worker/modules/crt-scanf";

// Back scanfCore's writes with a plain buffer (no validator → writes proceed unchecked).
const BUF = new Uint8Array(64 * 1024);
const view = new DataView(BUF.buffer);
Mem.bind(() => BUF);

/** Guest arg pointers: args[0]/[1] are the (already-read) input/format ptrs, unused by the core. */
function ptrs(...addrs: number[]): number[] {
    return [0, 0, ...addrs];
}

beforeEach(() => BUF.fill(0));

const u32 = (a: number) => view.getUint32(a, true);
const i32 = (a: number) => view.getInt32(a, true);
const u16 = (a: number) => view.getUint16(a, true);
const u8 = (a: number) => BUF[a];
const f32 = (a: number) => view.getFloat32(a, true);
const f64 = (a: number) => view.getFloat64(a, true);
const cstr = (a: number) => {
    let s = ""; for (let i = a; BUF[i]; i++) s += String.fromCharCode(BUF[i]); return s;
};

describe("scanfCore — basic conversions", () => {
    test("%d %d %f assigns three fields", () => {
        const r = scanfCore("42 -7 3.5", "%d %d %f", ptrs(0x100, 0x104, 0x108), 2);
        expect(r.assigned).toBe(3);
        expect(i32(0x100)).toBe(42);
        expect(i32(0x104)).toBe(-7);
        expect(f32(0x108)).toBeCloseTo(3.5, 5);
    });

    test("%u honors unsigned wraparound", () => {
        const r = scanfCore("4294967295", "%u", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);
        expect(u32(0x100)).toBe(0xffffffff);
    });

    test("literal characters must match; mismatch returns fields so far", () => {
        const r = scanfCore("x=5;y=9", "x=%d;z=%d", ptrs(0x100, 0x104), 2);
        expect(r.assigned).toBe(1);        // %d got 5, then 'z' != 'y' → stop
        expect(i32(0x100)).toBe(5);
        expect(u32(0x104)).toBe(0);        // second arg untouched
    });
});

describe("scanfCore — width write-size (memory safety)", () => {
    test("%hd writes exactly 2 bytes, leaving neighbors intact", () => {
        view.setUint32(0x100, 0xaaaaaaaa, true); // sentinel
        const r = scanfCore("-1", "%hd", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);
        expect(u16(0x100)).toBe(0xffff);   // low 2 bytes = -1
        expect(u16(0x102)).toBe(0xaaaa);   // upper 2 bytes untouched — no clobber
    });

    test("%hhd writes exactly 1 byte", () => {
        view.setUint32(0x100, 0xbbbbbbbb, true);
        scanfCore("255", "%hhd", ptrs(0x100), 2);
        expect(u8(0x100)).toBe(0xff);
        expect(u8(0x101)).toBe(0xbb);
    });

    test("%I64d / %lld writes 8 bytes", () => {
        const r = scanfCore("4294967296", "%I64d", ptrs(0x100), 2); // 2^32
        expect(r.assigned).toBe(1);
        expect(u32(0x100)).toBe(0);
        expect(u32(0x104)).toBe(1);
        scanfCore("4294967296", "%lld", ptrs(0x200), 2);
        expect(u32(0x200)).toBe(0);
        expect(u32(0x204)).toBe(1);
    });
});

describe("scanfCore — base handling", () => {
    test("%i auto-detects hex (0x) and octal (0)", () => {
        const r = scanfCore("0x1F 017 42", "%i %i %i", ptrs(0x100, 0x104, 0x108), 2);
        expect(r.assigned).toBe(3);
        expect(i32(0x100)).toBe(31);   // 0x1F
        expect(i32(0x104)).toBe(15);   // 017 octal
        expect(i32(0x108)).toBe(42);   // decimal
    });

    test("%x consumes optional 0x prefix", () => {
        scanfCore("0xdeadBEEF", "%x", ptrs(0x100), 2);
        expect(u32(0x100)).toBe(0xdeadbeef);
    });

    test("%x without prefix still parses hex", () => {
        scanfCore("ff", "%x", ptrs(0x100), 2);
        expect(u32(0x100)).toBe(0xff);
    });

    test("%o parses octal", () => {
        scanfCore("777", "%o", ptrs(0x100), 2);
        expect(u32(0x100)).toBe(0o777);
    });
});

describe("scanfCore — float boundary consumption", () => {
    test("%f consumes only the numeric prefix, leaving the rest for %d", () => {
        const r = scanfCore("12.5-3", "%f%d", ptrs(0x100, 0x104), 2);
        expect(r.assigned).toBe(2);
        expect(f32(0x100)).toBeCloseTo(12.5, 5);
        expect(i32(0x104)).toBe(-3);
    });

    test("%f handles exponent and backs out a dangling 'e'", () => {
        const r = scanfCore("1.5e3x", "%f", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);
        expect(f32(0x100)).toBeCloseTo(1500, 3);
        expect(r.consumed).toBe(5); // "1.5e3", not the trailing x
    });

    test("%lf writes an 8-byte double", () => {
        scanfCore("3.141592653589793", "%lf", ptrs(0x100), 2);
        expect(f64(0x100)).toBeCloseTo(Math.PI, 12);
    });
});

describe("scanfCore — strings, chars, scansets", () => {
    test("%s stops at whitespace and null-terminates", () => {
        const r = scanfCore("hello world", "%s", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);
        expect(cstr(0x100)).toBe("hello");
    });

    test("%5s honors field width", () => {
        scanfCore("abcdefgh", "%5s", ptrs(0x100), 2);
        expect(cstr(0x100)).toBe("abcde");
    });

    test("%c reads a single char without skipping whitespace", () => {
        const r = scanfCore("  X", "%c", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);
        expect(u8(0x100)).toBe(0x20); // leading space
    });

    test("scanset %[^,] reads until delimiter", () => {
        const r = scanfCore("key,value", "%[^,]", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);
        expect(cstr(0x100)).toBe("key");
    });

    test("scanset %[a-z] positive range", () => {
        scanfCore("abcXYZ", "%[a-z]", ptrs(0x100), 2);
        expect(cstr(0x100)).toBe("abc");
    });

    test("scanset ']' as first member is literal", () => {
        scanfCore("]]]stop", "%[]]", ptrs(0x100), 2);
        expect(cstr(0x100)).toBe("]]]");
    });
});

describe("scanfCore — suppression, %n, EOF", () => {
    test("%*d suppresses assignment and does not consume a vararg", () => {
        const r = scanfCore("10 20", "%*d %d", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);   // only the second field counts
        expect(i32(0x100)).toBe(20);  // written to the FIRST arg (suppressed one took none)
    });

    test("%n stores chars consumed, not counted as assignment", () => {
        const r = scanfCore("12345 rest", "%d%n", ptrs(0x100, 0x104), 2);
        expect(r.assigned).toBe(1);
        expect(i32(0x100)).toBe(12345);
        expect(i32(0x104)).toBe(5);
    });

    test("empty input before first conversion reports EOF", () => {
        const r = scanfCore("", "%d", ptrs(0x100), 2);
        expect(r.assigned).toBe(0);
        expect(r.eof).toBe(true);
    });

    test("all-whitespace input before %d reports EOF", () => {
        const r = scanfCore("   \t\n", "%d", ptrs(0x100), 2);
        expect(r.assigned).toBe(0);
        expect(r.eof).toBe(true);
    });

    test("matching failure (not EOF) does not set eof", () => {
        const r = scanfCore("abc", "%d", ptrs(0x100), 2);
        expect(r.assigned).toBe(0);
        expect(r.eof).toBe(false);
    });
});

describe("scanfCore — consumed count (fscanf rewind contract)", () => {
    test("consumed reflects exactly the matched prefix", () => {
        const r = scanfCore("42 abc", "%d", ptrs(0x100), 2);
        expect(r.assigned).toBe(1);
        expect(r.consumed).toBe(2); // "42"; the " abc" stays in the stream
    });
});
