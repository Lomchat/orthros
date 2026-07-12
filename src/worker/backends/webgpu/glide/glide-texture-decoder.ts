export const GLIDE_TEXFMT_RGB_332 = 0x00;
export const GLIDE_TEXFMT_YIQ_422 = 0x01;
export const GLIDE_TEXFMT_ALPHA_8 = 0x02;
export const GLIDE_TEXFMT_INTENSITY_8 = 0x03;
export const GLIDE_TEXFMT_ALPHA_INTENSITY_44 = 0x04;
export const GLIDE_TEXFMT_P_8 = 0x05;
export const GLIDE_TEXFMT_ARGB_8332 = 0x08;
export const GLIDE_TEXFMT_AYIQ_8422 = 0x09;
export const GLIDE_TEXFMT_RGB_565 = 0x0a;
export const GLIDE_TEXFMT_ARGB_1555 = 0x0b;
export const GLIDE_TEXFMT_ARGB_4444 = 0x0c;
export const GLIDE_TEXFMT_ALPHA_INTENSITY_88 = 0x0d;
export const GLIDE_TEXFMT_AP_88 = 0x0e;

/**
 * Decoded 3dfx NCC (Narrow Channel Compression / YIQ) table — GuNccTable from
 * glideutl.h: FxU8 yRGB[16]; FxI16 iRGB[4][3]; FxI16 qRGB[4][3]; FxU32 packed[12].
 */
export interface DecodedNccTable {
    yRGB: Uint8Array; // 16 luminance values
    iRGB: Int16Array; // [4][3] signed chroma (flattened: idx*3 + channel)
    qRGB: Int16Array; // [4][3] signed chroma
}

// Parse a 112-byte GuNccTable from guest memory bytes.
export function parseNccTable(bytes: Uint8Array): DecodedNccTable {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const yRGB = new Uint8Array(16);
    for (let i = 0; i < 16; i++) yRGB[i] = bytes[i] ?? 0;
    const iRGB = new Int16Array(12);
    const qRGB = new Int16Array(12);
    for (let i = 0; i < 12; i++) {
        iRGB[i] = bytes.length >= 16 + (i + 1) * 2 ? dv.getInt16(16 + i * 2, true) : 0;
        qRGB[i] = bytes.length >= 40 + (i + 1) * 2 ? dv.getInt16(40 + i * 2, true) : 0;
    }
    return { yRGB, iRGB, qRGB };
}

function clampByte(v: number): number {
    return Math.max(0, Math.min(255, v | 0));
}

// Decode one 8-bit YIQ texel via the NCC table: Y index = high 4 bits, I = bits
// [3:2], Q = bits [1:0]; RGB = clamp(Y + iRGB[I] + qRGB[Q]) per channel.
function decodeYiqTexel(texel: number, ncc: DecodedNccTable): [number, number, number] {
    const y = ncc.yRGB[(texel >> 4) & 0x0f] ?? 0;
    const ii = (texel >> 2) & 0x03;
    const qq = texel & 0x03;
    return [
        clampByte(y + (ncc.iRGB[ii * 3 + 0] ?? 0) + (ncc.qRGB[qq * 3 + 0] ?? 0)),
        clampByte(y + (ncc.iRGB[ii * 3 + 1] ?? 0) + (ncc.qRGB[qq * 3 + 1] ?? 0)),
        clampByte(y + (ncc.iRGB[ii * 3 + 2] ?? 0) + (ncc.qRGB[qq * 3 + 2] ?? 0)),
    ];
}

export function estimateTextureSizeBytes(width: number, height: number, format: number): number {
    const safeWidth = Math.max(1, width | 0);
    const safeHeight = Math.max(1, height | 0);
    switch (format | 0) {
        case GLIDE_TEXFMT_RGB_565:
        case GLIDE_TEXFMT_ARGB_1555:
        case GLIDE_TEXFMT_ARGB_4444:
        case GLIDE_TEXFMT_ARGB_8332:
        case GLIDE_TEXFMT_ALPHA_INTENSITY_88:
        case GLIDE_TEXFMT_AP_88:
        case GLIDE_TEXFMT_AYIQ_8422: // 16-bit: 8-bit alpha + 8-bit YIQ index
            return safeWidth * safeHeight * 2;
        case GLIDE_TEXFMT_RGB_332:
        case GLIDE_TEXFMT_YIQ_422: // 8-bit YIQ index
        case GLIDE_TEXFMT_ALPHA_8:
        case GLIDE_TEXFMT_INTENSITY_8:
        case GLIDE_TEXFMT_ALPHA_INTENSITY_44:
        case GLIDE_TEXFMT_P_8:
        default:
            return safeWidth * safeHeight;
    }
}

export function decodeGlideTexture(
    memory: Uint8Array,
    dataPtr: number,
    width: number,
    height: number,
    format: number,
    palette: Uint32Array | null = null,
    ncc: DecodedNccTable | null = null,
): Uint8Array {
    const safeWidth = Math.max(1, width | 0);
    const safeHeight = Math.max(1, height | 0);
    const out = new Uint8Array(safeWidth * safeHeight * 4);

    const readU16 = (offset: number): number => {
        if (offset < 0 || offset + 1 >= memory.length) return 0;
        return memory[offset] | (memory[offset + 1] << 8);
    };

    const readU32 = (offset: number): number => {
        if (offset < 0 || offset + 3 >= memory.length) return 0;
        return (
            memory[offset] |
            (memory[offset + 1] << 8) |
            (memory[offset + 2] << 16) |
            (memory[offset + 3] << 24)
        ) >>> 0;
    };

    for (let y = 0; y < safeHeight; y++) {
        for (let x = 0; x < safeWidth; x++) {
            const srcIndex = y * safeWidth + x;
            const dst = srcIndex * 4;

            if (format === GLIDE_TEXFMT_RGB_332) {
                const raw = memory[dataPtr + srcIndex] ?? 0;
                out[dst + 0] = ((raw >>> 5) & 0x07) * 255 / 7 | 0;
                out[dst + 1] = ((raw >>> 2) & 0x07) * 255 / 7 | 0;
                out[dst + 2] = (raw & 0x03) * 255 / 3 | 0;
                out[dst + 3] = 255;
                continue;
            }

            if (format === GLIDE_TEXFMT_YIQ_422) {
                const raw = memory[dataPtr + srcIndex] ?? 0;
                if (ncc) {
                    const c = decodeYiqTexel(raw, ncc);
                    out[dst + 0] = c[0];
                    out[dst + 1] = c[1];
                    out[dst + 2] = c[2];
                } else {
                    // No NCC table downloaded yet: fall back to luminance from the index.
                    out[dst + 0] = raw;
                    out[dst + 1] = raw;
                    out[dst + 2] = raw;
                }
                out[dst + 3] = 255;
                continue;
            }

            if (format === GLIDE_TEXFMT_AYIQ_8422) {
                const raw = readU16(dataPtr + srcIndex * 2);
                const yiq = raw & 0xff;
                const alpha = (raw >>> 8) & 0xff;
                if (ncc) {
                    const c = decodeYiqTexel(yiq, ncc);
                    out[dst + 0] = c[0];
                    out[dst + 1] = c[1];
                    out[dst + 2] = c[2];
                } else {
                    out[dst + 0] = yiq;
                    out[dst + 1] = yiq;
                    out[dst + 2] = yiq;
                }
                out[dst + 3] = alpha;
                continue;
            }

            if (format === GLIDE_TEXFMT_RGB_565) {
                const raw = readU16(dataPtr + srcIndex * 2);
                out[dst + 0] = (((raw >>> 11) & 0x1f) * 255 / 31) | 0;
                out[dst + 1] = (((raw >>> 5) & 0x3f) * 255 / 63) | 0;
                out[dst + 2] = ((raw & 0x1f) * 255 / 31) | 0;
                out[dst + 3] = 255;
                continue;
            }

            if (format === GLIDE_TEXFMT_ARGB_1555) {
                const raw = readU16(dataPtr + srcIndex * 2);
                out[dst + 0] = (((raw >>> 10) & 0x1f) * 255 / 31) | 0;
                out[dst + 1] = (((raw >>> 5) & 0x1f) * 255 / 31) | 0;
                out[dst + 2] = ((raw & 0x1f) * 255 / 31) | 0;
                out[dst + 3] = (raw & 0x8000) ? 255 : 0;
                continue;
            }

            if (format === GLIDE_TEXFMT_ARGB_4444) {
                const raw = readU16(dataPtr + srcIndex * 2);
                out[dst + 0] = ((raw >>> 8) & 0x0f) * 17;
                out[dst + 1] = ((raw >>> 4) & 0x0f) * 17;
                out[dst + 2] = (raw & 0x0f) * 17;
                out[dst + 3] = ((raw >>> 12) & 0x0f) * 17;
                continue;
            }

            if (format === GLIDE_TEXFMT_ARGB_8332) {
                const raw = readU16(dataPtr + srcIndex * 2);
                out[dst + 0] = ((raw >>> 5) & 0x07) * 255 / 7 | 0;
                out[dst + 1] = ((raw >>> 2) & 0x07) * 255 / 7 | 0;
                out[dst + 2] = (raw & 0x03) * 255 / 3 | 0;
                out[dst + 3] = (raw >>> 8) & 0xff;
                continue;
            }

            if (format === GLIDE_TEXFMT_ALPHA_8) {
                const a = memory[dataPtr + srcIndex] ?? 0;
                out[dst + 0] = 255;
                out[dst + 1] = 255;
                out[dst + 2] = 255;
                out[dst + 3] = a;
                continue;
            }

            if (format === GLIDE_TEXFMT_INTENSITY_8) {
                const i = memory[dataPtr + srcIndex] ?? 0;
                out[dst + 0] = i;
                out[dst + 1] = i;
                out[dst + 2] = i;
                out[dst + 3] = 255;
                continue;
            }

            if (format === GLIDE_TEXFMT_ALPHA_INTENSITY_44) {
                const raw = memory[dataPtr + srcIndex] ?? 0;
                const i = (raw & 0x0f) * 17;
                const a = ((raw >>> 4) & 0x0f) * 17;
                out[dst + 0] = i;
                out[dst + 1] = i;
                out[dst + 2] = i;
                out[dst + 3] = a;
                continue;
            }

            if (format === GLIDE_TEXFMT_ALPHA_INTENSITY_88) {
                const raw = readU16(dataPtr + srcIndex * 2);
                const i = raw & 0xff;
                const a = (raw >>> 8) & 0xff;
                out[dst + 0] = i;
                out[dst + 1] = i;
                out[dst + 2] = i;
                out[dst + 3] = a;
                continue;
            }

            if (format === GLIDE_TEXFMT_AP_88) {
                const raw = readU16(dataPtr + srcIndex * 2);
                const idx = raw & 0xff;
                const a = (raw >>> 8) & 0xff;
                if (palette) {
                    const c = palette[idx] >>> 0;
                    out[dst + 0] = (c >>> 16) & 0xff;
                    out[dst + 1] = (c >>> 8) & 0xff;
                    out[dst + 2] = c & 0xff;
                    out[dst + 3] = a;
                } else {
                    out[dst + 0] = idx;
                    out[dst + 1] = idx;
                    out[dst + 2] = idx;
                    out[dst + 3] = a;
                }
                continue;
            }

            if (format === GLIDE_TEXFMT_P_8 && palette) {
                const idx = memory[dataPtr + srcIndex] ?? 0;
                const raw = palette[idx] >>> 0;
                out[dst + 0] = (raw >>> 16) & 0xff;
                out[dst + 1] = (raw >>> 8) & 0xff;
                out[dst + 2] = raw & 0xff;
                out[dst + 3] = (raw >>> 24) & 0xff;
                continue;
            }

            // Fallback: grayscale from source byte
            const gray = clampByte(memory[dataPtr + srcIndex] ?? 0);
            out[dst + 0] = gray;
            out[dst + 1] = gray;
            out[dst + 2] = gray;
            out[dst + 3] = 255;
        }
    }

    return out;
}

// Glide 2.x: GR_LOD_256=0, GR_LOD_128=1, ..., GR_LOD_1=8
function lodToSize(lod: number): number {
    const table = [256, 128, 64, 32, 16, 8, 4, 2, 1];
    const idx = Math.max(0, Math.min(table.length - 1, lod | 0));
    return table[idx] ?? 64;
}

// Glide 2.x aspects are unsigned: 0=8:1, 1=4:1, 2=2:1, 3=1:1, 4=1:2, 5=1:4, 6=1:8
// LOD gives the max dimension; aspect shrinks the smaller axis.
export function computeTextureDimensions(lod: number, aspectRatio: number): { width: number; height: number } {
    const base = lodToSize(lod);
    const ar = aspectRatio | 0;
    if (ar < 3) {
        // Wider than tall: shrink height
        return { width: base, height: Math.max(1, base >> (3 - ar)) };
    } else if (ar > 3) {
        // Taller than wide: shrink width
        return { width: Math.max(1, base >> (ar - 3)), height: base };
    }
    return { width: base, height: base };
}
