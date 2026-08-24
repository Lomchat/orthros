import { describe, expect, test } from "bun:test";
import { InputManager } from "../../src/worker/runtime/input/input-manager";

function makeInputManager(): { input: InputManager; view: Int32Array } {
    const win = {
        hwnd: 1,
        visible: true,
        rect: { x: 0, y: 0, width: 1024, height: 768 },
    };
    const windowManager = {
        getKeyboardTargetWindow: () => win,
        getMouseTargetWindow: () => win,
        getActiveHwnd: () => 1,
        postMessage: () => undefined,
    };
    const input = new InputManager(windowManager as never);
    const buffer = new SharedArrayBuffer(32 * Int32Array.BYTES_PER_ELEMENT);
    const view = new Int32Array(buffer);
    input.setInputBuffer(buffer);
    return { input, view };
}

describe("InputManager harness mouse injection", () => {
    test("keeps absolute and DirectInput-relative movement in lockstep", () => {
        const { input, view } = makeInputManager();
        view[1] = 10; // mouseX
        view[2] = 20; // mouseY

        expect(input.injectMoveAtScreen(40, 60)).toBe(true);
        expect(input.getMouseState()).toEqual({ x: 40, y: 60, buttons: 0 });
        expect(input.getDInputAccum()).toEqual({ x: 30, y: 40 });

        // A button edge at the same point is not additional mouse movement.
        expect(input.injectButtonAtScreen(40, 60, 0, true)).toBe(true);
        expect(input.getDInputAccum()).toEqual({ x: 30, y: 40 });

        // clickAt also feeds the raw relative path used by DirectInput games.
        expect(input.injectClickAtScreen(50, 70)).toBe(true);
        expect(input.getDInputAccum()).toEqual({ x: 40, y: 50 });
    });
});
