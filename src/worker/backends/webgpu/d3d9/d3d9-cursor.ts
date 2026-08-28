/**
 * Small, allocation-free helpers for the D3D9 hardware cursor path.
 *
 * D3D cursor coordinates are expressed in backbuffer pixels and identify the
 * hotspot, not the top-left of the cursor bitmap.  The compositor therefore
 * has to subtract the hotspot and clip both destination geometry and source
 * UVs when the cursor straddles an edge.
 */

export interface D3D9CursorBlitRect {
    x: number;
    y: number;
    width: number;
    height: number;
    u0: number;
    v0: number;
    u1: number;
    v1: number;
}

export function computeD3D9CursorBlitRect(
    cursorX: number,
    cursorY: number,
    cursorWidth: number,
    cursorHeight: number,
    hotspotX: number,
    hotspotY: number,
    targetWidth: number,
    targetHeight: number,
): D3D9CursorBlitRect | null {
    if (cursorWidth <= 0 || cursorHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
        return null;
    }

    const left = cursorX - hotspotX;
    const top = cursorY - hotspotY;
    const right = left + cursorWidth;
    const bottom = top + cursorHeight;

    const clippedLeft = Math.max(0, left);
    const clippedTop = Math.max(0, top);
    const clippedRight = Math.min(targetWidth, right);
    const clippedBottom = Math.min(targetHeight, bottom);
    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return null;

    return {
        x: clippedLeft,
        y: clippedTop,
        width: clippedRight - clippedLeft,
        height: clippedBottom - clippedTop,
        u0: (clippedLeft - left) / cursorWidth,
        v0: (clippedTop - top) / cursorHeight,
        u1: (clippedRight - left) / cursorWidth,
        v1: (clippedBottom - top) / cursorHeight,
    };
}

/**
 * The shared WebGPU overlay pipeline uses premultiplied-alpha blending
 * (ONE, ONE_MINUS_SRC_ALPHA). D3DFMT_A8R8G8B8 cursor pixels are straight
 * alpha, so premultiply the copied snapshot exactly once at upload time.
 */
export function premultiplyD3D9CursorRgba(pixels: Uint8Array): void {
    for (let i = 0; i + 3 < pixels.length; i += 4) {
        const alpha = pixels[i + 3]!;
        if (alpha === 255) continue;
        if (alpha === 0) {
            pixels[i] = 0;
            pixels[i + 1] = 0;
            pixels[i + 2] = 0;
            continue;
        }
        pixels[i] = Math.round((pixels[i]! * alpha) / 255);
        pixels[i + 1] = Math.round((pixels[i + 1]! * alpha) / 255);
        pixels[i + 2] = Math.round((pixels[i + 2]! * alpha) / 255);
    }
}
