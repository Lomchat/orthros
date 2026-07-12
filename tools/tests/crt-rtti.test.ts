import { describe, expect, test } from "bun:test";
import { demangleTypeInfoName, getCompleteObjectLocator, rtDynamicCast } from "../../src/worker/modules/crt-rtti";

describe("crt-rtti re-exports", () => {
    test("demangleTypeInfoName is re-exported from msvc-demangle", () => {
        expect(demangleTypeInfoName(".?AVFoo@@")).toBe("class Foo");
    });
});

describe("getCompleteObjectLocator", () => {
    test("reads vfptr[-1] as the locator pointer", () => {
        const mem = new Uint8Array(0x1000);
        const dv = new DataView(mem.buffer);
        const inptr = 0x100;
        const vfptr = 0x200;
        const locator = 0x300;
        dv.setUint32(inptr, vfptr, true);      // object's vfptr slot
        dv.setUint32(vfptr - 4, locator, true); // vftable[-1] = complete object locator
        expect(getCompleteObjectLocator(mem, dv, inptr)).toBe(locator);
    });

    test("returns 0 for an out-of-range vfptr", () => {
        const mem = new Uint8Array(0x1000);
        const dv = new DataView(mem.buffer);
        dv.setUint32(0x100, 0xFFFF0000, true);
        expect(getCompleteObjectLocator(mem, dv, 0x100)).toBe(0);
    });
});

const CHD_MULTINH = 0x1;
const CHD_VIRTINH = 0x2;
const BCD_NOTVISIBLE = 0x2;

/** Builds MSVC 32-bit RTTI structures (TypeDescriptor / BCD / CHD / COL / vftable) in a flat buffer. */
class RttiBuilder {
    mem = new Uint8Array(0x10000);
    dv = new DataView(this.mem.buffer);
    private next = 0x2000;

    alloc(size: number): number {
        const p = this.next;
        this.next = (this.next + size + 3) & ~3;
        return p;
    }

    typeDesc(name: string): number {
        const p = this.alloc(8 + name.length + 1);
        this.dv.setUint32(p, 0xdead, true); // type_info vfptr (unused by cast logic)
        for (let i = 0; i < name.length; i++) this.mem[p + 8 + i] = name.charCodeAt(i);
        return p;
    }

    // 24-byte BaseClassDescriptor (VC6 layout, no trailing pCHD)
    bcd(td: number, numContained: number, mdisp: number, attrs = 0, pdisp = -1, vdisp = 0): number {
        const p = this.alloc(24);
        this.dv.setUint32(p, td, true);
        this.dv.setUint32(p + 4, numContained, true);
        this.dv.setInt32(p + 8, mdisp, true);
        this.dv.setInt32(p + 12, pdisp, true);
        this.dv.setInt32(p + 16, vdisp, true);
        this.dv.setUint32(p + 20, attrs, true);
        return p;
    }

    chd(attrs: number, bcds: number[]): number {
        const arr = this.alloc(bcds.length * 4);
        bcds.forEach((b, i) => this.dv.setUint32(arr + i * 4, b, true));
        const p = this.alloc(16);
        this.dv.setUint32(p + 4, attrs, true);
        this.dv.setUint32(p + 8, bcds.length, true);
        this.dv.setUint32(p + 12, arr, true);
        return p;
    }

    col(offset: number, td: number, chd: number): number {
        const p = this.alloc(20);
        this.dv.setUint32(p + 4, offset, true);
        this.dv.setUint32(p + 8, 0, true); // cdOffset
        this.dv.setUint32(p + 12, td, true);
        this.dv.setUint32(p + 16, chd, true);
        return p;
    }

    /** Returns the address of vftable[0]; vftable[-1] holds the COL. */
    vftable(col: number): number {
        const p = this.alloc(12);
        this.dv.setUint32(p, col, true);
        return p + 4;
    }

    /** Object subobject at obj+off gets the given vftable pointer. */
    object(size: number): number {
        return this.alloc(size);
    }
}

function cast(b: RttiBuilder, inptr: number, srcTd: number, targetTd: number, vfDelta = 0): number | null {
    return rtDynamicCast(b.mem, [inptr, vfDelta, srcTd, targetTd, 0]);
}

describe("rtDynamicCast — single inheritance", () => {
    // class A; class B : public A; class D : public B — complete object is D
    function buildSi(targetAttrs = { d: 0, b: 0, a: 0 }) {
        const b = new RttiBuilder();
        const tdD = b.typeDesc(".?AVD@@");
        const tdB = b.typeDesc(".?AVB@@");
        const tdA = b.typeDesc(".?AVA@@");
        const chd = b.chd(0, [
            b.bcd(tdD, 2, 0, targetAttrs.d),
            b.bcd(tdB, 1, 0, targetAttrs.b),
            b.bcd(tdA, 0, 0, targetAttrs.a),
        ]);
        const col = b.col(0, tdD, chd);
        const vft = b.vftable(col);
        const obj = b.object(16);
        b.dv.setUint32(obj, vft, true);
        return { b, tdD, tdB, tdA, obj };
    }

    test("downcast B* -> D* succeeds", () => {
        const { b, tdD, tdB, obj } = buildSi();
        expect(cast(b, obj, tdB, tdD)).toBe(obj);
    });

    test("runtime upcast D* -> B* succeeds (source type is irrelevant in SI)", () => {
        const { b, tdD, tdB, obj } = buildSi();
        expect(cast(b, obj, tdD, tdB)).toBe(obj);
    });

    test("same-type cast D* -> D* succeeds", () => {
        const { b, tdD, obj } = buildSi();
        expect(cast(b, obj, tdD, tdD)).toBe(obj);
    });

    test("cast to unrelated type fails", () => {
        const { b, tdB, obj } = buildSi();
        const tdU = b.typeDesc(".?AVU@@");
        expect(cast(b, obj, tdB, tdU)).toBeNull();
    });

    test("cast to a NOTVISIBLE target fails", () => {
        const { b, tdD, tdA, obj } = buildSi({ d: 0, b: 0, a: BCD_NOTVISIBLE });
        expect(cast(b, obj, tdD, tdA)).toBeNull();
    });

    test("type descriptors match by mangled name across duplicated instances", () => {
        const { b, tdD, tdB, obj } = buildSi();
        const tdD2 = b.typeDesc(".?AVD@@"); // same name, different address (other-module dup)
        expect(cast(b, obj, tdB, tdD2)).toBe(obj);
        expect(tdD2).not.toBe(tdD);
    });
});

describe("rtDynamicCast — multiple inheritance", () => {
    // class D : public B1, public B2 — B2 subobject at +8
    function buildMi() {
        const b = new RttiBuilder();
        const tdD = b.typeDesc(".?AVD@@");
        const tdB1 = b.typeDesc(".?AVB1@@");
        const tdB2 = b.typeDesc(".?AVB2@@");
        const chd = b.chd(CHD_MULTINH, [
            b.bcd(tdD, 2, 0),
            b.bcd(tdB1, 0, 0),
            b.bcd(tdB2, 0, 8),
        ]);
        const obj = b.object(16);
        b.dv.setUint32(obj, b.vftable(b.col(0, tdD, chd)), true);      // D/B1 vfptr
        b.dv.setUint32(obj + 8, b.vftable(b.col(8, tdD, chd)), true);  // B2 vfptr
        return { b, tdD, tdB1, tdB2, obj };
    }

    test("downcast B2* -> D* adjusts back to the complete object", () => {
        const { b, tdD, tdB2, obj } = buildMi();
        expect(cast(b, obj + 8, tdB2, tdD)).toBe(obj);
    });

    test("cross-cast B1* -> B2* lands on the sibling subobject", () => {
        const { b, tdB1, tdB2, obj } = buildMi();
        expect(cast(b, obj, tdB1, tdB2)).toBe(obj + 8);
    });

    test("downcast fails to unrelated type", () => {
        const { b, tdB2, obj } = buildMi();
        const tdU = b.typeDesc(".?AVU@@");
        expect(cast(b, obj + 8, tdB2, tdU)).toBeNull();
    });
});

describe("rtDynamicCast — virtual inheritance", () => {
    // Hand-crafted shape: virtual base V (single instance at +16) reachable
    // from two B instances at different offsets → ambiguous V* -> B*.
    test("ambiguous downcast (two target instances at different offsets) fails", () => {
        const b = new RttiBuilder();
        const tdD = b.typeDesc(".?AVD@@");
        const tdB = b.typeDesc(".?AVB@@");
        const tdV = b.typeDesc(".?AVV@@");
        const chd = b.chd(CHD_MULTINH | CHD_VIRTINH, [
            b.bcd(tdD, 4, 0),
            b.bcd(tdB, 1, 0),
            b.bcd(tdV, 0, 16),
            b.bcd(tdB, 1, 8),
            b.bcd(tdV, 0, 16),
        ]);
        const obj = b.object(24);
        b.dv.setUint32(obj + 16, b.vftable(b.col(16, tdD, chd)), true); // V vfptr
        expect(cast(b, obj + 16, tdV, tdB)).toBeNull();
    });

    test("unambiguous downcast V* -> B* succeeds", () => {
        const b = new RttiBuilder();
        const tdD = b.typeDesc(".?AVD@@");
        const tdB = b.typeDesc(".?AVB@@");
        const tdV = b.typeDesc(".?AVV@@");
        const chd = b.chd(CHD_MULTINH | CHD_VIRTINH, [
            b.bcd(tdD, 2, 0),
            b.bcd(tdB, 1, 4),
            b.bcd(tdV, 0, 16),
        ]);
        const obj = b.object(24);
        b.dv.setUint32(obj + 16, b.vftable(b.col(16, tdD, chd)), true);
        expect(cast(b, obj + 16, tdV, tdB)).toBe(obj + 4);
    });

    test("pmdToOffset resolves virtual displacement through the vbtable", () => {
        const b = new RttiBuilder();
        const tdD = b.typeDesc(".?AVD@@");
        const tdV = b.typeDesc(".?AVV@@");
        // V located via vbtable: pdisp=4 (vbptr at obj+4), vdisp=4, mdisp=0
        const chd = b.chd(CHD_MULTINH | CHD_VIRTINH, [
            b.bcd(tdD, 1, 0),
            b.bcd(tdV, 0, 0, 0, 4, 4),
        ]);
        const obj = b.object(32);
        const vbtable = b.alloc(8);
        b.dv.setUint32(obj + 4, vbtable, true);
        b.dv.setInt32(vbtable + 4, 12, true); // V subobject at 4 + 12 = obj+16
        b.dv.setUint32(obj + 16, b.vftable(b.col(16, tdD, chd)), true);
        expect(cast(b, obj + 16, tdV, tdD)).toBe(obj);
    });
});

describe("rtDynamicCast — vfDelta", () => {
    test("nonzero vfDelta recovers the source subobject offset in MI", () => {
        // Source subobject at +8 whose vfptr sits 4 bytes inside it (vfDelta=4):
        // compiler passes inptr = subobject+4; runtime must still match srcOffset 8.
        const b = new RttiBuilder();
        const tdD = b.typeDesc(".?AVD@@");
        const tdB = b.typeDesc(".?AVB@@");
        const chd = b.chd(CHD_MULTINH, [
            b.bcd(tdD, 1, 0),
            b.bcd(tdB, 0, 8),
        ]);
        const obj = b.object(24);
        b.dv.setUint32(obj + 12, b.vftable(b.col(12, tdD, chd)), true); // vfptr at subobject+4
        expect(cast(b, obj + 12, tdB, tdD, 4)).toBe(obj);
    });
});
