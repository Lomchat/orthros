/**
 * MSVC C++ RTTI — __RTDynamicCast / __RTtypeid.
 * Implemented from the publicly documented 32-bit MSVC RTTI metadata layout
 * (CompleteObjectLocator at vftable[-1] → TypeDescriptor / ClassHierarchyDescriptor →
 * pre-order BaseClassArray whose entries carry PMD displacements) and standard
 * dynamic_cast semantics (down-cast from the source subobject, else cross-cast to a
 * visible unambiguous target).
 */
import type { ThunkImplementation, ThunkResult } from '../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../core/logger';
import { demangleTypeInfoName } from '../core/tools/msvc-demangle';

export { demangleTypeInfoName };

const BCD_NOTVISIBLE = 0x00000002;
const BCD_AMBIGUOUS = 0x00000004;

const CHD_MULTINH = 0x00000001;
const CHD_VIRTINH = 0x00000002;

/** BaseClassDescriptor (24-byte VC6-era layout — never require the trailing pCHD). */
interface BaseClassEntry {
    typeDescPtr: number;
    numContainedBases: number;
    /** PMD: member disp / vbtable-ptr disp (-1 = non-virtual) / vbtable slot disp. */
    mdisp: number;
    pdisp: number;
    vdisp: number;
    attributes: number;
}

function readTypeName(mem: Uint8Array, typeDescPtr: number): string {
    if (typeDescPtr < 0x1000 || typeDescPtr + 16 >= mem.length) return '';
    let name = '';
    for (let i = 0; i < 256; i++) {
        const off = typeDescPtr + 8 + i;
        if (off >= mem.length) break;
        const ch = mem[off];
        if (ch === 0) break;
        name += String.fromCharCode(ch);
    }
    return name;
}

// TypeDescriptors are compared by decorated name, not address: each module links
// its own copy of a shared type's descriptor.
function sameType(mem: Uint8Array, lhsPtr: number, rhsPtr: number): boolean {
    if (!lhsPtr || !rhsPtr) return false;
    if (lhsPtr === rhsPtr) return true;
    const lhsName = readTypeName(mem, lhsPtr);
    return lhsName.length > 0 && lhsName === readTypeName(mem, rhsPtr);
}

function readBaseClassEntry(mem: Uint8Array, dv: DataView, arrayPtr: number, index: number): BaseClassEntry | null {
    if (arrayPtr < 0x1000 || arrayPtr + 4 + index * 4 > mem.length) return null;
    const ptr = dv.getUint32(arrayPtr + index * 4, true);
    if (ptr < 0x1000 || ptr + 24 > mem.length) return null;
    return {
        typeDescPtr: dv.getUint32(ptr, true),
        numContainedBases: dv.getUint32(ptr + 4, true),
        mdisp: dv.getInt32(ptr + 8, true),
        pdisp: dv.getInt32(ptr + 12, true),
        vdisp: dv.getInt32(ptr + 16, true),
        attributes: dv.getUint32(ptr + 20, true),
    };
}

export function getCompleteObjectLocator(mem: Uint8Array, dv: DataView, inptr: number): number {
    if (inptr < 4 || inptr + 4 > mem.length) return 0;
    const vfptr = dv.getUint32(inptr, true);
    if (vfptr < 8 || vfptr > mem.length) return 0;
    return dv.getUint32(vfptr - 4, true);
}

/** Walk locator.offset back, then the vtordisp at [inptr - cdOffset] when present. */
function locateCompleteObject(mem: Uint8Array, dv: DataView, inptr: number, locatorPtr: number): number {
    if (locatorPtr < 0x1000 || locatorPtr + 12 > mem.length) return 0;
    const offset = dv.getUint32(locatorPtr + 4, true);
    const cdOffset = dv.getUint32(locatorPtr + 8, true);

    let vtordisp = 0;
    if (cdOffset > 0 && inptr >= cdOffset && inptr - cdOffset + 4 <= mem.length) {
        vtordisp = dv.getInt32(inptr - cdOffset, true);
    }
    return (inptr - offset - vtordisp) >>> 0;
}

/** A base class entry's subobject offset within the complete object (resolving the PMD). */
function subobjectOffset(mem: Uint8Array, dv: DataView, completeObject: number, entry: BaseClassEntry): number {
    let off = entry.mdisp;
    if (entry.pdisp >= 0) {
        // Virtual base: indirect through the vbtable the pdisp points at.
        const vbPtrAddr = (completeObject + entry.pdisp) >>> 0;
        if (vbPtrAddr + 4 > mem.length) return 0;
        const vbTable = dv.getUint32(vbPtrAddr, true);
        const slotAddr = (vbTable + entry.vdisp) >>> 0;
        if (slotAddr + 4 > mem.length) return 0;
        off += entry.pdisp + dv.getInt32(slotAddr, true);
    }
    return off;
}

interface Hierarchy {
    attributes: number;
    baseClassArrayPtr: number;
    nBases: number;
}

function readHierarchy(mem: Uint8Array, dv: DataView, locatorPtr: number): Hierarchy | null {
    if (locatorPtr < 0x1000 || locatorPtr + 20 > mem.length) return null;
    const chdPtr = dv.getUint32(locatorPtr + 16, true);
    if (chdPtr < 0x1000 || chdPtr + 16 > mem.length) return null;

    const attributes = dv.getUint32(chdPtr + 4, true);
    const nBases = dv.getUint32(chdPtr + 8, true);
    const baseClassArrayPtr = dv.getUint32(chdPtr + 12, true);
    if (!baseClassArrayPtr || nBases === 0 || nBases > 0xffff) return null;
    return { attributes, baseClassArrayPtr, nBases };
}

/**
 * Down-cast resolution. The BaseClassArray is a pre-order flattening: entry i's
 * subtree is the numContainedBases entries following it. A target-type entry
 * qualifies when the source subobject (matched by type AND by its offset within
 * the complete object) is in that subtree. With virtual inheritance one virtual
 * base can be reachable from several target instances — that is only unambiguous
 * if all qualifying instances resolve to the SAME subobject offset.
 */
const AMBIGUOUS = Symbol('ambiguous-cast');

function resolveDownCast(
    mem: Uint8Array,
    dv: DataView,
    completeObject: number,
    hier: Hierarchy,
    srcTypePtr: number,
    srcOffset: number,
    targetTypePtr: number,
): BaseClassEntry | null | typeof AMBIGUOUS {
    const virtual = (hier.attributes & CHD_VIRTINH) !== 0;
    let found: BaseClassEntry | null = null;

    for (let i = 0; i < hier.nBases; i++) {
        const candidate = readBaseClassEntry(mem, dv, hier.baseClassArrayPtr, i);
        if (!candidate || !sameType(mem, candidate.typeDescPtr, targetTypePtr)) continue;

        const subtreeEnd = Math.min(i + 1 + candidate.numContainedBases, hier.nBases);
        for (let j = i + 1; j < subtreeEnd; j++) {
            const sub = readBaseClassEntry(mem, dv, hier.baseClassArrayPtr, j);
            if (!sub) continue;
            if (!sameType(mem, sub.typeDescPtr, srcTypePtr)) continue;
            if (subobjectOffset(mem, dv, completeObject, sub) !== srcOffset) continue;

            if (!virtual) return candidate;
            if (found &&
                subobjectOffset(mem, dv, completeObject, found) !==
                subobjectOffset(mem, dv, completeObject, candidate)) {
                return AMBIGUOUS;
            }
            found = candidate;
            break;
        }
    }
    return found;
}

/** Cross-cast: any visible, unambiguous instance of the target type qualifies. */
function resolveCrossCast(
    mem: Uint8Array,
    dv: DataView,
    hier: Hierarchy,
    targetTypePtr: number,
): BaseClassEntry | null {
    for (let i = 0; i < hier.nBases; i++) {
        const entry = readBaseClassEntry(mem, dv, hier.baseClassArrayPtr, i);
        if (!entry) continue;
        if (sameType(mem, entry.typeDescPtr, targetTypePtr) &&
            !(entry.attributes & (BCD_NOTVISIBLE | BCD_AMBIGUOUS))) {
            return entry;
        }
    }
    return null;
}

export function rtDynamicCast(mem: Uint8Array, args: number[]): number | null {
    const inptr = args[0] >>> 0;
    const vfDelta = args[1] | 0;
    const srcTypePtr = args[2] >>> 0;
    const targetTypePtr = args[3] >>> 0;

    if (!inptr) return null;

    try {
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const locatorPtr = getCompleteObjectLocator(mem, dv, inptr);
        const completeObject = locateCompleteObject(mem, dv, inptr, locatorPtr);
        if (!completeObject || !locatorPtr) return null;

        const hier = readHierarchy(mem, dv, locatorPtr);
        if (!hier) return null;

        let target: BaseClassEntry | null;
        if ((hier.attributes & CHD_MULTINH) === 0) {
            // Single inheritance: the hierarchy is a linear chain, so any visible
            // instance of the target type is THE instance — the source type and
            // subobject offset are irrelevant.
            target = null;
            for (let i = 0; i < hier.nBases; i++) {
                const entry = readBaseClassEntry(mem, dv, hier.baseClassArrayPtr, i);
                if (entry && sameType(mem, entry.typeDescPtr, targetTypePtr) &&
                    !(entry.attributes & BCD_NOTVISIBLE)) {
                    target = entry;
                    break;
                }
            }
        } else {
            // inptr points at the vfptr the compiler dereferenced; vfDelta is that
            // vfptr's offset within the source subobject. Undo it: the subobject's
            // delta from the complete object identifies WHICH instance of the
            // source type we are casting from.
            const srcOffset = ((inptr - vfDelta) >>> 0) - completeObject | 0;
            const down = resolveDownCast(mem, dv, completeObject, hier, srcTypePtr, srcOffset, targetTypePtr);
            if (down === AMBIGUOUS) return null; // hard failure — never cross-cast an ambiguous base
            target = down ?? resolveCrossCast(mem, dv, hier, targetTypePtr);
        }

        if (!target) return null;
        return (completeObject + subobjectOffset(mem, dv, completeObject, target)) >>> 0;
    } catch (err) {
        Logger.warn(LogCategory.SYSTEM, `__RTDynamicCast: RTTI access failed: ${err}`);
        return null;
    }
}

export function registerRttiExports(
    exports: Record<string, ThunkImplementation>,
    host: { throwBadCast: () => ThunkResult; throwBadTypeid: () => ThunkResult },
): void {
    // WASM hypercall handler 77 handles the hot path; JS remains the fallback for bad_cast
    // (reference cast failure) and when hypercalls are disabled.
    exports['__RTDynamicCast'] = (_ctx, mem, args) => {
        const isReference = (args[4] | 0) !== 0;
        const result = rtDynamicCast(mem, args);
        Logger.verbose(
            LogCategory.SYSTEM,
            `__RTDynamicCast(in=0x${(args[0] >>> 0).toString(16)}, src=0x${(args[2] >>> 0).toString(16)}, ` +
            `tgt=0x${(args[3] >>> 0).toString(16)}, ref=${args[4]}) -> ` +
            (result === null ? 'FAIL' : `0x${result.toString(16)}`),
        );
        if (result === null) {
            if (isReference && (args[0] >>> 0) !== 0) return host.throwBadCast();
            return 0;
        }
        return result;
    };

    // type_info& __cdecl __RTtypeid(void *pv) — the typeid() operator on a polymorphic
    // (has-a-vtable) expression. pv's vtable[-1] slot is the RTTICompleteObjectLocator;
    // its pTypeDescriptor (+12) IS a type_info* (TypeDescriptor and type_info share layout:
    // +0 vfptr, +4 name-cache, +8 decorated name), so no separate type_info is constructed.
    exports['__RTtypeid'] = (_ctx, mem, args) => {
        const inptr = args[0] >>> 0;
        if (!inptr) {
            Logger.warn(LogCategory.SYSTEM, '__RTtypeid: null pointer -> bad_typeid');
            return host.throwBadTypeid();
        }
        try {
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const locatorPtr = getCompleteObjectLocator(mem, dv, inptr);
            if (locatorPtr < 0x1000 || locatorPtr + 16 > mem.length) {
                Logger.warn(LogCategory.SYSTEM,
                    `__RTtypeid: no valid CompleteObjectLocator for 0x${inptr.toString(16)} -> bad_typeid`);
                return host.throwBadTypeid();
            }
            return dv.getUint32(locatorPtr + 12, true) >>> 0; // pTypeDescriptor
        } catch (err) {
            Logger.warn(LogCategory.SYSTEM, `__RTtypeid: RTTI access failed: ${err}`);
            return host.throwBadTypeid();
        }
    };
}
