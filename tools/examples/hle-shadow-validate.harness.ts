/**
 * M1 gate — in-game shadow validation of inner-loop HLE hooks (Guarded
 * Inner-Loop HLE, sync original-call primitive).
 *
 * Boots the NFSU retail bundle, Enter-skips the intros, then polls
 * dbg.hleHooks until every shadow-enabled hook leaves 'shadowing' (→ VALIDATED
 * 'active' with 0 mismatches = PASS; 'disabled' = FAIL with the mismatch
 * detail in the output). Reusable for every future hook that flips
 * validateInGame — the poll is descriptor-agnostic.
 *
 * Usage: bun tools/harness.ts up && bun tools/harness.ts run tools/examples/hle-shadow-validate.harness.ts
 */

import { harness } from "../harness";

interface HookStatus {
    libId: string;
    functionName: string;
    state: string;
    cleanCalls: number;
    targetCalls: number;
    guardFails: number;
    mismatches: number;
    lastMismatch?: string;
}

function grab(result: unknown): HookStatus[] {
    // .call("dbgCall", ...) journals under the RPC command name, not "call".
    const steps = (result as { steps?: Array<{ cmd: string; result?: unknown }> }).steps ?? [];
    const call = steps.filter(s => s.cmd === "dbgCall").pop();
    return ((call?.result as HookStatus[]) ?? []);
}

// Fresh worker + fresh wasm, then boot the retail bundle.
await harness().reload().run();
await harness()
    .streamLogs(["SYSTEM"])
    .openWgb("/apps/nfs-underground.wgb")
    .tickFrames(60)
    .run();

const started = Date.now();
let last: HookStatus[] = [];
let verdict = "TIMEOUT";
while (Date.now() - started < 180_000) {
    // Enter-skips intros (harmless once in the menu), then poll hook states.
    const r = await harness()
        .call("key", "Enter")
        .tickFrames(30)
        .call("dbgCall", "hleHooks")
        .run();
    last = grab(r);
    if (last.length > 0 && last.every(h => h.state !== "shadowing")) {
        verdict = last.every(h => h.state === "active" && h.mismatches === 0) ? "PASS" : "FAIL";
        break;
    }
}

console.log(JSON.stringify({ verdict, hooks: last }, null, 2));
if (verdict !== "PASS") process.exitCode = 1;
