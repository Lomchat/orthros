/**
 * Large I/O tracing — disabled by default (enable via dbg when needed).
 *
 * Call sites guard on LARGE_IO_TRACE_ENABLED so that, while disabled, the
 * path/position arguments are not gathered on every read.
 */
export const LARGE_IO_TRACE_ENABLED = false;

export const LARGE_IO_TRACE_MIN_BYTES = 64 * 1024;

export type LargeIoApi = 'ReadFile' | '_read' | 'fread';

export function shouldTraceLargeIo(_requested: number, _got: number): boolean {
    return false;
}

export function traceLargeRead(
    _api: LargeIoApi,
    _path: string,
    _handle: number,
    _pos: number,
    _requested: number,
    _got: number,
): void {
    // no-op
}
