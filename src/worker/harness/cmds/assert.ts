/**
 * Assertion verbs — turn a *driver* into a self-judging *test harness*.
 * Each throws a HarnessError on failure, which the DSL surfaces as a chain abort
 * + auto fault snapshot (facade.__runSteps). (expectSurfaceNonBlack lives in
 * textures.ts next to the readback it uses.)
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, serializeThreads } from "../serialize";
import { findDlgControl, describeDlgControl } from "../dlg";

export function registerAssertCommands(svc: HarnessService): void {
    /** expectDialog(title) — a window whose title contains `title` must exist. */
    svc.register("expectDialog", (args) => {
        const title = String(args[0] ?? "");
        const found = findDlgControl(title);
        if (!found) throw new HarnessError(`expectDialog: no window/control matching '${title}'`, HarnessErrorCode.NOT_FOUND);
        return { ok: true, ...describeDlgControl(found.hwnd, found.win) };
    });

    /** expectThread({state?, eip?}) — at least one thread must match. */
    svc.register("expectThread", (args) => {
        const opts = (args[0] ?? {}) as { state?: string; eip?: number };
        const snap = serializeThreads() as any;
        const threads: any[] = snap?.threads ?? [];
        const match = threads.find((t) =>
            (opts.state === undefined || String(t.stateName).toUpperCase() === String(opts.state).toUpperCase()) &&
            (opts.eip === undefined || (t.eip >>> 0) === (opts.eip >>> 0)),
        );
        if (!match) throw new HarnessError(`expectThread: no thread matching ${JSON.stringify(opts)}`, HarnessErrorCode.NOT_FOUND);
        return { ok: true, thread: match };
    });

    /** expectFileExists(path) — the VFS must have a file/dir at `path`.
     *  NOTE: getFileSize returns 0 (not -1) for a missing file, so we probe
     *  existence with a read-only openSync (null = not found) — distinguishing a
     *  genuine 0-byte file from an absent one (the 0-byte-save bug class). */
    svc.register("expectFileExists", (args) => {
        const path = String(args[0] ?? "");
        const fsx: any = sys().fileSystem as any;
        if (!fsx) throw new HarnessError("no filesystem", HarnessErrorCode.NO_PROCESS);
        const isDir = fsx.directoryExists(path);
        const handle = isDir ? null : fsx.openSync(path, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
        if (!handle && !isDir) throw new HarnessError(`expectFileExists: '${path}' not found`, HarnessErrorCode.NOT_FOUND);
        return { ok: true, path, size: handle ? fsx.getFileSize(path) : null, isDir, source: handle?.source ?? null };
    });
}
