/**
 * CRT conversion functions (atoi/atol/atof, strtol/strtoul/strtod, _ltoa/_ultoa/
 * _itoa, toupper/tolower, abs/labs, mbstowcs/wcstombs/wctomb, _wtoi/wcstoul).
 *
 * Host supplies codepage-aware string readers/writers, FPU push for
 * double-returning functions (atof/strtod), and locale-aware case-fold LUT
 * addresses (toupper/tolower index the same guest tables the trap-free inline
 * stubs use — see Msvcrt.buildCaseTables). No state lives here.
 */

import { Mem } from "../core/memory/mem-accessor";
import { fpuPush } from "../core/fpu-helper";
import { Logger, LogCategory } from "../core/logger";
import { encodeAnsi } from "./crt-format";
import type { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import type { Process } from "../core/process";

export interface CrtConvHost {
    process: Process;
    readCString(ptr: number, maxLen: number): string;
    readWString(ptr: number, maxChars: number): string;
    writeCString(ptr: number, value: string): void;
    writeUint16(addr: number, value: number): void;
    /** Live guest address of the tolower LUT (0 until allocated) — see Msvcrt.buildCaseTables. */
    caseLowerTableAddr(): number;
    /** Live guest address of the toupper LUT (0 until allocated). */
    caseUpperTableAddr(): number;
}

export function registerCrtConvExports(exports: Record<string, ThunkImplementation>, host: CrtConvHost): void {

    function atoi(ptr: number): number {
        const value = host.readCString(ptr, 256).trim();
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? (parsed | 0) : 0;
    }

    function atol(ptr: number): number {
        return atoi(ptr);
    }

    function ltoa(value: number, buffer: number, radix: number): number {
        if (!buffer) return 0;
        const base = radix > 1 ? radix : 10;
        const signed = (base === 10);
        const val = signed ? (value | 0) : (value >>> 0);
        const text = (signed && val < 0) ? `-${Math.abs(val).toString(base)}` : val.toString(base);
        host.writeCString(buffer, text);
        return buffer >>> 0;
    }

    function ultoa(value: number, buffer: number, radix: number): number {
        if (!buffer) return 0;
        const base = radix > 1 ? radix : 10;
        host.writeCString(buffer, (value >>> 0).toString(base));
        return buffer >>> 0;
    }

    function atof(ptr: number): number {
        const str = host.readCString(ptr, 256).trim();
        const value = parseFloat(str);
        const result = Number.isFinite(value) ? value : 0;
        fpuPush(host.process.v86, result);
        return 0;
    }

    function strtol(strPtr: number, endPtr: number, base: number): number {
        const str = host.readCString(strPtr, 256);
        let radix = base | 0;

        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;

        let negative = false;
        if (str[start] === '-') { negative = true; start++; }
        else if (str[start] === '+') { start++; }

        // Auto-detect base
        if (radix === 0) {
            if (str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) { radix = 16; start += 2; }
            else if (str[start] === '0') { radix = 8; start++; }
            else { radix = 10; }
        } else if (radix === 16 && str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) {
            start += 2;
        }

        let end = start;
        while (end < str.length) {
            const c = str[end].toLowerCase();
            const digit = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 :
                          c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : -1;
            if (digit < 0 || digit >= radix) break;
            end++;
        }

        const numStr = str.slice(start, end);
        let value = numStr.length > 0 ? parseInt(numStr, radix) | 0 : 0;
        if (negative) value = -value;

        if (endPtr) Mem.writeUint32(endPtr, strPtr + end);
        return value;
    }

    function strtoul(strPtr: number, endPtr: number, base: number): number {
        const str = host.readCString(strPtr, 256);
        let radix = base | 0;

        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;
        if (str[start] === '+') start++;

        if (radix === 0) {
            if (str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) { radix = 16; start += 2; }
            else if (str[start] === '0') { radix = 8; start++; }
            else { radix = 10; }
        } else if (radix === 16 && str[start] === '0' && (str[start + 1] === 'x' || str[start + 1] === 'X')) {
            start += 2;
        }

        let end = start;
        while (end < str.length) {
            const c = str[end].toLowerCase();
            const digit = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 :
                          c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : -1;
            if (digit < 0 || digit >= radix) break;
            end++;
        }

        const numStr = str.slice(start, end);
        const value = numStr.length > 0 ? parseInt(numStr, radix) >>> 0 : 0;

        if (endPtr) Mem.writeUint32(endPtr, strPtr + end);
        return value;
    }

    function strtod(strPtr: number, endPtr: number): number {
        const str = host.readCString(strPtr, 256);
        let start = 0;
        while (start < str.length && /\s/.test(str[start])) start++;
        const value = parseFloat(str.slice(start));
        const result = Number.isFinite(value) ? value : 0;
        fpuPush(host.process.v86, result);
        if (endPtr) {
            // Find where parsing ended
            const match = str.slice(start).match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
            const consumed = match ? start + match[0].length : start;
            Mem.writeUint32(endPtr, strPtr + consumed);
        }
        return 0;
    }

    function toupper(ch: number): number {
        const c = ch & 0xff;
        const caseUpperTableAddr = host.caseUpperTableAddr();
        if (caseUpperTableAddr) {
            const v = Mem.readUint8(caseUpperTableAddr + c);
            if (v !== null) return v;
        }
        return (c >= 0x61 && c <= 0x7a) ? c - 0x20 : c;
    }

    function tolower(ch: number): number {
        const c = ch & 0xff;
        const caseLowerTableAddr = host.caseLowerTableAddr();
        if (caseLowerTableAddr) {
            const v = Mem.readUint8(caseLowerTableAddr + c);
            if (v !== null) return v;
        }
        return (c >= 0x41 && c <= 0x5a) ? c + 0x20 : c;
    }

    function abs(value: number): number {
        const v = value | 0;
        return v < 0 ? -v : v;
    }

    function mbstowcs(dest: number, src: number, count: number): number {
        if (!src) return 0;
        const maxChars = count >>> 0;
        const str = host.readCString(src, maxChars > 0 ? maxChars : 0x100000);
        if (!dest) return str.length;
        const writeChars = Math.min(str.length, maxChars > 0 ? maxChars : str.length);
        for (let i = 0; i < writeChars; i++) {
            host.writeUint16(dest + i * 2, str.charCodeAt(i));
        }
        if (writeChars < maxChars) {
            host.writeUint16(dest + writeChars * 2, 0);
        }
        return writeChars;
    }

    function wcstombs(dest: number, src: number, count: number): number {
        if (!src) return 0;
        const maxBytes = count >>> 0;
        const wideStr: number[] = [];
        for (let i = 0; i < 0x100000; i += 2) {
            const ch = Mem.readUint16(src + i);
            if (ch === null || ch === 0) break;
            wideStr.push(ch);
        }
        const str = String.fromCharCode(...wideStr);
        const bytes = encodeAnsi(str);
        if (!dest) return bytes.length;
        const copyLen = Math.min(bytes.length, maxBytes > 0 ? maxBytes - 1 : bytes.length);
        Mem.writeBytes(dest, bytes.subarray(0, copyLen));
        if (maxBytes > copyLen) {
            Mem.writeBytes(dest + copyLen, new Uint8Array([0]));
        }
        return copyLen;
    }

    function wctomb(dest: number, wchar: number): number {
        if (!dest) return 0;
        Mem.writeBytes(dest, new Uint8Array([wchar & 0xff]));
        return 1;
    }

    function wtoi(ptr: number): number {
        const str = host.readWString(ptr, 256).trim();
        const parsed = parseInt(str, 10);
        const result = Number.isFinite(parsed) ? (parsed | 0) : 0;
        const preview = str.replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, 120);
        Logger.log(LogCategory.THUNK, `_wtoi: ptr=0x${(ptr >>> 0).toString(16)} text="${preview}" -> ${result}`);
        return result;
    }

    function wcstoul(ptr: number, endPtr: number, base: number): number {
        const str = host.readWString(ptr, 256).trim();
        const radix = (base >>> 0) || 10;
        const parsed = parseInt(str, radix);
        if (endPtr) Mem.writeUint32(endPtr, 0);
        return Number.isFinite(parsed) ? (parsed >>> 0) : 0;
    }

    exports["_wtoi"] = (ctx, mem, args) => wtoi(args[0] ?? 0);
    exports["wcstoul"] = (ctx, mem, args) => wcstoul(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);

    exports["atoi"] = (ctx, mem, args) => atoi(args[0] ?? 0);
    exports["atol"] = (ctx, mem, args) => atol(args[0] ?? 0);
    exports["_ltoa"] = (ctx, mem, args) => ltoa(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["_ultoa"] = (ctx, mem, args) => ultoa(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);

    exports["atof"] = (ctx, mem, args) => atof(args[0] ?? 0);

    exports["strtol"] = (ctx, mem, args) => strtol(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["strtoul"] = (ctx, mem, args) => strtoul(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["strtod"] = (ctx, mem, args) => strtod(args[0] ?? 0, args[1] ?? 0);
    exports["toupper"] = (ctx, mem, args) => toupper(args[0] ?? 0);
    exports["tolower"] = (ctx, mem, args) => tolower(args[0] ?? 0);
    exports["abs"] = (ctx, mem, args) => abs(args[0] ?? 0);
    exports["labs"] = (ctx, mem, args) => abs(args[0] ?? 0);
    exports["_itoa"] = (ctx, mem, args) => ltoa(args[0] ?? 0, args[1] ?? 0, args[2] ?? 10);
    exports["mbstowcs"] = (ctx, mem, args) => mbstowcs(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
    exports["wcstombs"] = (ctx, mem, args) => wcstombs(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
    exports["wctomb"] = (ctx, mem, args) => wctomb(args[0] ?? 0, args[1] ?? 0);
}
