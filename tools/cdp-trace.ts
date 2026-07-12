/**
 * cdp-trace.ts — capture a Chrome performance trace at the BROWSER level (via the
 * CDP Tracing domain) and write it as a .json.gz consumable by analyze-trace.ts.
 *
 * Unlike the harness perf verbs, this needs NO worker RPC cooperation — it works
 * even when the worker message pump is starved (long synchronous guest-load
 * bursts, livelocks), which is precisely when the in-worker profiler can't answer.
 *
 * Usage:
 *   bun tools/cdp-trace.ts [seconds] [out.json.gz]
 * Then:
 *   bun tools/analyze-trace.ts <out.json.gz> --thread worker
 */

import { gzipSync } from "bun";
import { connect } from "./cdp-core";

const seconds = Number(process.argv[2] ?? 8);
const outPath = process.argv[3] ?? "logs/harness/cdp-trace.json.gz";

const { session } = await connect();

// Categories: JS samples + our own console.timeStamp/perf marks; the disabled-by-default
// v8 cpu profiler category gives per-function self time that analyze-trace attributes.
const categories = [
    "-*",
    "devtools.timeline",
    "v8",
    "v8.execute",
    "disabled-by-default-v8.cpu_profiler",
    "toplevel",
    "blink.user_timing",
].join(",");

const chunks: any[] = [];
session.on("Tracing.dataCollected", (p) => {
    if (p?.value) chunks.push(...p.value);
});
const done = new Promise<void>((resolve) => {
    session.on("Tracing.tracingComplete", () => resolve());
});

console.log(`[cdp-trace] starting trace for ${seconds}s…`);
await session.send("Tracing.start", {
    traceConfig: { includedCategories: categories.split(",").filter(Boolean) },
    transferMode: "ReportEvents",
});
await Bun.sleep(seconds * 1000);
await session.send("Tracing.end");
await done;

const traceJson = JSON.stringify({ traceEvents: chunks });
await Bun.write(outPath, gzipSync(Buffer.from(traceJson)));
console.log(`[cdp-trace] ${chunks.length} events -> ${outPath} (${(traceJson.length / 1e6).toFixed(1)} MB uncompressed)`);
session.close();
process.exit(0);
