/// <reference types="@webgpu/types" />
/**
 * DXT / BC block-compressed texture support shared across the WebGPU DX backends
 * (D3D8 + D3D9).
 *
 * The texture paths historically assumed every texture was 32-bit ARGB and
 * uploaded it via a plain ARGB→RGBA swizzle. DXT-compressed textures (DXT1/3/5,
 * used heavily by DX8/DX9-era games — Morrowind menu UI, NFS Underground fonts/
 * UI/world art) are stored as 4×4 pixel blocks, so reading them as raw pixels
 * produced garbage (horizontal/vertical stripes instead of the image).
 *
 * This module owns:
 *   - format identification + block geometry (pitch/rows/size),
 *   - the mapping DXT → WebGPU BC texture format (native HW-decoded upload path),
 *   - a CPU block decoder to RGBA8 (fallback when the adapter lacks
 *     `texture-compression-bc`, or for textures whose dimensions are not block
 *     multiples — WebGPU requires block-aligned copies for compressed textures).
 *
 * The CPU decoder is deliberately self-contained (no ddraw `gpu-texture-utils`
 * coupling): the ddraw converter is strictly per-pixel and has no notion of
 * 4×4 blocks, so there is nothing to reuse there.
 */

// D3DFORMAT FourCC codes (little-endian 'DXT1'..'DXT5').
export const D3DFMT_DXT1 = 0x31545844; // 'DXT1' — BC1 (1-bit alpha)
export const D3DFMT_DXT2 = 0x32545844; // 'DXT2' — BC2, premultiplied alpha
export const D3DFMT_DXT3 = 0x33545844; // 'DXT3' — BC2, explicit 4-bit alpha
export const D3DFMT_DXT4 = 0x34545844; // 'DXT4' — BC3, premultiplied alpha
export const D3DFMT_DXT5 = 0x35545844; // 'DXT5' — BC3, interpolated alpha

export function isDxtFormat(format: number): boolean {
    return (
        format === D3DFMT_DXT1 ||
        format === D3DFMT_DXT2 ||
        format === D3DFMT_DXT3 ||
        format === D3DFMT_DXT4 ||
        format === D3DFMT_DXT5
    );
}

/** Bytes per 4×4 block: 8 for DXT1 (BC1), 16 for DXT2-5 (BC2/BC3). */
export function dxtBlockBytes(format: number): number {
    return format === D3DFMT_DXT1 ? 8 : 16;
}

/** Number of 4×4 blocks across a row of `width` pixels. */
function blocksWide(width: number): number {
    return Math.max(1, (width + 3) >> 2);
}

/**
 * Byte pitch of one block row for a compressed surface — `blocksWide * blockBytes`.
 * This is what real D3D9 LockRect returns for a DXT surface and the stride the
 * guest packs its blocks at (DXT1 = width*2, DXT3/5 = width*4). The legacy code
 * used the uncompressed width*4 for every format, which only happens to match
 * DXT3/5; DXT1 was read at 2× stride → content squished into the top half.
 */
export function dxtRowPitch(format: number, width: number): number {
    return blocksWide(width) * dxtBlockBytes(format);
}

/** Number of 4×4 block rows for `height` pixels. */
export function blocksHigh(height: number): number {
    return Math.max(1, (height + 3) >> 2);
}

/** Total compressed byte size of a DXT surface (block-row pitch × block rows). */
export function dxtSurfaceBytes(format: number, width: number, height: number): number {
    return dxtRowPitch(format, width) * blocksHigh(height);
}

function packRgb565(r: number, g: number, b: number): number {
    return ((Math.round(r * 31 / 255) & 31) << 11)
        | ((Math.round(g * 63 / 255) & 63) << 5)
        | (Math.round(b * 31 / 255) & 31);
}

function unpackRgb565(value: number): [number, number, number] {
    return [r5(value), g6(value), b5(value)];
}

/**
 * Deterministic BC1/DXT1 range-fit encoder used by D3DX surface uploads.
 * Quality is intentionally modest but stable: min/max endpoints followed by a
 * perceptually weighted selector pass. This is the same inexpensive shape used
 * by the validated BFME cold-load encoder, generalized to RGBA8 input.
 */
export function encodeRgbaToDxt1(
    rgba: Uint8Array,
    width: number,
    height: number,
    dst: Uint8Array,
    dstPitch = dxtRowPitch(D3DFMT_DXT1, width),
): boolean {
    if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return false;
    const bw = blocksWide(width);
    const bh = blocksHigh(height);
    if (dstPitch < bw * 8 || dst.length < dstPitch * bh) return false;

    const block = new Uint8Array(16 * 4);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            let opaque = 0;
            let hasTransparent = false;
            let minR = 255, minG = 255, minB = 255;
            let maxR = 0, maxG = 0, maxB = 0;
            for (let ty = 0; ty < 4; ty++) {
                const sy = Math.min(height - 1, by * 4 + ty);
                for (let tx = 0; tx < 4; tx++) {
                    const sx = Math.min(width - 1, bx * 4 + tx);
                    const src = (sy * width + sx) * 4;
                    const p = (ty * 4 + tx) * 4;
                    const r = rgba[src], g = rgba[src + 1], b = rgba[src + 2], a = rgba[src + 3];
                    block[p] = r; block[p + 1] = g; block[p + 2] = b; block[p + 3] = a;
                    if (a < 128) {
                        hasTransparent = true;
                    } else {
                        opaque++;
                        minR = Math.min(minR, r); minG = Math.min(minG, g); minB = Math.min(minB, b);
                        maxR = Math.max(maxR, r); maxG = Math.max(maxG, g); maxB = Math.max(maxB, b);
                    }
                }
            }

            const out = by * dstPitch + bx * 8;
            if (opaque === 0) {
                dst[out] = 0; dst[out + 1] = 0; dst[out + 2] = 0; dst[out + 3] = 0;
                dst[out + 4] = 0xff; dst[out + 5] = 0xff; dst[out + 6] = 0xff; dst[out + 7] = 0xff;
                continue;
            }

            let c0 = packRgb565(maxR, maxG, maxB);
            let c1 = packRgb565(minR, minG, minB);
            if (hasTransparent) {
                if (c0 > c1) [c0, c1] = [c1, c0];
            } else if (c0 < c1) {
                [c0, c1] = [c1, c0];
            }
            const p0 = unpackRgb565(c0);
            const p1 = unpackRgb565(c1);
            const palette: Array<[number, number, number]> = [p0, p1];
            if (hasTransparent || c0 <= c1) {
                palette.push([
                    (p0[0] + p1[0]) >> 1,
                    (p0[1] + p1[1]) >> 1,
                    (p0[2] + p1[2]) >> 1,
                ]);
            } else {
                palette.push([
                    (2 * p0[0] + p1[0] + 1) / 3 | 0,
                    (2 * p0[1] + p1[1] + 1) / 3 | 0,
                    (2 * p0[2] + p1[2] + 1) / 3 | 0,
                ], [
                    (p0[0] + 2 * p1[0] + 1) / 3 | 0,
                    (p0[1] + 2 * p1[1] + 1) / 3 | 0,
                    (p0[2] + 2 * p1[2] + 1) / 3 | 0,
                ]);
            }

            let selectors = 0;
            const paletteLength = hasTransparent || c0 <= c1 ? 3 : 4;
            for (let i = 0; i < 16; i++) {
                const p = i * 4;
                let best = 3;
                if (block[p + 3] >= 128) {
                    let bestError = Number.POSITIVE_INFINITY;
                    for (let candidate = 0; candidate < paletteLength; candidate++) {
                        const colour = palette[candidate]!;
                        const dr = block[p] - colour[0];
                        const dg = block[p + 1] - colour[1];
                        const db = block[p + 2] - colour[2];
                        const error = dr * dr * 0.29703665 + dg * dg + db * db * 0.10078278;
                        if (error < bestError) { bestError = error; best = candidate; }
                    }
                }
                selectors |= best << (i * 2);
            }
            dst[out] = c0 & 0xff; dst[out + 1] = c0 >>> 8;
            dst[out + 2] = c1 & 0xff; dst[out + 3] = c1 >>> 8;
            dst[out + 4] = selectors & 0xff; dst[out + 5] = selectors >>> 8 & 0xff;
            dst[out + 6] = selectors >>> 16 & 0xff; dst[out + 7] = selectors >>> 24 & 0xff;
        }
    }
    return true;
}

/** Map a DXT FourCC to its native WebGPU BC texture format. */
export function dxtToBcGpuFormat(format: number): GPUTextureFormat {
    switch (format) {
        case D3DFMT_DXT1:
            return "bc1-rgba-unorm";
        case D3DFMT_DXT2:
        case D3DFMT_DXT3:
            return "bc2-rgba-unorm";
        case D3DFMT_DXT4:
        case D3DFMT_DXT5:
        default:
            return "bc3-rgba-unorm";
    }
}

/**
 * Native BC upload is only valid when the base-level dimensions are multiples of
 * the 4×4 block size; WebGPU rejects compressed copies whose extent is not block
 * aligned (except at the texture edge, which we don't special-case). Non-aligned
 * sizes route to the CPU decoder instead.
 */
export function isBlockAligned(width: number, height: number): boolean {
    return (width & 3) === 0 && (height & 3) === 0;
}

// Expand a 5-bit channel to 8 bits (bit replication, matches D3D reference).
function r5(c: number): number { const v = (c >> 11) & 0x1f; return (v << 3) | (v >> 2); }
function g6(c: number): number { const v = (c >> 5) & 0x3f; return (v << 2) | (v >> 4); }
function b5(c: number): number { const v = c & 0x1f; return (v << 3) | (v >> 2); }

/**
 * Decode one BC1 color block into a 4-entry RGBA palette (each entry packed as
 * 0xAABBGGRR so it can be written straight into a Uint32 RGBA destination).
 *
 * @param forceFourColor BC2/BC3 color blocks always use the 4-colour interpolation
 *   regardless of endpoint ordering; BC1 uses 3-colour + 1-bit alpha when c0<=c1.
 */
function decodeColorPalette(
    src: Uint8Array,
    off: number,
    forceFourColor: boolean,
    palette: Uint32Array
): void {
    const c0 = src[off] | (src[off + 1] << 8);
    const c1 = src[off + 2] | (src[off + 3] << 8);

    const r0 = r5(c0), gg0 = g6(c0), bb0 = b5(c0);
    const r1 = r5(c1), gg1 = g6(c1), bb1 = b5(c1);

    palette[0] = 0xff000000 | (bb0 << 16) | (gg0 << 8) | r0;
    palette[1] = 0xff000000 | (bb1 << 16) | (gg1 << 8) | r1;

    if (forceFourColor || c0 > c1) {
        // 4-colour: c2 = 2/3·c0 + 1/3·c1, c3 = 1/3·c0 + 2/3·c1.
        const r2 = (2 * r0 + r1 + 1) / 3 | 0;
        const g2 = (2 * gg0 + gg1 + 1) / 3 | 0;
        const b2 = (2 * bb0 + bb1 + 1) / 3 | 0;
        const r3 = (r0 + 2 * r1 + 1) / 3 | 0;
        const g3 = (gg0 + 2 * gg1 + 1) / 3 | 0;
        const b3 = (bb0 + 2 * bb1 + 1) / 3 | 0;
        palette[2] = 0xff000000 | (b2 << 16) | (g2 << 8) | r2;
        palette[3] = 0xff000000 | (b3 << 16) | (g3 << 8) | r3;
    } else {
        // 3-colour + transparent black (BC1 1-bit alpha).
        const r2 = (r0 + r1) >> 1;
        const g2 = (gg0 + gg1) >> 1;
        const b2 = (bb0 + bb1) >> 1;
        palette[2] = 0xff000000 | (b2 << 16) | (g2 << 8) | r2;
        palette[3] = 0x00000000; // fully transparent
    }
}

/**
 * Decode a DXT1/DXT3/DXT5 surface to tightly-packed RGBA8 (bytesPerRow = width*4).
 *
 * @param src       compressed blocks
 * @param srcPitch  byte pitch of one block row in `src` (== dxtRowPitch)
 * @param dst       destination RGBA8 buffer (>= width*height*4 bytes)
 */
export function decodeDxtToRgba(
    format: number,
    src: Uint8Array,
    srcPitch: number,
    width: number,
    height: number,
    dst: Uint8Array
): void {
    const dst32 = new Uint32Array(dst.buffer, dst.byteOffset, width * height);
    const blockBytes = dxtBlockBytes(format);
    const bw = blocksWide(width);
    const bh = blocksHigh(height);
    const isDxt1 = format === D3DFMT_DXT1;
    const isDxt5 = format === D3DFMT_DXT4 || format === D3DFMT_DXT5;
    const isDxt3 = format === D3DFMT_DXT2 || format === D3DFMT_DXT3;

    const palette = new Uint32Array(4);
    const alpha = new Uint8Array(16); // per-texel alpha (BC2/BC3), texel-major
    const alphaPal = new Uint8Array(8); // BC3 8-entry alpha palette

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const blockOff = by * srcPitch + bx * blockBytes;
            let colorOff = blockOff;

            // ---- alpha sub-block (BC2/BC3 occupy the first 8 bytes) ----
            if (isDxt3) {
                for (let i = 0; i < 8; i++) {
                    const a = src[blockOff + i];
                    alpha[i * 2] = (a & 0x0f) * 17;       // 0..15 → 0..255
                    alpha[i * 2 + 1] = (a >> 4) * 17;
                }
                colorOff = blockOff + 8;
            } else if (isDxt5) {
                const a0 = src[blockOff];
                const a1 = src[blockOff + 1];
                alphaPal[0] = a0;
                alphaPal[1] = a1;
                if (a0 > a1) {
                    for (let i = 1; i < 7; i++) alphaPal[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
                } else {
                    for (let i = 1; i < 5; i++) alphaPal[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0;
                    alphaPal[6] = 0;
                    alphaPal[7] = 255;
                }
                // 16 × 3-bit indices packed in the 6 bytes after a0/a1.
                let bitLo = src[blockOff + 2] | (src[blockOff + 3] << 8) | (src[blockOff + 4] << 16);
                let bitHi = src[blockOff + 5] | (src[blockOff + 6] << 8) | (src[blockOff + 7] << 16);
                for (let i = 0; i < 8; i++) { alpha[i] = alphaPal[bitLo & 7]; bitLo >>>= 3; }
                for (let i = 8; i < 16; i++) { alpha[i] = alphaPal[bitHi & 7]; bitHi >>>= 3; }
                colorOff = blockOff + 8;
            }

            // ---- color sub-block (BC1; forced 4-colour for BC2/BC3) ----
            decodeColorPalette(src, colorOff, !isDxt1, palette);
            let bits =
                (src[colorOff + 4] |
                    (src[colorOff + 5] << 8) |
                    (src[colorOff + 6] << 16) |
                    (src[colorOff + 7] << 24)) >>> 0;

            const px0 = bx * 4;
            const py0 = by * 4;
            for (let ty = 0; ty < 4; ty++) {
                const y = py0 + ty;
                if (y >= height) { bits >>>= 8; continue; }
                let rowBits = bits & 0xff;
                bits >>>= 8;
                const dstRow = y * width;
                for (let tx = 0; tx < 4; tx++) {
                    const x = px0 + tx;
                    const ci = rowBits & 3;
                    rowBits >>= 2;
                    if (x >= width) continue;
                    let rgba = palette[ci];
                    if (isDxt3 || isDxt5) {
                        rgba = (rgba & 0x00ffffff) | (alpha[ty * 4 + tx] << 24);
                    }
                    dst32[dstRow + x] = rgba >>> 0;
                }
            }
        }
    }
}
