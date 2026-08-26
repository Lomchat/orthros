import { describe, expect, test } from "bun:test";
import { textOut } from "../../src/worker/modules/gdi32/gdi-text";

function fixture() {
    let syncs = 0;
    const canvas: Record<string, unknown> = {};
    const ctx = {
        canvas,
        font: "",
        fillStyle: "",
        textBaseline: "",
        textAlign: "",
        fillText() {},
        fillRect() {},
        measureText() { return { width: 12 }; },
    };
    const state = {
        font: "12px sans-serif",
        appliedFont: "",
        textColor: "#fff",
        appliedFillStyle: "",
        textEscapement: 0,
        bkMode: 1,
        bkColor: "#000",
        fontSize: 12,
    };
    const gdi = {
        contexts: new Map([[1, ctx]]),
        hdcStates: new Map([[1, state]]),
        overlayCtx: null,
        setOverlayDirty() {},
        expandDirtyRect() {},
        markDirty() {},
        invalidateImageDataCache() {},
        syncSelectedDibBits() { syncs++; return true; },
    };
    return { gdi, getSyncs: () => syncs };
}

describe("GDI text DIB commits", () => {
    test("TextOut commits immediately by default", () => {
        const f = fixture();
        expect(textOut(f.gdi as never, 1, 2, 3, "A")).toBe(true);
        expect(f.getSyncs()).toBe(1);
    });

    test("ExtTextOut can batch glyphs behind one API-boundary commit", () => {
        const f = fixture();
        expect(textOut(f.gdi as never, 1, 2, 3, "A", false)).toBe(true);
        expect(textOut(f.gdi as never, 1, 14, 3, "B", false)).toBe(true);
        expect(f.getSyncs()).toBe(0);
        f.gdi.syncSelectedDibBits();
        expect(f.getSyncs()).toBe(1);
    });
});
