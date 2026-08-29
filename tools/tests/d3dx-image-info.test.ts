import { describe, expect, it } from 'bun:test';
import { readImageInfoBytes } from '../../src/worker/modules/d3dx9/image-decode';

function u16be(data: Uint8Array, at: number, value: number): void {
    data[at] = value >>> 8;
    data[at + 1] = value;
}

function u32le(data: Uint8Array, at: number, value: number): void {
    new DataView(data.buffer).setUint32(at, value >>> 0, true);
}

function u32be(data: Uint8Array, at: number, value: number): void {
    new DataView(data.buffer).setUint32(at, value >>> 0, false);
}

describe('D3DX header-only image info', () => {
    it('reads PNG IHDR without decoding pixels', () => {
        const png = new Uint8Array(24);
        png.set([0x89, 0x50, 0x4e, 0x47], 0);
        png.set([0x49, 0x48, 0x44, 0x52], 12);
        u32be(png, 16, 1024);
        u32be(png, 20, 512);
        expect(readImageInfoBytes(png)).toEqual({ width: 1024, height: 512, mipLevels: 11 });
    });

    it('walks JPEG markers to a SOF dimensions record', () => {
        const jpeg = new Uint8Array(32);
        jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8], 0);
        u16be(jpeg, 13, 600);
        u16be(jpeg, 15, 800);
        expect(readImageInfoBytes(jpeg)).toEqual({ width: 800, height: 600, mipLevels: 10 });
    });

    it('reads top-down BMP, DDS mip count and TGA headers', () => {
        const bmp = new Uint8Array(54);
        bmp.set([0x42, 0x4d], 0);
        u32le(bmp, 14, 40);
        u32le(bmp, 18, 320);
        u32le(bmp, 22, -200);
        expect(readImageInfoBytes(bmp)).toEqual({ width: 320, height: 200, mipLevels: 9 });

        const dds = new Uint8Array(128);
        u32le(dds, 0, 0x20534444);
        u32le(dds, 4, 124);
        u32le(dds, 12, 256);
        u32le(dds, 16, 512);
        u32le(dds, 28, 7);
        u32le(dds, 76, 32);
        expect(readImageInfoBytes(dds)).toEqual({ width: 512, height: 256, mipLevels: 7 });

        const tga = new Uint8Array(18);
        tga[2] = 2;
        tga[12] = 64;
        tga[14] = 32;
        tga[16] = 32;
        expect(readImageInfoBytes(tga)).toEqual({ width: 64, height: 32, mipLevels: 7 });
    });

    it('rejects malformed or dimensionless headers', () => {
        expect(readImageInfoBytes(new Uint8Array())).toBeNull();
        expect(readImageInfoBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 1]))).toBeNull();
    });
});
