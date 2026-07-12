import { TKIND_COCLASS, TKIND_INTERFACE, TypeLibDescriptor } from "./typelib-types";

/**
 * Static descriptor for Westwood SUN.TLB (Tiberian Sun).
 * GUIDs extracted from Game.exe + BLOWFISH.DLL in c:\Share\tiberian-sun\
 */
export const SUN_TYPELIB: TypeLibDescriptor = {
    name: "SUN",
    path: "SUN.TLB",
    libid: "e7f91750-8861-11d1-b707-00a024ddafd1",
    versionMajor: 1,
    versionMinor: 0,
    lcid: 0x409,
    types: [
        {
            name: "BlowfishCipher",
            guid: "1440ad10-6aa8-11d1-b6f9-00a024ddafd1",
            kind: TKIND_COCLASS,
            docString: "BlowfishCipher Class",
            helpContext: 0,
        },
        {
            name: "IBlockCipher",
            guid: "e0113100-6a7c-11d1-b6f9-00a024ddafd1",
            kind: TKIND_INTERFACE,
            docString: "IBlockCipher Interface",
            helpContext: 0,
        },
    ],
};

export const BLOWFISH_CLSID = SUN_TYPELIB.types[0].guid;
export const IBLOCK_CIPHER_IID = SUN_TYPELIB.types[1].guid;

export function matchSunTypeLibPath(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    return normalized.endsWith("/sun.tlb") || normalized === "sun.tlb";
}
