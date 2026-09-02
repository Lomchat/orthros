import { Logger, LogCategory } from "../../core/logger";
import { getContainerDir } from "./container-store";

/**
 * Hot-page profile persistence: the set of guest code pages the JIT compiled in
 * earlier sessions, as v86's HOTP image, kept in the game's OPFS container next
 * to registry.json. Installed before the guest boots, it lets those pages compile
 * at first touch instead of after the interpreted hotness ramp — the ramp is the
 * dominant cost of a cold path made of code that runs once per session.
 *
 * The image is keyed by the executable's bytes (each page carries a hash), so a
 * profile from a different build is rejected page by page rather than trusted.
 */
export class HotProfilePersistence {
    private static readonly FILE = "jit-hot-profile.bin";
    private static readonly MAGIC = 0x50544f48; // "HOTP"
    /** Bound the file: a profile is a few hundred KiB for a large game. */
    private static readonly MAX_BYTES = 8 * 1024 * 1024;

    static isImage(bytes: Uint8Array): boolean {
        if (bytes.byteLength < 12 || bytes.byteLength > this.MAX_BYTES) return false;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return dv.getUint32(0, true) === this.MAGIC;
    }

    static async load(gameId: string): Promise<Uint8Array | null> {
        try {
            const dir = await getContainerDir(gameId, false);
            if (!dir) return null;
            const handle = await dir.getFileHandle(this.FILE);
            const file = await handle.getFile();
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (!this.isImage(bytes)) {
                Logger.warn(LogCategory.SYSTEM, `Ignoring malformed hot-page profile for ${gameId} (${bytes.byteLength} bytes)`);
                return null;
            }
            Logger.log(LogCategory.SYSTEM, `Loaded hot-page profile for ${gameId} (${bytes.byteLength} bytes)`);
            return bytes;
        } catch (err: any) {
            if (err?.name !== "NotFoundError") {
                Logger.error(LogCategory.SYSTEM, `Failed to load hot-page profile for ${gameId}: ${err?.message ?? err}`);
            }
            return null;
        }
    }

    /** Delete the stored profile; true when a file was removed. */
    static async remove(gameId: string): Promise<boolean> {
        try {
            const dir = await getContainerDir(gameId, false);
            if (!dir) return false;
            await dir.removeEntry(this.FILE);
            Logger.log(LogCategory.SYSTEM, `Removed hot-page profile for ${gameId}`);
            return true;
        } catch (err: any) {
            if (err?.name !== "NotFoundError") {
                Logger.error(LogCategory.SYSTEM, `Failed to remove hot-page profile for ${gameId}: ${err?.message ?? err}`);
            }
            return false;
        }
    }

    static async save(gameId: string, bytes: Uint8Array): Promise<boolean> {
        if (!this.isImage(bytes)) return false;
        try {
            const dir = await getContainerDir(gameId, true);
            if (!dir) return false;
            const handle = await dir.getFileHandle(this.FILE, { create: true });
            const writable = await handle.createWritable();
            // A view over wasm memory may sit on a SharedArrayBuffer, which the
            // stream will not take; write a private copy.
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            await writable.write(copy);
            await writable.close();
            Logger.verbose(LogCategory.SYSTEM, `Saved hot-page profile for ${gameId} (${bytes.byteLength} bytes)`);
            return true;
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `Failed to save hot-page profile for ${gameId}: ${error}`);
            return false;
        }
    }
}
