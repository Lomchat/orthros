/**
 * GDI raster operations + BMP parsing — pure pixel processing (no GDIContext
 * state). applyRopCode does SRCAND/SRCPAINT/SRCINVERT ROP blends;
 * parseBMPHeader/parseBMPPixels decode a DIB/BMP byte stream (GetDIBits,
 * LoadBitmap, icon/cursor extractors).
 */
import { Logger, LogCategory } from '../../core/logger';

export function applyRopCode(
        destCtx: OffscreenCanvasRenderingContext2D,
        srcCtx: OffscreenCanvasRenderingContext2D,
        rop: number,
        xDest: number, yDest: number, wDest: number, hDest: number,
        xSrc: number, ySrc: number, wSrc: number, hSrc: number
    ): void {
        const SRCINVERT = 0x00660046;    // Source XOR destination
        const SRCAND = 0x008800C6;      // Source AND destination
        const SRCPAINT = 0x00EE0086;    // Source OR destination

        if (rop === SRCINVERT || rop === SRCAND || rop === SRCPAINT) {
            // Get source and destination image data
            const srcData = srcCtx.getImageData(xSrc, ySrc, wSrc, hSrc);
            const destData = destCtx.getImageData(xDest, yDest, wDest, hDest);

            const srcPixels = srcData.data;
            const destPixels = destData.data;

            const applyOp = (srcOffset: number, destOffset: number): void => {
                if (rop === SRCINVERT) {
                    // XOR: dest = src ^ dest
                    destPixels[destOffset] = srcPixels[srcOffset] ^ destPixels[destOffset]; // R
                    destPixels[destOffset + 1] = srcPixels[srcOffset + 1] ^ destPixels[destOffset + 1]; // G
                    destPixels[destOffset + 2] = srcPixels[srcOffset + 2] ^ destPixels[destOffset + 2]; // B
                    destPixels[destOffset + 3] = Math.max(srcPixels[srcOffset + 3], destPixels[destOffset + 3]); // A
                } else if (rop === SRCAND) {
                    // AND: dest = src & dest
                    destPixels[destOffset] = srcPixels[srcOffset] & destPixels[destOffset]; // R
                    destPixels[destOffset + 1] = srcPixels[srcOffset + 1] & destPixels[destOffset + 1]; // G
                    destPixels[destOffset + 2] = srcPixels[srcOffset + 2] & destPixels[destOffset + 2]; // B
                    destPixels[destOffset + 3] = Math.max(srcPixels[srcOffset + 3], destPixels[destOffset + 3]); // A
                } else if (rop === SRCPAINT) {
                    // OR: dest = src | dest
                    destPixels[destOffset] = srcPixels[srcOffset] | destPixels[destOffset]; // R
                    destPixels[destOffset + 1] = srcPixels[srcOffset + 1] | destPixels[destOffset + 1]; // G
                    destPixels[destOffset + 2] = srcPixels[srcOffset + 2] | destPixels[destOffset + 2]; // B
                    destPixels[destOffset + 3] = Math.max(srcPixels[srcOffset + 3], destPixels[destOffset + 3]); // A
                }
            };

            if (wSrc !== wDest || hSrc !== hDest) {
                // Scale source to destination size using nearest-neighbor sampling.
                const xScale = wSrc / wDest;
                const yScale = hSrc / hDest;

                for (let y = 0; y < hDest; y++) {
                    const srcY = Math.min(hSrc - 1, (y * yScale) | 0);
                    const srcRow = srcY * wSrc * 4;
                    const destRow = y * wDest * 4;
                    for (let x = 0; x < wDest; x++) {
                        const srcX = Math.min(wSrc - 1, (x * xScale) | 0);
                        const srcOffset = srcRow + srcX * 4;
                        const destOffset = destRow + x * 4;
                        applyOp(srcOffset, destOffset);
                    }
                }
            } else {
                // Apply bitwise operation pixel by pixel
                for (let i = 0; i < destPixels.length; i += 4) {
                    applyOp(i, i);
                }
            }

            // Put modified data back
            destCtx.putImageData(destData, xDest, yDest);
        }
    }

    /**
     * Parse BMP file header and info header
     * Returns parsed header information or null if invalid
     */
export function parseBMPHeader(data: Uint8Array): { width: number; height: number; bitsPerPixel: number; compression: number; offset: number; rowSize: number; isTopDown: boolean; palette: Uint32Array | null } | null {
        if (data.length < 54) {
            Logger.warn(LogCategory.GDI32, 'parseBMPHeader: File too small for BMP headers');
            return null;
        }

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // BITMAPFILEHEADER (14 bytes)
        const bfType = view.getUint16(0, true);
        if (bfType !== 0x4D42) { // "BM"
            Logger.warn(LogCategory.GDI32, `parseBMPHeader: Invalid BMP signature 0x${bfType.toString(16)}, expected 0x4D42`);
            return null;
        }
        const bfOffBits = view.getUint32(10, true);

        // BITMAPINFOHEADER (starts at offset 14)
        const biSize = view.getUint32(14, true); // Size of info header (can be 40, 108, 124, etc.)
        const biWidth = view.getInt32(18, true);
        const biHeight = view.getInt32(22, true); // Can be negative for top-down DIB
        const biPlanes = view.getUint16(26, true);
        const biBitCount = view.getUint16(28, true);
        const biCompression = view.getUint32(30, true);
        const biClrUsed = view.getUint32(46, true); // Number of colors in palette (0 = use full palette for bit depth)

        if (biPlanes !== 1) {
            Logger.warn(LogCategory.GDI32, `parseBMPHeader: Invalid planes ${biPlanes}, expected 1`);
            return null;
        }

        if (biBitCount !== 1 && biBitCount !== 4 && biBitCount !== 8 && biBitCount !== 24 && biBitCount !== 32) {
            Logger.warn(LogCategory.GDI32, `parseBMPHeader: Unsupported bit count ${biBitCount}, expected 1, 4, 8, 24, or 32`);
            return null;
        }

        if (biCompression !== 0) {
            Logger.warn(LogCategory.GDI32, `parseBMPHeader: Unsupported compression ${biCompression}, expected 0 (BI_RGB)`);
            return null;
        }

        const width = Math.abs(biWidth);
        const height = Math.abs(biHeight);
        const isTopDown = biHeight < 0;
        const rowSize = Math.floor((width * biBitCount + 31) / 32) * 4; // DWORD-aligned

        // Parse palette for 8-bit BMP
        let palette: Uint32Array | null = null;
        if (biBitCount === 8) {
            // Palette starts after BITMAPFILEHEADER (14) + BITMAPINFOHEADER (biSize)
            const paletteOffset = 14 + biSize;
            // Number of colors: biClrUsed (if 0, use full palette = 256 for 8-bit)
            const numColors = biClrUsed === 0 ? 256 : biClrUsed;
            if (numColors > 256) {
                Logger.warn(LogCategory.GDI32, `parseBMPHeader: Invalid palette size ${numColors}, max 256`);
                return null;
            }
            const paletteSize = numColors * 4; // Each color is 4 bytes (BGRA)

            if (data.length < paletteOffset + paletteSize) {
                Logger.warn(LogCategory.GDI32, `parseBMPHeader: File too small for palette, expected ${paletteOffset + paletteSize} bytes, got ${data.length}`);
                return null;
            }

            palette = new Uint32Array(numColors);
            for (let i = 0; i < numColors; i++) {
                const colorOffset = paletteOffset + i * 4;
                const b = data[colorOffset];
                const g = data[colorOffset + 1];
                const r = data[colorOffset + 2];
                palette[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
            }

            Logger.verbose(LogCategory.GDI32, `parseBMPHeader: Loaded ${numColors}-color palette for 8-bit BMP`);
        } else if (biBitCount === 4) {
            const paletteOffset = 14 + biSize;
            const numColors = biClrUsed === 0 ? 16 : Math.min(biClrUsed, 16);
            const paletteSize = numColors * 4;

            if (data.length < paletteOffset + paletteSize) {
                Logger.warn(LogCategory.GDI32, `parseBMPHeader: File too small for 4-bit palette`);
                return null;
            }

            palette = new Uint32Array(numColors);
            for (let i = 0; i < numColors; i++) {
                const colorOffset = paletteOffset + i * 4;
                const b = data[colorOffset], g = data[colorOffset + 1], r = data[colorOffset + 2];
                palette[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
            }
            Logger.verbose(LogCategory.GDI32, `parseBMPHeader: Loaded ${numColors}-color palette for 4-bit BMP`);
        } else if (biBitCount === 1) {
            const paletteOffset = 14 + biSize;
            const numColors = biClrUsed === 0 ? 2 : Math.min(biClrUsed, 2);
            const paletteSize = numColors * 4;

            if (data.length < paletteOffset + paletteSize) {
                Logger.warn(LogCategory.GDI32, `parseBMPHeader: File too small for 1-bit palette`);
                return null;
            }

            palette = new Uint32Array(numColors);
            for (let i = 0; i < numColors; i++) {
                const colorOffset = paletteOffset + i * 4;
                const b = data[colorOffset], g = data[colorOffset + 1], r = data[colorOffset + 2];
                palette[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
            }
            Logger.verbose(LogCategory.GDI32, `parseBMPHeader: Loaded ${numColors}-color palette for 1-bit BMP`);
        }


        return {
            width,
            height,
            bitsPerPixel: biBitCount,
            compression: biCompression,
            offset: bfOffBits, // Use bfOffBits from file header, not calculated value
            rowSize,
            isTopDown,
            palette,
        };
    }

    /**
     * Parse BMP pixel data and convert BGR to RGBA
     * Returns RGBA pixel data as Uint8Array
     */
export function parseBMPPixels(data: Uint8Array, header: { width: number; height: number; bitsPerPixel: number; offset: number; rowSize: number; isTopDown: boolean; palette: Uint32Array | null }): Uint8Array | null {
        const { width, height, bitsPerPixel, offset, rowSize, isTopDown, palette } = header;
        const bytesPerPixel = bitsPerPixel >= 8 ? bitsPerPixel / 8 : 1;

        if (data.length < offset + height * rowSize) {
            Logger.warn(LogCategory.GDI32, `parseBMPPixels: File too small, expected ${offset + height * rowSize} bytes, got ${data.length}`);
            return null;
        }

        const pixels = new Uint8Array(width * height * 4); // RGBA

        for (let y = 0; y < height; y++) {
            // BMP rows: if isTopDown (biHeight < 0), rows are already top-down, no flip needed
            // Otherwise (biHeight > 0), rows are bottom-up, need to flip for Canvas API
            const srcRow = y;
            const dstRow = isTopDown ? y : height - 1 - y;
            const srcOffset = offset + srcRow * rowSize;
            const dstOffset = dstRow * width * 4;

            for (let x = 0; x < width; x++) {
                const dstPixel = dstOffset + x * 4;

                if (bitsPerPixel === 32) {
                    // BGRA → RGBA
                    const srcPixel = srcOffset + x * bytesPerPixel;
                    pixels[dstPixel] = data[srcPixel + 2];     // R
                    pixels[dstPixel + 1] = data[srcPixel + 1]; // G
                    pixels[dstPixel + 2] = data[srcPixel];     // B
                    pixels[dstPixel + 3] = data[srcPixel + 3]; // A
                } else if (bitsPerPixel === 24) {
                    // BGR → RGBA (alpha = 255)
                    const srcPixel = srcOffset + x * bytesPerPixel;
                    pixels[dstPixel] = data[srcPixel + 2];     // R
                    pixels[dstPixel + 1] = data[srcPixel + 1]; // G
                    pixels[dstPixel + 2] = data[srcPixel];     // B
                    pixels[dstPixel + 3] = 255;                // A
                } else if (bitsPerPixel === 8 && palette) {
                    // 8-bit indexed color with palette
                    const paletteIndex = data[srcOffset + x]; // 1 byte index (0-255)
                    const color = palette[paletteIndex]; // RGBA color from palette

                    // Extract RGBA components from 0xAABBGGRR format
                    pixels[dstPixel] = (color) & 0xFF;        // R
                    pixels[dstPixel + 1] = (color >> 8) & 0xFF; // G
                    pixels[dstPixel + 2] = (color >> 16) & 0xFF; // B
                    pixels[dstPixel + 3] = (color >> 24) & 0xFF; // A
                } else if (bitsPerPixel === 4 && palette) {
                    const byteVal = data[srcOffset + (x >> 1)];
                    const idx = (x & 1) === 0 ? (byteVal >> 4) : (byteVal & 0x0F);
                    const color = idx < palette.length ? palette[idx] : 0xFF000000;
                    pixels[dstPixel]     = color & 0xFF;
                    pixels[dstPixel + 1] = (color >> 8) & 0xFF;
                    pixels[dstPixel + 2] = (color >> 16) & 0xFF;
                    pixels[dstPixel + 3] = (color >> 24) & 0xFF;
                } else if (bitsPerPixel === 1 && palette) {
                    const byteVal = data[srcOffset + (x >> 3)];
                    const idx = (byteVal >> (7 - (x & 7))) & 1;
                    const color = palette[idx];
                    pixels[dstPixel]     = color & 0xFF;
                    pixels[dstPixel + 1] = (color >> 8) & 0xFF;
                    pixels[dstPixel + 2] = (color >> 16) & 0xFF;
                    pixels[dstPixel + 3] = (color >> 24) & 0xFF;
                }
            }
        }


        return pixels;
    }
