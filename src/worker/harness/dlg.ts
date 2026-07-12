/**
 * Harness-local dialog helpers. Self-contained equivalents of the
 * dbg-commands dlg helpers, depending only on the exported user32 `windows` map +
 * getAbsoluteWindowPosition — so the harness owns its dialog resolution and does
 * not reach into the debug console module. GLOBAL/screen coords throughout.
 */

import { windows, getAbsoluteWindowPosition, type WindowInfo } from "../modules/user32/shared-state";

/** One described control/window with GLOBAL rect + click center. */
export interface DlgControlInfo {
    hwnd: number;
    id: number | null;
    title: string;
    cls: string;
    x: number; y: number; w: number; h: number;
    cx: number; cy: number;
    visible: boolean;
    customPaint: boolean;
}

export function describeDlgControl(hwnd: number, w: WindowInfo): DlgControlInfo {
    const abs = getAbsoluteWindowPosition(w);
    const width = w.width ?? 0, height = w.height ?? 0;
    return {
        hwnd,
        id: w.controlId ?? null,
        title: w.title ?? "",
        cls: w.systemControlClass || w.nativeClassName || (w.children?.length ? "window" : ""),
        x: abs.x, y: abs.y, w: width, h: height,
        cx: abs.x + (width >> 1), cy: abs.y + (height >> 1),
        visible: !!w.visible,
        customPaint: !!w.guestCustomPaint,
    };
}

/** Resolve a target: HWND or control id (number), or title substring (string,
 *  prefers a visible match). */
export function findDlgControl(target: string | number): { hwnd: number; win: WindowInfo } | undefined {
    if (typeof target === "number") {
        const t = target >>> 0;
        const byHwnd = windows.get(t);
        if (byHwnd) return { hwnd: t, win: byHwnd };
        for (const [hwnd, w] of windows) if ((w.controlId ?? -1) === target) return { hwnd, win: w };
        return undefined;
    }
    const needle = String(target).trim().toLowerCase();
    let hidden: { hwnd: number; win: WindowInfo } | undefined;
    for (const [hwnd, w] of windows) {
        if (!(w.title ?? "").toLowerCase().includes(needle)) continue;
        if (w.visible) return { hwnd, win: w };
        if (!hidden) hidden = { hwnd, win: w };
    }
    return hidden;
}
