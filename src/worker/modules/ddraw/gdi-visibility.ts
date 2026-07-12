/**
 * DirectDraw cooperative-level GDI visibility (exclusive fullscreen semantics).
 */

import type { DDrawContext } from './context';
import type { RenderActive } from '../../runtime/runtime-services';

export const DDSCL_NORMAL = 0x00000000;
export const DDSCL_FULLSCREEN = 0x00000001;
export const DDSCL_EXCLUSIVE = 0x00000010;
export const DDSCL_EXCLUSIVE_FULLSCREEN = DDSCL_FULLSCREEN | DDSCL_EXCLUSIVE;

export function isDDrawExclusiveFullscreen(ddrawCtx: DDrawContext | null | undefined): boolean {
    if (!ddrawCtx) return false;
    return ((ddrawCtx.cooperative?.flags ?? 0) & DDSCL_EXCLUSIVE_FULLSCREEN) === DDSCL_EXCLUSIVE_FULLSCREEN;
}

/** GDI desktop surface hidden while the flip chain owns the screen. */
export function isGdiSurfaceHidden(ddrawCtx: DDrawContext | null | undefined): boolean {
    return isDDrawExclusiveFullscreen(ddrawCtx) && ddrawCtx!.gdiSurfaceVisible === false;
}

/** A hardware-3D presenter owns the screen, so GDI overlay compositing (window-background
 *  paints, etc.) must not black out the rendered frame. Two cases:
 *   - Pure D3D8/D3D9/Glide/OpenGL game with NO DirectDraw 2D primary in play → the 3D
 *     renderer always owns the screen (no DDraw surface to compose with).
 *   - A 3D renderer layered over a DirectDraw primary (D3D7-era) → only owns the screen in
 *     DDraw exclusive fullscreen; windowed DDraw still composes GDI.
 *  Without this, a fullscreen D3D9 game (which never sets a DDraw cooperative level) had its
 *  frame clobbered every other present by the GDI loop compositing a black bg paint → flicker. */
export function shouldSuppress3DGdiOverlay(
    renderActive: RenderActive | null,
    ddrawCtx: DDrawContext | null | undefined,
): boolean {
    if (!(renderActive as { suppressGdiOverlay?: boolean } | null)?.suppressGdiOverlay) return false;
    const ddrawHasPrimary = !!(ddrawCtx as { surfaces?: { primary?: number } } | null | undefined)?.surfaces?.primary;
    if (!ddrawHasPrimary) return true; // pure 3D presenter — it owns the canvas outright
    return isDDrawExclusiveFullscreen(ddrawCtx);
}
