/**
 * bfme-coldpath-timeline — one isolated boot, sampled end to end.
 *
 * Emits a timeline of retired guest instructions, D3D9 presentations and DXT
 * encoder counters from page load through menu, skirmish setup and map load.
 * The point is attribution: guest throughput (MIPS) and encoder call counts are
 * structural quantities, so a phase can be compared across builds even though
 * ms/frame in the same phase is not reproducible.
 *
 *   bun tools/examples/bfme-coldpath-timeline.harness.ts --tag t1 [--port 9451]
 *     [--profile tmp/bfme1-current] [--no-nav] [--total 900]
 */

import { openBenchSession } from "../bench-session";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const port = Number(arg("port", "9451"));
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme1-current");
const game = arg("game", "bfme");
const tag = arg("tag", `t${Date.now()}`);
const totalSec = Number(arg("total", "900"));
const sampleSec = Number(arg("sample", "5"));

const bench = await openBenchSession({
    profile,
    url: `http://127.0.0.1:5173/?game=${game}&bench=${tag}`,
    port,
    matchToken: `bench=${tag}`,
});

const t0 = performance.now();
const samples: any[] = [];
const marks: Record<string, number> = {};

async function sample(): Promise<any> {
    const s = await bench.evalPage<any>(`(async () => {
        const d = await __BS__.harness.dbgCall("d3d9Perf");
        const o = await __BS__.harness.dbgCall("guestOdometer");
        const x = await __BS__.harness.dbgCall("dxtCacheReport");
        return {
            present: d?.api?.present ?? 0,
            draws: (d?.api?.drawPrimitive ?? 0) + (d?.api?.drawIndexedPrimitive ?? 0)
                 + (d?.api?.drawPrimitiveUP ?? 0) + (d?.api?.drawIndexedPrimitiveUP ?? 0),
            insn: o?.instructions ?? 0,
            ticks: o?.ticks ?? 0,
            dxtLookups: x?.lookups ?? 0,
            dxtHits: x?.hits ?? 0,
            dxtInserts: x?.inserts ?? 0,
            dxtReplacements: x?.replacements ?? 0,
        };
    })()`, 30_000).catch((e) => ({ err: String(e) }));
    s.tSec = Math.round((performance.now() - t0) / 100) / 10;
    samples.push(s);
    return s;
}

function lastTwo(): [any, any] | null {
    if (samples.length < 2) return null;
    return [samples[samples.length - 2], samples[samples.length - 1]];
}

function intervalMips(): number | null {
    const pair = lastTwo();
    if (!pair || pair[0].insn == null || pair[1].insn == null) return null;
    const dt = (pair[1].tSec - pair[0].tSec) * 1000;
    return dt > 0 ? Math.round(((pair[1].insn - pair[0].insn) / dt) / 1000 * 1000) / 1000 : null;
}

// BFME 1 runs an 800x600 exclusive desktop; these are its real menu coordinates.
const NAV: Array<{ label: string; x: number; y: number; afterMs: number }> = [
    { label: "solo", x: 90, y: 575, afterMs: 6_000 },
    { label: "skirmish", x: 320, y: 575, afterMs: 20_000 },
    { label: "play", x: 340, y: 575, afterMs: 0 },
];

let navIndex = 0;
let navDueAt = Infinity;
let sawPresent = false;

while (performance.now() - t0 < totalSec * 1_000) {
    const s = await sample();
    const mips = intervalMips();
    console.log(JSON.stringify({
        t: s.tSec, insn: s.insn, mips, present: s.present, draws: s.draws,
        dxt: s.dxtLookups, dxtHits: s.dxtHits,
    }));

    if (!sawPresent && s.present > 0) {
        sawPresent = true;
        marks.firstPresentSec = s.tSec;
        marks.firstPresentInsn = s.insn;
        // Give the menu a moment to settle before driving it.
        navDueAt = performance.now() + 15_000;
        console.log(`MARK first-present t=${s.tSec}s insn=${s.insn}`);
    }

    if (!has("no-nav") && navIndex < NAV.length && performance.now() >= navDueAt) {
        const step = NAV[navIndex]!;
        await bench.evalPage(`(async () => {
            await __BS__.harness.move(${step.x}, ${step.y});
            await new Promise(r => setTimeout(r, 1200));
            return __BS__.harness.clickHold(${step.x}, ${step.y}, 700);
        })()`, 30_000).catch((e) => console.log(`nav ${step.label} failed: ${e}`));
        marks[`nav_${step.label}_sec`] = Math.round((performance.now() - t0) / 100) / 10;
        marks[`nav_${step.label}_insn`] = s.insn;
        console.log(`MARK nav:${step.label} t=${marks[`nav_${step.label}_sec`]}s`);
        navDueAt = step.afterMs > 0 ? performance.now() + step.afterMs : Infinity;
        navIndex++;
    }

    await Bun.sleep(sampleSec * 1_000);
}

await bench.assertIsolated().catch((e) => console.log(`ISOLATION LOST: ${e}`));

console.log("RESULT " + JSON.stringify({
    tag,
    worker: bench.workerUrl?.split("/").at(-1) ?? null,
    marks,
    dxtAdvertise: await bench.dbg("dxtAdvertiseReport").catch(() => null),
    dxt: await bench.dbg("dxtCacheReport").catch(() => null),
    odometer: await bench.dbg("guestOdometer").catch(() => null),
    jit: await bench.dbg("jitCompileStats").catch(() => null),
    faults: await bench.evalPage(`__BS__.harness.faults(5)`).catch(() => null),
    samples,
}));
bench.close();
