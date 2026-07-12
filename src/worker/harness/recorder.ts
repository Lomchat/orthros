/**
 * Present-serial input recorder for record/replay. Captures harness-injected
 * input stamped with the PRESENT-FRAME delta (presentSerial - startSerial), and
 * replays it gated to present boundaries — deterministic vs the page-side
 * wall-clock setTimeout macro (App.tsx playRecording).
 *
 * Scope: this records the inputs the harness drives (the reproducible case) and
 * re-applies them at the same frame offsets. FULL bit-exact replay (poll-tick +
 * manual time-advance + FPU/scheduler determinism + checkpoints) is out of scope:
 * the engine has no deterministic FPU across context switches, so frame-gating is
 * the achievable lever.
 */

import { sys } from "./serialize";

export interface RecordedInput {
    /** present-serial offset from record start. */
    atFrame: number;
    cmd: string;
    args: unknown[];
}

export interface Recording {
    startSerial: number;
    events: RecordedInput[];
}

function presentSerial(): number {
    return (sys().services?.render?.getPresentSerial?.() ?? 0) >>> 0;
}

class Recorder {
    active = false;
    private startSerial = 0;
    private events: RecordedInput[] = [];

    start(): { recording: boolean; startSerial: number } {
        this.startSerial = presentSerial();
        this.events = [];
        this.active = true;
        return { recording: true, startSerial: this.startSerial };
    }

    /** Called by the input verbs (gated by `active`). */
    note(cmd: string, args: unknown[]): void {
        if (!this.active) return;
        this.events.push({ atFrame: (presentSerial() - this.startSerial) >>> 0, cmd, args });
    }

    stop(): Recording {
        this.active = false;
        return { startSerial: this.startSerial, events: this.events.slice() };
    }

    snapshot(): Recording {
        return { startSerial: this.startSerial, events: this.events.slice() };
    }
}

export const recorder = new Recorder();
