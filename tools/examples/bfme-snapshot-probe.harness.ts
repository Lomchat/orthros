/**
 * bfme-snapshot-probe — is a cached post-load state even possible?
 *
 * Thirty FPS on a map loading screen cannot be reached by making the emulator
 * faster: the engine presents ~38 times across a 180 s load, so the target is
 * ~140x away and the work is genuine single-threaded engine computation, not
 * overhead. The only construction that removes the wait is to not perform the
 * load twice — snapshot the guest once, restore it afterwards.
 *
 * That rests on one unverified assumption: that v86's save_state survives this
 * runtime at all. Orthros keeps large parts of the machine outside guest RAM
 * (D3D9 texture pixels, host file handles, worker-side HLE state), so a guest
 * snapshot may be both incomplete and too large to store. This measures the
 * size and the failure mode before any of it is built.
 *
 *   bun tools/examples/bfme-snapshot-probe.harness.ts [--port 9534]
 */

import { openBenchSession } from "../bench-session";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg("port", "9534"));
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme1-snap");
const tag = `snap-${Date.now()}`;

const bench = await openBenchSession({
    profile, port, url: `http://127.0.0.1:5173/?game=bfme&bench=${tag}`, matchToken: `bench=${tag}`,
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
await Bun.sleep(15_000);

console.log("PROBE " + JSON.stringify(await bench.dbg("snapshotProbe").catch(e => ({ threw: String(e) }))));
console.log("FAULTS " + JSON.stringify(await bench.evalPage(`__BS__.harness.faults(3)`).catch(() => null)));
bench.close();
