/**
 * shot() — capture the on-screen frame as a PNG. Worker-side wrap of
 * RenderActive.captureFrame() (the active presenter's screenshot), returned as
 * base64 through the RPC contract (POJO-friendly). With opts.save it also routes
 * the PNG to the log server via the existing debug_png_dump channel (logs/debug/).
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys } from "../serialize";

/** Base64-encode bytes (chunked to avoid String.fromCharCode arg overflow). */
export function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

export function registerScreenCommands(svc: HarnessService): void {
    svc.register("shot", async (args) => {
        const opts = (args[0] ?? {}) as { save?: string };
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.captureFrame) throw new HarnessError("no active presenter (nothing rendered yet)", HarnessErrorCode.UNSUPPORTED);
        const blob: Blob = await active.captureFrame();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const base64 = bytesToBase64(bytes);
        let saved: string | null = null;
        if (opts.save) {
            const name = opts.save.replace(/\.png$/i, "");
            (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
            saved = `logs/debug/${name}.png`;
        }
        return { bytes: bytes.length, base64, saved };
    });

    /**
     * frameLog(n?) — last `n` per-present summaries from the active presenter
     * (D3D9). Each entry: { p, hasClear, flags, cmds, draws, color }. Lets an
     * agent correlate visible black frames with clear-only presents (hasClear &&
     * draws===0) vs content presents — the decisive datum for swap/flicker bugs.
     */
    svc.register("frameLog", (args) => {
        const n = typeof args[0] === "number" ? (args[0] as number) : 60;
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.getFrameLog) throw new HarnessError("active presenter has no frameLog (not D3D9, or nothing rendered yet)", HarnessErrorCode.UNSUPPORTED);
        return active.getFrameLog(n);
    });

    /** rtDebug() — D3D9 render-target diagnostics: recent SetRenderTarget surface→texture
     *  resolutions + which textures were created with D3DUSAGE_RENDERTARGET. */
    svc.register("rtDebug", () => {
        const active: any = sys().services?.render?.getActive?.();
        if (!active?.getRtDebug) throw new HarnessError("active presenter has no rtDebug (not D3D9)", HarnessErrorCode.UNSUPPORTED);
        return active.getRtDebug();
    });
}
