/**
 * Shared guest-string helpers for the kernel32 file-io module family.
 * Sibling submodules (console/find/volume/path) reuse these without a cycle.
 */
import { decodeAnsiString, EmulatorConfig } from '../../core/emulator-config-manager';

// Windows MAX_PATH constant (260 characters)
export const MAX_PATH = 260;

// Safe string reading helpers with MAX_PATH limits to prevent memory exhaustion
export const readStringA = (mem: Uint8Array, addr: number, maxLen: number = MAX_PATH): string => {
    if (!addr || addr < 0 || addr >= mem.length) return '';
    const maxEnd = Math.min(addr + maxLen, mem.length);
    // Find null terminator within bounds
    let nullPos = -1;
    for (let i = addr; i < maxEnd; i++) {
        if (mem[i] === 0) {
            nullPos = i;
            break;
        }
    }
    const strEnd = nullPos !== -1 ? nullPos : maxEnd;
    return decodeAnsiString(mem, addr, strEnd - addr, EmulatorConfig.getInstance().ansiCodePage);
};

export const readStringW = (mem: Uint8Array, addr: number, maxChars: number = MAX_PATH): string => {
    if (!addr || addr < 0 || addr >= mem.length) return '';
    const maxBytes = Math.min(addr + maxChars * 2, mem.length);
    let end = addr;
    // Find double null terminator (00 00) for UTF-16LE
    while (end < maxBytes - 1) {
        if (mem[end] === 0 && mem[end + 1] === 0) break;
        end += 2;
    }
    return new TextDecoder('utf-16le').decode(mem.slice(addr, end));
};

// Helper function to encode string to UTF-16LE
export const encodeUTF16LE = (str: string): Uint8Array => {
    const result = new Uint8Array(str.length * 2 + 2); // +2 for null terminator
    const view = new DataView(result.buffer);
    for (let i = 0; i < str.length; i++) {
        view.setUint16(i * 2, str.charCodeAt(i), true); // true = little-endian
    }
    view.setUint16(str.length * 2, 0, true); // null terminator
    return result;
};
