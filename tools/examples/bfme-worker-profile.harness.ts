/**
 * bfme-worker-profile — CPU profile of the emulator Worker for a chosen phase.
 *
 * Guest execution lives in the Worker, so a page-side profile shows almost
 * nothing, and the Worker is a dedicated target: absent from /json/list and from
 * Target.getTargets, reachable only via auto-attach. This drives that path.
 *
 * Self time is the question a dispatch-entry histogram cannot answer. Code made
 * of short branchy blocks — x87 compare-and-branch sequences especially — scores
 * high on entries without necessarily costing the most time, so a hot page has
 * to be confirmed here before it is worth optimising.
 *
 *   bun tools/examples/bfme-worker-profile.harness.ts [--port 9552]
 *     [--profile ...] [--game bfme] [--seconds 10] [--settle 15]
 */

import { openBenchSession } from "../bench-session";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg("port", "9552"));
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme1-current");
const game = arg("game", "bfme");
const seconds = Number(arg("seconds", "10"));
const settleSec = Number(arg("settle", "15"));
const tag = `wprof-${Date.now()}`;

const bench = await openBenchSession({
    profile, port, url: `http://127.0.0.1:5173/?game=${game}&bench=${tag}`, matchToken: `bench=${tag}`,
});

const t0 = performance.now();
while (performance.now() - t0 < 400_000) {
    const p = await bench.evalPage<number>(
        `(async () => (await __BS__.harness.dbgCall("d3d9Perf"))?.api?.present ?? 0)()`, 30_000,
    ).catch(() => 0);
    if (p > 0) break;
    await Bun.sleep(2_000);
}
console.log(`first present after ${Math.round((performance.now() - t0) / 1000)}s`);
await Bun.sleep(settleSec * 1_000);

const prof = await bench.profileWorker(seconds * 1_000, 20);
console.log(`samples=${prof.totalSamples} over ${prof.durationMs}ms`);
for (const r of prof.top) {
    console.log(`${String(r.pct).padStart(6)}%  ${r.fn.slice(0, 54).padEnd(54)} ${r.url.slice(0, 24)}`);
}
console.log("RESULT " + JSON.stringify(prof));
bench.close();
