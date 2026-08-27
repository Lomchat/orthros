/**
 * Copy Canvas2D RGBA pixels into a guest-visible 24/32-bit DIBSection.
 *
 * The 24-bit path compacts into the ImageData buffer first and then uses one
 * bulk TypedArray copy per row. Direct byte stores into WebAssembly memory are
 * surprisingly expensive in Chromium, even for a 64x64 font atlas.
 * `rgba` is scratch and is intentionally mutated by the 24-bit path.
 */
export function copyCanvasRgbaToDib(
    mem: Uint8Array,
    bitsPtr: number,
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    stride: number,
    bpp: 24 | 32,
    topDown: boolean,
): void {
    if (bpp === 24) {
        let compact = 0;
        for (let y = 0; y < height; y++) {
            let src = y * width * 4;
            const rowEnd = compact + stride;
            for (let x = 0; x < width; x++) {
                const red = rgba[src];
                rgba[compact++] = rgba[src + 2];
                rgba[compact++] = rgba[src + 1];
                rgba[compact++] = red;
                src += 4;
            }
            while (compact < rowEnd) rgba[compact++] = 0;
        }
        for (let y = 0; y < height; y++) {
            const dstY = topDown ? y : height - 1 - y;
            const src = y * stride;
            mem.set(rgba.subarray(src, src + stride), bitsPtr + dstY * stride);
        }
        return;
    }

    // DIB32 and ImageData are both tightly packed in all observed callers.
    // Swap R/B with 32-bit stores when alignment permits, retaining the exact
    // row fallback for unusual padded or unaligned DIBs.
    if ((bitsPtr & 3) === 0 && stride === width * 4) {
        const src32 = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
        const dst32 = new Uint32Array(mem.buffer, mem.byteOffset + bitsPtr, width * height);
        for (let y = 0; y < height; y++) {
            const dstY = topDown ? y : height - 1 - y;
            let src = y * width;
            let dst = dstY * width;
            for (let x = 0; x < width; x++) {
                const pixel = src32[src++];
                dst32[dst++] = (pixel & 0xff00ff00) | ((pixel & 0xff) << 16) | ((pixel >>> 16) & 0xff);
            }
        }
        return;
    }

    for (let y = 0; y < height; y++) {
        const dstY = topDown ? y : height - 1 - y;
        let src = y * width * 4;
        let dst = bitsPtr + dstY * stride;
        for (let x = 0; x < width; x++) {
            mem[dst++] = rgba[src + 2];
            mem[dst++] = rgba[src + 1];
            mem[dst++] = rgba[src];
            mem[dst++] = rgba[src + 3];
            src += 4;
        }
        const rowEnd = bitsPtr + dstY * stride + stride;
        while (dst < rowEnd) mem[dst++] = 0;
    }
}
