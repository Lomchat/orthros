import { ORTHROS_ROOT } from "./container-store";
import type { SyncAccessHandleLike } from "@orthros/formats/zip";
import { wgbCacheKeyForUrl } from "./wgb-cache-key";
import {
    sha256Hex,
    verifiedMarkerName,
    type WgbIntegrityManifest,
} from "./wgb-integrity";

const CACHE_DIR = "wgb-cache";
const META_MAGIC = 0x42535243; // "BSRC" — Orthros range cache
const META_VERSION = 1;
const META_HEADER_BYTES = 32;
const INTEGRITY_META_VERSION = 2;
const INTEGRITY_META_HEADER_BYTES = 64;
const QUOTA_MARGIN_BYTES = 256 * 1024 * 1024;

type SyncFileHandle = FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
    move?: (name: string) => Promise<void>;
};

export type PersistentRangeProgress = {
    loadedBytes: number;
    totalBytes: number;
    complete: boolean;
};

export class RangeChunkIntegrityError extends Error {
    constructor(
        readonly index: number,
        readonly expected: string,
        readonly actual: string,
    ) {
        super(`range chunk ${index} failed SHA-256 (${actual} != ${expected})`);
        this.name = "RangeChunkIntegrityError";
    }
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
}

function bitIsSet(bits: Uint8Array, index: number): boolean {
    return (bits[index >>> 3]! & (1 << (index & 7))) !== 0;
}

function setBit(bits: Uint8Array, index: number): void {
    bits[index >>> 3] = bits[index >>> 3]! | (1 << (index & 7));
}

function countBits(bits: Uint8Array, limit: number): number {
    let count = 0;
    for (let i = 0; i < limit; i++) if (bitIsSet(bits, i)) count++;
    return count;
}

function writeAll(handle: SyncAccessHandleLike, bytes: Uint8Array, at: number): void {
    let written = 0;
    while (written < bytes.byteLength) {
        const n = handle.write(bytes.subarray(written), { at: at + written });
        if (n <= 0) throw new Error("OPFS short write");
        written += n;
    }
}

function readAll(handle: SyncAccessHandleLike, bytes: Uint8Array, at: number): number {
    let read = 0;
    while (read < bytes.byteLength) {
        const n = handle.read(bytes.subarray(read), { at: at + read });
        if (n <= 0) break;
        read += n;
    }
    return read;
}

/**
 * Sparse, resumable OPFS backing for HTTP range chunks.
 *
 * Data is written to `<game>.wgb.part`; a compact bitset sidecar records only
 * chunks whose data has already been flushed. The data flush happens BEFORE its
 * bit is committed, so an interrupted page can at worst download a chunk twice —
 * it can never trust an incomplete chunk. Once all bits are present the part is
 * atomically promoted to the normal WGB cache key used by WgbCache on next launch.
 */
export class PersistentRangeStore {
    private data: SyncAccessHandleLike;
    private meta: SyncAccessHandleLike | null;
    private readonly dataFile: SyncFileHandle;
    private readonly metaName: string;
    private readonly cacheDir: FileSystemDirectoryHandle;
    private readonly finalKey: string;
    private readonly chunkSize: number;
    private readonly totalSize: number;
    private readonly chunkCount: number;
    private readonly bits: Uint8Array;
    private readonly integrity: WgbIntegrityManifest | null;
    private completedChunks: number;
    private promoted = false;

    private constructor(args: {
        data: SyncAccessHandleLike;
        meta: SyncAccessHandleLike;
        dataFile: SyncFileHandle;
        metaName: string;
        cacheDir: FileSystemDirectoryHandle;
        finalKey: string;
        chunkSize: number;
        totalSize: number;
        bits: Uint8Array;
        integrity: WgbIntegrityManifest | null;
    }) {
        this.data = args.data;
        this.meta = args.meta;
        this.dataFile = args.dataFile;
        this.metaName = args.metaName;
        this.cacheDir = args.cacheDir;
        this.finalKey = args.finalKey;
        this.chunkSize = args.chunkSize;
        this.totalSize = args.totalSize;
        this.chunkCount = Math.ceil(args.totalSize / args.chunkSize);
        this.bits = args.bits;
        this.integrity = args.integrity;
        this.completedChunks = countBits(args.bits, this.chunkCount);
    }

    static async open(
        url: string,
        totalSize: number,
        chunkSize: number,
        integrity: WgbIntegrityManifest | null = null,
    ): Promise<PersistentRangeStore | null> {
        try {
            if (!(totalSize > 0) || !(chunkSize > 0)) return null;
            if (integrity && (integrity.size !== totalSize || integrity.chunkSize !== chunkSize)) return null;
            const root = await navigator.storage.getDirectory();
            const orthros = await root.getDirectoryHandle(ORTHROS_ROOT, { create: true });
            const dir = await orthros.getDirectoryHandle(CACHE_DIR, { create: true });
            const finalKey = wgbCacheKeyForUrl(url);
            const partName = `${finalKey}.part`;
            const metaName = `${partName}.map`;
            const chunkCount = Math.ceil(totalSize / chunkSize);
            const bitBytes = Math.ceil(chunkCount / 8);
            const metaVersion = integrity ? INTEGRITY_META_VERSION : META_VERSION;
            const headerBytes = integrity ? INTEGRITY_META_HEADER_BYTES : META_HEADER_BYTES;

            const dataFile = await dir.getFileHandle(partName, { create: true }) as SyncFileHandle;
            const metaFile = await dir.getFileHandle(metaName, { create: true }) as SyncFileHandle;
            if (typeof dataFile.createSyncAccessHandle !== "function" ||
                typeof metaFile.createSyncAccessHandle !== "function" ||
                typeof dataFile.move !== "function") return null;

            const data = await dataFile.createSyncAccessHandle();
            const meta = await metaFile.createSyncAccessHandle();
            const metaBytes = new Uint8Array(headerBytes + bitBytes);
            const existingMetaSize = meta.getSize();
            let valid = false;
            let reusableBits: Uint8Array | null = null;
            if (existingMetaSize === metaBytes.byteLength && readAll(meta, metaBytes, 0) === metaBytes.byteLength) {
                const view = new DataView(metaBytes.buffer);
                valid = view.getUint32(0, true) === META_MAGIC &&
                    view.getUint32(4, true) === metaVersion &&
                    view.getFloat64(8, true) === totalSize &&
                    view.getUint32(16, true) === chunkSize &&
                    view.getUint32(20, true) === chunkCount &&
                    data.getSize() === totalSize;
                if (valid && integrity) {
                    valid = bytesEqual(metaBytes.subarray(32, 64), hexToBytes(integrity.sha256));
                }
            }

            // Upgrade an old bitmap, or salvage unchanged chunks after a bundle
            // identity change. No legacy bit is trusted directly: every marked
            // chunk is re-hashed against the new descriptor before it survives.
            if (!valid && integrity && data.getSize() === totalSize) {
                const oldBytes = new Uint8Array(existingMetaSize);
                if (existingMetaSize >= META_HEADER_BYTES && readAll(meta, oldBytes, 0) === oldBytes.byteLength) {
                    const oldView = new DataView(oldBytes.buffer);
                    const oldVersion = oldView.getUint32(4, true);
                    const oldHeader = oldVersion === META_VERSION ? META_HEADER_BYTES :
                        oldVersion === INTEGRITY_META_VERSION ? INTEGRITY_META_HEADER_BYTES : 0;
                    const compatible = oldHeader > 0 && existingMetaSize === oldHeader + bitBytes &&
                        oldView.getUint32(0, true) === META_MAGIC &&
                        oldView.getFloat64(8, true) === totalSize &&
                        oldView.getUint32(16, true) === chunkSize &&
                        oldView.getUint32(20, true) === chunkCount;
                    if (compatible) {
                        const oldBits = oldBytes.subarray(oldHeader);
                        reusableBits = new Uint8Array(bitBytes);
                        for (let index = 0; index < chunkCount; index++) {
                            if (!bitIsSet(oldBits, index)) continue;
                            const start = index * chunkSize;
                            const length = Math.min(chunkSize, totalSize - start);
                            const bytes = new Uint8Array(length);
                            if (readAll(data, bytes, start) === length &&
                                await sha256Hex(bytes) === integrity.chunks[index]) {
                                setBit(reusableBits, index);
                            }
                        }
                    }
                }
            }

            if (!valid) {
                if (data.getSize() !== totalSize) {
                    const estimate = await navigator.storage.estimate();
                    const free = Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0));
                    // Creating the sparse target at full logical size consumes origin quota.
                    // Leave room for saves and temporary browser bookkeeping.
                    if (free > 0 && free < totalSize + QUOTA_MARGIN_BYTES) {
                        try { data.close(); } catch {}
                        try { meta.close(); } catch {}
                        try { await dir.removeEntry(partName); } catch {}
                        try { await dir.removeEntry(metaName); } catch {}
                        return null;
                    }
                }
                metaBytes.fill(0);
                const view = new DataView(metaBytes.buffer);
                view.setUint32(0, META_MAGIC, true);
                view.setUint32(4, metaVersion, true);
                view.setFloat64(8, totalSize, true);
                view.setUint32(16, chunkSize, true);
                view.setUint32(20, chunkCount, true);
                if (integrity) metaBytes.set(hexToBytes(integrity.sha256), 32);
                if (reusableBits) metaBytes.set(reusableBits, headerBytes);
                data.truncate(totalSize);
                data.flush();
                meta.truncate(metaBytes.byteLength);
                writeAll(meta, metaBytes, 0);
                meta.flush();
            }

            const bits = metaBytes.slice(headerBytes);
            return new PersistentRangeStore({
                data, meta, dataFile, metaName, cacheDir: dir, finalKey,
                chunkSize, totalSize, bits, integrity,
            });
        } catch {
            return null;
        }
    }

    hasChunk(index: number): boolean {
        return index >= 0 && index < this.chunkCount && (this.promoted || bitIsSet(this.bits, index));
    }

    readChunk(index: number): Uint8Array | null {
        if (!this.hasChunk(index)) return null;
        const start = index * this.chunkSize;
        const length = Math.min(this.chunkSize, this.totalSize - start);
        const out = new Uint8Array(length);
        return readAll(this.data, out, start) === length ? out : null;
    }

    async writeChunk(index: number, bytes: Uint8Array): Promise<void> {
        if (this.promoted || this.hasChunk(index)) return;
        const start = index * this.chunkSize;
        const expected = Math.min(this.chunkSize, this.totalSize - start);
        if (bytes.byteLength !== expected) throw new Error(`range chunk ${index} has ${bytes.byteLength} bytes, expected ${expected}`);

        if (this.integrity) {
            const expectedHash = this.integrity.chunks[index]!;
            const actualHash = await sha256Hex(bytes);
            if (actualHash !== expectedHash) throw new RangeChunkIntegrityError(index, expectedHash, actualHash);
        }

        // SHA-256 yields to the worker event loop. A foreground miss and a large
        // background extent can therefore finish the same chunk concurrently;
        // re-check after hashing so the bitmap/count advances exactly once.
        if (this.promoted || this.hasChunk(index)) return;

        writeAll(this.data, bytes, start);
        this.data.flush();

        setBit(this.bits, index);
        this.completedChunks++;
        const byteIndex = index >>> 3;
        if (this.meta) {
            const headerBytes = this.integrity ? INTEGRITY_META_HEADER_BYTES : META_HEADER_BYTES;
            writeAll(this.meta, this.bits.subarray(byteIndex, byteIndex + 1), headerBytes + byteIndex);
            this.meta.flush();
        }

        if (this.completedChunks === this.chunkCount) await this.promote();
    }

    progress(): PersistentRangeProgress {
        let loadedBytes = Math.min(this.totalSize, this.completedChunks * this.chunkSize);
        if (this.completedChunks === this.chunkCount) loadedBytes = this.totalSize;
        return { loadedBytes, totalBytes: this.totalSize, complete: this.completedChunks === this.chunkCount };
    }

    private async promote(): Promise<void> {
        if (this.promoted) return;
        this.data.flush();
        this.data.close();
        this.meta?.close();
        this.meta = null;
        try { await this.cacheDir.removeEntry(this.metaName); } catch {}
        await this.dataFile.move!(this.finalKey);
        if (this.integrity) {
            // The marker is keyed by the raw-file SHA-256. Its existence means every
            // persisted 2 MiB chunk matched the signed descriptor before promotion.
            await this.cacheDir.getFileHandle(verifiedMarkerName(this.finalKey, this.integrity), { create: true });
        }
        // Keep serving the current game from the newly-promoted local file.
        this.data = await this.dataFile.createSyncAccessHandle!();
        this.promoted = true;
    }

    close(): void {
        try { this.data.close(); } catch {}
        try { this.meta?.close(); } catch {}
        this.meta = null;
    }
}

/**
 * Persist a foreground range without making the optional OPFS cache part of the
 * game's correctness path. Integrity failures still propagate so callers can
 * retry the network bytes; quota, handle, flush and promotion failures disable
 * persistence but must not discard the already-valid response being served.
 */
export async function writeRangeChunkBestEffort(
    store: Pick<PersistentRangeStore, "writeChunk">,
    index: number,
    bytes: Uint8Array,
    onStorageFailure: (error: unknown) => void,
): Promise<boolean> {
    try {
        await store.writeChunk(index, bytes);
        return true;
    } catch (error) {
        if (error instanceof RangeChunkIntegrityError) throw error;
        onStorageFailure(error);
        return false;
    }
}
