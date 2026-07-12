/** Inspect the leading bytes of a large GlobalAlloc buffer after guest I/O. */

export interface GlobalBufferVerifyResult {
    hex16: string;
    magic: string;
    details: string;
    allZero: boolean;
}

function hexSlice(bytes: Uint8Array, len: number): string {
    const n = Math.min(len, bytes.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        out.push(bytes[i]!.toString(16).padStart(2, '0'));
    }
    return out.join(' ');
}

function asciiMagic(bytes: Uint8Array, len: number): string {
    let s = '';
    for (let i = 0; i < len && i < bytes.length; i++) {
        const c = bytes[i]!;
        s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.';
    }
    return s;
}

function readU16LE(bytes: Uint8Array, off: number): number {
    return bytes[off]! | (bytes[off + 1]! << 8);
}

function readU32LE(bytes: Uint8Array, off: number): number {
    return (
        (bytes[off]! |
            (bytes[off + 1]! << 8) |
            (bytes[off + 2]! << 16) |
            (bytes[off + 3]! << 24)) >>>
        0
    );
}

function readI32LE(bytes: Uint8Array, off: number): number {
    return readU32LE(bytes, off) | 0;
}

export function verifyGlobalBuffer(bytes: Uint8Array): GlobalBufferVerifyResult {
    const sampleLen = Math.min(64, bytes.length);
    const sample = bytes.subarray(0, sampleLen);
    const hex16 = hexSlice(sample, 16);
    const allZero = sampleLen > 0 && sample.every((b) => b === 0);

    // Raw DIB (BITMAPINFOHEADER without 14-byte BMP file header) — common after GlobalAlloc+strip
    if (sampleLen >= 16) {
        const biSize = readU32LE(sample, 0);
        if (biSize === 0x28 || biSize === 0x0c || biSize === 0x7c) {
            const biWidth = readI32LE(sample, 4);
            const biHeight = readI32LE(sample, 8);
            const biBitCount = readU16LE(sample, 14);
            return {
                hex16,
                magic: 'DIB',
                details: `DIB biSize=${biSize} ${biWidth}x${Math.abs(biHeight)} bpp=${biBitCount}`,
                allZero,
            };
        }
    }

    if (sampleLen >= 2 && sample[0] === 0x42 && sample[1] === 0x4d) {
        if (sampleLen >= 30) {
            const bfSize = readU32LE(sample, 2);
            const biWidth = readI32LE(sample, 18);
            const biHeight = readI32LE(sample, 22);
            const biBitCount = readU16LE(sample, 28);
            return {
                hex16,
                magic: 'BM',
                details: `BMP bfSize=${bfSize} ${biWidth}x${Math.abs(biHeight)} bpp=${biBitCount}`,
                allZero,
            };
        }
        return { hex16, magic: 'BM', details: 'BMP (header truncated in sample)', allZero };
    }

    if (sampleLen >= 4 && sample[0] === 0x52 && sample[1] === 0x49 && sample[2] === 0x46 && sample[3] === 0x46) {
        const riffSize = sampleLen >= 8 ? readU32LE(sample, 4) : 0;
        const form = sampleLen >= 12 ? asciiMagic(sample, 4).slice(8, 12) : '????';
        return {
            hex16,
            magic: 'RIFF',
            details: `RIFF size=${riffSize} form=${form.trim()}`,
            allZero,
        };
    }

    if (sampleLen >= 2 && sample[0] === 0x78 && (sample[1] === 0x01 || sample[1] === 0x9c || sample[1] === 0xda)) {
        return { hex16, magic: 'ZLIB', details: 'zlib/deflate stream', allZero };
    }

    if (sampleLen >= 4 && sample[0] === 0x50 && sample[1] === 0x4b) {
        return { hex16, magic: 'PK', details: 'ZIP/PK archive signature', allZero };
    }

    const magic = asciiMagic(sample, Math.min(4, sampleLen));
    return {
        hex16,
        magic: magic || '(empty)',
        details: allZero ? 'all-zero sample — read may not have landed' : 'unrecognized format',
        allZero,
    };
}
