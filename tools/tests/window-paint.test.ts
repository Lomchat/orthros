/**
 * Window paint fidelity harness — invalid regions, child Z-order, overlay repair hooks.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
    invalidateWindow,
    validateWindow,
    hasPendingUpdate,
    getWindowUpdateBounds,
    getWindowUpdateRects,
    consumeNeedsErase,
    clearWindowUpdate,
    removeWindowUpdate,
} from '../../src/worker/modules/user32/paint-region';
import {
    windows,
    reorderChildInParent,
    getChildZOrderSibling,
    getChildrenInPaintOrder,
    setLockWindowUpdate,
    isWindowUpdateLocked,
    type WindowInfo,
} from '../../src/worker/modules/user32/shared-state';

function mkWin(handle: number, w = 100, h = 80): WindowInfo {
    return {
        handle,
        title: 't',
        style: 0,
        x: 0,
        y: 0,
        width: w,
        height: h,
        children: [],
        visible: true,
        wndProc: 0,
    };
}

describe('paint-region invalid areas', () => {
    const HWND = 0x10001;

    beforeEach(() => {
        windows.clear();
        removeWindowUpdate(HWND);
        windows.set(HWND, mkWin(HWND));
    });

    test('InvalidateRect NULL marks full client', () => {
        invalidateWindow(HWND, null, false);
        expect(hasPendingUpdate(HWND)).toBe(true);
        const b = getWindowUpdateBounds(HWND)!;
        expect(b).toEqual({ left: 0, top: 0, right: 100, bottom: 80 });
    });

    test('partial invalidation unions into bounding box', () => {
        invalidateWindow(HWND, { left: 10, top: 10, right: 50, bottom: 40 }, false);
        invalidateWindow(HWND, { left: 60, top: 20, right: 90, bottom: 70 }, true);
        const b = getWindowUpdateBounds(HWND)!;
        expect(b.left).toBe(10);
        expect(b.top).toBe(10);
        expect(b.right).toBe(90);
        expect(b.bottom).toBe(70);
        expect(consumeNeedsErase(HWND)).toBe(true);
    });

    test('ValidateRect partial subtracts from update region', () => {
        invalidateWindow(HWND, { left: 0, top: 0, right: 100, bottom: 80 }, false);
        validateWindow(HWND, { left: 0, top: 0, right: 50, bottom: 80 });
        const rects = getWindowUpdateRects(HWND);
        expect(rects.length).toBe(1);
        expect(rects[0].left).toBe(50);
    });

    test('ValidateRect NULL clears update region', () => {
        invalidateWindow(HWND, null, false);
        validateWindow(HWND, null);
        expect(hasPendingUpdate(HWND)).toBe(false);
    });

    test('BeginPaint clears update region', () => {
        invalidateWindow(HWND, null, true);
        expect(consumeNeedsErase(HWND)).toBe(true);
        clearWindowUpdate(HWND);
        expect(hasPendingUpdate(HWND)).toBe(false);
    });
});

describe('child Z-order helpers', () => {
    const PARENT = 0x10000;
    const A = 0x10001;
    const B = 0x10002;
    const C = 0x10003;

    beforeEach(() => {
        windows.clear();
        windows.set(PARENT, { ...mkWin(PARENT), children: [A, B, C] });
        windows.set(A, { ...mkWin(A), parent: PARENT });
        windows.set(B, { ...mkWin(B), parent: PARENT });
        windows.set(C, { ...mkWin(C), parent: PARENT });
    });

    test('paint order is back to front', () => {
        expect(getChildrenInPaintOrder(PARENT)).toEqual([C, B, A]);
    });

    test('SetWindowPos Z-order reorder', () => {
        reorderChildInParent(A, B);
        expect(windows.get(PARENT)!.children).toEqual([B, A, C]);
        expect(getChildZOrderSibling(A, 'prev')).toBe(B);
        expect(getChildZOrderSibling(A, 'next')).toBe(C);
    });

    test('HWND_TOP moves child to front', () => {
        reorderChildInParent(A, 0);
        expect(getChildrenInPaintOrder(PARENT)[0]).toBe(A);
    });
});

describe('LockWindowUpdate', () => {
    const ROOT = 0x10000;
    const CHILD = 0x10001;

    beforeEach(() => {
        windows.clear();
        setLockWindowUpdate(0);
        windows.set(ROOT, { ...mkWin(ROOT), children: [CHILD] });
        windows.set(CHILD, { ...mkWin(CHILD), parent: ROOT });
    });

    test('locks subtree', () => {
        setLockWindowUpdate(ROOT);
        expect(isWindowUpdateLocked(ROOT)).toBe(true);
        expect(isWindowUpdateLocked(CHILD)).toBe(true);
        expect(isWindowUpdateLocked(0x99999)).toBe(false);
        setLockWindowUpdate(0);
        expect(isWindowUpdateLocked(ROOT)).toBe(false);
    });
});
