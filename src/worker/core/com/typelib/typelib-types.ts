export const TKIND_ENUM = 0;
export const TKIND_RECORD = 1;
export const TKIND_MODULE = 2;
export const TKIND_INTERFACE = 3;
export const TKIND_DISPATCH = 4;
export const TKIND_COCLASS = 5;
export const TKIND_ALIAS = 6;
export const TKIND_UNION = 7;

export const SYS_WIN32 = 2;

export type TypeKind = typeof TKIND_COCLASS | typeof TKIND_INTERFACE | typeof TKIND_DISPATCH;

export interface TypeInfoDescriptor {
    name: string;
    guid: string;
    kind: TypeKind;
    docString?: string;
    helpContext?: number;
}

export interface TypeLibDescriptor {
    name: string;
    path: string;
    libid: string;
    versionMajor: number;
    versionMinor: number;
    lcid: number;
    types: TypeInfoDescriptor[];
}

export const normalizeGuid = (value: string): string =>
    value.replace(/[{}]/g, "").toLowerCase();

export const readGuidFromMem = (mem: Uint8Array, addr: number): string => {
    const b = mem;
    const data1 = (b[addr] | (b[addr + 1] << 8) | (b[addr + 2] << 16) | (b[addr + 3] << 24)) >>> 0;
    const data2 = (b[addr + 4] | (b[addr + 5] << 8)) >>> 0;
    const data3 = (b[addr + 6] | (b[addr + 7] << 8)) >>> 0;
    const tail = Array.from(b.slice(addr + 8, addr + 16))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    return `${data1.toString(16).padStart(8, "0")}-${data2.toString(16).padStart(4, "0")}-${data3.toString(16).padStart(4, "0")}-${tail.slice(0, 4)}-${tail.slice(4)}`.toLowerCase();
};

export const writeGuidToMem = (mem: Uint8Array, addr: number, guid: string): void => {
    const clean = normalizeGuid(guid);
    const parts = clean.split("-");
    if (parts.length !== 5) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(addr, parseInt(parts[0], 16), true);
    view.setUint16(addr + 4, parseInt(parts[1], 16), true);
    view.setUint16(addr + 6, parseInt(parts[2], 16), true);
    const tail = parts[3] + parts[4];
    for (let i = 0; i < 8; i++) {
        mem[addr + 8 + i] = parseInt(tail.slice(i * 2, i * 2 + 2), 16);
    }
};

/** TYPELIBATTR — 32 bytes (aligned layout used by games) */
export const TYPELIBATTR_SIZE = 32;

/** Minimal TYPEATTR blob for coclass queries */
export const TYPEATTR_SIZE = 96;
