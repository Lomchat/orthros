import { describe, expect, test } from "bun:test";
import {
  advanceVirtualPointer,
  BFME_DOUBLE_ESCAPE_WINDOW_MS,
  canvasCursorStyle,
  computeGameCursorPlacement,
  decideBfmeEscapeKeyDown,
  wantsRelativePointer,
} from "../../src/app/pointer-policy";

describe("host pointer policy", () => {
  test("BFME always arms click-to-capture while ordinary absolute games do not", () => {
    const absolute = { cursorVisible: true, cursorClipped: false, mouseCaptured: false };
    expect(wantsRelativePointer("bfme", absolute)).toBe(true);
    expect(wantsRelativePointer("revolt", absolute)).toBe(false);
    expect(wantsRelativePointer("revolt", { ...absolute, cursorClipped: true })).toBe(true);
    expect(wantsRelativePointer("revolt", { ...absolute, mouseCaptured: true })).toBe(true);
    expect(wantsRelativePointer("revolt", { ...absolute, cursorVisible: false })).toBe(true);
  });

  test("BFME hides the host arrow only over the game canvas", () => {
    expect(canvasCursorStyle("bfme", true, true, true)).toBe("none");
    expect(canvasCursorStyle("bfme", true, true, false)).toBe("");
    expect(canvasCursorStyle("bfme", false, true)).toBe("");
    expect(canvasCursorStyle("revolt", true, true)).toBe("");
    expect(canvasCursorStyle("revolt", true, false)).toBe("none");
  });

  test("positions a hotspot-aligned game cursor over a scaled canvas", () => {
    expect(computeGameCursorPlacement(
      { x: 400, y: 300 },
      { width: 32, height: 32, hotspotX: 2, hotspotY: 2 },
      { left: 100, top: 50, width: 1600, height: 1200 },
      { left: 20, top: 10 },
      800,
      600,
    )).toEqual({ left: 876, top: 636, width: 64, height: 64 });
  });

  test("relative movement advances and clamps the virtual guest cursor", () => {
    expect(advanceVirtualPointer({ x: 100, y: 50 }, 10, -5, 2, 3, 800, 600))
      .toEqual({ x: 120, y: 35 });
    expect(advanceVirtualPointer({ x: 795, y: 2 }, 20, -20, 1, 1, 800, 600))
      .toEqual({ x: 799, y: 0 });
  });

  test("uses two physical Escape presses only when Keyboard Lock owns Escape", () => {
    const first = decideBfmeEscapeKeyDown(10_000, 0, true, false);
    expect(first).toEqual({
      action: "forward",
      armedUntil: 10_000 + BFME_DOUBLE_ESCAPE_WINDOW_MS,
    });
    expect(decideBfmeEscapeKeyDown(10_500, first.armedUntil, true, false))
      .toEqual({ action: "release-pointer", armedUntil: 0 });

    // Outside fullscreen/Keyboard Lock, Pointer Lock's browser escape gesture wins.
    expect(decideBfmeEscapeKeyDown(10_000, 0, false, false))
      .toEqual({ action: "forward", armedUntil: 0 });
  });

  test("does not treat key repeat or a late press as the second Escape", () => {
    const armedUntil = 10_000 + BFME_DOUBLE_ESCAPE_WINDOW_MS;
    expect(decideBfmeEscapeKeyDown(10_100, armedUntil, true, true))
      .toEqual({ action: "ignore-repeat", armedUntil });
    expect(decideBfmeEscapeKeyDown(armedUntil + 1, armedUntil, true, false))
      .toEqual({
        action: "forward",
        armedUntil: armedUntil + 1 + BFME_DOUBLE_ESCAPE_WINDOW_MS,
      });
  });
});
