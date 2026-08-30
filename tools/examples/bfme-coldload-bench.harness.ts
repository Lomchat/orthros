/**
 * bfme-coldload-bench — stationary cold-path benchmark for BFME.
 *
 * Reports, for one boot:
 *   - wall time and retired guest instructions to the first D3D9 presentation,
 *   - a fixed-work MIPS window on the warm menu (comparable across builds even
 *     though the menu is clamped to 30 FPS),
 *   - the DXT encoder counters, which are the cold path's dominant cost.
 *
 * Usage:
 *   bun tools/examples/bfme-coldload-bench.harness.ts [--port 9451]
 *     [--profile tmp/bfme1-current] [--game bfme] [--tag run1]
 *     [--work 400000000] [--boot-timeout 420]
 */

import { openBenchSession } from "../bench-session";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg("port", "9451"));
const profile = arg("profile", "tmp/bfme1-current");
const game = arg("game", "bfme");
const tag = arg("tag", `bench-${Date.now()}`);
const workInstructions = Number(arg("work", "400000000"));
const bootTimeoutSec = Number(arg("boot-timeout", "420"));

const url = `http://127.0.0.1:5173/?game=${game}&bench=${tag}`;

const bench = await openBenchSession({ profile, url, port, matchToken: `bench=${tag}` });

const t0 = performance.now();
let firstPresentMs: number | null = null;
let lastProgress = 0;

// The FPS pill only appears once RenderService has published a real interval,
// i.e. after a genuine D3D9 presentation. That makes it a usable milestone.
while (performance.now() - t0 < bootTimeoutSec * 1_000) {
    const fps = await bench.evalPage<string | null>(`(() => {
        const pill = [...document.querySelectorAll("span")].find(e =>
            [...e.children].some(c => c.textContent?.trim() === "FPS") && e.querySelector("strong"));
        return pill?.querySelector("strong")?.textContent?.trim() ?? null;
    })()`, 5_000).catch(() => null);
    if (fps && fps !== "—") { firstPresentMs = performance.now() - t0; break; }
    const elapsed = performance.now() - t0;
    if (elapsed - lastProgress > 20_000) {
        lastProgress = elapsed;
        const odo = await bench.dbg<any>("guestOdometer").catch(() => null);
        console.log(JSON.stringify({ waitingSec: Math.round(elapsed / 1000), odometer: odo?.instructions ?? null }));
    }
    await Bun.sleep(500);
}

if (firstPresentMs === null) throw new Error(`no presentation within ${bootTimeoutSec}s`);
await bench.assertIsolated();

const bootOdometer = await bench.dbg<any>("guestOdometer", true);
console.log(JSON.stringify({
    milestone: "first-present",
    wallMs: Math.round(firstPresentMs),
    guestInstructions: bootOdometer.instructions,
    meanInstructionsPerTick: bootOdometer.instructionsPerTick,
}));

// Let the menu settle, then measure a fixed amount of guest work. Unlike an
// ms/frame window this is not defeated by the engine's 30 FPS pacing clamp.
await Bun.sleep(10_000);
await bench.dbg("workWindow", workInstructions);
let window: any = null;
for (let i = 0; i < 240; i++) {
    await Bun.sleep(1_000);
    window = await bench.dbg<any>("workWindowReport");
    if (window?.done) break;
}
await bench.assertIsolated();

const report = {
    tag,
    worker: bench.workerUrl?.split("/").at(-1) ?? null,
    firstPresent: { wallMs: Math.round(firstPresentMs), guestInstructions: bootOdometer.instructions },
    workWindow: window,
    dxt: await bench.dbg("dxtCacheReport").catch(() => null),
    dxtAdvertise: await bench.dbg("dxtAdvertiseReport").catch(() => null),
    jit: await bench.evalPage(`__BS__.harness.dbgCall("jitCompileStats")`).catch(() => null),
    faults: await bench.evalPage(`__BS__.harness.faults(5)`).catch(() => null),
};
console.log("RESULT " + JSON.stringify(report));
bench.close();
