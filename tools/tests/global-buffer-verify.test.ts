import { describe, expect, test } from 'bun:test';
import { verifyGlobalBuffer } from '../../src/worker/core/diagnostics/global-buffer-verify';

describe('verifyGlobalBuffer', () => {
    test('detects all-zero buffer', () => {
        const r = verifyGlobalBuffer(new Uint8Array(64));
        expect(r.allZero).toBe(true);
        expect(r.details).toContain('all-zero');
    });

    test('parses raw DIB BITMAPINFOHEADER', () => {
        const buf = new Uint8Array(64);
        buf[0] = 0x28; // biSize=40
        buf[4] = 0x9c; // width 156
        buf[8] = 0x88;
        buf[9] = 0x08; // height 2184
        buf[14] = 0x18; // 24bpp
        const r = verifyGlobalBuffer(buf);
        expect(r.magic).toBe('DIB');
        expect(r.details).toContain('156x2184');
        expect(r.details).toContain('bpp=24');
    });

    test('parses BMP file header fields', () => {
        const buf = new Uint8Array(64);
        buf[0] = 0x42;
        buf[1] = 0x4d;
        buf[2] = 0xaa;
        buf[3] = 0x0f;
        buf[4] = 0x10;
        buf[5] = 0x00;
        buf[18] = 0x80;
        buf[19] = 0x02;
        buf[22] = 0xe0;
        buf[23] = 0x01;
        buf[28] = 0x08;
        const r = verifyGlobalBuffer(buf);
        expect(r.magic).toBe('BM');
        expect(r.details).toContain('640x480');
        expect(r.details).toContain('bpp=8');
        expect(r.allZero).toBe(false);
    });
});
