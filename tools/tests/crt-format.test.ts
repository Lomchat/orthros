/**
 * Unit tests for the shared C-runtime printf engine (crt-format.ts formatCLazy).
 *
 * Covers the narrow + wide paths that serve the entire msvcrt/crtdll printf
 * family. The crux: %f consumes a C-promoted double (TWO 32-bit va_list slots),
 * which is the root-cause fix for Unreal Gold's `appSprintf` writing literal
 * "%f" into Unreal.ini (→ atof("%f")=0 → dead mouse axis scale).
 */
import { describe, expect, test } from "bun:test";
import { ArrayVaListReader, formatCLazy } from "../../src/worker/modules/crt-format";

/** Split a JS double into the two little-endian 32-bit slots a varargs stack holds. */
function doubleSlots(value: number): [number, number] {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat64(0, value, true);
    return [dv.getUint32(0, true), dv.getUint32(4, true)];
}

/** Build a fake guest string table: returns { ptrs, readNarrow, readWide }. */
function makeStringTable(strings: string[]) {
    // Assign each string a fake "pointer" = index+1 (0 reserved for null).
    const readNarrow = (addr: number) => strings[addr - 1] ?? "";
    const readWide = (addr: number) => strings[addr - 1] ?? "";
    return { readNarrow, readWide };
}

describe("formatCLazy — narrow integer/char/pointer", () => {
    const rd = (s: string[]) => makeStringTable(s).readNarrow;

    test("%d / %i / %u signedness", () => {
        const args = [-5, 7, 0xfffffffb];
        const out = formatCLazy("%d %i %u", new ArrayVaListReader(args, 0), rd([]));
        expect(out).toBe("-5 7 4294967291");
    });

    test("%x / %X / %o", () => {
        const out = formatCLazy("%x %X %o", new ArrayVaListReader([0xdeadbeef, 0xdeadbeef, 8], 0), rd([]));
        expect(out).toBe("deadbeef DEADBEEF 10");
    });

    test("%c and %% literal", () => {
        const out = formatCLazy("[%c] 100%%", new ArrayVaListReader([65], 0), rd([]));
        expect(out).toBe("[A] 100%");
    });

    test("%p pads to 8 upper-hex", () => {
        const out = formatCLazy("%p", new ArrayVaListReader([0x1234], 0), rd([]));
        expect(out).toBe("00001234");
    });

    test("%-10d left align", () => {
        const out = formatCLazy("[%-10d]", new ArrayVaListReader([42], 0), rd([]));
        expect(out).toBe("[42        ]");
    });

    test("%05x zero pad", () => {
        const out = formatCLazy("%05x", new ArrayVaListReader([0xab], 0), rd([]));
        expect(out).toBe("000ab");
    });

    test("%+d sign and space flag", () => {
        expect(formatCLazy("%+d", new ArrayVaListReader([5], 0), rd([]))).toBe("+5");
        expect(formatCLazy("% d", new ArrayVaListReader([5], 0), rd([]))).toBe(" 5");
    });

    test("# alternate form for %#x / %#o", () => {
        expect(formatCLazy("%#x", new ArrayVaListReader([0xff], 0), rd([]))).toBe("0xff");
        expect(formatCLazy("%#o", new ArrayVaListReader([8], 0), rd([]))).toBe("010");
        // '#' on a zero hex value adds no prefix (C rule)
        expect(formatCLazy("%#x", new ArrayVaListReader([0], 0), rd([]))).toBe("0");
    });

    test("* width and * precision pulled from args", () => {
        // width=6, value=42  -> "    42"
        expect(formatCLazy("%*d", new ArrayVaListReader([6, 42], 0), rd([]))).toBe("    42");
        // precision=3 on %d -> zero-pads digits to 3
        expect(formatCLazy("%.*d", new ArrayVaListReader([3, 7], 0), rd([]))).toBe("007");
    });

    test("length modifiers skip dwords for 64-bit and are tolerated", () => {
        // %lld consumes a low+high dword pair; engine reads one uint32 for value,
        // verify it does not crash and formats the low dword.
        const out = formatCLazy("%lld", new ArrayVaListReader([123, 0], 0), rd([]));
        expect(out).toBe("123");
    });
});

describe("formatCLazy — floating point (the Unreal fix)", () => {
    const rd = makeStringTable([]).readNarrow;

    test("%f default precision = 6 (exact Unreal case)", () => {
        const out = formatCLazy("ScaleXYZ=%f", new ArrayVaListReader(doubleSlots(0.5), 0), rd);
        expect(out).toBe("ScaleXYZ=" + (0.5).toFixed(6));
        expect(out).toBe("ScaleXYZ=0.500000");
    });

    test("%f consumes TWO dwords (double promotion)", () => {
        // First arg is the double (2 slots), then a trailing %d reads the 3rd slot.
        const args = [...doubleSlots(1.25), 99];
        const out = formatCLazy("%f|%d", new ArrayVaListReader(args, 0), rd);
        expect(out).toBe("1.250000|99");
    });

    test("%.2f precision", () => {
        const out = formatCLazy("%.2f", new ArrayVaListReader(doubleSlots(3.14159), 0), rd);
        expect(out).toBe("3.14");
    });

    test("negative float sign", () => {
        const out = formatCLazy("%.1f", new ArrayVaListReader(doubleSlots(-2.5), 0), rd);
        expect(out).toBe("-2.5");
    });

    test("%e / %E", () => {
        expect(formatCLazy("%e", new ArrayVaListReader(doubleSlots(12345), 0), rd))
            .toBe((12345).toExponential(6));
        expect(formatCLazy("%E", new ArrayVaListReader(doubleSlots(12345), 0), rd))
            .toBe((12345).toExponential(6).toUpperCase());
    });

    test("%g / %G", () => {
        expect(formatCLazy("%g", new ArrayVaListReader(doubleSlots(100), 0), rd))
            .toBe((100).toPrecision(6));
        expect(formatCLazy("%G", new ArrayVaListReader(doubleSlots(100), 0), rd))
            .toBe((100).toPrecision(6).toUpperCase());
    });

    test("%+08.2f combined flags/width/precision", () => {
        // value 3.5 -> "+3.50" then zero-pad to width 8 after sign -> "+0003.50"
        const out = formatCLazy("%+08.2f", new ArrayVaListReader(doubleSlots(3.5), 0), rd);
        expect(out).toBe("+0003.50");
    });
});

describe("formatCLazy — narrow %s", () => {
    test("%s reads narrow, with width/precision", () => {
        const { readNarrow } = makeStringTable(["hello"]);
        expect(formatCLazy("%s", new ArrayVaListReader([1], 0), readNarrow)).toBe("hello");
        // precision truncates
        expect(formatCLazy("%.3s", new ArrayVaListReader([1], 0), readNarrow)).toBe("hel");
        // width right-aligns
        expect(formatCLazy("%8s", new ArrayVaListReader([1], 0), readNarrow)).toBe("   hello");
    });

    test("null pointer -> (null)", () => {
        const { readNarrow } = makeStringTable([]);
        expect(formatCLazy("%s", new ArrayVaListReader([0], 0), readNarrow)).toBe("(null)");
    });
});

describe("formatCLazy — wide-mode %s / %S / %hs rule", () => {
    // narrow table = index 1, wide table = index 2 (distinguishable strings)
    const strings = ["NARROW", "WIDE"];
    const readNarrow = (addr: number) => strings[0] && addr === 1 ? "NARROW" : "";
    const readWide = (addr: number) => addr === 2 ? "WIDE" : "";
    const opts = { wide: true, readWString: readWide };

    test("wide %s = wide", () => {
        const out = formatCLazy("%s", new ArrayVaListReader([2], 0), readNarrow, opts);
        expect(out).toBe("WIDE");
    });

    test("wide %hs = narrow", () => {
        const out = formatCLazy("%hs", new ArrayVaListReader([1], 0), readNarrow, opts);
        expect(out).toBe("NARROW");
    });

    test("wide %S = narrow", () => {
        const out = formatCLazy("%S", new ArrayVaListReader([1], 0), readNarrow, opts);
        expect(out).toBe("NARROW");
    });

    test("wide %ls / %ws = wide", () => {
        expect(formatCLazy("%ls", new ArrayVaListReader([2], 0), readNarrow, opts)).toBe("WIDE");
        expect(formatCLazy("%ws", new ArrayVaListReader([2], 0), readNarrow, opts)).toBe("WIDE");
    });

    test("wide %f still works (double promotion in wide mode)", () => {
        const out = formatCLazy("v=%f", new ArrayVaListReader(doubleSlots(0.5), 0), readNarrow, opts);
        expect(out).toBe("v=0.500000");
    });
});

describe("formatCLazy — narrow-mode %s / %ls / %S rule", () => {
    const readNarrow = (addr: number) => addr === 1 ? "NARROW" : "";
    const readWide = (addr: number) => addr === 2 ? "WIDE" : "";
    const opts = { wide: false, readWString: readWide };

    test("narrow %s = narrow", () => {
        expect(formatCLazy("%s", new ArrayVaListReader([1], 0), readNarrow, opts)).toBe("NARROW");
    });

    test("narrow %ls / %ws / %S = wide", () => {
        expect(formatCLazy("%ls", new ArrayVaListReader([2], 0), readNarrow, opts)).toBe("WIDE");
        expect(formatCLazy("%ws", new ArrayVaListReader([2], 0), readNarrow, opts)).toBe("WIDE");
        expect(formatCLazy("%S", new ArrayVaListReader([2], 0), readNarrow, opts)).toBe("WIDE");
    });

    test("narrow %hs = narrow", () => {
        expect(formatCLazy("%hs", new ArrayVaListReader([1], 0), readNarrow, opts)).toBe("NARROW");
    });
});
