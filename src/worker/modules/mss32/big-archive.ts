import { Logger, LogCategory } from "../../core/logger";
import type { VirtualFileSystem, VfsFileHandle } from "../../runtime/filesystem/vfs";

export interface BigArchiveEntry {
    offset: number;
    size: number;
    name: string;
}

/** Parse the directory at the start of an EA BIG4/BIGF archive. */
export function parseBigDirectory(bytes: Uint8Array): Map<string, BigArchiveEntry> {
    if (bytes.byteLength < 16) throw new Error("BIG header is truncated");
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== "BIG4" && magic !== "BIGF") throw new Error(`unsupported BIG magic ${JSON.stringify(magic)}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(8, false);
    const headerSize = view.getUint32(12, false);
    if (count > 100_000 || headerSize < 16 || headerSize > bytes.byteLength) {
        throw new Error(`invalid BIG directory count=${count} headerSize=${headerSize}`);
    }

    const entries = new Map<string, BigArchiveEntry>();
    let cursor = 16;
    for (let i = 0; i < count; i++) {
        if (cursor + 9 > headerSize) throw new Error(`BIG entry ${i} is truncated`);
        const offset = view.getUint32(cursor, false);
        const size = view.getUint32(cursor + 4, false);
        cursor += 8;
        const nameStart = cursor;
        while (cursor < headerSize && bytes[cursor] !== 0) cursor++;
        if (cursor >= headerSize) throw new Error(`BIG entry ${i} has no filename terminator`);
        const name = new TextDecoder("windows-1252").decode(bytes.subarray(nameStart, cursor));
        cursor++;
        entries.set(normalizeBigPath(name), { offset, size, name });
    }
    return entries;
}

export function normalizeBigPath(name: string): string {
    return name.replace(/\//g, "\\").replace(/^\.?\\+/, "").toLowerCase();
}

const indexCache = new WeakMap<object, Map<string, Promise<Map<string, BigArchiveEntry> | null>>>();

async function openExisting(fs: VirtualFileSystem, path: string): Promise<VfsFileHandle | null> {
    return fs.openSync(path, 0x80000000, 3) ?? await fs.open(path, 0x80000000, 3);
}

async function readRange(fs: VirtualFileSystem, path: string, offset: number, size: number): Promise<Uint8Array | null> {
    const handle = await openExisting(fs, path);
    if (!handle) return null;
    fs.setPosition(handle, offset, 0);
    const sync = fs.readSync(handle, size);
    if (sync) return sync.slice();
    const data = await fs.read(handle, size);
    return data.byteLength ? data.slice() : null;
}

async function loadIndex(fs: VirtualFileSystem, archivePath: string): Promise<Map<string, BigArchiveEntry> | null> {
    const first = await readRange(fs, archivePath, 0, 16);
    if (!first || first.byteLength < 16) return null;
    const magic = String.fromCharCode(first[0], first[1], first[2], first[3]);
    if (magic !== "BIG4" && magic !== "BIGF") return null;
    const headerSize = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(12, false);
    if (headerSize < 16 || headerSize > 64 * 1024 * 1024) return null;
    const header = await readRange(fs, archivePath, 0, headerSize);
    if (!header || header.byteLength < headerSize) return null;
    return parseBigDirectory(header);
}

function cachedIndex(fs: VirtualFileSystem, archivePath: string): Promise<Map<string, BigArchiveEntry> | null> {
    let perFs = indexCache.get(fs as object);
    if (!perFs) indexCache.set(fs as object, perFs = new Map());
    let pending = perFs.get(archivePath);
    if (!pending) {
        pending = loadIndex(fs, archivePath).catch((error) => {
            Logger.warn(LogCategory.SYSTEM, `MSS32: BIG index ${archivePath} failed: ${String(error)}`);
            return null;
        });
        perFs.set(archivePath, pending);
    }
    return pending;
}

const AUDIO_ARCHIVES = [
    "Music.big",
    "AmbientStreams.big",
    "lang\\FrenchAudio.big",
    "Audio.big",
];

/** Resolve a BFME virtual audio path from the game's BIG archives without
 * unpacking hundreds of megabytes. Only the requested entry range is read. */
export async function readAudioFromBigArchives(fs: VirtualFileSystem, requestedPath: string): Promise<Uint8Array | null> {
    const key = normalizeBigPath(requestedPath);
    for (const archivePath of AUDIO_ARCHIVES) {
        const index = await cachedIndex(fs, archivePath);
        const entry = index?.get(key);
        if (!entry) continue;
        if (entry.size <= 0 || entry.size > 256 * 1024 * 1024) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: refusing invalid BIG audio size ${entry.size} for ${entry.name}`);
            return null;
        }
        const data = await readRange(fs, archivePath, entry.offset, entry.size);
        if (!data || data.byteLength !== entry.size) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: short BIG read for ${entry.name}: ${data?.byteLength ?? 0}/${entry.size}`);
            return null;
        }
        Logger.log(LogCategory.SYSTEM, `MSS32: loaded ${entry.name} (${entry.size} bytes) from ${archivePath}`);
        return data;
    }
    return null;
}
