import { asBufferSource } from "../../../dom-buffer";

const HEX_256 = /^[0-9a-f]{64}$/;

export interface WgbIntegrityManifest {
    version: 1;
    algorithm: "sha256";
    file?: string;
    size: number;
    sha256: string;
    chunkSize: number;
    chunks: string[];
    segmentSize: number;
    segments: string[];
}

const manifests = new Map<string, Promise<WgbIntegrityManifest | null>>();

export function integrityUrlForWgb(url: string): string {
    const parsed = new URL(url, "http://orthros.invalid");
    parsed.pathname = `${parsed.pathname}.integrity.json`;
    if (parsed.origin === "http://orthros.invalid") return `${parsed.pathname}${parsed.search}`;
    return parsed.toString();
}

export function parseWgbIntegrity(value: unknown): WgbIntegrityManifest {
    const v = value as Partial<WgbIntegrityManifest> | null;
    if (!v || v.version !== 1 || v.algorithm !== "sha256" ||
        !Number.isSafeInteger(v.size) || (v.size ?? 0) <= 0 ||
        !Number.isSafeInteger(v.chunkSize) || (v.chunkSize ?? 0) <= 0 ||
        !Number.isSafeInteger(v.segmentSize) || (v.segmentSize ?? 0) < (v.chunkSize ?? 0) ||
        !HEX_256.test(v.sha256 ?? "") || !Array.isArray(v.chunks) || !Array.isArray(v.segments) ||
        v.chunks.some((h) => !HEX_256.test(h)) || v.segments.some((h) => !HEX_256.test(h))) {
        throw new Error("invalid WGB integrity descriptor");
    }
    const chunkCount = Math.ceil(v.size! / v.chunkSize!);
    const segmentCount = Math.ceil(v.size! / v.segmentSize!);
    if (v.chunks.length !== chunkCount || v.segments.length !== segmentCount || v.segmentSize! % v.chunkSize! !== 0) {
        throw new Error("WGB integrity descriptor geometry mismatch");
    }
    return v as WgbIntegrityManifest;
}

/** Optional for generic URL bundles; production BFME publishes this descriptor. */
export function loadWgbIntegrity(url: string): Promise<WgbIntegrityManifest | null> {
    const descriptorUrl = integrityUrlForWgb(url);
    let pending = manifests.get(descriptorUrl);
    if (!pending) {
        pending = fetch(descriptorUrl, { cache: "no-cache" })
            .then(async (response) => response.ok ? parseWgbIntegrity(await response.json()) : null)
            .catch(() => null);
        manifests.set(descriptorUrl, pending);
    }
    return pending;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(bytes)));
    let hex = "";
    for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

export function integrityEtag(integrity: WgbIntegrityManifest): string {
    return `"sha256-${integrity.sha256}"`;
}

export function verifiedMarkerName(cacheKey: string, integrity: WgbIntegrityManifest): string {
    return `${cacheKey}.verified-${integrity.sha256}`;
}
