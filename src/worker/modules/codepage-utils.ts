/**
 * Codepage-aware ANSI string utilities for guest memory I/O.
 *
 * All functions use the active ANSI code page from EmulatorConfig
 * (default 1252, configurable per-game via manifest "codepage" field).
 */

export { getCodePageDecoder, decodeAnsiString, encodeAnsiString } from "../core/emulator-config-manager";
import { EmulatorConfig, encodeAnsiString, getCodePageDecoder } from "../core/emulator-config-manager";
import { asBufferSource } from "../../dom-buffer";

/** Get the active ANSI code page from EmulatorConfig. */
export function getAnsiCodePage(): number {
    return EmulatorConfig.getInstance().ansiCodePage;
}

/**
 * Read a null-terminated ANSI string from guest memory using the active code page.
 * Replaces: `new TextDecoder().decode(...)` and `String.fromCharCode(byte)` loop patterns.
 */
export function readAnsiFromGuest(mem: Uint8Array, ptr: number, maxLen?: number): string {
    if (!ptr || ptr < 0 || ptr >= mem.length) return "";
    const limit = maxLen ?? (mem.length - ptr);
    let end = ptr;
    const stop = Math.min(ptr + limit, mem.length);
    while (end < stop && mem[end] !== 0) end++;
    if (end === ptr) return "";
    return getCodePageDecoder(EmulatorConfig.getInstance().ansiCodePage)
        .decode(asBufferSource(mem.subarray(ptr, end)));
}

/**
 * Write a JS string to guest memory as null-terminated ANSI bytes.
 * Returns bytes written (excluding null terminator).
 * Replaces: `charCodeAt(i) & 0xFF` loops and `new TextEncoder().encode(...)`.
 */
export function writeAnsiToGuest(mem: Uint8Array, addr: number, str: string, maxBytes?: number): number {
    if (!addr || addr < 0 || addr >= mem.length) return 0;
    const encoded = encodeAnsiString(str, EmulatorConfig.getInstance().ansiCodePage);
    const limit = maxBytes !== undefined ? Math.min(encoded.length, maxBytes - 1) : encoded.length;
    mem.set(encoded.subarray(0, limit), addr);
    mem[addr + limit] = 0;
    return limit;
}

/**
 * Encode a JS string to ANSI bytes using the active code page (no null terminator).
 * Drop-in replacement for `new TextEncoder().encode(str)` when writing to guest memory.
 */
export function encodeAnsi(str: string): Uint8Array {
    return encodeAnsiString(str, EmulatorConfig.getInstance().ansiCodePage);
}
