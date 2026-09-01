/**
 * bfme-boot-ab — repeated, isolated cold-boot A/B.
 *
 * Boot to the first D3D9 presentation is the cold path in its purest form: it is
 * fully CPU bound, needs no UI driving, and is the same guest work every time.
 * Each run reports wall time AND retired guest instructions; the instruction
 * count is the stability check. If it moves between arms, the two arms did not
 * execute the same work and the wall-time delta means nothing.
 *
 *   bun tools/examples/bfme-boot-ab.harness.ts --runs 6 \
 *     --setup-a 'dbg.jitPendingCompiles(2)' --setup-b 'dbg.jitPendingCompiles(6)'
 *
 * Setups are evaluated in the page before the guest starts, so they must be
 * commands that persist their intent without a live WASM instance.
 */

import { openBenchSession } from "../bench-session";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg("port", "9453"));
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme1-current");
const game = arg("game", "bfme");
const runs = Number(arg("runs", "4"));
const bootTimeoutSec = Number(arg("boot-timeout", "400"));
/** Config index to read back per run, so an arm that failed to apply its
 *  setting shows up as a broken experiment rather than a null result. */
const verifyConfig = Number(arg("verify-config", "-1"));
const setupA = arg("setup-a", "");
const setupB = arg("setup-b", "");
const labelA = arg("label-a", "A");
const labelB = arg("label-b", "B");

interface RunResult {
    arm: string; run: number; wallMs: number; instructions: number;
    mips: number; interp?: any; jit: any; fpu?: any; tex?: any; dxt?: any; chain?: any; verified?: any;
    threadCpuMs?: any; sleepPaths?: any; ok: boolean; note?: string;
}
const results: RunResult[] = [];

async function bootOnce(arm: string, setup: string, run: number): Promise<RunResult> {
    const tag = `ab-${arm}-${run}-${Date.now()}`;
    const bench = await openBenchSession({
        profile, port, url: `http://127.0.0.1:5173/?game=${game}&bench=${tag}`, matchToken: `bench=${tag}`,
    });
    try {
        if (setup) {
            const applied = await bench.evalPage(`(async () => { const r = await (${setup}); return r; })()`, 30_000)
                .catch((e) => `setup failed: ${e}`);
            console.log(`[${arm}#${run}] setup ${setup} -> ${JSON.stringify(applied)}`);
        }
        const t0 = performance.now();
        let wallMs = -1;
        while (performance.now() - t0 < bootTimeoutSec * 1_000) {
            const present = await bench.evalPage<number>(
                `(async () => (await __BS__.harness.dbgCall("d3d9Perf"))?.api?.present ?? 0)()`, 20_000)
                .catch(() => 0);
            if (present > 0) { wallMs = performance.now() - t0; break; }
            await Bun.sleep(1_000);
        }
        if (wallMs < 0) {
            return { arm, run, wallMs: -1, instructions: -1, mips: 0, jit: null, ok: false, note: "timeout" };
        }
        await bench.assertIsolated();
        const odo = await bench.dbg<any>("guestOdometer");
        const interp = await bench.dbg<any>("interpretedShare").catch(() => null);
        const jit = await bench.dbg<any>("jitCompileStats").catch(() => null);
        const sched = await bench.dbg<any>("schedulerPerf").catch(() => null);
        const fpu = await bench.dbg<any>("fpuRelaxedReport").catch(() => null);
        // Texture memory is the mechanical half of the compressed-format question:
        // wall time drifts, 8x the bytes does not.
        const tex = await bench.dbg<any>("d3d9TextureMemory").catch(() => null);
        const dxt = await bench.dbg<any>("dxtAdvertiseReport").catch(() => null);
        // Read-only: proves the arm is actually in the state its label claims.
        // Two A/Bs in this repo compared identical arms because a pre-boot
        // setting was silently dropped, and the wall times looked like a null
        // result rather than a broken experiment.
        const chain = await bench.dbg<any>("jitConfig", 4).catch(() => null);
        const verified = verifyConfig >= 0
            ? await bench.dbg<any>("jitConfig", verifyConfig).catch(() => null)
            : null;
        return {
            arm, run, wallMs: Math.round(wallMs),
            instructions: odo?.instructions ?? -1,
            mips: Math.round(((odo?.instructions ?? 0) / wallMs) / 1000 * 1000) / 1000,
            interp,
            // Forward the whole JIT report: hand-picking fields here silently
            // dropped newly added counters from finished experiments.
            jit,
            fpu,
            tex,
            dxt,
            chain,
            verified,
            threadCpuMs: sched?.threadCpuMs ?? null,
            sleepPaths: sched?.sleepPaths ?? null,
            ok: true,
        };
    } finally {
        bench.close();
    }
}

for (let run = 1; run <= runs; run++) {
    // Alternate and reverse each pair (ABBA), so a monotonic drift in machine
    // state cannot masquerade as an effect.
    const order = run % 2 === 1 ? [["A", setupA, labelA], ["B", setupB, labelB]] : [["B", setupB, labelB], ["A", setupA, labelA]];
    for (const [arm, setup, label] of order as Array<[string, string, string]>) {
        const r = await bootOnce(label, setup, run);
        results.push(r);
        console.log(`RUN ${JSON.stringify(r)}`);
    }
}

function summarize(label: string) {
    const rows = results.filter((r) => r.arm === label && r.ok);
    if (rows.length === 0) return { label, n: 0 };
    const wall = rows.map((r) => r.wallMs).sort((a, b) => a - b);
    const insn = rows.map((r) => r.instructions).sort((a, b) => a - b);
    const median = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
        label, n: rows.length,
        wallMedianMs: median(wall), wallMeanMs: Math.round(mean(wall)),
        wallMinMs: wall[0], wallMaxMs: wall[wall.length - 1],
        insnMedian: median(insn),
        insnSpreadPct: Math.round(((insn[insn.length - 1]! - insn[0]!) / insn[0]!) * 10_000) / 100,
        mipsMean: Math.round(mean(rows.map((r) => r.mips)) * 1000) / 1000,
        interpretedPctMean: Math.round(mean(rows.map((r) => r.interp?.interpretedPct ?? 0)) * 100) / 100,
    };
}

console.log("SUMMARY " + JSON.stringify({
    a: summarize(labelA), b: summarize(labelB), runs: results,
}));
