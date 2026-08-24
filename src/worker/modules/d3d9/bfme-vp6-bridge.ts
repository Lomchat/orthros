/**
 * BFME VP6 compatibility bridge.
 *
 * BFME 1 decodes its long-form VP6 movies in guest code and uploads the result
 * through a 1024x512 X8R8G8B8 lockable surface.  The legacy decoder currently
 * produces an almost-black frame under the x86 runtime.  BottleShip already
 * ships a local FFmpeg/WASM decoder for Bink/Smacker; use the same decoder for
 * these large VP6 assets and replace the bad guest pixels immediately before
 * UnlockRect snapshots them into the D3D9 texture store.
 *
 * This is deliberately narrow: small *_with_alpha and menu-loop VP6 files keep
 * using BFME's native path.  Only large, non-alpha movies are intercepted.
 */

import { videoEngine, type VideoInfo } from "../../../video/video-engine";
import { Logger, LogCategory } from "../../core/logger";
import { System } from "../../core/system";

const MIN_LONG_FORM_BYTES = 8 * 1024 * 1024;
const MAX_MOVIE_BYTES = 192 * 1024 * 1024;

interface ActiveMovie {
    path: string;
    handle: number;
    info: VideoInfo;
    startedAt: number;
    decodedTarget: number;
    frame: Uint8Array | null;
    lastInjectedAt: number;
}

let generation = 0;
let loadingPath = "";
let active: ActiveMovie | null = null;
let lastNotedPath = "";
let lastNotedAt = 0;

function normalized(path: string): string {
    return path.replace(/\//g, "\\").toLowerCase();
}

function isLongFormVp6(path: string, size: number): boolean {
    const p = normalized(path);
    return p.endsWith(".vp6") &&
        p.includes("data\\movies\\") &&
        !p.includes("_with_alpha") &&
        size >= MIN_LONG_FORM_BYTES &&
        size <= MAX_MOVIE_BYTES;
}

/** Called after CreateFileA successfully opens a candidate movie. */
export function noteBfmeVp6Open(path: string): void {
    const vfs = System.getInstance().fileSystem;
    const size = vfs.getFileSize(path);
    const p = normalized(path);
    if (!p.endsWith(".vp6")) return;
    if (!isLongFormVp6(path, size)) {
        // Starting another non-alpha movie ends a previous long-form session.
        // Tiny *_with_alpha menu layers may coexist and must not disturb it.
        if (!p.includes("_with_alpha") && active) {
            videoEngine.close(active.handle);
            active = null;
        }
        return;
    }

    const now = performance.now();
    // One movie can be opened through several handles while it starts. Collapse
    // that burst, but allow selecting the same tutorial again later.
    if (loadingPath === path && lastNotedPath === path && now - lastNotedAt < 3000) return;
    if (active?.path === path && now - active.lastInjectedAt < 3000) return;
    lastNotedPath = path;
    lastNotedAt = now;

    const myGeneration = ++generation;
    loadingPath = path;
    void (async () => {
        try {
            const file = await vfs.open(path, 0x80000000, 3);
            if (!file) throw new Error("VFS open failed");
            const bytes = await vfs.read(file, size);
            if (myGeneration !== generation) return;

            const handle = await videoEngine.open(bytes);
            const info = videoEngine.getInfo(handle);
            if (!info || !info.codecName.toLowerCase().includes("vp6")) {
                videoEngine.close(handle);
                throw new Error(`unexpected codec ${info?.codecName ?? "unknown"}`);
            }
            if (active) videoEngine.close(active.handle);
            active = {
                path,
                handle,
                info,
                startedAt: performance.now(),
                decodedTarget: -1,
                frame: null,
                lastInjectedAt: performance.now(),
            };
            Logger.log(LogCategory.SYSTEM,
                `[BFME-VP6] ready "${path}" ${info.width}x${info.height} ` +
                `${info.fps.toFixed(3)}fps frames=${info.frameCount}`);
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `[BFME-VP6] failed "${path}": ${error}`);
        } finally {
            if (myGeneration === generation) loadingPath = "";
        }
    })();
}

/**
 * Replace a matching guest lock with the wall-clock VP6 frame. Returns true
 * when pixels were injected. The caller still performs its normal UnlockRect.
 */
export function injectBfmeVp6Frame(
    memory: Uint8Array,
    ptr: number,
    pitch: number,
    surfaceWidth: number,
    surfaceHeight: number,
    format: number,
): boolean {
    const movie = active;
    if (!movie || !movie.frame && movie.info.frameCount <= 0) return false;
    if (format !== 21 && format !== 22) return false; // A8R8G8B8 / X8R8G8B8

    // BFME rounds a 640x480 movie surface up to 1024x512. Matching the exact
    // power-of-two allocation avoids touching unrelated lockable textures.
    const expectedWidth = 1 << Math.ceil(Math.log2(movie.info.width));
    const expectedHeight = 1 << Math.ceil(Math.log2(movie.info.height));
    if (surfaceWidth !== expectedWidth || surfaceHeight !== expectedHeight) return false;
    if (pitch < movie.info.width * 4 || ptr <= 0) return false;

    const elapsed = Math.max(0, performance.now() - movie.startedAt);
    const durationMs = movie.info.frameCount > 0 && movie.info.fps > 0
        ? movie.info.frameCount * 1000 / movie.info.fps
        : Number.POSITIVE_INFINITY;
    if (elapsed > durationMs + 2000) {
        videoEngine.close(movie.handle);
        active = null;
        return false;
    }
    const target = Math.min(
        Math.max(0, movie.info.frameCount - 1),
        Math.floor(elapsed * Math.max(1, movie.info.fps) / 1000),
    );

    if (target !== movie.decodedTarget) {
        // Raw VP6 seek lands on the preceding keyframe and decoder_do_frame
        // emits the corresponding image. This keeps playback tied to wall time
        // even when the emulated game renders slowly (e.g. VPS SwiftShader).
        if (target !== movie.decodedTarget + 1) {
            videoEngine.gotoFrame(movie.handle, target);
        }
        if (videoEngine.doFrame(movie.handle)) {
            const decoded = videoEngine.getFrameBgra(movie.handle);
            if (decoded) movie.frame = new Uint8Array(decoded);
            movie.decodedTarget = target;
        }
    }

    const frame = movie.frame;
    if (!frame) return false;
    const rowBytes = movie.info.width * 4;
    const end = ptr + pitch * (movie.info.height - 1) + rowBytes;
    if (end > memory.length) return false;
    for (let y = 0; y < movie.info.height; y++) {
        const src = y * rowBytes;
        memory.set(frame.subarray(src, src + rowBytes), ptr + y * pitch);
    }
    movie.lastInjectedAt = performance.now();
    return true;
}

export function getBfmeVp6DebugState(): unknown {
    return {
        loadingPath,
        active: active ? {
            path: active.path,
            info: active.info,
            decodedTarget: active.decodedTarget,
            hasFrame: !!active.frame,
            ageMs: Math.round(performance.now() - active.startedAt),
        } : null,
    };
}
