/** Per-window scroll bar state shared by user32 and comctl32 FlatSB. */

export type ScrollBarState = {
    min: number;
    max: number;
    page: number;
    pos: number;
    enabled: boolean;
    visible: boolean;
};

const scrollBarState = new Map<string, ScrollBarState>();

export const SIF_RANGE = 0x1;
export const SIF_PAGE = 0x2;
export const SIF_POS = 0x4;

function scrollBarKey(hwnd: number, bar: number): string {
    return `${hwnd >>> 0}:${bar | 0}`;
}

export function getScrollBarState(hwnd: number, bar: number): ScrollBarState {
    return scrollBarState.get(scrollBarKey(hwnd, bar)) ?? {
        min: 0,
        max: 100,
        page: 10,
        pos: 0,
        enabled: true,
        visible: true,
    };
}

export function setScrollBarState(hwnd: number, bar: number, state: ScrollBarState): void {
    scrollBarState.set(scrollBarKey(hwnd, bar), state);
}

export function getScrollPos(hwnd: number, bar: number): number {
    return getScrollBarState(hwnd, bar).pos;
}

export function setScrollPos(hwnd: number, bar: number, pos: number): number {
    const state = getScrollBarState(hwnd, bar);
    const prev = state.pos;
    state.pos = pos | 0;
    setScrollBarState(hwnd, bar, state);
    return prev;
}

export function setScrollRange(hwnd: number, bar: number, min: number, max: number): void {
    const state = getScrollBarState(hwnd, bar);
    state.min = min | 0;
    state.max = max | 0;
    setScrollBarState(hwnd, bar, state);
}

export function getScrollRange(mem: Uint8Array, hwnd: number, bar: number, lpMin: number, lpMax: number): boolean {
    if (!lpMin || !lpMax || lpMin + 4 > mem.length || lpMax + 4 > mem.length) return false;
    const state = getScrollBarState(hwnd, bar);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setInt32(lpMin, state.min, true);
    view.setInt32(lpMax, state.max, true);
    return true;
}

export function readScrollInfo(mem: Uint8Array, hwnd: number, bar: number, lpsi: number): boolean {
    if (!lpsi || lpsi + 24 > mem.length) return false;
    const state = getScrollBarState(hwnd, bar);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const cbSize = view.getUint32(lpsi, true);
    if (cbSize < 20) return false;
    const fMask = view.getUint32(lpsi + 4, true);
    if (fMask & SIF_RANGE) {
        view.setInt32(lpsi + 8, state.min, true);
        view.setInt32(lpsi + 12, state.max, true);
    }
    if (fMask & SIF_PAGE) {
        view.setUint32(lpsi + 16, state.page >>> 0, true);
    }
    if (fMask & SIF_POS) {
        view.setInt32(lpsi + 20, state.pos, true);
    }
    if (cbSize >= 28 && fMask & 0x10) {
        view.setInt32(lpsi + 24, state.pos, true);
    }
    return true;
}

export function applyScrollInfo(mem: Uint8Array, hwnd: number, bar: number, lpsi: number): number {
    if (!lpsi || lpsi + 24 > mem.length) return 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const cbSize = view.getUint32(lpsi, true);
    if (cbSize < 20) return 0;
    const fMask = view.getUint32(lpsi + 4, true);
    const state = getScrollBarState(hwnd, bar);
    const prevPos = state.pos;
    if (fMask & SIF_RANGE) {
        state.min = view.getInt32(lpsi + 8, true);
        state.max = view.getInt32(lpsi + 12, true);
    }
    if (fMask & SIF_PAGE) {
        state.page = view.getUint32(lpsi + 16, true);
    }
    if (fMask & SIF_POS) {
        state.pos = view.getInt32(lpsi + 20, true);
    }
    setScrollBarState(hwnd, bar, state);
    return prevPos;
}

export function resetScrollState(): void {
    scrollBarState.clear();
}
