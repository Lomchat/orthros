/**
 * Canonical thunked DLL name resolution.
 * Versioned or wrapper DLL names map to a single HLE module.
 */

const STATIC_ALIASES: Record<string, string> = {
    xdd: "ddraw",
    ddraw32: "ddraw",
    dinput8: "dinput",
    openal32: "wrap_oal",
};

/** d3dx9_24 … d3dx9_43, d3dx924-style link names */
const D3DX9_VERSIONED = /^d3dx9_?\d+$/i;
/** Debug D3DX9 builds */
const D3DX9_DEBUG = /^d3dx9d_\d+$/i;

function stripDllExtension(value: string): string {
    return value.replace(/\.dll$/i, "");
}

/**
 * Normalize a DLL path or base name to lowercase without extension.
 */
export function normalizeDllBaseName(value: string): string {
    const trimmed = value.trim().replace(/^"+|"+$/g, "").replace(/\//g, "\\");
    const base = stripDllExtension(trimmed.split("\\").pop() ?? trimmed);
    return base.toLowerCase();
}

/**
 * Resolve a requested DLL name to the canonical HLE module name.
 * Returns the normalized base name when no alias applies.
 */
export function resolveThunkedDllAlias(name: string): string {
    const base = normalizeDllBaseName(name);
    if (!base) return base;

    const staticTarget = STATIC_ALIASES[base];
    if (staticTarget) return staticTarget;

    if (D3DX9_VERSIONED.test(base) || D3DX9_DEBUG.test(base)) {
        return "d3dx9";
    }

    return base;
}

/**
 * True when the requested name aliases to a different canonical module.
 */
export function isThunkedDllAlias(name: string): boolean {
    const base = normalizeDllBaseName(name);
    return base !== resolveThunkedDllAlias(name);
}
