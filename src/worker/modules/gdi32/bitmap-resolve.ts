/**
 * Resolve a GDI/user BITMAP handle to RGBA pixels for overlay painting.
 * Tries: stored pixels → live DC canvas → CreateDIBSection bitsPtr.
 */

import { System } from '../../core/system';
import { SystemResourceProvider } from '../../core/resources/system-resource-provider';
import { asArrayBufferView } from '../../../dom-buffer';

export interface ResolvedBitmapRgba {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

/** Win32 static SS_BITMAP / SS_ICON image placement (user32 Static control). */
export type StaticImageLayoutMode = 'stretch' | 'center';

export interface StaticImageLayout {
    mode: StaticImageLayoutMode;
    /** Destination rect in canvas space. */
    x: number;
    y: number;
    w: number;
    h: number;
}

interface BitmapUserObj {
    type: string;
    width?: number;
    height?: number;
    pixels?: Uint8Array | Uint8ClampedArray | null;
    bitsPtr?: number;
    dibBpp?: number;
    dibStride?: number;
    dibTopDown?: boolean;
    dibPalette?: Uint32Array;
    isTopDown?: boolean;
    loading?: boolean;
}

/** True when the JS RGBA shadow was filled by LoadImage/parseBMP (not a CreateDIBSection placeholder). */
export function bitmapPixelsPopulated(obj: BitmapUserObj): boolean {
    const w = obj.width ?? 0;
    const h = obj.height ?? 0;
    const p = obj.pixels;
    if (!p || w <= 0 || h <= 0 || p.length < w * h * 4) return false;
    const sample = Math.min(p.length, 4096);
    for (let i = 0; i < sample; i++) {
        if (p[i] !== 0) return true;
    }
    return false;
}

export function bitmapHasPixelSource(obj: BitmapUserObj): boolean {
    return bitmapPixelsPopulated(obj) || !!(obj.bitsPtr && obj.dibStride);
}

function unwrapBitmapObj(hBitmap: number): BitmapUserObj | null {
    const rp = SystemResourceProvider.getInstance();
    const raw = rp.getUserObject(hBitmap) ?? rp.getGdiObject(hBitmap);
    if (!raw) return null;
    if (raw.type === 'BITMAP') return raw as BitmapUserObj;
    if (raw.data?.type === 'BITMAP') return raw.data as BitmapUserObj;
    return null;
}

function pixelsValid(obj: BitmapUserObj): boolean {
    return bitmapPixelsPopulated(obj);
}

/** Read 32bpp BGRA from guest DIBSection bits into RGBA. */
function readDibSectionRgba(
    mem: Uint8Array,
    bitsPtr: number,
    w: number,
    h: number,
    dibStride: number,
    dibTopDown: boolean,
): Uint8ClampedArray | null {
    if (!bitsPtr || w <= 0 || h <= 0 || dibStride <= 0) return null;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const srcY = dibTopDown ? y : (h - 1 - y);
        let srcOff = bitsPtr + srcY * dibStride;
        const dstOff = y * w * 4;
        for (let x = 0; x < w; x++) {
            const di = dstOff + x * 4;
            out[di] = mem[srcOff + 2];
            out[di + 1] = mem[srcOff + 1];
            out[di + 2] = mem[srcOff];
            out[di + 3] = mem[srcOff + 3] || 255;
            srcOff += 4;
        }
    }
    return out;
}

/** Read 4/8/16/24/32 bpp DIBSection row data into RGBA (best-effort). */
function readDibSectionRgbaGeneric(
    mem: Uint8Array,
    bitsPtr: number,
    w: number,
    h: number,
    dibStride: number,
    dibTopDown: boolean,
    dibBpp: number,
    palette?: Uint32Array,
): Uint8ClampedArray | null {
    if (dibBpp === 32) {
        return readDibSectionRgba(mem, bitsPtr, w, h, dibStride, dibTopDown);
    }
    if (!bitsPtr || w <= 0 || h <= 0) return null;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const srcY = dibTopDown ? y : (h - 1 - y);
        const srcRow = bitsPtr + srcY * dibStride;
        const dstOff = y * w * 4;
        if (dibBpp === 24) {
            for (let x = 0; x < w; x++) {
                const si = srcRow + x * 3;
                const di = dstOff + x * 4;
                out[di] = mem[si + 2];
                out[di + 1] = mem[si + 1];
                out[di + 2] = mem[si];
                out[di + 3] = 255;
            }
        } else if (dibBpp === 16) {
            for (let x = 0; x < w; x++) {
                const v = mem[srcRow + x * 2] | (mem[srcRow + x * 2 + 1] << 8);
                const di = dstOff + x * 4;
                out[di] = ((v >> 11) & 0x1F) * 255 / 31;
                out[di + 1] = ((v >> 5) & 0x3F) * 255 / 63;
                out[di + 2] = (v & 0x1F) * 255 / 31;
                out[di + 3] = 255;
            }
        } else if (dibBpp === 8 && palette && palette.length > 0) {
            for (let x = 0; x < w; x++) {
                const idx = mem[srcRow + x];
                const color = palette[idx] ?? 0xff000000;
                const di = dstOff + x * 4;
                out[di] = (color >> 16) & 0xff;
                out[di + 1] = (color >> 8) & 0xff;
                out[di + 2] = color & 0xff;
                out[di + 3] = (color >>> 24) & 0xff;
            }
        } else if (dibBpp === 4 && palette && palette.length > 0) {
            for (let x = 0; x < w; x++) {
                const byte = mem[srcRow + (x >> 1)];
                const idx = (x & 1) === 0 ? (byte >> 4) : (byte & 0x0f);
                const color = palette[idx] ?? 0xff000000;
                const di = dstOff + x * 4;
                out[di] = (color >> 16) & 0xff;
                out[di + 1] = (color >> 8) & 0xff;
                out[di + 2] = color & 0xff;
                out[di + 3] = (color >>> 24) & 0xff;
            }
        } else {
            return null;
        }
    }
    return out;
}

/**
 * Resolve bitmap handle to RGBA for painting.
 * @param mem Guest memory (required for DIBSection bitsPtr reads).
 */
export function resolveBitmapRgba(hBitmap: number, mem?: Uint8Array): ResolvedBitmapRgba | null {
    if (!hBitmap) return null;

    const obj = unwrapBitmapObj(hBitmap);
    if (!obj) return null;

    const w = obj.width ?? 0;
    const h = obj.height ?? 0;
    if (w <= 0 || h <= 0) return null;

    if (mem && obj.bitsPtr && obj.dibStride && !pixelsValid(obj)) {
        const bpp = obj.dibBpp ?? 32;
        const rgba = readDibSectionRgbaGeneric(
            mem, obj.bitsPtr, w, h, obj.dibStride, !!obj.dibTopDown, bpp, obj.dibPalette,
        );
        if (rgba) return { data: rgba, width: w, height: h };
    }

    if (pixelsValid(obj)) {
        const p = obj.pixels!;
        const clamped = p instanceof Uint8ClampedArray
            ? p.subarray(0, w * h * 4)
            : new Uint8ClampedArray(p.buffer, p.byteOffset, Math.min(p.byteLength, w * h * 4));
        if (clamped.length >= w * h * 4) {
            return { data: clamped.subarray(0, w * h * 4), width: w, height: h };
        }
    }

    const gdi = System.getInstance().gdiContext;
    const rendered = gdi.getBitmapRenderedPixels(hBitmap);
    if (rendered && rendered.length >= w * h * 4) {
        return { data: rendered.subarray(0, w * h * 4), width: w, height: h };
    }

    if (mem && obj.bitsPtr && obj.dibStride) {
        const bpp = obj.dibBpp ?? 32;
        const rgba = readDibSectionRgbaGeneric(
            mem, obj.bitsPtr, w, h, obj.dibStride, !!obj.dibTopDown, bpp, obj.dibPalette,
        );
        if (rgba) return { data: rgba, width: w, height: h };
    }

    return null;
}

/** Bitmap dimensions from a GDI/user BITMAP handle (no pixel read). */
export function getBitmapObjectDimensions(hBitmap: number): { width: number; height: number } | null {
    const obj = unwrapBitmapObj(hBitmap);
    if (!obj) return null;
    const width = obj.width ?? 0;
    const height = obj.height ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
}

/** Icon dimensions from a user ICON handle. */
export function getIconObjectDimensions(hIcon: number): { width: number; height: number } | null {
    const rp = SystemResourceProvider.getInstance();
    const raw = rp.getUserObject(hIcon) ?? rp.getGdiObject(hIcon);
    if (!raw || raw.type !== 'ICON') return null;
    const width = raw.width ?? 0;
    const height = raw.height ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Win32 Static control image layout for SS_BITMAP / SS_ICON.
 *
 * STM_SETIMAGE on SS_BITMAP (without SS_CENTERIMAGE) auto-sizes the control to the
 * bitmap first; paint then maps image 1:1 into that rect (stretch with equal dims).
 * With SS_CENTERIMAGE: control keeps template size; image drawn at natural size, centered.
 */
export function layoutStaticControlImage(
    destX: number,
    destY: number,
    destW: number,
    destH: number,
    imageW: number,
    imageH: number,
    style: number,
    SS_CENTERIMAGE: number,
): StaticImageLayout {
    if ((style & SS_CENTERIMAGE) !== 0) {
        return {
            mode: 'center',
            x: destX + Math.max(0, Math.floor((destW - imageW) / 2)),
            y: destY + Math.max(0, Math.floor((destH - imageH) / 2)),
            w: imageW,
            h: imageH,
        };
    }
    return {
        mode: 'stretch',
        x: destX,
        y: destY,
        w: destW,
        h: destH,
    };
}

/** @deprecated Use layoutStaticControlImage */
export function layoutBitmapDestRect(
    destX: number,
    destY: number,
    destW: number,
    destH: number,
    bmpW: number,
    bmpH: number,
    style: number,
    SS_CENTERIMAGE: number,
    _SS_REALSIZEIMAGE: number,
): { x: number; y: number; w: number; h: number; srcW: number; srcH: number } {
    const layout = layoutStaticControlImage(destX, destY, destW, destH, bmpW, bmpH, style, SS_CENTERIMAGE);
    if (layout.mode === 'stretch') {
        return { x: layout.x, y: layout.y, w: layout.w, h: layout.h, srcW: bmpW, srcH: bmpH };
    }
    return { x: layout.x, y: layout.y, w: layout.w, h: layout.h, srcW: bmpW, srcH: bmpH };
}

/** Blit RGBA into a 2D context per Win32 static control rules. */
export function blitStaticControlImage(
    ctx: OffscreenCanvasRenderingContext2D,
    data: Uint8ClampedArray,
    imageW: number,
    imageH: number,
    clipX: number,
    clipY: number,
    clipW: number,
    clipH: number,
    layout: StaticImageLayout,
): void {
    if (imageW <= 0 || imageH <= 0 || clipW <= 0 || clipH <= 0) return;

    const frame = new OffscreenCanvas(imageW, imageH);
    const frameCtx = frame.getContext('2d');
    if (!frameCtx) return;
    frameCtx.putImageData(new ImageData(asArrayBufferView(data), imageW, imageH), 0, 0);

    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX, clipY, clipW, clipH);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;

    if (layout.mode === 'stretch') {
        ctx.drawImage(frame, 0, 0, imageW, imageH, layout.x, layout.y, layout.w, layout.h);
    } else {
        ctx.drawImage(frame, 0, 0, imageW, imageH, layout.x, layout.y, imageW, imageH);
    }
    ctx.restore();
}

/** Resolve ICON user object to RGBA (same layout as bitmap). */
export function resolveIconRgba(hIcon: number): ResolvedBitmapRgba | null {
    if (!hIcon) return null;
    const rp = SystemResourceProvider.getInstance();
    const raw = rp.getUserObject(hIcon) ?? rp.getGdiObject(hIcon);
    if (!raw || raw.type !== 'ICON') return null;
    const w = raw.width ?? 0;
    const h = raw.height ?? 0;
    const p = raw.pixels as Uint8Array | undefined;
    if (w <= 0 || h <= 0 || !p || p.length < w * h * 4) return null;
    const clamped = new Uint8ClampedArray(p.buffer, p.byteOffset, w * h * 4);
    return { data: clamped, width: w, height: h };
}
