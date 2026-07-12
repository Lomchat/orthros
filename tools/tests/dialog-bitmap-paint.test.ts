/**
 * Unit tests for dialog bitmap/icon resolve + layout helpers.
 */
import { describe, expect, test } from 'bun:test';
import { layoutStaticControlImage } from '../../src/worker/modules/gdi32/bitmap-resolve';
import { decodeIconResource } from '../../src/worker/modules/kernel32/icon-extractor';

const SS_CENTERIMAGE = 0x0200;

describe('layoutStaticControlImage', () => {
    test('SS_BITMAP default stretches to control client rect', () => {
        const r = layoutStaticControlImage(10, 20, 100, 80, 200, 150, 0, SS_CENTERIMAGE);
        expect(r.mode).toBe('stretch');
        expect(r.x).toBe(10);
        expect(r.y).toBe(20);
        expect(r.w).toBe(100);
        expect(r.h).toBe(80);
    });

    test('SS_CENTERIMAGE draws 1:1 centered in control', () => {
        const r = layoutStaticControlImage(0, 0, 100, 100, 40, 30, SS_CENTERIMAGE, SS_CENTERIMAGE);
        expect(r.mode).toBe('center');
        expect(r.x).toBe(30);
        expect(r.y).toBe(35);
        expect(r.w).toBe(40);
        expect(r.h).toBe(30);
    });
});

describe('decodeIconResource', () => {
    test('returns null for truncated data', () => {
        expect(decodeIconResource(new Uint8Array(10))).toBeNull();
    });

    test('decodes minimal 1x1 32bpp icon', () => {
        const biSize = 40;
        const w = 1;
        const h = 1;
        const total = biSize + 4 + 4;
        const data = new Uint8Array(total);
        const view = new DataView(data.buffer);
        view.setUint32(0, biSize, true);
        view.setInt32(4, w, true);
        view.setInt32(8, h * 2, true);
        view.setUint16(14, 32, true);
        data[biSize] = 128;
        data[biSize + 3] = 255;
        const decoded = decodeIconResource(data);
        expect(decoded).not.toBeNull();
        expect(decoded!.width).toBe(1);
        expect(decoded!.height).toBe(1);
        expect(decoded!.pixels[2]).toBe(128);
    });
});
