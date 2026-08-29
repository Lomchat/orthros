/**
 * Bridge helpers for D3DX9 HLE — surface copy, mip filtering, texture upload.
 */

import { resolveSurfaceInfo, resolveTextureInfo, surfaceMeta, D3D_OK, D3DERR_INVALIDCALL } from './resource-registry';
import { decodeD3DTextureToRgba8, d3dFormatBpp } from '../../backends/webgpu/shared/texture-formats';
import { D3DFMT_DXT1, decodeDxtToRgba, encodeRgbaToDxt1, isDxtFormat } from '../../backends/webgpu/shared/dxt';

const D3DX_FILTER_LINEAR = 3;

type Rect = { left: number; top: number; right: number; bottom: number };

function readRect(mem: Uint8Array, ptr: number, fullW: number, fullH: number): Rect {
    if (!ptr) return { left: 0, top: 0, right: fullW, bottom: fullH };
    if (ptr + 16 > mem.length) return { left: 0, top: 0, right: fullW, bottom: fullH };
    const view = new DataView(mem.buffer, mem.byteOffset + ptr, 16);
    return {
        left: view.getInt32(0, true),
        top: view.getInt32(4, true),
        right: view.getInt32(8, true),
        bottom: view.getInt32(12, true),
    };
}

function rectWidth(r: Rect): number {
    return Math.max(0, r.right - r.left);
}

function rectHeight(r: Rect): number {
    return Math.max(0, r.bottom - r.top);
}

function colorKeyMatch(pixelBgra: number, colorKey: number): boolean {
    if (colorKey === 0) return false;
    const ckB = colorKey & 0xff;
    const ckG = (colorKey >>> 8) & 0xff;
    const ckR = (colorKey >>> 16) & 0xff;
    const ckA = (colorKey >>> 24) & 0xff;
    const pB = pixelBgra & 0xff;
    const pG = (pixelBgra >>> 8) & 0xff;
    const pR = (pixelBgra >>> 16) & 0xff;
    const pA = (pixelBgra >>> 24) & 0xff;
    if (ckA !== 0 && pA !== ckA) return false;
    return pR === ckR && pG === ckG && pB === ckB;
}

function readPixelBgra(mem: Uint8Array, ptr: number): number {
    const view = new DataView(mem.buffer, mem.byteOffset + ptr, 4);
    return view.getUint32(0, true);
}

function writePixelBgra(mem: Uint8Array, ptr: number, pixel: number): void {
    const view = new DataView(mem.buffer, mem.byteOffset + ptr, 4);
    view.setUint32(0, pixel >>> 0, true);
}

function sampleBilinear(
    mem: Uint8Array,
    basePtr: number,
    pitch: number,
    x: number,
    y: number,
    maxW: number,
    maxH: number,
): number {
    const fx = Math.max(0, Math.min(maxW - 1, x));
    const fy = Math.max(0, Math.min(maxH - 1, y));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(maxW - 1, x0 + 1);
    const y1 = Math.min(maxH - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;

    const p00 = readPixelBgra(mem, basePtr + y0 * pitch + x0 * 4);
    const p10 = readPixelBgra(mem, basePtr + y0 * pitch + x1 * 4);
    const p01 = readPixelBgra(mem, basePtr + y1 * pitch + x0 * 4);
    const p11 = readPixelBgra(mem, basePtr + y1 * pitch + x1 * 4);

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const ch = (c0: number, c1: number, c2: number, c3: number, shift: number) => {
        const v0 = (c0 >>> shift) & 0xff;
        const v1 = (c1 >>> shift) & 0xff;
        const v2 = (c2 >>> shift) & 0xff;
        const v3 = (c3 >>> shift) & 0xff;
        const top = lerp(v0, v1, tx);
        const bot = lerp(v2, v3, tx);
        return Math.round(lerp(top, bot, ty));
    };

    const b = ch(p00, p10, p01, p11, 0);
    const g = ch(p00, p10, p01, p11, 8);
    const r = ch(p00, p10, p01, p11, 16);
    const a = ch(p00, p10, p01, p11, 24);
    return (a << 24) | (r << 16) | (g << 8) | b;
}

export function d3dxLoadSurfaceFromSurface(
    mem: Uint8Array,
    destSurface: number,
    destRectPtr: number,
    srcSurface: number,
    srcRectPtr: number,
    filter: number,
    colorKey: number,
): number {
    const dest = resolveSurfaceInfo(destSurface);
    const src = resolveSurfaceInfo(srcSurface);
    if (!dest || !src) return D3DERR_INVALIDCALL;

    const destRect = readRect(mem, destRectPtr, dest.width, dest.height);
    const srcRect = readRect(mem, srcRectPtr, src.width, src.height);
    const dw = rectWidth(destRect);
    const dh = rectHeight(destRect);
    const sw = rectWidth(srcRect);
    const sh = rectHeight(srcRect);
    if (dw === 0 || dh === 0 || sw === 0 || sh === 0) return D3D_OK;

    const destLock = dest.device.lockTexture(dest.texturePtr, dest.level);
    const srcLock = src.device.lockTexture(src.texturePtr, src.level);
    if (!destLock || !srcLock) {
        if (destLock) dest.device.unlockTexture(dest.texturePtr, dest.level, mem);
        if (srcLock) src.device.unlockTexture(src.texturePtr, src.level, mem);
        return D3DERR_INVALIDCALL;
    }

    const useLinear = filter === D3DX_FILTER_LINEAR;
    const srcBase = srcLock.ptr + srcRect.top * srcLock.pitch + srcRect.left * 4;
    const destBase = destLock.ptr + destRect.top * destLock.pitch + destRect.left * 4;

    for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
            const srcX = sw === dw ? x : (x * (sw - 1)) / Math.max(1, dw - 1);
            const srcY = sh === dh ? y : (y * (sh - 1)) / Math.max(1, dh - 1);
            let pixel: number;
            if (useLinear && (sw > 1 || sh > 1)) {
                pixel = sampleBilinear(mem, srcBase, srcLock.pitch, srcX, srcY, sw, sh);
            } else {
                const sx = Math.min(sw - 1, Math.round(srcX));
                const sy = Math.min(sh - 1, Math.round(srcY));
                pixel = readPixelBgra(mem, srcBase + sy * srcLock.pitch + sx * 4);
            }
            if (colorKeyMatch(pixel, colorKey)) continue;
            writePixelBgra(mem, destBase + y * destLock.pitch + x * 4, pixel);
        }
    }

    dest.device.unlockTexture(dest.texturePtr, dest.level, mem);
    src.device.unlockTexture(src.texturePtr, src.level, mem);
    return D3D_OK;
}

function writeEncodedPixel(
    mem: Uint8Array,
    ptr: number,
    format: number,
    r: number,
    g: number,
    b: number,
    a: number,
): boolean {
    switch (format >>> 0) {
        case 21: // D3DFMT_A8R8G8B8
        case 22: // D3DFMT_X8R8G8B8
            mem[ptr] = b;
            mem[ptr + 1] = g;
            mem[ptr + 2] = r;
            mem[ptr + 3] = format === 22 ? 0xff : a;
            return true;
        case 23: { // D3DFMT_R5G6B5
            const value = ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3);
            mem[ptr] = value & 0xff;
            mem[ptr + 1] = value >>> 8;
            return true;
        }
        case 24: // D3DFMT_X1R5G5B5
        case 25: { // D3DFMT_A1R5G5B5
            const alpha = format === 24 || a >= 128 ? 0x8000 : 0;
            const value = alpha | ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3);
            mem[ptr] = value & 0xff;
            mem[ptr + 1] = value >>> 8;
            return true;
        }
        case 26: // D3DFMT_A4R4G4B4
        case 27: { // D3DFMT_X4R4G4B4
            const alpha = format === 27 ? 0xf : a >>> 4;
            const value = (alpha << 12) | ((r >>> 4) << 8) | ((g >>> 4) << 4) | (b >>> 4);
            mem[ptr] = value & 0xff;
            mem[ptr + 1] = value >>> 8;
            return true;
        }
        case 28: // D3DFMT_A8
            mem[ptr] = a;
            return true;
        case 50: // D3DFMT_L8
            mem[ptr] = Math.round((r * 77 + g * 150 + b * 29) / 256);
            return true;
        default:
            return false;
    }
}

/** D3DXLoadSurfaceFromMemory for the uncompressed D3D formats used by legacy engines. */
export function d3dxLoadSurfaceFromMemory(
    mem: Uint8Array,
    destSurface: number,
    destRectPtr: number,
    srcMemory: number,
    srcFormat: number,
    srcPitch: number,
    srcRectPtr: number,
    filter: number,
    colorKey: number,
): number {
    const dest = resolveSurfaceInfo(destSurface);
    const destMeta = surfaceMeta.get(destSurface);
    if (!dest || !destMeta || !srcMemory || !srcPitch) return D3DERR_INVALIDCALL;

    const destRect = readRect(mem, destRectPtr, dest.width, dest.height);
    const srcRect = readRect(mem, srcRectPtr, rectWidth(destRect), rectHeight(destRect));
    const dw = rectWidth(destRect);
    const dh = rectHeight(destRect);
    const sw = rectWidth(srcRect);
    const sh = rectHeight(srcRect);
    if (!dw || !dh || !sw || !sh) return D3D_OK;

    const srcBpp = d3dFormatBpp(srcFormat);
    if (!srcBpp || (srcBpp & 7) !== 0) return D3DERR_INVALIDCALL;
    const srcBase = srcMemory + srcRect.top * srcPitch + srcRect.left * (srcBpp >>> 3);

    // The overwhelmingly common D3DX texture-upload case already has the
    // destination's format and dimensions. Copy its rows verbatim instead of
    // decoding every source pixel to RGBA and encoding it again. A zero color
    // key is D3DX's disabled value, and equal dimensions make point/linear
    // filtering equivalent for this copy.
    if (destMeta.format === srcFormat && colorKey === 0 && dw === sw && dh === sh) {
        const direct = dest.face < 0 ? dest.device.getTextureLevelPixels(dest.texturePtr, dest.level) : null;
        const destLock = direct ? null : dest.device.lockTexture(dest.texturePtr, dest.level);
        if (!direct && !destLock) return D3DERR_INVALIDCALL;
        const destPixels = direct ? direct.data : mem;
        const destPtr = direct ? 0 : destLock!.ptr;
        const destPitch = direct ? direct.pitch : destLock!.pitch;
        const rowBytes = dw * (srcBpp >>> 3);
        let ok = rowBytes <= srcPitch && rowBytes <= destPitch;
        for (let y = 0; y < dh && ok; y++) {
            const srcOffset = srcBase + y * srcPitch;
            const destOffset = destPtr + (destRect.top + y) * destPitch + destRect.left * (srcBpp >>> 3);
            if (srcOffset < 0 || srcOffset + rowBytes > mem.length ||
                destOffset < 0 || destOffset + rowBytes > destPixels.length) {
                ok = false;
                break;
            }
            destPixels.set(mem.subarray(srcOffset, srcOffset + rowBytes), destOffset);
        }
        if (direct) {
            if (ok) ok = dest.device.setTextureLevelPixels(dest.texturePtr, dest.level, destPixels, destPitch);
        } else {
            dest.device.unlockTexture(dest.texturePtr, dest.level, mem);
        }
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    }

    const rgba = new Uint8Array(sw * sh * 4);
    try {
        decodeD3DTextureToRgba8(mem, srcBase, sw, sh, srcFormat, { pitch: srcPitch, out: rgba });
    } catch {
        return D3DERR_INVALIDCALL;
    }

    if (destMeta.format === D3DFMT_DXT1) {
        // The decoded buffer is already cropped to srcRect; present it as a
        // tightly-packed image so the generic RGBA compositor can preserve any
        // destination pixels outside destRect before recompressing the surface.
        return d3dxLoadSurfaceFromRgba(mem, destSurface, destRectPtr, rgba, sw, sh, 0, filter, colorKey);
    }

    const destBpp = d3dFormatBpp(destMeta.format);
    if (!destBpp || (destBpp & 7) !== 0) return D3DERR_INVALIDCALL;

    const direct = dest.face < 0 ? dest.device.getTextureLevelPixels(dest.texturePtr, dest.level) : null;
    const destLock = direct ? null : dest.device.lockTexture(dest.texturePtr, dest.level);
    if (!direct && !destLock) return D3DERR_INVALIDCALL;
    // D3DX is already executing on the host. Writing through a temporary guest
    // LockRect buffer needlessly allocates from the emulated HEAP and copies the
    // whole surface twice. Work on a host-side copy when the backend exposes one,
    // then commit it directly; retain LockRect as a compatibility fallback.
    const destPixels = direct ? new Uint8Array(direct.data) : mem;
    const destPtr = direct ? 0 : destLock!.ptr;
    const destPitch = direct ? direct.pitch : destLock!.pitch;
    const destBytes = destBpp >>> 3;
    const useLinear = filter === D3DX_FILTER_LINEAR;
    const sample = (x: number, y: number): [number, number, number, number] => {
        const fx = Math.max(0, Math.min(sw - 1, x));
        const fy = Math.max(0, Math.min(sh - 1, y));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        if (!useLinear) {
            const off = (Math.round(fy) * sw + Math.round(fx)) * 4;
            return [rgba[off], rgba[off + 1], rgba[off + 2], rgba[off + 3]];
        }
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const channel = (c: number) => {
            const p00 = rgba[(y0 * sw + x0) * 4 + c];
            const p10 = rgba[(y0 * sw + x1) * 4 + c];
            const p01 = rgba[(y1 * sw + x0) * 4 + c];
            const p11 = rgba[(y1 * sw + x1) * 4 + c];
            return Math.round((p00 + (p10 - p00) * tx) * (1 - ty) + (p01 + (p11 - p01) * tx) * ty);
        };
        return [channel(0), channel(1), channel(2), channel(3)];
    };

    let ok = true;
    for (let y = 0; y < dh && ok; y++) {
        for (let x = 0; x < dw; x++) {
            const sx = dw === sw ? x : (x * (sw - 1)) / Math.max(1, dw - 1);
            const sy = dh === sh ? y : (y * (sh - 1)) / Math.max(1, dh - 1);
            const [r, g, b, a] = sample(sx, sy);
            const packedBgra = (a << 24) | (r << 16) | (g << 8) | b;
            if (colorKeyMatch(packedBgra, colorKey)) continue;
            const ptr = destPtr + (destRect.top + y) * destPitch + (destRect.left + x) * destBytes;
            if (!writeEncodedPixel(destPixels, ptr, destMeta.format, r, g, b, a)) {
                ok = false;
                break;
            }
        }
    }
    if (direct) {
        if (ok) ok = dest.device.setTextureLevelPixels(dest.texturePtr, dest.level, destPixels, destPitch);
    } else {
        dest.device.unlockTexture(dest.texturePtr, dest.level, mem);
    }
    return ok ? D3D_OK : D3DERR_INVALIDCALL;
}

/**
 * Load decoded RGBA pixels directly into a D3D9 surface. This is the decoded-image
 * counterpart of D3DXLoadSurfaceFromMemory and avoids manufacturing a second guest
 * buffer merely to pass image data that already exists in host memory.
 */
export function d3dxLoadSurfaceFromRgba(
    mem: Uint8Array,
    destSurface: number,
    destRectPtr: number,
    rgba: Uint8Array,
    srcWidth: number,
    srcHeight: number,
    srcRectPtr: number,
    filter: number,
    colorKey: number,
): number {
    const dest = resolveSurfaceInfo(destSurface);
    const destMeta = surfaceMeta.get(destSurface);
    if (!dest || !destMeta || srcWidth <= 0 || srcHeight <= 0 || rgba.length < srcWidth * srcHeight * 4) {
        return D3DERR_INVALIDCALL;
    }

    const destRect = readRect(mem, destRectPtr, dest.width, dest.height);
    const srcRect = readRect(mem, srcRectPtr, srcWidth, srcHeight);
    const dw = rectWidth(destRect);
    const dh = rectHeight(destRect);
    const sw = rectWidth(srcRect);
    const sh = rectHeight(srcRect);
    if (!dw || !dh || !sw || !sh) return D3D_OK;
    if (destRect.left < 0 || destRect.top < 0 || destRect.right > dest.width || destRect.bottom > dest.height ||
        srcRect.left < 0 || srcRect.top < 0 || srcRect.right > srcWidth || srcRect.bottom > srcHeight) {
        return D3DERR_INVALIDCALL;
    }

    if (destMeta.format === D3DFMT_DXT1) {
        const direct = dest.face < 0 ? dest.device.getTextureLevelPixels(dest.texturePtr, dest.level) : null;
        if (!direct) return D3DERR_INVALIDCALL;
        const composed = new Uint8Array(dest.width * dest.height * 4);
        decodeDxtToRgba(D3DFMT_DXT1, direct.data, direct.pitch, dest.width, dest.height, composed);
        const useLinear = filter === D3DX_FILTER_LINEAR;
        const sourcePixel = (px: number, py: number, channel: number) =>
            rgba[((srcRect.top + py) * srcWidth + srcRect.left + px) * 4 + channel];
        for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
                const fx = Math.max(0, Math.min(sw - 1, dw === sw ? x : (x * (sw - 1)) / Math.max(1, dw - 1)));
                const fy = Math.max(0, Math.min(sh - 1, dh === sh ? y : (y * (sh - 1)) / Math.max(1, dh - 1)));
                const x0 = Math.floor(fx), y0 = Math.floor(fy);
                const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
                const tx = fx - x0, ty = fy - y0;
                const channel = (c: number) => useLinear
                    ? Math.round((sourcePixel(x0, y0, c) + (sourcePixel(x1, y0, c) - sourcePixel(x0, y0, c)) * tx) * (1 - ty)
                        + (sourcePixel(x0, y1, c) + (sourcePixel(x1, y1, c) - sourcePixel(x0, y1, c)) * tx) * ty)
                    : sourcePixel(Math.round(fx), Math.round(fy), c);
                const r = channel(0), g = channel(1), b = channel(2), a = channel(3);
                if (colorKeyMatch((a << 24) | (r << 16) | (g << 8) | b, colorKey)) continue;
                const out = ((destRect.top + y) * dest.width + destRect.left + x) * 4;
                composed[out] = r; composed[out + 1] = g; composed[out + 2] = b; composed[out + 3] = a;
            }
        }
        const encoded = new Uint8Array(direct.data.length);
        if (!encodeRgbaToDxt1(composed, dest.width, dest.height, encoded, direct.pitch)) return D3DERR_INVALIDCALL;
        return dest.device.setTextureLevelPixels(dest.texturePtr, dest.level, encoded, direct.pitch)
            ? D3D_OK : D3DERR_INVALIDCALL;
    }

    const destBpp = d3dFormatBpp(destMeta.format);
    if (!destBpp || (destBpp & 7) !== 0) return D3DERR_INVALIDCALL;
    const direct = dest.face < 0 ? dest.device.getTextureLevelPixels(dest.texturePtr, dest.level) : null;
    const destLock = direct ? null : dest.device.lockTexture(dest.texturePtr, dest.level);
    if (!direct && !destLock) return D3DERR_INVALIDCALL;
    const destPixels = direct ? new Uint8Array(direct.data) : mem;
    const destPtr = direct ? 0 : destLock!.ptr;
    const destPitch = direct ? direct.pitch : destLock!.pitch;

    const destBytes = destBpp >>> 3;
    const useLinear = filter === D3DX_FILTER_LINEAR;
    const sample = (x: number, y: number): [number, number, number, number] => {
        const fx = Math.max(0, Math.min(sw - 1, x));
        const fy = Math.max(0, Math.min(sh - 1, y));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const pixel = (px: number, py: number, channel: number) =>
            rgba[((srcRect.top + py) * srcWidth + srcRect.left + px) * 4 + channel];
        if (!useLinear) {
            const px = Math.min(sw - 1, Math.round(fx));
            const py = Math.min(sh - 1, Math.round(fy));
            return [pixel(px, py, 0), pixel(px, py, 1), pixel(px, py, 2), pixel(px, py, 3)];
        }
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const channel = (c: number) => {
            const p00 = pixel(x0, y0, c);
            const p10 = pixel(x1, y0, c);
            const p01 = pixel(x0, y1, c);
            const p11 = pixel(x1, y1, c);
            return Math.round((p00 + (p10 - p00) * tx) * (1 - ty) + (p01 + (p11 - p01) * tx) * ty);
        };
        return [channel(0), channel(1), channel(2), channel(3)];
    };

    let ok = true;
    for (let y = 0; y < dh && ok; y++) {
        for (let x = 0; x < dw; x++) {
            const sx = dw === sw ? x : (x * (sw - 1)) / Math.max(1, dw - 1);
            const sy = dh === sh ? y : (y * (sh - 1)) / Math.max(1, dh - 1);
            const [r, g, b, a] = sample(sx, sy);
            const packedBgra = (a << 24) | (r << 16) | (g << 8) | b;
            if (colorKeyMatch(packedBgra, colorKey)) continue;
            const ptr = destPtr + (destRect.top + y) * destPitch + (destRect.left + x) * destBytes;
            if (!writeEncodedPixel(destPixels, ptr, destMeta.format, r, g, b, a)) {
                ok = false;
                break;
            }
        }
    }
    if (direct) {
        if (ok) ok = dest.device.setTextureLevelPixels(dest.texturePtr, dest.level, destPixels, destPitch);
    } else {
        dest.device.unlockTexture(dest.texturePtr, dest.level, mem);
    }
    return ok ? D3D_OK : D3DERR_INVALIDCALL;
}

function downsampleRgbaBox2x(
    src: Uint8Array,
    srcPitch: number,
    srcW: number,
    srcH: number,
    dst: Uint8Array,
    dstPitch: number,
    dstW: number,
    dstH: number,
): void {
    for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
            const sx = x * 2;
            const sy = y * 2;
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let count = 0;
            for (let oy = 0; oy < 2; oy++) {
                const py = Math.min(srcH - 1, sy + oy);
                for (let ox = 0; ox < 2; ox++) {
                    const px = Math.min(srcW - 1, sx + ox);
                    const off = py * srcPitch + px * 4;
                    r += src[off];
                    g += src[off + 1];
                    b += src[off + 2];
                    a += src[off + 3];
                    count++;
                }
            }
            const dstOff = y * dstPitch + x * 4;
            dst[dstOff] = Math.round(r / count);
            dst[dstOff + 1] = Math.round(g / count);
            dst[dstOff + 2] = Math.round(b / count);
            dst[dstOff + 3] = Math.round(a / count);
        }
    }
}

export function d3dxFilterTexture(texturePtr: number, srcLevel: number, _filter: number): number {
    const info = resolveTextureInfo(texturePtr);
    if (!info) return D3DERR_INVALIDCALL;

    const { device, meta } = info;
    // D3DX_DEFAULT is explicitly accepted for SrcLevel and selects the base
    // level. Treating 0xffffffff as an unsigned level previously rejected the
    // exact call pattern used by BFME II before any filtering happened.
    const start = (srcLevel >>> 0) === 0xffffffff ? 0 : Math.max(0, srcLevel >>> 0);
    if (start >= meta.levels) return D3DERR_INVALIDCALL;
    // A one-level texture has no destination mip to generate. Returning before
    // reading and decoding its base pixels makes this frequent D3DX no-op O(1).
    if (start + 1 >= meta.levels) return D3D_OK;

    let level = start;
    const firstPixels = device.getTextureLevelPixels(texturePtr, level);
    if (!firstPixels) return D3DERR_INVALIDCALL;
    let srcWidth = firstPixels.width;
    let srcHeight = firstPixels.height;
    let srcRgba = new Uint8Array(srcWidth * srcHeight * 4);
    try {
        decodeD3DTextureToRgba8(firstPixels.data, 0, srcWidth, srcHeight, meta.format, {
            pitch: firstPixels.pitch,
            out: srcRgba,
        });
    } catch {
        return D3DERR_INVALIDCALL;
    }

    while (level + 1 < meta.levels) {
        const dstW = Math.max(1, srcWidth >>> 1);
        const dstH = Math.max(1, srcHeight >>> 1);
        const dstRgbaPitch = dstW * 4;
        const dstRgba = new Uint8Array(dstRgbaPitch * dstH);
        downsampleRgbaBox2x(
            srcRgba,
            srcWidth * 4,
            srcWidth,
            srcHeight,
            dstRgba,
            dstRgbaPitch,
            dstW,
            dstH,
        );

        const target = device.getTextureLevelPixels(texturePtr, level + 1);
        if (!target) return D3DERR_INVALIDCALL;
        let encoded: Uint8Array;
        if (meta.format === D3DFMT_DXT1) {
            encoded = new Uint8Array(target.data.length);
            if (!encodeRgbaToDxt1(dstRgba, dstW, dstH, encoded, target.pitch)) {
                return D3DERR_INVALIDCALL;
            }
        } else {
            // DXT2-5 need their own alpha encoders. Never write RGBA bytes into
            // block-compressed storage; fail cleanly until those codecs exist.
            if (isDxtFormat(meta.format)) return D3DERR_INVALIDCALL;
            const bpp = d3dFormatBpp(meta.format);
            if (!bpp || (bpp & 7) !== 0) return D3DERR_INVALIDCALL;
            const bytesPerPixel = bpp >>> 3;
            encoded = new Uint8Array(target.data.length);
            for (let y = 0; y < dstH; y++) {
                for (let x = 0; x < dstW; x++) {
                    const src = (y * dstW + x) * 4;
                    if (!writeEncodedPixel(
                        encoded,
                        y * target.pitch + x * bytesPerPixel,
                        meta.format,
                        dstRgba[src],
                        dstRgba[src + 1],
                        dstRgba[src + 2],
                        dstRgba[src + 3],
                    )) return D3DERR_INVALIDCALL;
                }
            }
        }
        if (!device.setTextureLevelPixels(texturePtr, level + 1, encoded, target.pitch)) {
            return D3DERR_INVALIDCALL;
        }
        level++;
        srcRgba = dstRgba;
        srcWidth = dstW;
        srcHeight = dstH;
    }

    return D3D_OK;
}

/** Convert RGBA decode output to D3D A8R8G8B8 (BGRA byte order). */
export function rgbaToBgra(rgba: Uint8Array, out?: Uint8Array): Uint8Array {
    const dst = out ?? new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        dst[i] = rgba[i + 2];
        dst[i + 1] = rgba[i + 1];
        dst[i + 2] = rgba[i];
        dst[i + 3] = rgba[i + 3];
    }
    return dst;
}

export function uploadRgbaToTexture(
    texturePtr: number,
    width: number,
    height: number,
    rgba: Uint8Array,
): boolean {
    const info = resolveTextureInfo(texturePtr);
    if (!info) return false;
    const bgra = rgbaToBgra(rgba);
    const pitch = width * 4;
    return info.device.setTextureLevelPixels(texturePtr, 0, bgra, pitch);
}
