/**
 * Image decode for D3DX texture loaders (PNG/JPEG/BMP/DDS/TGA).
 */

import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';
import type { SurfaceFormat } from '../ddraw/com-objects';
import { asBlobPart, asArrayBufferView } from '../../../dom-buffer';
import {
    D3DFMT_A1R5G5B5,
    D3DFMT_A4R4G4B4,
    D3DFMT_A8,
    D3DFMT_A8B8G8R8,
    D3DFMT_A8L8,
    D3DFMT_A8P8,
    D3DFMT_A8R8G8B8,
    D3DFMT_ATI1,
    D3DFMT_ATI2,
    D3DFMT_BC4S,
    D3DFMT_BC4U,
    D3DFMT_BC5S,
    D3DFMT_BC5U,
    D3DFMT_DXT1,
    D3DFMT_DXT2,
    D3DFMT_DXT3,
    D3DFMT_DXT4,
    D3DFMT_DXT5,
    D3DFMT_G16R16,
    D3DFMT_L8,
    D3DFMT_R5G6B5,
    D3DFMT_X8R8G8B8,
    DDPF_ALPHAPIXELS,
    DDPF_FOURCC,
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    decodeD3DTextureToRgba8,
    decodeSurfaceFormatToRgba8,
    getSurfaceFormatLayout,
} from '../../backends/webgpu/shared/texture-formats';

export type DecodedImage = {
    width: number;
    height: number;
    rgba: Uint8Array;
    mipLevels: number;
};

export type ImageInfo = {
    width: number;
    height: number;
    mipLevels: number;
};

const DDS_MAGIC = 0x20534444; // "DDS "
const DDS_HEADER_SIZE = 124;
const DDS_PIXELFORMAT_SIZE = 32;
const DDSD_PITCH = 0x00000008;
const DDPF_ALPHA = 0x00000002;
const DDPF_LUMINANCE = 0x00020000;
const FOURCC_DX10 = 0x30315844; // "DX10"

// DXGI_FORMAT values used by DDS DX10 headers. We decode the first 2D
// subresource; cube/array/volume variants are accepted as first-slice images.
const DXGI_FORMAT_R8G8B8A8_UNORM = 28;
const DXGI_FORMAT_R8G8B8A8_UNORM_SRGB = 29;
const DXGI_FORMAT_R16G16_UNORM = 35;
const DXGI_FORMAT_BC1_TYPELESS = 70;
const DXGI_FORMAT_BC1_UNORM = 71;
const DXGI_FORMAT_BC1_UNORM_SRGB = 72;
const DXGI_FORMAT_BC2_TYPELESS = 73;
const DXGI_FORMAT_BC2_UNORM = 74;
const DXGI_FORMAT_BC2_UNORM_SRGB = 75;
const DXGI_FORMAT_BC3_TYPELESS = 76;
const DXGI_FORMAT_BC3_UNORM = 77;
const DXGI_FORMAT_BC3_UNORM_SRGB = 78;
const DXGI_FORMAT_BC4_TYPELESS = 79;
const DXGI_FORMAT_BC4_UNORM = 80;
const DXGI_FORMAT_BC4_SNORM = 81;
const DXGI_FORMAT_BC5_TYPELESS = 82;
const DXGI_FORMAT_BC5_UNORM = 83;
const DXGI_FORMAT_BC5_SNORM = 84;
const DXGI_FORMAT_B5G6R5_UNORM = 85;
const DXGI_FORMAT_B5G5R5A1_UNORM = 86;
const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
const DXGI_FORMAT_B8G8R8X8_UNORM = 88;
const DXGI_FORMAT_B8G8R8A8_UNORM_SRGB = 91;
const DXGI_FORMAT_B8G8R8X8_UNORM_SRGB = 93;
const DXGI_FORMAT_B4G4R4A4_UNORM = 115;

function readU16LE(data: Uint8Array, offset: number): number {
    return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readU32LE(data: Uint8Array, offset: number): number {
    return (
        (data[offset] ?? 0) |
        ((data[offset + 1] ?? 0) << 8) |
        ((data[offset + 2] ?? 0) << 16) |
        ((data[offset + 3] ?? 0) << 24)
    ) >>> 0;
}

function readU16BE(data: Uint8Array, offset: number): number {
    return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

function readU32BE(data: Uint8Array, offset: number): number {
    return (
        ((data[offset] ?? 0) << 24) |
        ((data[offset + 1] ?? 0) << 16) |
        ((data[offset + 2] ?? 0) << 8) |
        (data[offset + 3] ?? 0)
    ) >>> 0;
}

function ddsFourCCToD3DFormat(fourCC: number): number {
    switch (fourCC >>> 0) {
        case D3DFMT_DXT1:
        case D3DFMT_DXT2:
        case D3DFMT_DXT3:
        case D3DFMT_DXT4:
        case D3DFMT_DXT5:
        case D3DFMT_ATI1:
        case D3DFMT_ATI2:
        case D3DFMT_BC4U:
        case D3DFMT_BC4S:
        case D3DFMT_BC5U:
        case D3DFMT_BC5S:
            return fourCC >>> 0;
        default:
            return 0;
    }
}

function dxgiFormatToD3DFormat(dxgiFormat: number): number {
    switch (dxgiFormat) {
        case DXGI_FORMAT_R8G8B8A8_UNORM:
        case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
            return D3DFMT_A8B8G8R8;
        case DXGI_FORMAT_B8G8R8A8_UNORM:
        case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
            return D3DFMT_A8R8G8B8;
        case DXGI_FORMAT_B8G8R8X8_UNORM:
        case DXGI_FORMAT_B8G8R8X8_UNORM_SRGB:
            return D3DFMT_X8R8G8B8;
        case DXGI_FORMAT_B5G6R5_UNORM:
            return D3DFMT_R5G6B5;
        case DXGI_FORMAT_B5G5R5A1_UNORM:
            return D3DFMT_A1R5G5B5;
        case DXGI_FORMAT_B4G4R4A4_UNORM:
            return D3DFMT_A4R4G4B4;
        case DXGI_FORMAT_R16G16_UNORM:
            return D3DFMT_G16R16;
        case DXGI_FORMAT_BC1_TYPELESS:
        case DXGI_FORMAT_BC1_UNORM:
        case DXGI_FORMAT_BC1_UNORM_SRGB:
            return D3DFMT_DXT1;
        case DXGI_FORMAT_BC2_TYPELESS:
        case DXGI_FORMAT_BC2_UNORM:
        case DXGI_FORMAT_BC2_UNORM_SRGB:
            return D3DFMT_DXT3;
        case DXGI_FORMAT_BC3_TYPELESS:
        case DXGI_FORMAT_BC3_UNORM:
        case DXGI_FORMAT_BC3_UNORM_SRGB:
            return D3DFMT_DXT5;
        case DXGI_FORMAT_BC4_TYPELESS:
        case DXGI_FORMAT_BC4_UNORM:
            return D3DFMT_BC4U;
        case DXGI_FORMAT_BC4_SNORM:
            return D3DFMT_BC4S;
        case DXGI_FORMAT_BC5_TYPELESS:
        case DXGI_FORMAT_BC5_UNORM:
            return D3DFMT_BC5U;
        case DXGI_FORMAT_BC5_SNORM:
            return D3DFMT_BC5S;
        default:
            return 0;
    }
}

function decodeDDS(data: Uint8Array): { width: number; height: number; rgba: Uint8Array; mipLevels: number } | null {
    if (data.length < 128 || readU32LE(data, 0) !== DDS_MAGIC) return null;
    if (readU32LE(data, 4) !== DDS_HEADER_SIZE || readU32LE(data, 76) !== DDS_PIXELFORMAT_SIZE) return null;

    const flags = readU32LE(data, 8);
    const height = readU32LE(data, 12);
    const width = readU32LE(data, 16);
    const pitchOrLinearSize = readU32LE(data, 20);
    const mipMapCount = readU32LE(data, 28);
    const pfFlags = readU32LE(data, 80);
    const fourCC = readU32LE(data, 84);
    const bpp = readU32LE(data, 88);
    const rMask = readU32LE(data, 92);
    const gMask = readU32LE(data, 96);
    const bMask = readU32LE(data, 100);
    const aMask = readU32LE(data, 104);
    let dataOffset = 128;

    if (width <= 0 || height <= 0 || dataOffset >= data.length) return null;

    let palette: Uint32Array | undefined;
    if ((pfFlags & DDPF_PALETTEINDEXED8) !== 0) {
        if (data.length < dataOffset + 256 * 4) return null;
        palette = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            const p = dataOffset + i * 4;
            const r = data[p] ?? 0;
            const g = data[p + 1] ?? 0;
            const b = data[p + 2] ?? 0;
            palette[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
        dataOffset += 256 * 4;
    }

    if (dataOffset >= data.length) return null;

    if ((pfFlags & DDPF_FOURCC) !== 0) {
        let format = ddsFourCCToD3DFormat(fourCC);
        if (fourCC === FOURCC_DX10) {
            if (data.length < 148) return null;
            const dxgiFormat = readU32LE(data, 128);
            format = dxgiFormatToD3DFormat(dxgiFormat);
            dataOffset = 148;
        }
        if (!format) return null;
        if (dataOffset >= data.length) return null;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, format),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if ((pfFlags & DDPF_LUMINANCE) !== 0) {
        const format = bpp === 16 && aMask ? D3DFMT_A8L8 : D3DFMT_L8;
        const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
            ? pitchOrLinearSize
            : getSurfaceFormatLayout({ flags: 0, bpp, rMask: 0, gMask: 0, bMask: 0, aMask }, width, height).pitch;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, format, { pitch }),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if ((pfFlags & DDPF_ALPHA) !== 0 && bpp === 8 && (pfFlags & DDPF_RGB) === 0) {
        const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
            ? pitchOrLinearSize
            : width;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, D3DFMT_A8, { pitch }),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if ((pfFlags & DDPF_PALETTEINDEXED8) !== 0 && bpp === 16) {
        const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
            ? pitchOrLinearSize
            : width * 2;
        return {
            width,
            height,
            rgba: decodeD3DTextureToRgba8(data, dataOffset, width, height, D3DFMT_A8P8, { pitch, palette }),
            mipLevels: Math.max(1, mipMapCount || 1),
        };
    }

    if (bpp !== 8 && bpp !== 16 && bpp !== 24 && bpp !== 32) return null;
    if ((pfFlags & (DDPF_RGB | DDPF_ALPHA | DDPF_PALETTEINDEXED8)) === 0) return null;

    const format: SurfaceFormat = {
        flags: pfFlags,
        bpp,
        rMask,
        gMask,
        bMask,
        aMask: (pfFlags & (DDPF_ALPHAPIXELS | DDPF_ALPHA)) !== 0 ? aMask : 0,
    };
    const pitch = (flags & DDSD_PITCH) && pitchOrLinearSize > 0
        ? pitchOrLinearSize
        : getSurfaceFormatLayout(format, width, height).pitch;

    return {
        width,
        height,
        rgba: decodeSurfaceFormatToRgba8(data, dataOffset, width, height, pitch, format, undefined, undefined, palette),
        mipLevels: Math.max(1, mipMapCount || 1),
    };
}

function decodeTGA(data: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
    if (data.length < 18) return null;

    const idLength = data[0];
    const colorMapType = data[1];
    const imageType = data[2];
    const colorMapFirst = readU16LE(data, 3);
    const colorMapLength = readU16LE(data, 5);
    const colorMapBpp = data[7];
    const width = readU16LE(data, 12);
    const height = readU16LE(data, 14);
    const bpp = data[16];
    const descriptor = data[17];
    const topDown = (descriptor & 0x20) !== 0;
    const rightToLeft = (descriptor & 0x10) !== 0;
    const alphaBits = descriptor & 0x0f;
    const isColorMapped = imageType === 1 || imageType === 9;
    const isTrueColor = imageType === 2 || imageType === 10;
    const isGrayscale = imageType === 3 || imageType === 11;
    const isRLE = imageType === 9 || imageType === 10 || imageType === 11;

    if (width <= 0 || height <= 0) return null;
    if (!isColorMapped && !isTrueColor && !isGrayscale) return null;
    if (isColorMapped && colorMapType !== 1) return null;
    if (!isColorMapped && colorMapType !== 0) return null;
    if (isTrueColor && bpp !== 15 && bpp !== 16 && bpp !== 24 && bpp !== 32) return null;
    if (isGrayscale && bpp !== 8 && bpp !== 16) return null;
    if (isColorMapped && bpp !== 8 && bpp !== 16) return null;

    const colorMapBytesPerEntry = colorMapType ? Math.ceil(colorMapBpp / 8) : 0;
    const colorMapBytes = colorMapLength * colorMapBytesPerEntry;
    const pixelBytes = Math.ceil(bpp / 8);
    const rgba = new Uint8Array(width * height * 4);
    let src = 18 + idLength + colorMapBytes;

    const palette: Uint32Array | null = isColorMapped ? new Uint32Array(colorMapFirst + colorMapLength) : null;
    if (palette) {
        let p = 18 + idLength;
        for (let i = 0; i < colorMapLength; i++) {
            const c = readTgaColor(data, p, colorMapBpp, colorMapBpp === 16 ? 1 : 0);
            palette[colorMapFirst + i] = (c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
            p += colorMapBytesPerEntry;
        }
    }

    function writePixel(pixel: number, r: number, g: number, b: number, a: number): void {
        const logicalRow = Math.floor(pixel / width);
        const logicalCol = pixel % width;
        const row = topDown ? logicalRow : (height - 1 - logicalRow);
        const col = rightToLeft ? (width - 1 - logicalCol) : logicalCol;
        const dst = (row * width + col) * 4;
        rgba[dst] = r;
        rgba[dst + 1] = g;
        rgba[dst + 2] = b;
        rgba[dst + 3] = a;
    }

    const readPixel = (): [number, number, number, number] => {
        if (isColorMapped) {
            const idx = bpp === 16 ? readU16LE(data, src) : (data[src] ?? 0);
            src += pixelBytes;
            const raw = palette?.[idx] ?? 0xff000000;
            return [raw & 0xff, (raw >>> 8) & 0xff, (raw >>> 16) & 0xff, (raw >>> 24) & 0xff];
        }
        if (isGrayscale) {
            const l = data[src] ?? 0;
            const a = bpp === 16 ? (data[src + 1] ?? 255) : 255;
            src += pixelBytes;
            return [l, l, l, a];
        }
        const c = readTgaColor(data, src, bpp, alphaBits);
        src += pixelBytes;
        return c;
    };

    if (!isRLE) {
        for (let pixel = 0; pixel < width * height && src < data.length; pixel++) {
            const c = readPixel();
            writePixel(pixel, c[0], c[1], c[2], c[3]);
        }
    } else {
        let pixel = 0;
        while (pixel < width * height && src < data.length) {
            const packet = data[src++];
            const count = (packet & 0x7f) + 1;
            const packetIsRLE = (packet & 0x80) !== 0;

            if (packetIsRLE) {
                const c = readPixel();
                for (let j = 0; j < count && pixel < width * height; j++, pixel++) {
                    writePixel(pixel, c[0], c[1], c[2], c[3]);
                }
            } else {
                for (let j = 0; j < count && pixel < width * height; j++, pixel++) {
                    const c = readPixel();
                    writePixel(pixel, c[0], c[1], c[2], c[3]);
                }
            }
        }
    }

    return { width, height, rgba };
}

function readTgaColor(data: Uint8Array, offset: number, bpp: number, alphaBits: number = 0): [number, number, number, number] {
    if (bpp === 16 || bpp === 15) {
        const raw = readU16LE(data, offset);
        return [
            ((raw >>> 10) & 0x1f) * 255 / 31 | 0,
            ((raw >>> 5) & 0x1f) * 255 / 31 | 0,
            (raw & 0x1f) * 255 / 31 | 0,
            bpp === 16 && alphaBits > 0 && (raw & 0x8000) === 0 ? 0 : 255,
        ];
    }
    return [
        data[offset + 2] ?? 0,
        data[offset + 1] ?? 0,
        data[offset] ?? 0,
        bpp === 32 ? (data[offset + 3] ?? 255) : 255,
    ];
}

async function imageBitmapFromRGBA(rgba: Uint8Array, width: number, height: number): Promise<ImageBitmap> {
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return createImageBitmap(new ImageData(asArrayBufferView(clamped), width, height));
}

async function rgbaFromImageBitmap(bitmap: ImageBitmap): Promise<Uint8Array> {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
}

function computeMipLevels(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * Read only the container header needed by D3DXGetImageInfo*. This deliberately
 * avoids createImageBitmap, canvas readback and full DDS/TGA pixel expansion.
 */
export function readImageInfoBytes(data: Uint8Array): ImageInfo | null {
    let width = 0;
    let height = 0;
    let mipLevels = 0;

    if (data.length >= 24
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
        && data[12] === 0x49 && data[13] === 0x48 && data[14] === 0x44 && data[15] === 0x52) {
        width = readU32BE(data, 16);
        height = readU32BE(data, 20);
    } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
        let pos = 2;
        while (pos + 3 < data.length) {
            while (pos < data.length && data[pos] !== 0xff) pos++;
            while (pos < data.length && data[pos] === 0xff) pos++;
            if (pos >= data.length) break;
            const marker = data[pos++];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (marker === 0xd9 || marker === 0xda || pos + 1 >= data.length) break;
            const segmentLength = readU16BE(data, pos);
            if (segmentLength < 2 || pos + segmentLength > data.length) return null;
            const isSof = (marker >= 0xc0 && marker <= 0xc3)
                || (marker >= 0xc5 && marker <= 0xc7)
                || (marker >= 0xc9 && marker <= 0xcb)
                || (marker >= 0xcd && marker <= 0xcf);
            if (isSof) {
                if (segmentLength < 7) return null;
                height = readU16BE(data, pos + 3);
                width = readU16BE(data, pos + 5);
                break;
            }
            pos += segmentLength;
        }
    } else if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
        const dibSize = readU32LE(data, 14);
        if (dibSize === 12) {
            width = readU16LE(data, 18);
            height = readU16LE(data, 20);
        } else if (dibSize >= 40 && data.length >= 26) {
            width = Math.abs(readU32LE(data, 18) | 0);
            height = Math.abs(readU32LE(data, 22) | 0);
        }
    } else if (data.length >= 128 && readU32LE(data, 0) === DDS_MAGIC
        && readU32LE(data, 4) === DDS_HEADER_SIZE && readU32LE(data, 76) === DDS_PIXELFORMAT_SIZE) {
        height = readU32LE(data, 12);
        width = readU32LE(data, 16);
        mipLevels = Math.max(1, readU32LE(data, 28) || 1);
    } else if (data.length >= 18) {
        const colorMapType = data[1];
        const imageType = data[2];
        const bpp = data[16];
        const isColorMapped = imageType === 1 || imageType === 9;
        const isTrueColor = imageType === 2 || imageType === 10;
        const isGrayscale = imageType === 3 || imageType === 11;
        const formatOk = (isColorMapped && (bpp === 8 || bpp === 16))
            || (isTrueColor && (bpp === 15 || bpp === 16 || bpp === 24 || bpp === 32))
            || (isGrayscale && (bpp === 8 || bpp === 16));
        if (formatOk && colorMapType === (isColorMapped ? 1 : 0)) {
            width = readU16LE(data, 12);
            height = readU16LE(data, 14);
        }
    }

    if (width <= 0 || height <= 0) return null;
    return { width, height, mipLevels: mipLevels || computeMipLevels(width, height) };
}

export async function decodeImageBytes(data: Uint8Array): Promise<DecodedImage | null> {
    try {
        let width: number;
        let height: number;
        let rgba: Uint8Array;

        if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
            const bitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: 'image/png' }));
            width = bitmap.width;
            height = bitmap.height;
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        } else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
            const bitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: 'image/jpeg' }));
            width = bitmap.width;
            height = bitmap.height;
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        } else if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
            const bitmap = await createImageBitmap(new Blob([asBlobPart(data)], { type: 'image/bmp' }));
            width = bitmap.width;
            height = bitmap.height;
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        } else if (data.length >= 4 && readU32LE(data, 0) === DDS_MAGIC) {
            const dds = decodeDDS(data);
            if (!dds) return null;
            width = dds.width;
            height = dds.height;
            rgba = dds.rgba;
            return {
                width,
                height,
                rgba,
                mipLevels: dds.mipLevels,
            };
        } else {
            const tga = decodeTGA(data);
            if (!tga) return null;
            width = tga.width;
            height = tga.height;
            const bitmap = await imageBitmapFromRGBA(tga.rgba, width, height);
            rgba = await rgbaFromImageBitmap(bitmap);
            bitmap.close();
        }

        return {
            width,
            height,
            rgba,
            mipLevels: computeMipLevels(width, height),
        };
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `d3dx9: image decode failed: ${e}`);
        return null;
    }
}

export async function loadImageFromVfs(path: string): Promise<DecodedImage | null> {
    const vfs = System.getInstance().fileSystem;
    const normalized = path.replace(/\\/g, '/');
    const fh = await vfs.open(normalized, 0x80000000, 3);
    if (!fh) {
        Logger.warn(LogCategory.SYSTEM, `d3dx9: file not found "${normalized}"`);
        return null;
    }
    const size = vfs.getFileSize(normalized);
    if (size <= 0) return null;
    const data = await vfs.read(fh, size);
    return decodeImageBytes(data);
}

export async function loadImageInfoFromVfs(path: string): Promise<ImageInfo | null> {
    const vfs = System.getInstance().fileSystem;
    const normalized = path.replace(/\\/g, '/');
    const fh = await vfs.open(normalized, 0x80000000, 3);
    if (!fh) return null;
    const size = vfs.getFileSize(normalized);
    if (size <= 0) return null;
    return readImageInfoBytes(await vfs.read(fh, size));
}
