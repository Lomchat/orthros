/**
 * record / replay verbs. record() starts capturing harness inputs with
 * present-frame stamps; recordStop() returns the Recording; replay(recording)
 * re-injects each input gated to its recorded present-frame offset — so the replay
 * follows the same frame cadence rather than wall-clock.
 */

import type { HarnessService, HarnessCtx } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, proc } from "../serialize";
import { recorder, type Recording } from "../recorder";
import { applyInput } from "./input";

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    });
}

export function registerRecordCommands(svc: HarnessService): void {
    svc.register("record", () => recorder.start());
    svc.register("recordStop", () => recorder.stop());
    svc.register("recording", () => recorder.snapshot());

    /**
     * replay(recording, {speed?}) — re-inject recorded inputs gated to present
     * serial. Resumes v86 if parked. speed scales the frame gate (1 = same cadence).
     */
    svc.register("replay", async (args, ctx: HarnessCtx) => {
        const rec = args[0] as Recording | undefined;
        if (!rec || !Array.isArray(rec.events)) throw new HarnessError("replay expects a Recording {startSerial,events[]}", HarnessErrorCode.BAD_ARGS);
        const render: any = sys().services?.render;
        if (!render?.getPresentSerial) throw new HarnessError("render service unavailable", HarnessErrorCode.NO_PROCESS);
        const v86: any = proc()?.v86;
        if (v86?.is_running && !v86.is_running()) (globalThis as any).__harnessResume?.();
        const base = render.getPresentSerial() >>> 0;
        const applied: unknown[] = [];
        for (const ev of rec.events) {
            const targetSerial = base + (ev.atFrame >>> 0);
            // Gate to the present boundary (poll; cheap).
            while ((render.getPresentSerial() >>> 0) < targetSerial) {
                if (ctx.signal.aborted) throw ctx.signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED);
                await delay(4, ctx.signal);
            }
            try {
                applied.push({ atFrame: ev.atFrame, cmd: ev.cmd, result: applyInput(ev.cmd, ev.args) });
            } catch (e) {
                applied.push({ atFrame: ev.atFrame, cmd: ev.cmd, error: (e as Error).message });
            }
        }
        return { replayed: applied.length, baseSerial: base, applied };
    });
}
