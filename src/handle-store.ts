/**
 * Persistent File System Access handle store (main thread).
 *
 * Lets a user pick an installed game's `.wgb` (or folder) ONCE via showOpenFilePicker/
 * showDirectoryPicker and keep playing it across sessions WITHOUT copying the (multi-GB) bundle into
 * hidden OPFS — the no-copy-ROM path. FileSystemFileHandle / FileSystemDirectoryHandle are
 * structured-cloneable, so we persist them in IndexedDB keyed by the game's container `gameId`. On a
 * later session we re-acquire the handle and re-request permission (Chrome drops the grant between
 * sessions — `verifyPermission` smooths this, but a user gesture is required to re-prompt).
 *
 * Chromium-only (showOpenFilePicker/persistent handles). `isSupported()` lets callers fall back to the
 * OPFS-copy path on other browsers.
 */

// Pre-rename name, kept: renaming the IndexedDB drops every stored directory handle.
const DB_NAME = "bottleship-handles";
const STORE = "handles";
const DB_VERSION = 1;

export interface StoredHandleRecord {
    /** Namespaced gameId (container key). */
    gameId: string;
    handle: FileSystemFileHandle | FileSystemDirectoryHandle;
    kind: "file" | "directory";
    /** Display label + size hint for the library list (avoids touching the handle to render). */
    title?: string;
    addedAt: number;
}

export function isSupported(): boolean {
    return typeof indexedDB !== "undefined" &&
        typeof (globalThis as any).showOpenFilePicker === "function";
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "gameId" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then((db) => new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
    }));
}

export async function saveHandle(rec: Omit<StoredHandleRecord, "addedAt"> & { addedAt?: number }): Promise<void> {
    await tx("readwrite", (s) => s.put({ addedAt: Date.now(), ...rec }));
}

export async function getHandle(gameId: string): Promise<StoredHandleRecord | null> {
    const rec = await tx<StoredHandleRecord | undefined>("readonly", (s) => s.get(gameId));
    return rec ?? null;
}

export async function listHandles(): Promise<StoredHandleRecord[]> {
    const all = await tx<StoredHandleRecord[]>("readonly", (s) => s.getAll() as IDBRequest<StoredHandleRecord[]>);
    return all ?? [];
}

export async function removeHandle(gameId: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(gameId));
}

/**
 * Ensure read permission on a stored handle, prompting if necessary. MUST be called from a user
 * gesture when it needs to prompt (Chrome requirement). Returns true if granted.
 */
export async function verifyPermission(
    handle: FileSystemHandle,
    mode: "read" | "readwrite" = "read",
): Promise<boolean> {
    const opts = { mode };
    const h = handle as any;
    if ((await h.queryPermission(opts)) === "granted") return true;
    if ((await h.requestPermission(opts)) === "granted") return true;
    return false;
}

/**
 * Resolve a stored handle to a `File` (the .wgb bytes) for no-copy loading, re-requesting permission
 * if needed. For a directory handle, expects a single `.wgb` inside (the simple BYO case). Returns
 * null if permission is denied or no bundle is found.
 */
export async function fileFromHandle(rec: StoredHandleRecord): Promise<File | null> {
    if (!(await verifyPermission(rec.handle, "read"))) return null;
    if (rec.kind === "file") {
        return (rec.handle as FileSystemFileHandle).getFile();
    }
    const dir = rec.handle as FileSystemDirectoryHandle;
    for await (const [name, h] of (dir as any).entries()) {
        if (h.kind === "file" && name.toLowerCase().endsWith(".wgb")) {
            return (h as FileSystemFileHandle).getFile();
        }
    }
    return null;
}
