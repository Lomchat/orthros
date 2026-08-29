/**
 * Bounded flight recorder for failed graphics HRESULTs.
 *
 * The general WinAPI ring is intentionally short and is quickly overwritten by
 * a game's crash reporter.  Graphics failures are rare, so retaining only their
 * name, HRESULT, caller and first arguments gives us the actual triggering API
 * without adding allocation or string work to successful render calls.
 */

export interface GraphicsHresultFailure {
    api: string;
    hresult: number;
    caller: number;
    args: number[];
    seq: number;
    detail?: string;
}

const GRAPHICS_PREFIXES = ["d3d9:", "d3dx9:", "d3d8:", "ddraw:", "d3d:"];
const MAX_FAILURES = 128;

let failures: GraphicsHresultFailure[] = [];
let sequence = 0;

export function recordGraphicsHresultFailure(
    api: string,
    hresult: number,
    caller: number,
    args: ArrayLike<number>,
    argCount: number,
    detail?: string,
): void {
    const hr = hresult >>> 0;
    if ((hr & 0x80000000) === 0) return;
    const lower = api.toLowerCase();
    if (!GRAPHICS_PREFIXES.some((prefix) => lower.startsWith(prefix))) return;

    const copiedArgs: number[] = [];
    const count = Math.min(6, Math.max(0, argCount | 0), args.length);
    for (let i = 0; i < count; i++) copiedArgs.push(args[i]! >>> 0);
    failures.push({
        api,
        hresult: hr,
        caller: caller >>> 0,
        args: copiedArgs,
        seq: ++sequence,
        ...(detail ? { detail: detail.slice(0, 1024) } : {}),
    });
    if (failures.length > MAX_FAILURES) failures = failures.slice(-MAX_FAILURES);
}

export function getGraphicsHresultFailures(): GraphicsHresultFailure[] {
    return failures.map((failure) => ({ ...failure, args: [...failure.args] }));
}

export function resetGraphicsHresultFailures(): void {
    failures = [];
    sequence = 0;
}
