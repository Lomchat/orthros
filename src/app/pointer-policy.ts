export interface RelativePointerSignals {
  cursorVisible: boolean;
  cursorClipped: boolean;
  mouseCaptured: boolean;
}

export const BFME_DOUBLE_ESCAPE_WINDOW_MS = 1_200;

export type BfmeEscapeAction = "forward" | "release-pointer" | "ignore-repeat";

export interface BfmeEscapeDecision {
  action: BfmeEscapeAction;
  armedUntil: number;
}

/**
 * Pointer Lock reserves Escape as the browser's unlock gesture unless fullscreen
 * Keyboard Lock has successfully captured it. In that stronger mode, the first
 * physical press remains a guest key and arms a short second-press escape hatch.
 * Auto-repeat must never count as the second press: holding Escape is the user
 * agent's mandatory emergency way out of Keyboard Lock.
 */
export function decideBfmeEscapeKeyDown(
  now: number,
  armedUntil: number,
  canDeferBrowserUnlock: boolean,
  repeat: boolean,
): BfmeEscapeDecision {
  if (!canDeferBrowserUnlock) return { action: "forward", armedUntil: 0 };
  if (repeat) {
    return {
      action: "ignore-repeat",
      armedUntil: armedUntil > now ? armedUntil : 0,
    };
  }
  if (armedUntil > now) return { action: "release-pointer", armedUntil: 0 };
  return {
    action: "forward",
    armedUntil: now + BFME_DOUBLE_ESCAPE_WINDOW_MS,
  };
}

/**
 * BFME is an absolute-pointer RTS, but host pointer-lock still gives it a stable
 * virtual absolute cursor: browser deltas advance a position clamped in guest
 * pixels. Other games retain the faithful Win32/DirectInput capture signals.
 */
export function wantsRelativePointer(gameId: string | null, signals: RelativePointerSignals): boolean {
  return gameId === "bfme" || !signals.cursorVisible || signals.cursorClipped || signals.mouseCaptured;
}

/** The guest cursor owns BFME while captured; releasing capture restores the host arrow. */
export function canvasCursorStyle(
  gameId: string | null,
  hovered: boolean,
  cursorVisible: boolean,
  pointerLocked = false,
): string {
  if (!hovered) return "";
  if (gameId === "bfme") return pointerLocked ? "none" : "";
  return cursorVisible ? "" : "none";
}

export function computeGameCursorPlacement(
  pointer: { x: number; y: number },
  frame: { width: number; height: number; hotspotX: number; hotspotY: number },
  canvas: { left: number; top: number; width: number; height: number },
  panel: { left: number; top: number },
  pointerWidth: number,
  pointerHeight: number,
): { left: number; top: number; width: number; height: number } {
  const scaleX = canvas.width / Math.max(1, pointerWidth);
  const scaleY = canvas.height / Math.max(1, pointerHeight);
  return {
    left: canvas.left - panel.left + (pointer.x - frame.hotspotX) * scaleX,
    top: canvas.top - panel.top + (pointer.y - frame.hotspotY) * scaleY,
    width: frame.width * scaleX,
    height: frame.height * scaleY,
  };
}

export function advanceVirtualPointer(
  current: { x: number; y: number },
  movementX: number,
  movementY: number,
  scaleX: number,
  scaleY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(Math.max(0, width - 1), current.x + movementX * scaleX)),
    y: Math.max(0, Math.min(Math.max(0, height - 1), current.y + movementY * scaleY)),
  };
}
