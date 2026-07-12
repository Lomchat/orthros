/**
 * PE Icon Extractor
 *
 * Reads RT_GROUP_ICON + RT_ICON resources from a loaded PE module in guest memory
 * and reconstructs a valid .ico file binary for sending to the host page.
 */

import { findResourceInPE, getFirstResourceId } from './resource';
import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

export interface DecodedIcon {
    width: number;
    height: number;
    pixels: Uint8Array;
}

interface IconEntry {
    width: number;
    height: number;
    colorCount: number;
    planes: number;
    bitCount: number;
    id: number;
    data: Uint8Array | null;
}

/** Decode a single RT_ICON resource blob (ICONIMAGE) to RGBA. */
export function decodeIconResource(data: Uint8Array): DecodedIcon | null {
    if (data.length < 40) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const biSize = view.getUint32(0, true);
    const biWidth = view.getInt32(4, true);
    const biHeight = view.getInt32(8, true);
    const biBitCount = view.getUint16(14, true);
    const biClrUsed = view.getUint32(32, true);

    if (biWidth <= 0 || biHeight <= 0 || biHeight % 2 !== 0) return null;

    const w = biWidth;
    const h = biHeight / 2;
    const paletteColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    const paletteBytes = paletteColors * 4;
    const xorOffset = biSize + paletteBytes;
    const xorRowStride = Math.floor((w * biBitCount + 31) / 32) * 4;
    const andRowStride = Math.floor((w + 31) / 32) * 4;
    const andOffset = xorOffset + xorRowStride * h;

    if (andOffset + andRowStride * h > data.length) return null;

    const pixels = new Uint8Array(w * h * 4);
    let palette: Uint8Array | null = null;
    if (biBitCount <= 8 && paletteColors > 0) {
        palette = new Uint8Array(paletteColors * 4);
        const palOff = biSize;
        for (let i = 0; i < paletteColors; i++) {
            const o = palOff + i * 4;
            palette[i * 4 + 0] = data[o + 2];
            palette[i * 4 + 1] = data[o + 1];
            palette[i * 4 + 2] = data[o + 0];
            palette[i * 4 + 3] = 255;
        }
    }

    for (let row = 0; row < h; row++) {
        const xorRow = h - 1 - row;
        const xorOff = xorOffset + xorRow * xorRowStride;
        const andOff = andOffset + xorRow * andRowStride;
        const dstOff = row * w * 4;

        for (let x = 0; x < w; x++) {
            const di = dstOff + x * 4;
            if (biBitCount === 32) {
                const si = xorOff + x * 4;
                pixels[di] = data[si + 2];
                pixels[di + 1] = data[si + 1];
                pixels[di + 2] = data[si];
                pixels[di + 3] = data[si + 3];
            } else if (biBitCount === 24) {
                const si = xorOff + x * 3;
                pixels[di] = data[si + 2];
                pixels[di + 1] = data[si + 1];
                pixels[di + 2] = data[si];
                pixels[di + 3] = 255;
            } else if (biBitCount === 8 && palette) {
                const idx = data[xorOff + x];
                const pi = idx * 4;
                pixels[di] = palette[pi];
                pixels[di + 1] = palette[pi + 1];
                pixels[di + 2] = palette[pi + 2];
                pixels[di + 3] = 255;
            } else if (biBitCount === 4 && palette) {
                const byteVal = data[xorOff + (x >> 1)];
                const idx = (x & 1) === 0 ? (byteVal >> 4) : (byteVal & 0x0F);
                const pi = idx * 4;
                pixels[di] = palette[pi];
                pixels[di + 1] = palette[pi + 1];
                pixels[di + 2] = palette[pi + 2];
                pixels[di + 3] = 255;
            } else if (biBitCount === 1 && palette) {
                const byteVal = data[xorOff + (x >> 3)];
                const bit = (byteVal >> (7 - (x & 7))) & 1;
                const pi = bit * 4;
                pixels[di] = palette[pi];
                pixels[di + 1] = palette[pi + 1];
                pixels[di + 2] = palette[pi + 2];
                pixels[di + 3] = 255;
            } else {
                return null;
            }

            const andByte = data[andOff + (x >> 3)];
            const andBit = (andByte >> (7 - (x & 7))) & 1;
            if (andBit) pixels[di + 3] = 0;
        }
    }

    return { width: w, height: h, pixels };
}

function loadIconDataFromPe(
    mem: Uint8Array,
    moduleBase: number,
    resourceName: number | string,
): DecodedIcon | null {
    let iconEntry = findResourceInPE(mem, moduleBase, RT_ICON, resourceName);
    if (!iconEntry) {
        const groupEntry = findResourceInPE(mem, moduleBase, RT_GROUP_ICON, resourceName);
        if (groupEntry) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const groupAddr = moduleBase + groupEntry.dataRVA;
            const idCount = view.getUint16(groupAddr + 4, true);
            let bestId = 0;
            let bestArea = 0;
            for (let i = 0; i < idCount; i++) {
                const base = groupAddr + 6 + i * 14;
                const ew = view.getUint8(base) || 256;
                const eh = view.getUint8(base + 1) || 256;
                const area = ew * eh;
                const id = view.getUint16(base + 12, true);
                if (area >= bestArea) {
                    bestArea = area;
                    bestId = id;
                }
            }
            if (bestId) iconEntry = findResourceInPE(mem, moduleBase, RT_ICON, bestId);
        }
    }
    if (!iconEntry) return null;
    const addr = moduleBase + iconEntry.dataRVA;
    return decodeIconResource(mem.subarray(addr, addr + iconEntry.size));
}

/**
 * Load RT_ICON / RT_GROUP_ICON from PE and register as user object. Returns 0 on failure.
 */
export function loadIconFromPeResource(
    mem: Uint8Array,
    moduleBase: number,
    resourceName: number | string,
): number {
    if (!moduleBase) moduleBase = 0x00400000;
    const decoded = loadIconDataFromPe(mem, moduleBase, resourceName);
    if (!decoded) {
        Logger.warn(LogCategory.KERNEL32,
            `loadIconFromPeResource: icon not found (name=${resourceName}, module=0x${moduleBase.toString(16)})`);
        return 0;
    }
    const handle = System.getInstance().resourceProvider.registerUserObject({
        type: 'ICON',
        name: resourceName,
        width: decoded.width,
        height: decoded.height,
        pixels: decoded.pixels,
        loading: false,
    });
    Logger.log(LogCategory.KERNEL32,
        `loadIconFromPeResource: ${decoded.width}x${decoded.height} (name=${resourceName}) -> 0x${handle.toString(16)}`);
    return handle;
}

/**
 * Extract the main application icon from a PE module loaded in guest memory.
 * Returns a reconstructed ICO file as Uint8Array, or null if no icon found.
 */
export function extractAppIcon(mem: Uint8Array, moduleBase: number): Uint8Array | null {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    // Find the first RT_GROUP_ICON entry — ID varies per app (1, 101, 102, ...)
    const groupId = getFirstResourceId(mem, moduleBase, RT_GROUP_ICON);
    if (groupId === null) return null;

    const groupEntry = findResourceInPE(mem, moduleBase, RT_GROUP_ICON, groupId);
    if (!groupEntry) return null;

    const groupAddr = moduleBase + groupEntry.dataRVA;

    // GRPICONDIR: reserved(2) + type(2) + count(2)
    const idCount = view.getUint16(groupAddr + 4, true);
    if (idCount === 0) return null;

    // GRPICONDIRENTRY (14 bytes each):
    // bWidth(1) bHeight(1) bColorCount(1) bReserved(1) wPlanes(2) wBitCount(2) dwBytesInRes(4) nId(2)
    const entries: IconEntry[] = [];
    for (let i = 0; i < idCount; i++) {
        const base = groupAddr + 6 + i * 14;
        entries.push({
            width:      view.getUint8(base),
            height:     view.getUint8(base + 1),
            colorCount: view.getUint8(base + 2),
            planes:     view.getUint16(base + 4, true),
            bitCount:   view.getUint16(base + 6, true),
            id:         view.getUint16(base + 12, true),
            data:       null,
        });
    }

    // Load RT_ICON data for each entry
    for (const entry of entries) {
        const iconEntry = findResourceInPE(mem, moduleBase, RT_ICON, entry.id);
        if (!iconEntry) continue;
        const addr = moduleBase + iconEntry.dataRVA;
        entry.data = mem.slice(addr, addr + iconEntry.size);
    }

    const valid = entries.filter(e => e.data !== null);
    if (valid.length === 0) return null;

    // Sort largest first — browser will pick the most appropriate size
    valid.sort((a, b) => (b.width || 256) * (b.height || 256) - (a.width || 256) * (a.height || 256));

    // Reconstruct ICO: ICONDIR(6) + ICONDIRENTRY*n(16*n) + image data
    const headerSize = 6 + valid.length * 16;
    const totalSize = headerSize + valid.reduce((s, e) => s + e.data!.byteLength, 0);
    const out = new Uint8Array(totalSize);
    const dv = new DataView(out.buffer);

    dv.setUint16(0, 0, true);            // reserved
    dv.setUint16(2, 1, true);            // type = 1 (icon)
    dv.setUint16(4, valid.length, true);

    let dataOffset = headerSize;
    for (let i = 0; i < valid.length; i++) {
        const e = valid[i];
        const base = 6 + i * 16;
        dv.setUint8(base,     e.width);
        dv.setUint8(base + 1, e.height);
        dv.setUint8(base + 2, e.colorCount);
        dv.setUint8(base + 3, 0);
        dv.setUint16(base + 4, e.planes,  true);
        dv.setUint16(base + 6, e.bitCount, true);
        dv.setUint32(base + 8, e.data!.byteLength, true);
        dv.setUint32(base + 12, dataOffset, true);
        out.set(e.data!, dataOffset);
        dataOffset += e.data!.byteLength;
    }

    return out;
}

interface GroupIconEntry {
    width: number;
    height: number;
    id: number;
}

/** Parse the first RT_GROUP_ICON resource into per-size entries. */
function getFirstGroupIconEntries(mem: Uint8Array, moduleBase: number): GroupIconEntry[] | null {
    const groupId = getFirstResourceId(mem, moduleBase, RT_GROUP_ICON);
    if (groupId === null) return null;
    const groupEntry = findResourceInPE(mem, moduleBase, RT_GROUP_ICON, groupId);
    if (!groupEntry) return null;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const groupAddr = moduleBase + groupEntry.dataRVA;
    const idCount = view.getUint16(groupAddr + 4, true);
    if (idCount === 0) return null;

    const entries: GroupIconEntry[] = [];
    for (let i = 0; i < idCount; i++) {
        const base = groupAddr + 6 + i * 14;
        entries.push({
            width: view.getUint8(base) || 256,
            height: view.getUint8(base + 1) || 256,
            id: view.getUint16(base + 12, true),
        });
    }
    return entries;
}

function loadIconFromGroupEntry(mem: Uint8Array, moduleBase: number, entry: GroupIconEntry): number {
    const iconEntry = findResourceInPE(mem, moduleBase, RT_ICON, entry.id);
    if (!iconEntry) return 0;
    const addr = moduleBase + iconEntry.dataRVA;
    const decoded = decodeIconResource(mem.subarray(addr, addr + iconEntry.size));
    if (!decoded) return 0;
    return System.getInstance().resourceProvider.registerUserObject({
        type: 'ICON',
        width: decoded.width,
        height: decoded.height,
        pixels: decoded.pixels,
        loading: false,
    });
}

/** Number of icon sizes in the first RT_GROUP_ICON of a loaded PE module. */
export function countPeIcons(mem: Uint8Array, moduleBase: number): number {
    return getFirstGroupIconEntries(mem, moduleBase)?.length ?? 0;
}

/** Load one icon from the first RT_GROUP_ICON at the given zero-based entry index. */
export function loadIconFromPeByIndex(mem: Uint8Array, moduleBase: number, iconIndex: number): number {
    const entries = getFirstGroupIconEntries(mem, moduleBase);
    if (!entries || iconIndex < 0 || iconIndex >= entries.length) return 0;
    return loadIconFromGroupEntry(mem, moduleBase, entries[iconIndex]);
}

/** Load the largest or smallest icon from the first RT_GROUP_ICON. */
export function loadIconFromPeBySize(mem: Uint8Array, moduleBase: number, preferLarge: boolean): number {
    const entries = getFirstGroupIconEntries(mem, moduleBase);
    if (!entries || entries.length === 0) return 0;
    let pick = entries[0];
    for (const e of entries) {
        const area = e.width * e.height;
        const pickArea = pick.width * pick.height;
        if (preferLarge ? area > pickArea : area < pickArea) pick = e;
    }
    return loadIconFromGroupEntry(mem, moduleBase, pick);
}

/** Resolve a file path to a loaded PE module base address (best effort). */
export function resolveModuleBaseForIconPath(filePath: string): number | null {
    if (!filePath) return null;
    const norm = filePath.replace(/\//g, '\\').toLowerCase();
    const baseName = norm.split('\\').pop() ?? norm;

    const registry = System.getInstance().process?.moduleRegistry;
    if (registry) {
        for (const mod of registry.getAllModules()) {
            const modPath = mod.path.replace(/\//g, '\\').toLowerCase();
            const modBase = mod.name.toLowerCase();
            if (
                modPath === norm
                || modPath.endsWith('\\' + baseName)
                || baseName === `${modBase}.exe`
                || baseName === `${modBase}.dll`
            ) {
                return mod.baseAddress;
            }
        }
    }

    const sys = System.getInstance();
    const exePath = sys.executablePath?.replace(/\//g, '\\').toLowerCase();
    if (exePath && (exePath === norm || baseName === sys.executableName?.toLowerCase())) {
        return 0x00400000;
    }
    return null;
}
