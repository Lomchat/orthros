/**
 * GDI32 device-context state: coordinate-space mapping, world transform, clipping
 * queries, and the printing/doc spool stubs. Mapping/clip/print handlers (mostly
 * faithful stubs) with no rendering.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';

// ---------------------------------------------------------------------------
// Region handle store
// ---------------------------------------------------------------------------
// Lightweight HRGN registry: maps handle → bounding rect {left,top,right,bottom}.
// This is intentionally minimal — we don't model complex polygonal regions, but
// we do track the bounding rectangle so that GetRgnBox, CombineRgn, OffsetRgn,
// and SetRectRgn can return coherent data to callers.
interface RegionRect { left: number; top: number; right: number; bottom: number; }

const _regionStore = new Map<number, RegionRect>();
let _nextRgnHandle = 0x70000001; // distinct from HDC/HGDIOBJ/HPALETTE ranges

function _rgnAlloc(left: number, top: number, right: number, bottom: number): number {
    const h = _nextRgnHandle++;
    _regionStore.set(h, { left, top, right, bottom });
    return h;
}

/** RegionType constants returned by region functions */
const NULLREGION   = 1;
const SIMPLEREGION = 2;
const COMPLEXREGION = 3;
const ERROR_REGION  = 0;

function _classifyRegion(r: RegionRect): number {
    if (r.left >= r.right || r.top >= r.bottom) return NULLREGION;
    return SIMPLEREGION;
}

export function registerPaintingDcStateExports(exports: Record<string, ThunkImplementation>): void {
    // Coordinate transformations and mapping
    exports['SetMapMode'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iMode = args[1];
        Logger.verbose(LogCategory.GDI32, `SetMapMode(hdc=0x${hdc.toString(16)}, mode=${iMode})`);
        // Stub: return old mode (MM_TEXT = 1)
        return 1;
    };

    // BOOL ModifyWorldTransform(HDC hdc, const XFORM *lpXform, DWORD iMode)
    // MWT_IDENTITY=1, MWT_LEFTMULTIPLY=2, MWT_RIGHTMULTIPLY=3
    exports['ModifyWorldTransform'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iMode = args[2];
        Logger.verbose(LogCategory.GDI32, `ModifyWorldTransform(hdc=0x${hdc.toString(16)}, mode=${iMode}) — stub`);
        return 1; // success
    };

    exports['SetViewportOrgEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const lppt = args[3];
        Logger.verbose(LogCategory.GDI32, `SetViewportOrgEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        if (lppt) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lppt, 0, true);     // old x
            view.setInt32(lppt + 4, 0, true); // old y
        }
        return 1; // success
    };

    exports['SetViewportExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const lpsz = args[3];
        Logger.verbose(LogCategory.GDI32, `SetViewportExtEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        if (lpsz) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpsz, 640, true);     // old cx
            view.setInt32(lpsz + 4, 480, true); // old cy
        }
        return 1; // success
    };

    exports['SetWindowExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const lpsz = args[3];
        Logger.verbose(LogCategory.GDI32, `SetWindowExtEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        if (lpsz) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpsz, 640, true);     // old cx
            view.setInt32(lpsz + 4, 480, true); // old cy
        }
        return 1; // success
    };

    exports['OffsetViewportOrgEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const lppt = args[3];
        Logger.verbose(LogCategory.GDI32, `OffsetViewportOrgEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        if (lppt) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lppt, 0, true);     // old x
            view.setInt32(lppt + 4, 0, true); // old y
        }
        return 1; // success
    };

    exports['ScaleViewportExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const xNum = args[1] | 0;
        const xDenom = args[2] | 0;
        const yNum = args[3] | 0;
        const yDenom = args[4] | 0;
        const lpsz = args[5];
        Logger.verbose(LogCategory.GDI32, `ScaleViewportExtEx(hdc=0x${hdc.toString(16)}, ${xNum}/${xDenom}, ${yNum}/${yDenom})`);
        if (lpsz) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpsz, 640, true);     // old cx
            view.setInt32(lpsz + 4, 480, true); // old cy
        }
        return 1; // success
    };

    exports['ScaleWindowExtEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const xNum = args[1] | 0;
        const xDenom = args[2] | 0;
        const yNum = args[3] | 0;
        const yDenom = args[4] | 0;
        const lpsz = args[5];
        Logger.verbose(LogCategory.GDI32, `ScaleWindowExtEx(hdc=0x${hdc.toString(16)}, ${xNum}/${xDenom}, ${yNum}/${yDenom})`);
        if (lpsz) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lpsz, 640, true);     // old cx
            view.setInt32(lpsz + 4, 480, true); // old cy
        }
        return 1; // success
    };

    exports['DPtoLP'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lppt = args[1];
        const c = args[2];
        Logger.verbose(LogCategory.GDI32, `DPtoLP(hdc=0x${hdc.toString(16)}, count=${c})`);
        // Stub: identity transformation (no change to points)
        return 1; // success
    };

    // Clipping and visibility
    exports['GetClipBox'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lprect = args[1];
        Logger.verbose(LogCategory.GDI32, `GetClipBox(hdc=0x${hdc.toString(16)})`);
        // Stub: return full screen rect
        if (lprect) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lprect, 0, true);       // left
            view.setInt32(lprect + 4, 0, true);   // top
            view.setInt32(lprect + 8, 640, true); // right
            view.setInt32(lprect + 12, 480, true);// bottom
        }
        return 1; // SIMPLEREGION
    };

    exports['IntersectClipRect'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const left = args[1] | 0;
        const top = args[2] | 0;
        const right = args[3] | 0;
        const bottom = args[4] | 0;
        Logger.verbose(LogCategory.GDI32, `IntersectClipRect(hdc=0x${hdc.toString(16)}, ${left},${top},${right},${bottom})`);
        return 1; // SIMPLEREGION
    };

    exports['ExcludeClipRect'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const left = args[1] | 0;
        const top = args[2] | 0;
        const right = args[3] | 0;
        const bottom = args[4] | 0;
        Logger.verbose(LogCategory.GDI32, `ExcludeClipRect(hdc=0x${hdc.toString(16)}, ${left},${top},${right},${bottom})`);
        return 1; // SIMPLEREGION
    };

    exports['PtVisible'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        Logger.verbose(LogCategory.GDI32, `PtVisible(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        return 1; // visible
    };

    exports['RectVisible'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lprect = args[1];
        Logger.verbose(LogCategory.GDI32, `RectVisible(hdc=0x${hdc.toString(16)})`);
        return 1; // visible
    };

    // Printing support
    exports['StartDocA'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const lpdi = args[1];
        Logger.verbose(LogCategory.GDI32, `StartDocA(hdc=0x${hdc.toString(16)})`);
        // Stub: return positive job ID
        return 1;
    };

    exports['EndDoc'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `EndDoc(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['AbortDoc'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `AbortDoc(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['StartPage'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `StartPage(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['EndPage'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `EndPage(hdc=0x${hdc.toString(16)})`);
        return 1; // success
    };

    exports['SetAbortProc'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const proc = args[1];
        Logger.verbose(LogCategory.GDI32, `SetAbortProc(hdc=0x${hdc.toString(16)}, proc=0x${proc.toString(16)})`);
        return 1; // success
    };

    exports['Escape'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const iEscape = args[1];
        const cjIn = args[2];
        const pvIn = args[3];
        const pvOut = args[4];
        Logger.verbose(LogCategory.GDI32, `Escape(hdc=0x${hdc.toString(16)}, escape=${iEscape})`);
        // Stub: return 0 (not supported for most escape codes)
        return 0;
    };

    exports['GdiFlush'] = (ctx, mem, args): number => {
        // Flush GDI batched operations - always succeeds in our emulator
        Logger.verbose(LogCategory.GDI32, 'GdiFlush()');
        return 1; // TRUE
    };

    exports['RectInRegion'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const lprc = args[1];
        Logger.verbose(LogCategory.GDI32, `RectInRegion(hRgn=0x${hRgn.toString(16)}, lprc=0x${lprc.toString(16)})`);
        // Stub: assume rectangle intersects region
        return 1; // TRUE
    };

    exports['OffsetClipRgn'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        Logger.verbose(LogCategory.GDI32, `OffsetClipRgn(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        return 1; // SIMPLEREGION
    };

    exports['OffsetWindowOrgEx'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const x = args[1] | 0;
        const y = args[2] | 0;
        const lppt = args[3];
        Logger.verbose(LogCategory.GDI32, `OffsetWindowOrgEx(hdc=0x${hdc.toString(16)}, ${x}, ${y})`);
        if (lppt) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lppt, 0, true);
            view.setInt32(lppt + 4, 0, true);
        }
        return 1;
    };

    exports['SetRectRgn'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const left  = args[1] | 0;
        const top   = args[2] | 0;
        const right = args[3] | 0;
        const bottom = args[4] | 0;
        Logger.verbose(
            LogCategory.GDI32,
            `SetRectRgn(hRgn=0x${hRgn.toString(16)}, ${left},${top},${right},${bottom})`,
        );
        // Update stored bounds if we own this handle, otherwise accept silently.
        if (_regionStore.has(hRgn)) {
            _regionStore.set(hRgn, { left, top, right, bottom });
        }
        return 1;
    };

    // -----------------------------------------------------------------------
    // Region creation / combination / query
    // -----------------------------------------------------------------------

    // HRGN CreateRectRgn(int x1, int y1, int x2, int y2)
    exports['CreateRectRgn'] = (ctx, mem, args): number => {
        const left   = args[0] | 0;
        const top    = args[1] | 0;
        const right  = args[2] | 0;
        const bottom = args[3] | 0;
        const h = _rgnAlloc(left, top, right, bottom);
        Logger.verbose(LogCategory.GDI32,
            `CreateRectRgn(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateRectRgnIndirect(const RECT *lprect)
    exports['CreateRectRgnIndirect'] = (ctx, mem, args): number => {
        const lprect = args[0];
        if (!lprect || lprect + 16 > mem.length) return 0;
        const view   = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left   = view.getInt32(lprect,      true);
        const top    = view.getInt32(lprect +  4, true);
        const right  = view.getInt32(lprect +  8, true);
        const bottom = view.getInt32(lprect + 12, true);
        const h = _rgnAlloc(left, top, right, bottom);
        Logger.verbose(LogCategory.GDI32,
            `CreateRectRgnIndirect(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h) — store as rect
    exports['CreateRoundRectRgn'] = (ctx, mem, args): number => {
        const left   = args[0] | 0;
        const top    = args[1] | 0;
        const right  = args[2] | 0;
        const bottom = args[3] | 0;
        const h = _rgnAlloc(left, top, right, bottom);
        Logger.verbose(LogCategory.GDI32,
            `CreateRoundRectRgn(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateEllipticRgn(int x1, int y1, int x2, int y2) — store as bounding rect
    exports['CreateEllipticRgn'] = (ctx, mem, args): number => {
        const left   = args[0] | 0;
        const top    = args[1] | 0;
        const right  = args[2] | 0;
        const bottom = args[3] | 0;
        const h = _rgnAlloc(left, top, right, bottom);
        Logger.verbose(LogCategory.GDI32,
            `CreateEllipticRgn(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreateEllipticRgnIndirect(const RECT *lprect)
    exports['CreateEllipticRgnIndirect'] = (ctx, mem, args): number => {
        const lprect = args[0];
        if (!lprect || lprect + 16 > mem.length) return 0;
        const view   = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const left   = view.getInt32(lprect,      true);
        const top    = view.getInt32(lprect +  4, true);
        const right  = view.getInt32(lprect +  8, true);
        const bottom = view.getInt32(lprect + 12, true);
        const h = _rgnAlloc(left, top, right, bottom);
        Logger.verbose(LogCategory.GDI32,
            `CreateEllipticRgnIndirect(${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // HRGN CreatePolygonRgn(const POINT *pptl, int cPoint, int iMode) — store convex bounding rect
    exports['CreatePolygonRgn'] = (ctx, mem, args): number => {
        const pptl   = args[0];
        const cPoint = args[1] | 0;
        if (!pptl || cPoint <= 0 || pptl + cPoint * 8 > mem.length) {
            return _rgnAlloc(0, 0, 0, 0);
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let left = 0x7FFFFFFF, top = 0x7FFFFFFF, right = -0x80000000, bottom = -0x80000000;
        for (let i = 0; i < cPoint; i++) {
            const x = view.getInt32(pptl + i * 8,     true);
            const y = view.getInt32(pptl + i * 8 + 4, true);
            if (x < left)   left   = x;
            if (y < top)    top    = y;
            if (x > right)  right  = x;
            if (y > bottom) bottom = y;
        }
        const h = _rgnAlloc(left, top, right, bottom);
        Logger.verbose(LogCategory.GDI32,
            `CreatePolygonRgn(${cPoint} pts, bbox ${left},${top},${right},${bottom}) -> 0x${h.toString(16)}`);
        return h;
    };

    // int CombineRgn(HRGN hrgnDst, HRGN hrgnSrc1, HRGN hrgnSrc2, int fnCombineMode)
    // Combine modes: RGN_AND=1, RGN_OR=2, RGN_XOR=3, RGN_DIFF=4, RGN_COPY=5
    exports['CombineRgn'] = (ctx, mem, args): number => {
        const hrgnDst  = args[0];
        const hrgnSrc1 = args[1];
        const hrgnSrc2 = args[2];
        const fnMode   = args[3] | 0;

        const src1 = _regionStore.get(hrgnSrc1) ?? { left: 0, top: 0, right: 0, bottom: 0 };
        const src2 = _regionStore.get(hrgnSrc2) ?? { left: 0, top: 0, right: 0, bottom: 0 };

        let dst: RegionRect;
        const RGN_AND = 1, RGN_OR = 2, RGN_XOR = 3, RGN_DIFF = 4, RGN_COPY = 5;

        switch (fnMode) {
            case RGN_COPY:
                dst = { ...src1 };
                break;
            case RGN_OR:
                // Bounding box of union
                dst = {
                    left:   Math.min(src1.left,   src2.left),
                    top:    Math.min(src1.top,    src2.top),
                    right:  Math.max(src1.right,  src2.right),
                    bottom: Math.max(src1.bottom, src2.bottom),
                };
                break;
            case RGN_AND:
                // Intersection
                dst = {
                    left:   Math.max(src1.left,   src2.left),
                    top:    Math.max(src1.top,    src2.top),
                    right:  Math.min(src1.right,  src2.right),
                    bottom: Math.min(src1.bottom, src2.bottom),
                };
                break;
            case RGN_DIFF:
                // Approximate: use src1's bounds when src2 is empty/disjoint, else clip
                dst = { ...src1 };
                break;
            default: // RGN_XOR and unknown: use union as conservative approximation
                dst = {
                    left:   Math.min(src1.left,   src2.left),
                    top:    Math.min(src1.top,    src2.top),
                    right:  Math.max(src1.right,  src2.right),
                    bottom: Math.max(src1.bottom, src2.bottom),
                };
                break;
        }

        // Write result into hrgnDst (which must already be a valid handle or we create one)
        if (_regionStore.has(hrgnDst)) {
            _regionStore.set(hrgnDst, dst);
        } else {
            // Some callers pass an hRgn created via CreateRectRgn(0,0,0,0); register it lazily.
            _regionStore.set(hrgnDst, dst);
        }

        const result = _classifyRegion(dst);
        Logger.verbose(LogCategory.GDI32,
            `CombineRgn(dst=0x${hrgnDst.toString(16)}, src1=0x${hrgnSrc1.toString(16)}, src2=0x${hrgnSrc2.toString(16)}, mode=${fnMode}) -> ${result}`);
        return result;
    };

    // int OffsetRgn(HRGN hrgn, int x, int y)
    exports['OffsetRgn'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const x    = args[1] | 0;
        const y    = args[2] | 0;
        const r = _regionStore.get(hRgn);
        if (!r) {
            Logger.verbose(LogCategory.GDI32, `OffsetRgn(0x${hRgn.toString(16)}, ${x}, ${y}) — unknown handle`);
            return ERROR_REGION;
        }
        r.left   += x; r.right  += x;
        r.top    += y; r.bottom += y;
        const result = _classifyRegion(r);
        Logger.verbose(LogCategory.GDI32,
            `OffsetRgn(0x${hRgn.toString(16)}, ${x}, ${y}) -> ${result} [${r.left},${r.top},${r.right},${r.bottom}]`);
        return result;
    };

    // int GetRgnBox(HRGN hrgn, LPRECT lprc)
    // Returns the bounding rectangle of a region into *lprc.
    // Return value: NULLREGION (1), SIMPLEREGION (2), COMPLEXREGION (3), or 0 on error.
    exports['GetRgnBox'] = (ctx, mem, args): number => {
        const hRgn = args[0];
        const lprc = args[1];

        if (!hRgn || !lprc || lprc + 16 > mem.length) {
            Logger.verbose(LogCategory.GDI32,
                `GetRgnBox(0x${hRgn.toString(16)}, 0x${lprc.toString(16)}) -> ERROR (null/out-of-bounds)`);
            return ERROR_REGION;
        }

        const r = _regionStore.get(hRgn);
        if (!r) {
            // Unknown handle — write a zeroed RECT and return NULLREGION.
            Logger.verbose(LogCategory.GDI32,
                `GetRgnBox(0x${hRgn.toString(16)}) — unknown handle, returning NULLREGION`);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setInt32(lprc,      0, true);
            view.setInt32(lprc +  4, 0, true);
            view.setInt32(lprc +  8, 0, true);
            view.setInt32(lprc + 12, 0, true);
            return NULLREGION;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt32(lprc,      r.left,   true);
        view.setInt32(lprc +  4, r.top,    true);
        view.setInt32(lprc +  8, r.right,  true);
        view.setInt32(lprc + 12, r.bottom, true);

        const result = _classifyRegion(r);
        Logger.verbose(LogCategory.GDI32,
            `GetRgnBox(0x${hRgn.toString(16)}) -> ${result} [${r.left},${r.top},${r.right},${r.bottom}]`);
        return result;
    };

    exports['SetColorAdjustment'] = (ctx, mem, args): number => {
        const hdc = args[0];
        Logger.verbose(LogCategory.GDI32, `SetColorAdjustment(hdc=0x${hdc.toString(16)}) — stub`);
        return 1;
    };

    exports['SetMapperFlags'] = (ctx, mem, args): number => {
        const hdc = args[0];
        const flags = args[1] >>> 0;
        Logger.verbose(LogCategory.GDI32, `SetMapperFlags(hdc=0x${hdc.toString(16)}, flags=0x${flags.toString(16)}) — stub`);
        return 0; // previous flags
    };
}
