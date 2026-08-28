import { harness } from "../harness";

const fastDxt = process.env.BFME_DXT_FAST === "1";
const fastRgb24 = process.env.BFME_RGB24_FAST === "1";
const fastSparseFloat4 = process.env.BFME_SPARSE_FLOAT4_FAST === "1";

// Start on the settled Skirmish setup screen. This isolates the expensive
// "Start -> map ready" phase from BFME's boot and menu-construction phases.
// Each window resets the frame/thunk profiler and the exact DXT-cache counters,
// so the output remains comparable even when the loading rate changes sharply.

function resultFor(run: any, cmd: string, occurrence = 0): any {
    return run.steps.filter((step: any) => step.cmd === cmd)[occurrence]?.result ?? null;
}

function debugResults(run: any): any[] {
    return run.steps
        .filter((step: any) => step.cmd === "dbgCall")
        .map((step: any) => step.result);
}

async function measure(label: string, durationMs: number, trace = false): Promise<void> {
    const chain = harness()
        .perfProfile({ enable: true, reset: true })
        .call("dbgCall", "jitCompileStats", true)
        .call("dbgCall", "dxtCacheReport", true)
        .call("dbgCall", "rgb24Report", true);
    chain.call("dbgCall", "sparseFloat4Report", true);

    if (trace) {
        chain
            .call("dbgCall", "trace2Reset")
            .call("dbgCall", "trace2WatchTier2", 64);
    }

    chain.sleep(durationMs);

    if (trace) chain.call("dbgCall", "trace2UnwatchAll");

    chain
        .perfStats()
        .perfSpikes({ top: 12, minMs: 40 })
        .profilerStats({ top: 30, sort: "total" })
        .call("dbgCall", "jitCompileStats")
        .call("dbgCall", "dxtCacheReport", true)
        .call("dbgCall", "rgb24Report", true)
        .call("dbgCall", "sparseFloat4Report", true)
        .call("dbgCall", "tier2Stats");

    if (trace) {
        chain
            .call("dbgCall", "trace2PageHistogram")
            .call("dbgCall", "trace2Blocks", 80);
    }

    chain.faults(20);
    const run = await chain.run();
    const debug = debugResults(run);
    console.log(JSON.stringify({
        phase: label,
        ok: run.ok,
        perf: resultFor(run, "perfStats"),
        spikes: resultFor(run, "perfSpikes"),
        profiler: resultFor(run, "profilerStats"),
        jit: debug.find((value) => value && typeof value === "object" && "started" in value),
        dxt: debug.findLast((value) => value && typeof value === "object" && "lookups" in value),
        rgb24: debug.findLast((value) => value && typeof value === "object" && "pixels" in value),
        sparseFloat4: debug.findLast((value) => value && typeof value === "object" && "items" in value),
        tier2: debug.find((value) => value && typeof value === "object" && "pageCount" in value),
        pages: trace ? debug.findLast((value) => Array.isArray(value)) : null,
        faults: resultFor(run, "faults"),
    }));
    if (!run.ok) process.exit(1);
}

await harness()
    .call("stopLogs")
    .call("dbgCall", "ioTrace", true, 4096)
    .call("dbgCall", "jitCompileStats", true)
    .call("dbgCall", "dxtCacheReport", true)
    .call("dbgCall", "dxtFast", fastDxt)
    .call("dbgCall", "rgb24Fast", fastRgb24)
    .call("dbgCall", "sparseFloat4Fast", fastSparseFloat4)
    .move(340, 575)
    .sleep(1_200)
    .call("clickHold", 340, 575, 700)
    .run();

await measure("loading-00-10s", 10_000);
await measure("loading-10-25s", 15_000);
await measure("loading-25-40s", 15_000, true);
await measure("loading-40-55s", 15_000);
await measure("loading-55-70s", 15_000);
await measure("loading-70-90s", 20_000);

const tail = await harness()
    .call("dbgCall", "ioTraceReport", true)
    .call("dbgCall", "shadowDiff")
    .call("dbgCall", "hleReport")
    .faults(20)
    .run();
console.log(JSON.stringify({ phase: "loading-tail", ok: tail.ok, debug: debugResults(tail), faults: resultFor(tail, "faults") }));
