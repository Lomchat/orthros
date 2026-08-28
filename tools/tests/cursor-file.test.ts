import { describe, expect, test } from "bun:test";
import { decodeWindowsCursor } from "../../src/worker/modules/user32/cursor-file";

function makeCursor(hotspotX = 1, hotspotY = 2): Uint8Array {
    const dibBytes = 40 + 16 + 8;
    const out = new Uint8Array(22 + dibBytes);
    const view = new DataView(out.buffer);
    view.setUint16(2, 2, true);
    view.setUint16(4, 1, true);
    out[6] = 2;
    out[7] = 2;
    view.setUint16(10, hotspotX, true);
    view.setUint16(12, hotspotY, true);
    view.setUint32(14, dibBytes, true);
    view.setUint32(18, 22, true);
    view.setUint32(22, 40, true);
    view.setInt32(26, 2, true);
    view.setInt32(30, 4, true);
    view.setUint16(34, 1, true);
    view.setUint16(36, 32, true);
    // Bottom row then top row, BGRA.
    out.set([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255], 62);
    return out;
}

function makeAni(cursor: Uint8Array): Uint8Array {
    const anihSize = 36;
    const listPayloadSize = 4 + 8 + cursor.length + (cursor.length & 1);
    const bodySize = 4 + (8 + anihSize) + (8 + 4) + (8 + listPayloadSize);
    const out = new Uint8Array(8 + bodySize);
    const view = new DataView(out.buffer);
    const cc = (offset: number, value: string) => {
        for (let i = 0; i < 4; i++) out[offset + i] = value.charCodeAt(i);
    };
    cc(0, "RIFF"); view.setUint32(4, bodySize, true); cc(8, "ACON");
    cc(12, "anih"); view.setUint32(16, anihSize, true); view.setUint32(48, 3, true);
    cc(56, "rate"); view.setUint32(60, 4, true); view.setUint32(64, 3, true);
    cc(68, "LIST"); view.setUint32(72, listPayloadSize, true); cc(76, "fram");
    cc(80, "icon"); view.setUint32(84, cursor.length, true); out.set(cursor, 88);
    return out;
}

describe("Windows cursor files", () => {
    test("decodes CUR pixels and hotspot", () => {
        const cursor = decodeWindowsCursor(makeCursor());
        expect(cursor?.frames).toHaveLength(1);
        expect(cursor?.frames[0]).toMatchObject({ width: 2, height: 2, hotspotX: 1, hotspotY: 2 });
        expect(Array.from(cursor!.frames[0]!.pixels.slice(0, 4))).toEqual([0, 0, 255, 255]);
    });

    test("decodes RIFF ACON frames and jiffy timing", () => {
        const cursor = decodeWindowsCursor(makeAni(makeCursor(0, 1)));
        expect(cursor?.sequence).toEqual([0]);
        expect(cursor?.delaysMs).toEqual([50]);
        expect(cursor?.frames[0]).toMatchObject({ hotspotX: 0, hotspotY: 1 });
    });

    test("rejects unrelated files", () => {
        expect(decodeWindowsCursor(new Uint8Array([1, 2, 3]))).toBeNull();
    });
});
