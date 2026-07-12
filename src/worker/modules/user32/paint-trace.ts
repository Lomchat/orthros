/**
 * Optional WM_PAINT diagnostics — disabled in production builds (no hot-path logging).
 *
 * Call sites guard on PAINT_TRACE_ENABLED so that, while disabled, no argument
 * objects/strings are built on the message-pump hot path. Flip to `true` (and
 * fill in real bodies below) when investigating WM_PAINT delivery.
 */
export const PAINT_TRACE_ENABLED = false;

export function isPaintTraceHwnd(_hwnd: number): boolean {
    return false;
}

export function logPaintTrace(_event: string, _detail: string): void {
    // no-op
}

export function logPaintMsgDelivered(
    _api: string,
    _hwnd: number,
    _message: number,
    _extra?: Record<string, string | number | boolean>,
): void {
    // no-op
}

export function logPaintPendingBlocked(
    _api: string,
    _msgMin: number,
    _msgMax: number,
    _remove: boolean,
): void {
    // no-op
}

export function logPaintPendingThreadMismatch(
    _api: string,
    _msgMin: number,
    _msgMax: number,
    _remove: boolean,
): void {
    // no-op
}

export function logBeginEndPaint(
    _api: 'BeginPaint' | 'EndPaint',
    _hWnd: number,
    _detail: string,
): void {
    // no-op
}
