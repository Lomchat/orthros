import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { System } from "../core/system";
import { Mem } from "../core/memory/mem-accessor";

const S_OK = 0x00000000;
const E_INVALIDARG = 0x80070057;
const DISP_E_TYPEMISMATCH = 0x80020005;
const DISP_E_OVERFLOW = 0x8002000a;

const VT_EMPTY = 0;
const VT_I2 = 2;
const VT_I4 = 3;
const VT_R4 = 4;
const VT_R8 = 5;
const VT_CY = 6;
const VT_BSTR = 8;
const VT_BOOL = 11;
const VT_UI4 = 19;
const VT_TYPEMASK = 0x0fff;

const VARCMP_LT = 0;
const VARCMP_EQ = 1;
const VARCMP_GT = 2;

function vt(mem: Uint8Array, p: number): number {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return view.getUint16(p, true) & VT_TYPEMASK;
}

function clear(mem: Uint8Array, p: number): void {
    if (!p || p + 16 > mem.length) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (vt(mem, p) === VT_BSTR) {
        const bstr = view.getUint32(p + 8, true);
        if (bstr >= 4) System.getInstance().process?.memory?.free(bstr - 4);
    }
    mem.fill(0, p, p + 16);
}

function asR8(mem: Uint8Array, p: number): number | null {
    if (!p || p + 16 > mem.length) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const t = vt(mem, p);
    switch (t) {
        case VT_I2: return view.getInt16(p + 8, true);
        case VT_I4: return view.getInt32(p + 8, true);
        case VT_UI4: return view.getUint32(p + 8, true);
        case VT_BOOL: return view.getUint32(p + 8, true) ? -1 : 0;
        case VT_R4: return view.getFloat32(p + 8, true);
        case VT_R8: return view.getFloat64(p + 8, true);
        case VT_CY: return Number(view.getBigInt64(p + 8, true)) / 10000;
        case VT_BSTR: {
            const bstr = view.getUint32(p + 8, true);
            if (!bstr) return 0;
            let s = "";
            let i = 0;
            while (bstr + i * 2 + 1 < mem.length) {
                const ch = view.getUint16(bstr + i * 2, true);
                if (!ch) break;
                s += String.fromCharCode(ch);
                i++;
            }
            const n = parseFloat(s);
            return Number.isNaN(n) ? null : n;
        }
        case VT_EMPTY:
            return 0;
        default:
            return null;
    }
}

function writeR8(mem: Uint8Array, p: number, v: number): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(p, VT_R8, true);
    view.setFloat64(p + 8, v, true);
}

function writeI4(mem: Uint8Array, p: number, v: number): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(p, VT_I4, true);
    view.setInt32(p + 8, v | 0, true);
}

function writeBool(mem: Uint8Array, p: number, v: boolean): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(p, VT_BOOL, true);
    view.setUint32(p + 8, v ? 0xffffffff : 0, true);
}

function allocBstr(mem: Uint8Array, text: string): number {
    const alloc = (size: number) => System.getInstance().process?.memory?.alloc(size) ?? 0;
    const wcharLen = text.length;
    const totalSize = 4 + wcharLen * 2 + 2;
    const block = alloc(totalSize);
    if (!block) return 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(block, wcharLen * 2, true);
    for (let i = 0; i < wcharLen; i++) {
        view.setUint16(block + 4 + i * 2, text.charCodeAt(i), true);
    }
    view.setUint16(block + 4 + wcharLen * 2, 0, true);
    return block + 4;
}

function readWide(mem: Uint8Array, addr: number): string {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let out = "";
    let p = addr;
    while (p + 1 < mem.length) {
        const ch = view.getUint16(p, true);
        if (!ch) break;
        out += String.fromCharCode(ch);
        p += 2;
    }
    return out;
}

function binaryOp(
    mem: Uint8Array,
    left: number,
    right: number,
    result: number,
    op: (a: number, b: number) => number,
): number {
    if (!left || !right || !result) return E_INVALIDARG;
    const a = asR8(mem, left);
    const b = asR8(mem, right);
    if (a === null || b === null) return DISP_E_TYPEMISMATCH;
    clear(mem, result);
    writeR8(mem, result, op(a, b));
    return S_OK;
}

export function createVariantOpExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const bin = (op: (a: number, b: number) => number) =>
        (_ctx: unknown, mem: Uint8Array, args: number[]) =>
            binaryOp(mem, args[0] >>> 0, args[1] >>> 0, args[2] >>> 0, op);

    exports["VarAdd"] = bin((a, b) => a + b);
    exports["VarSub"] = bin((a, b) => a - b);
    exports["VarMul"] = bin((a, b) => a * b);
    exports["VarDiv"] = bin((a, b) => (b === 0 ? NaN : a / b));
    exports["VarMod"] = bin((a, b) => (b === 0 ? NaN : a % b));
    exports["VarIdiv"] = bin((a, b) => (b === 0 ? NaN : Math.trunc(a / b)));

    exports["VarAnd"] = (_ctx, mem, args) => {
        const left = args[0] >>> 0;
        const right = args[1] >>> 0;
        const result = args[2] >>> 0;
        const a = asR8(mem, left);
        const b = asR8(mem, right);
        if (a === null || b === null) return DISP_E_TYPEMISMATCH;
        clear(mem, result);
        writeI4(mem, result, (a | 0) & (b | 0));
        return S_OK;
    };
    exports["VarOr"] = (_ctx, mem, args) => {
        const a = asR8(mem, args[0] >>> 0);
        const b = asR8(mem, args[1] >>> 0);
        if (a === null || b === null) return DISP_E_TYPEMISMATCH;
        clear(mem, args[2] >>> 0);
        writeI4(mem, args[2] >>> 0, (a | 0) | (b | 0));
        return S_OK;
    };
    exports["VarXor"] = (_ctx, mem, args) => {
        const a = asR8(mem, args[0] >>> 0);
        const b = asR8(mem, args[1] >>> 0);
        if (a === null || b === null) return DISP_E_TYPEMISMATCH;
        clear(mem, args[2] >>> 0);
        writeI4(mem, args[2] >>> 0, (a | 0) ^ (b | 0));
        return S_OK;
    };

    exports["VarNeg"] = (_ctx, mem, args) => {
        const src = args[0] >>> 0;
        const dest = args[1] >>> 0;
        const v = asR8(mem, src);
        if (v === null) return DISP_E_TYPEMISMATCH;
        clear(mem, dest);
        writeR8(mem, dest, -v);
        return S_OK;
    };

    exports["VarNot"] = (_ctx, mem, args) => {
        const src = args[0] >>> 0;
        const dest = args[1] >>> 0;
        const v = asR8(mem, src);
        if (v === null) return DISP_E_TYPEMISMATCH;
        clear(mem, dest);
        writeI4(mem, dest, ~(v | 0));
        return S_OK;
    };

    exports["VarCmp"] = (_ctx, mem, args) => {
        const a = asR8(mem, args[0] >>> 0);
        const b = asR8(mem, args[1] >>> 0);
        if (a === null || b === null) return DISP_E_TYPEMISMATCH;
        if (a < b) return VARCMP_LT;
        if (a > b) return VARCMP_GT;
        return VARCMP_EQ;
    };

    exports["VarBstrFromBool"] = (_ctx, mem, args) => {
        const boolIn = args[0] & 0xffff;
        const pbstr = args[3] >>> 0;
        if (!pbstr) return E_INVALIDARG;
        const bstr = allocBstr(mem, boolIn ? "-1" : "0");
        if (!bstr) return DISP_E_OVERFLOW;
        Mem.writeUint32(pbstr, bstr);
        return S_OK;
    };

    exports["VarBoolFromStr"] = (_ctx, mem, args) => {
        const str = args[0] >>> 0;
        const pbool = args[3] >>> 0;
        if (!str || !pbool) return E_INVALIDARG;
        const s = readWide(mem, str).trim().toLowerCase();
        const truthy = s === "-1" || s === "true" || s === "1" || s === "yes";
        Mem.writeUint16(pbool, truthy ? 0xffff : 0);
        return S_OK;
    };

    exports["VarCyFromStr"] = (_ctx, mem, args) => {
        const str = args[0] >>> 0;
        const pcy = args[3] >>> 0;
        if (!str || !pcy || pcy + 8 > mem.length) return E_INVALIDARG;
        const s = readWide(mem, str).replace(/[^\d.,+-]/g, "").replace(",", ".");
        const n = parseFloat(s);
        if (Number.isNaN(n)) return DISP_E_TYPEMISMATCH;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setBigInt64(pcy, BigInt(Math.round(n * 10000)), true);
        return S_OK;
    };

    exports["VarBstrFromCy"] = (_ctx, mem, args) => {
        const lo = args[0] >>> 0;
        const hi = args[1] >>> 0;
        const pbstr = args[4] >>> 0;
        if (!pbstr) return E_INVALIDARG;
        const cy = Number((BigInt(hi) << 32n) | BigInt(lo)) / 10000;
        const bstr = allocBstr(mem, String(cy));
        if (!bstr) return DISP_E_OVERFLOW;
        Mem.writeUint32(pbstr, bstr);
        return S_OK;
    };

    return exports;
}
