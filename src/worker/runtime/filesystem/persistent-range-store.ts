import type { SyncAccessHandleLike } from "@orthros/formats/zip";
import { wgbCacheKeyForUrl } from "./wgb-cache-key";

const CACHE_DIR = "wgb-cache";
const META_MAGIC = 0x42535243; // "BSRC" — Orthros range cache
const META_VERSION = 1;
const META_HEADER_BYTES = 32;
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
        this.completedChunks = countBits(args.bits, this.chunkCount);
    }

    static async open(url: string, totalSize: number, chunkSize: number): Promise<PersistentRangeStore | null> {
        try {
            if (!(totalSize > 0) || !(chunkSize > 0)) return null;
            const root = await navigator.storage.getDirectory();
            const orthros = await root.getDirectoryHandle("bottleship", { create: true });
            const dir = await orthros.getDirectoryHandle(CACHE_DIR, { create: true });
            const finalKey = wgbCacheKeyForUrl(url);
            const partName = `${finalKey}.part`;
            const metaName = `${partName}.map`;
            const chunkCount = Math.ceil(totalSize / chunkSize);
            const bitBytes = Math.ceil(chunkCount / 8);

            const dataFile = await dir.getFileHandle(partName, { create: true }) as SyncFileHandle;
            const metaFile = await dir.getFileHandle(metaName, { create: true }) as SyncFileHandle;
            if (typeof dataFile.createSyncAccessHandle !== "function" ||
                typeof metaFile.createSyncAccessHandle !== "function" ||
                typeof dataFile.move !== "function") return null;

            const data = await dataFile.createSyncAccessHandle();
            const meta = await metaFile.createSyncAccessHandle();
            const metaBytes = new Uint8Array(META_HEADER_BYTES + bitBytes);
            const existingMetaSize = meta.getSize();
            let valid = false;
            if (existingMetaSize === metaBytes.byteLength && readAll(meta, metaBytes, 0) === metaBytes.byteLength) {
                const view = new DataView(metaBytes.buffer);
                valid = view.getUint32(0, true) === META_MAGIC &&
                    view.getUint32(4, true) === META_VERSION &&
                    view.getFloat64(8, true) === totalSize &&
                    view.getUint32(16, true) === chunkSize &&
                    view.getUint32(20, true) === chunkCount &&
                    data.getSize() === totalSize;
            }

            if (!valid) {
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
                metaBytes.fill(0);
                const view = new DataView(metaBytes.buffer);
                view.setUint32(0, META_MAGIC, true);
                view.setUint32(4, META_VERSION, true);
                view.setFloat64(8, totalSize, true);
                view.setUint32(16, chunkSize, true);
                view.setUint32(20, chunkCount, true);
                data.truncate(totalSize);
                data.flush();
                meta.truncate(metaBytes.byteLength);
                writeAll(meta, metaBytes, 0);
                meta.flush();
            }

            const bits = metaBytes.slice(META_HEADER_BYTES);
            return new PersistentRangeStore({
                data, meta, dataFile, metaName, cacheDir: dir, finalKey,
                chunkSize, totalSize, bits,
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

        writeAll(this.data, bytes, start);
        this.data.flush();

        setBit(this.bits, index);
        this.completedChunks++;
        const byteIndex = index >>> 3;
        if (this.meta) {
            writeAll(this.meta, this.bits.subarray(byteIndex, byteIndex + 1), META_HEADER_BYTES + byteIndex);
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
