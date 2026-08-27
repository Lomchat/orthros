/**
 * GDI text rendering — TextOut/DrawText canvas paths (escapement rotation,
 * OPAQUE background fills, DT_* alignment, linked-bitmap mirroring). Each
 * function takes the owning GDIContext as `gdi` and reads/writes its DC state.
 * Font/state selection stays in context.ts (SelectObject); this module only
 * renders with the already-selected state.
 */
import { Logger, LogCategory } from "../../core/logger";
import { drawTextPrefixOptions, fillTextWithMnemonic } from "../win32-text";
import type { GDIContext } from './context';

export function textOut(
    gdi: GDIContext,
    hdc: number,
    x: number,
    y: number,
    text: string,
    syncDib = true,
): boolean {
    if (!text) return false;
    const ctx = gdi.contexts.get(hdc);
    const state = gdi.hdcStates.get(hdc);
    if (!ctx || !state) {
        Logger.warn(LogCategory.GDI32, `textOut: Invalid HDC 0x${hdc.toString(16)} or state`);
        return false;
    }

    // Mark overlay as dirty if we're drawing to it
    const isOverlay = ctx === gdi.overlayCtx;
    if (isOverlay) {
        gdi.setOverlayDirty(true);
    }

    // Lazy apply font and text color
    if (state.appliedFont !== state.font) {
        ctx.font = state.font;
        state.appliedFont = state.font;
    }
    if (state.appliedFillStyle !== state.textColor) {
        ctx.fillStyle = state.textColor;
        state.appliedFillStyle = state.textColor;
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Apply rotation if escapement is set
    // lfEscapement is in tenths of degrees (0.1 degree units)
    // Convert to radians: angle_rad = (escapement / 10) * (π / 180)
    const hasRotation = state.textEscapement !== 0;

    if (hasRotation) {
        // Save transform instead of using save/restore to avoid resetting font/fillStyle
        const savedTransform = ctx.getTransform();

        // Move to text position and rotate
        ctx.translate(x, y);
        const angleRad = (state.textEscapement / 10) * (Math.PI / 180);
        ctx.rotate(angleRad);

        // Only draw background if OPAQUE mode (bkMode=2)
        // TRANSPARENT = 1, OPAQUE = 2
        if (state.bkMode === 2) {
            // Measure text to draw background
            const metrics = ctx.measureText(text);
            // Use cached font size to avoid regex parsing
            ctx.fillStyle = state.bkColor;
            state.appliedFillStyle = state.bkColor; // Mark fillStyle as changed
            ctx.fillRect(0, 0, metrics.width, state.fontSize);

            // Restore text color
            ctx.fillStyle = state.textColor;
            state.appliedFillStyle = state.textColor;
        }

        // Draw text at origin (0, 0) after rotation
        ctx.fillText(text, 0, 0);

        // Restore transform manually (doesn't reset font/fillStyle)
        ctx.setTransform(savedTransform);
    } else {
        // No rotation - draw normally
        // Only draw background if OPAQUE mode (bkMode=2)
        // TRANSPARENT = 1, OPAQUE = 2
        if (state.bkMode === 2) {
            // Measure text to draw background
            const metrics = ctx.measureText(text);
            // Use cached font size to avoid regex parsing
            ctx.fillStyle = state.bkColor;
            state.appliedFillStyle = state.bkColor;
            ctx.fillRect(x, y, metrics.width, state.fontSize);

            // Restore text color
            ctx.fillStyle = state.textColor;
            state.appliedFillStyle = state.textColor;
        }

        ctx.fillText(text, x, y);
    }

    // Mark as dirty for ReleaseDC optimization
    // Approximate text bounds for dirty rect tracking
    const metrics = ctx.measureText(text);
    const width = metrics.width;
    const height = state.fontSize * 1.5; // Safe margin

    if (state.textEscapement !== 0) {
        // Rotated text: use bounding box
        const radius = Math.max(width, height);
        gdi.expandDirtyRect(hdc, x - radius, y - radius, radius * 2, radius * 2);
    } else {
        gdi.expandDirtyRect(hdc, x, y, width, height);
    }
    gdi.markDirty(hdc);

    // Invalidate image data cache after drawing
    gdi.invalidateImageDataCache(hdc);

    // If this is a memory DC with linked bitmap, update the bitmap canvas
    const linkedBitmap = (ctx.canvas as any).__bitmapCanvas;
    if (linkedBitmap) {
        const bitmapCtx = linkedBitmap.getContext('2d');
        if (bitmapCtx) {
            // Apply same font and color
            if (state.appliedFont !== state.font) {
                bitmapCtx.font = state.font;
            }
            if (state.appliedFillStyle !== state.textColor) {
                bitmapCtx.fillStyle = state.textColor;
            }
            bitmapCtx.textBaseline = 'top';
            bitmapCtx.textAlign = 'left';

            if (hasRotation) {
                bitmapCtx.save();
                bitmapCtx.translate(x, y);
                const angleRad = (state.textEscapement / 10) * (Math.PI / 180);
                bitmapCtx.rotate(angleRad);
                if (state.bkMode === 2) {
                    const metrics = bitmapCtx.measureText(text);
                    bitmapCtx.fillStyle = state.bkColor;
                    bitmapCtx.fillRect(0, 0, metrics.width, state.fontSize);
                    bitmapCtx.fillStyle = state.textColor;
                }
                bitmapCtx.fillText(text, 0, 0);
                bitmapCtx.restore();
            } else {
                if (state.bkMode === 2) {
                    const metrics = bitmapCtx.measureText(text);
                    bitmapCtx.fillStyle = state.bkColor;
                    bitmapCtx.fillRect(x, y, metrics.width, state.fontSize);
                    bitmapCtx.fillStyle = state.textColor;
                }
                bitmapCtx.fillText(text, x, y);
            }
        }
    }

    // CreateDIBSection exposes its pixels directly to the guest. Text rendered
    // through a memory DC must therefore be committed before ExtTextOut returns.
    // ExtTextOut may draw one glyph at a time when lpDx is supplied. Its public
    // API boundary batches those draws and commits the DIB once; doing a full
    // canvas readback after every glyph turns font-atlas construction into a
    // multi-hundred-millisecond stall. Direct TextOut callers keep the faithful
    // immediate commit by default.
    if (syncDib) gdi.syncSelectedDibBits(hdc, 'TextOut');

    return true;
}

export function drawText(gdi: GDIContext, hdc: number, text: string, rect?: { left: number; top: number; right: number; bottom: number }, format?: number): boolean {
    if (!text) return false;
    const ctx = gdi.contexts.get(hdc);
    const state = gdi.hdcStates.get(hdc);
    if (!ctx || !state) {
        Logger.warn(LogCategory.GDI32, `drawText: Invalid HDC 0x${hdc.toString(16)} or state`);
        return false;
    }

    // Mark overlay as dirty if we're drawing to it
    const isOverlay = ctx === gdi.overlayCtx;
    if (isOverlay) {
        gdi.setOverlayDirty(true);
    }

    // Lazy apply font and text color
    if (state.appliedFont !== state.font) {
        ctx.font = state.font;
        state.appliedFont = state.font;
    }
    if (state.appliedFillStyle !== state.textColor) {
        ctx.fillStyle = state.textColor;
        state.appliedFillStyle = state.textColor;
    }

    // Only draw background if OPAQUE mode (bkMode=2) and rect provided
    // TRANSPARENT = 1, OPAQUE = 2
    if (state.bkMode === 2 && rect) {
        ctx.fillStyle = state.bkColor;
        state.appliedFillStyle = state.bkColor;
        ctx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);

        // Restore text color
        ctx.fillStyle = state.textColor;
        state.appliedFillStyle = state.textColor;
    }

    ctx.textBaseline = 'top';

    // DrawText format flags
    const DT_CENTER = 0x01;
    const DT_RIGHT = 0x02;
    const DT_VCENTER = 0x04;
    const DT_BOTTOM = 0x08;
    const prefixOptions = drawTextPrefixOptions(format);

    let x = rect ? rect.left : 0;
    let y = rect ? rect.top : 0;

    // Handle horizontal alignment
    if (rect && format !== undefined) {
        if (format & DT_CENTER) {
            ctx.textAlign = 'center';
            x = rect.left + (rect.right - rect.left) / 2;
        } else if (format & DT_RIGHT) {
            ctx.textAlign = 'right';
            x = rect.right;
        } else {
            ctx.textAlign = 'left';
        }

        // Handle vertical alignment
        if (format & DT_VCENTER) {
            ctx.textBaseline = 'middle';
            y = rect.top + (rect.bottom - rect.top) / 2;
        } else if (format & DT_BOTTOM) {
            ctx.textBaseline = 'bottom';
            y = rect.bottom;
        }
    }

    fillTextWithMnemonic(ctx, text, x, y, prefixOptions);

    // Reset alignment
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // Mark as dirty for ReleaseDC optimization
    gdi.markDirty(hdc);

    // Invalidate image data cache after drawing
    gdi.invalidateImageDataCache(hdc);

    // If this is a memory DC with linked bitmap, update the bitmap canvas
    const linkedBitmap = (ctx.canvas as any).__bitmapCanvas;
    if (linkedBitmap) {
        const bitmapCtx = linkedBitmap.getContext('2d');
        if (bitmapCtx) {
            // Apply same settings and draw
            if (state.appliedFont !== state.font) {
                bitmapCtx.font = state.font;
            }
            if (state.appliedFillStyle !== state.textColor) {
                bitmapCtx.fillStyle = state.textColor;
            }
            bitmapCtx.textBaseline = 'top';
            bitmapCtx.textAlign = 'left';

            if (rect && format !== undefined) {
                if (format & DT_CENTER) {
                    bitmapCtx.textAlign = 'center';
                } else if (format & DT_RIGHT) {
                    bitmapCtx.textAlign = 'right';
                }
                if (format & DT_VCENTER) {
                    bitmapCtx.textBaseline = 'middle';
                } else if (format & DT_BOTTOM) {
                    bitmapCtx.textBaseline = 'bottom';
                }
            }

            if (state.bkMode === 2 && rect) {
                bitmapCtx.fillStyle = state.bkColor;
                bitmapCtx.fillRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
                bitmapCtx.fillStyle = state.textColor;
            }

            fillTextWithMnemonic(bitmapCtx, text, x, y, prefixOptions);
            bitmapCtx.textAlign = 'left';
            bitmapCtx.textBaseline = 'top';
        }
    }

    gdi.syncSelectedDibBits(hdc, 'DrawText');

    return true;
}
