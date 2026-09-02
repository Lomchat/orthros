/**
 * bfme-reach-map-load — get BFME into an actual map load, reliably.
 *
 * Reaching the load is the prerequisite for every cold-path measurement, and it
 * kept failing for a reason that is invisible without feedback: the menus depend
 * on persisted profile state. A fresh profile shows a first-run modal that only
 * the keyboard dismisses; a profile that already has a player shows a different
 * screen, with a different draws-per-frame signature and a different Play
 * position. Blind coordinate scripts therefore work on one profile and silently
 * do nothing on another, producing zeroed counters that read as "the change
 * under test had no effect".
 *
 * This drives the menus as a state machine keyed on draws-per-presentation:
 * Escape back to a known screen, walk forward, verify every transition, and try
 * candidate coordinates until one moves the screen. The map load itself is
 * detected structurally — presentations nearly stop while draws keep climbing,
 * because the engine is inside long synchronous work — so success does not
 * depend on recognising any particular screen.
 *
 *   bun tools/examples/bfme-reach-map-load.harness.ts [--port 9530]
 *     [--profile ...] [--attempts 3] [--hold 240]
 *
 * Exits non-zero if no load was reached, rather than reporting empty counters.
 */

import { openBenchSession, type BenchSession } from "../bench-session";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg("port", "9530"));
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme1-current");
const game = arg("game", "bfme");
const attempts = Number(arg("attempts", "3"));
const holdSec = Number(arg("hold", "240"));
/** Guest instructions to time. Work parity removes the "how far did the load
 *  get" term, which otherwise dominates every comparison. */
const workTarget = Number(arg("work", "0"));
const bootTimeoutSec = Number(arg("boot-timeout", "400"));
/** Hot-page profile (HOTP image) to install before the guest boots, and the
 *  file to write the merged profile to after the hold. Pages the profile knows
 *  compile at first touch, so a second session skips the interpreted ramp the
 *  first one paid; comparing the two runs is the gate for that mechanism. */
const importProfile = arg("import-profile", "");
const exportProfile = arg("export-profile", "");
/** Ahead-of-time batch (URL without extension, see tools/aot/build-batch.ts)
 *  installed `--aot-at` seconds into the hold, so the windows before and after
 *  compare the same session with and without the translated code. */
const aotInstall = arg("aot-install", "");
const aotAtSec = Number(arg("aot-at", "120"));
/** Print the hottest missing-entry addresses (reset ten seconds earlier). */
const missTopAtSec = Number(arg("miss-top-at", "-1"));
/** Dump the dispatch-entry histogram by page (30 s window starting at
 *  --hot-dump-at seconds into the hold) to a JSON file: the dynamic hotness
 *  an ahead-of-time batch should be selected by. */
const hotDump = arg("dump-hot-pages", "");
const hotDumpAtSec = Number(arg("hot-dump-at", "90"));
const tag = `load-${Date.now()}`;

interface Sample { present: number; draws: number }

async function sample(b: BenchSession): Promise<Sample> {
    return b.evalPage<Sample>(`(async () => {
        const a = (await __BS__.harness.dbgCall("d3d9Perf"))?.api ?? {};
        return { present: a.present ?? 0,
                 draws: (a.drawPrimitive ?? 0) + (a.drawIndexedPrimitive ?? 0)
                      + (a.drawPrimitiveUP ?? 0) + (a.drawIndexedPrimitiveUP ?? 0) };
    })()`, 30_000);
}

/** A full JIT cache flush sends the whole working set back to the interpreter to
 *  re-climb the hotness ramp, so its rate during a load explains far more about
 *  the frame times than the presentation counters do. */
/** Read-and-reset, so each value covers exactly one sampling window. The
 *  question is how much of a load is the emulator deliberately yielding to the
 *  host because the guest asked to sleep. */
async function sleepStats(b: BenchSession): Promise<any> {
    return b.evalPage(`__BS__.harness.dbgCall("schedulerPerf", true)`, 30_000).catch(() => null);
}

/** Read-and-reset so each value covers exactly one window. */
async function jitStats(b: BenchSession): Promise<Record<string, number> | null> {
    return b.evalPage(`__BS__.harness.dbgCall("jitCompileStats", true)`, 30_000).catch(() => null);
}

/** Splits interpreted work by what would fix it: a page with nothing compiled
 *  needs a module, a page whose module lacks this entry point needs recompiling,
 *  and a state mismatch needs its own module. Without this a high interpreted
 *  share says only that the JIT is losing, not which lever would change it. */
async function interpShare(b: BenchSession): Promise<Record<string, number> | null> {
    return b.evalPage(`__BS__.harness.dbgCall("interpretedShare")`, 30_000).catch(() => null);
}

const hotPages = process.argv.includes("--hot-pages");
const cpuProfile = process.argv.includes("--cpu-profile");
let profiledStall = false;
let profiledAotHang = false;

/** Arm the in-dispatch page histogram for the next window. */
async function armHot(b: BenchSession): Promise<void> {
    if (hotPages) await b.evalPage(`__BS__.harness.dbgCall("hotPages", true)`, 30_000).catch(() => {});
}

async function readHot(b: BenchSession): Promise<any> {
    if (!hotPages) return null;
    return b.evalPage(`__BS__.harness.dbgCall("hotPages", false, 6)`, 30_000).catch(() => null);
}

/** Draws per presentation identifies the screen; presentation rate identifies load. */
async function probe(b: BenchSession, ms = 4_000): Promise<{ fps: number; dpf: number }> {
    const a = await sample(b);
    await Bun.sleep(ms);
    const c = await sample(b);
    const dp = c.present - a.present;
    return { fps: dp / (ms / 1000), dpf: dp > 0 ? Math.round((c.draws - a.draws) / dp) : 0 };
}

async function click(b: BenchSession, x: number, y: number): Promise<void> {
    await b.evalPage(`(async () => { await __BS__.harness.move(${x}, ${y});
        await new Promise(r => setTimeout(r, 900));
        return __BS__.harness.clickHold(${x}, ${y}, 600); })()`, 30_000).catch(() => {});
}

async function key(b: BenchSession, k: string | number): Promise<void> {
    await b.evalPage(`__BS__.harness.keyHold(${JSON.stringify(k)}, 120)`, 20_000).catch(() => {});
    await Bun.sleep(400);
}

/** True once presentations nearly stop while draws keep advancing. */
function looksLikeLoading(before: Sample, after: Sample, seconds: number): boolean {
    const fps = (after.present - before.present) / seconds;
    return fps < 5 && after.draws > before.draws;
}

/**
 * A profile with no player stops on a modal that ignores the mouse: it wants a
 * name typed and confirmed. A profile that already has one goes straight to the
 * map list. The two screens are only distinguishable by their draws per frame,
 * and clicking Play on the wrong one does nothing at all — which reads as "the
 * change under test had no effect" rather than as a navigation failure.
 */
async function dismissProfileModal(b: BenchSession): Promise<void> {
    const before = await probe(b, 3_000);
    await key(b, "enter");
    await Bun.sleep(8_000);
    let after = await probe(b, 3_000);
    if (Math.abs(after.dpf - before.dpf) / Math.max(1, before.dpf) > 0.2) {
        console.log(JSON.stringify({ step: "profile-modal", via: "enter",
            dpf: { before: before.dpf, after: after.dpf } }));
        return;
    }
    await b.evalPage(`__BS__.harness.type("Bench")`, 30_000).catch(() => {});
    await Bun.sleep(1_500);
    await key(b, "enter");
    await Bun.sleep(9_000);
    after = await probe(b, 3_000);
    console.log(JSON.stringify({ step: "profile-modal", via: "type+enter",
        dpf: { before: before.dpf, after: after.dpf } }));
}

async function tryStep(
    b: BenchSession, label: string, candidates: Array<[number, number]>, settleMs: number,
): Promise<boolean> {
    const before = await probe(b, 3_000);
    for (const [x, y] of candidates) {
        await click(b, x, y);
        await Bun.sleep(settleMs);
        const after = await probe(b, 3_000);
        const moved = before.dpf > 0 ? Math.abs(after.dpf - before.dpf) / before.dpf : 1;
        console.log(JSON.stringify({ step: label, tried: [x, y],
            dpf: { before: before.dpf, after: after.dpf }, fps: after.fps,
            changePct: Math.round(moved * 1000) / 10 }));
        if (moved > 0.2 || after.fps < 5) return true;
    }
    return false;
}

const bench = await openBenchSession({
    profile, port, url: `http://127.0.0.1:5173/?game=${game}&bench=${tag}`, matchToken: `bench=${tag}`,
});

// Set before the boot compiles anything, so the whole run is one policy rather
// than a mixture either side of a mid-flight toggle.
// Route every failed dynamic chain through the Rust resolver so the refusal is
// attributed by cause instead of collapsing into one counter.
// The PreemptionManager remembers this across the v86 that does not exist yet;
// the dispatch counters cannot be armed until it does, so that waits for the load.
if (process.argv.includes("--attribute-chain-misses")) {
    console.log("budget-fast-exit off " + JSON.stringify(
        await bench.dbg("jitBudgetFastExit", false).catch((e) => String(e))));
}

// The Tier-1 threshold was last judged with return chaining effectively off,
// so the balance between compiling a page and interpreting it may have moved.
const thresholdArg = process.argv.indexOf("--threshold");
if (thresholdArg >= 0 && process.argv[thresholdArg + 1]) {
    const t = Number(process.argv[thresholdArg + 1]);
    console.log(`threshold ${t} -> ` + JSON.stringify(
        await bench.dbg("jitBaseThreshold", t).catch((e) => String(e))));
}

if (process.argv.includes("--no-rearm")) {
    console.log("rearm disabled " + JSON.stringify(
        await bench.dbg("rearmOnSwitch", false).catch((e) => String(e))));
}

if (process.argv.includes("--rearm-on-switch")) {
    console.log("rearm-on-switch " + JSON.stringify(
        await bench.dbg("rearmOnSwitch", true).catch((e) => String(e))));
}

// config 42 lowers the compile threshold for a page that already owns a module,
// so a missing entry point recompiles it — and every recompile frees the old slot,
// which invalidates the whole return cache. Worth an A/B against 1 (off).
const divisorArg = process.argv.indexOf("--recompile-divisor");
if (divisorArg >= 0 && process.argv[divisorArg + 1]) {
    console.log("recompile-divisor " + JSON.stringify(
        await bench.dbg("jitRecompileDivisor", Number(process.argv[divisorArg + 1])).catch((e) => String(e))));
}

if (process.argv.includes("--flag-elision")) {
    console.log("flag-elision-across-faults " + JSON.stringify(
        await bench.dbg("jitFlagElisionAcrossFaults", true).catch((e) => String(e))));
}

if (process.argv.includes("--park-guard")) {
    console.log("park-guard " + JSON.stringify(
        await bench.dbg("jitChainParkGuard", true).catch((e) => String(e))));
}

if (process.argv.includes("--honor-urgent-exit")) {
    console.log("honor-urgent-exit " + JSON.stringify(
        await bench.dbg("jitHonorUrgentExit", true).catch((e) => String(e))));
}

if (process.argv.includes("--partial-eviction")) {
    console.log("partial-eviction " + JSON.stringify(
        await bench.dbg("jitPartialEviction", true).catch((e) => String(e))));
}

if (importProfile) {
    // Before the guest boots: the authority records the profile and installs it
    // on v86 init. If the worker is already past init, it installs immediately
    // and the pages touched so far simply miss the forced compile.
    const b64 = Buffer.from(await Bun.file(importProfile).arrayBuffer()).toString("base64");
    const applied = await bench.evalPage(
        `__BS__.harness.dbgCall("jitHotProfileImport", ${JSON.stringify(b64)})`, 60_000)
        .catch((e) => `import failed: ${e}`);
    console.log(`import-profile ${importProfile} (${b64.length} b64 chars) -> ${JSON.stringify(applied)}`);
}

const t0 = performance.now();
while (performance.now() - t0 < bootTimeoutSec * 1_000) {
    const s = await sample(bench).catch(() => null);
    if (s && s.present > 0) break;
    await Bun.sleep(2_000);
}
console.log(`first present after ${Math.round((performance.now() - t0) / 1000)}s`);
console.log("boot jit " + JSON.stringify(await bench.dbg("jitCompileStats").catch(() => null)));
console.log("boot hot-profile " + JSON.stringify(await bench.dbg("jitHotProfileStats").catch(() => null)));
// Interpreted share of the boot itself: the profile's first-touch compiles
// only pay off if this falls, so the number belongs next to the boot time.
console.log("boot interp " + JSON.stringify(await bench.dbg("interpretedShare").catch(() => null)));

// After boot, not before: these go straight to the wasm instance, which does not
// exist until the game has loaded. Applied earlier they silently do nothing.
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--jit-config" || !process.argv[i + 1]) continue;
    const [idx, val] = process.argv[i + 1]!.split("=").map(Number);
    const applied = await bench.dbg("jitConfig", idx, val).catch((e) => String(e));
    console.log(`jit-config ${idx}=${val} -> ${JSON.stringify(applied)}`);
    if (applied !== val) throw new Error(`jit config ${idx} did not take (got ${applied})`);
}
// The relaxed-FPU counters are emitted into blocks as they compile, so arming
// them here covers everything compiled from the menu on; arming at report time
// would only see blocks that happened to recompile afterwards.
if (process.argv.includes("--fpu-stats")) {
    console.log(`fpu-stats armed -> ${JSON.stringify(await bench.dbg("fpuRelaxed", true).catch((e) => String(e)))}`);
    await bench.dbg("jitClear").catch(() => null);
}
// Same constraint, and the counters cost enough that FPS read while they are
// armed is not comparable to a production frame time.
if (process.argv.includes("--dispatch-stats")) {
    console.log(`dispatch-stats armed -> ${JSON.stringify(await bench.dbg("dispatchStatsEnable", true).catch((e) => String(e)))}`);
    await bench.dbg("jitClear").catch(() => null);
}
await Bun.sleep(12_000);

let loading = false;
for (let attempt = 1; attempt <= attempts && !loading; attempt++) {
    // Escape back to a known screen: which one we start from depends on profile
    // state left by earlier runs, and that is exactly what broke previous scripts.
    for (let i = 0; i < 3; i++) await key(bench, "escape");
    await Bun.sleep(6_000);
    console.log(`attempt ${attempt} baseline ${JSON.stringify(await probe(bench))}`);

    // Explicit coordinates when the title's layout is known: the greedy "first
    // candidate that moves the screen wins" rule picks the wrong button on BFME II,
    // whose menu differs from BFME 1's.
    const coord = (name: string, fallback: Array<[number, number]>): Array<[number, number]> => {
        const i = process.argv.indexOf(`--${name}`);
        if (i < 0 || !process.argv[i + 1]) return fallback;
        const [x, y] = process.argv[i + 1]!.split(",").map(Number);
        return [[x!, y!]];
    };
    await tryStep(bench, "solo", coord("solo", [[90, 575], [215, 575], [160, 575]]), 7_000);
    await tryStep(bench, "skirmish", coord("skirmish", [[320, 575], [215, 387], [215, 420]]), 12_000);
    await dismissProfileModal(bench);
    // Arm before the click, not after the loading heuristic confirms: that
    // heuristic fires up to a sampling period late, and a retried attempt adds a
    // whole navigation cycle — two runs armed 23.6bn and 44.9bn instructions
    // apart and so measured different parts of the load.
    if (workTarget > 0) {
        console.log("work-window " + JSON.stringify(
            await bench.dbg("workWindow", workTarget).catch((e) => String(e))));
    }
    await tryStep(bench, "play", coord("play", [[340, 575], [705, 574], [640, 556]]), 15_000);

    const a = await sample(bench);
    await Bun.sleep(20_000);
    const c = await sample(bench);
    loading = looksLikeLoading(a, c, 20);
    console.log(JSON.stringify({ attempt, loading,
        fps: Math.round(((c.present - a.present) / 20) * 100) / 100 }));
}

if (!loading) {
    console.log("REACH-FAILED no map load detected");
    for (const e of bench.workerErrors()) console.log("WORKER-ERROR " + e);
    bench.close();
    process.exit(1);
}

console.log("LOADING confirmed — sampling");
await bench.dbg("stallReset").catch(() => null);
await bench.dbg("thunkCensus", true).catch(() => null);
if (process.argv.includes("--attribute-chain-misses")) {
    console.log("fastExit=" + JSON.stringify(await bench.dbg("jitBudgetFastExit", false).catch(() => null)));
    await bench.evalPage(`__BS__.harness.dbgCall("dispatchStatsEnable")`, 20_000).catch(() => {});
}
let prev = await sample(bench);
let prevJit = await jitStats(bench);
let prevInterp = await interpShare(bench);
// Read-and-reset now, or the first window's scheduler counters cover the whole
// boot and menu instead of ten seconds of loading.
await sleepStats(bench);
const jit0 = prevJit;
const tL = performance.now();
/** Per-window frame rate through the hold, so the load phase can be isolated
 *  from the gameplay that follows it rather than averaged together with it. */
const holdFps: number[] = [];
for (let i = 0; i < Math.ceil(holdSec / 10); i++) {
    if (hotDump && i * 10 === hotDumpAtSec) {
        await bench.evalPage(`__BS__.harness.dbgCall("hotPages", true)`, 30_000).catch(() => {});
        await Bun.sleep(30_000);
        const hp = await bench.evalPage(`__BS__.harness.dbgCall("hotPages", false, 6000)`, 60_000).catch(() => null);
        await bench.evalPage(`__BS__.harness.dbgCall("hotPages", null)`, 30_000).catch(() => {});
        await Bun.write(hotDump, JSON.stringify(hp));
        console.log(`HOT-DUMP ${hotDump}: ${JSON.stringify({ total: (hp as any)?.total, pages: (hp as any)?.pages })}`);
    }
    if (missTopAtSec >= 0 && i * 10 === missTopAtSec - 10) {
        await bench.evalPage(`__BS__.harness.dbgCall("missEntryTop", 0, true)`, 15_000).catch(() => {});
    }
    if (missTopAtSec >= 0 && i * 10 === missTopAtSec) {
        const top = await bench.evalPage(`__BS__.harness.dbgCall("missEntryTop", 32)`, 15_000).catch((e) => ({ error: String(e) }));
        console.log(`MISS-ENTRY-TOP at T+${i * 10}s ${JSON.stringify(top)}`);
    }
    if (aotInstall && i * 10 === aotAtSec) {
        const r = await bench.evalPage(`__BS__.harness.dbgCall("aotInstall", ${JSON.stringify(aotInstall)})`, 120_000)
            .catch((e) => `aotInstall failed: ${e}`);
        console.log(`AOT-INSTALL at T+${i * 10}s ${JSON.stringify(r)}`);
    }
    await armHot(bench);
    await Bun.sleep(10_000);
    const hot = await readHot(bench);
    const s = await sample(bench);
    const j = await jitStats(bench);
    const ip = await interpShare(bench);
    const dp = s.present - prev.present;
    holdFps.push(dp / 10);
    // jitStats now resets, so its values already cover this window.
    const d = (k: string) => (j ? (j[k] ?? 0) : 0);
    const di = (k: string) => (ip && prevInterp ? (ip[k] ?? 0) - (prevInterp[k] ?? 0) : 0);
    const retired = di("retired");
    // Retired guest instructions per second: the throughput a capped frame
    // rate cannot show, and the number that compares an installed batch with
    // the windows before it.
    console.log(`T+${((performance.now() - tL) / 1000).toFixed(0)}s fps=${(dp / 10).toFixed(2)}`
        + ` mips=${(retired / 10e6).toFixed(1)}`
        + ` dpf=${dp > 0 ? Math.round((s.draws - prev.draws) / dp) : 0}`
        + ` compiled=${d("completed")} forced=${d("hotForced")} codegenMs=${d("codegenMs").toFixed(0)} invalSlot=${d("retCacheInvalSlot")} invalTlb=${d("retCacheInvalTlb")} interp=${retired > 0 ? ((di("interpreted") / retired) * 100).toFixed(1) : "?"}%`
        + ` noModule=+${di("blocksNoModule")} missEntry=+${di("blocksMissingEntry")}`
        + ` stateMism=+${di("blocksStateMismatch")}`);
    if (aotInstall && i * 10 >= aotAtSec) {
        const st = await bench.evalPage(`__BS__.harness.dbgCall("aotStats")`, 15_000).catch((e) => ({ error: String(e) }));
        console.log(`   aot ${JSON.stringify(st)}`);
        // A guest that stops retiring instructions right after the install:
        // the recorder names the last translated entries, the report carries
        // the log tail (a wasm trap ends up there) and the profile tells
        // whether the Worker is still spinning.
        if (!profiledAotHang && ((st as any)?.error || retired === 0)) {
            profiledAotHang = true;
            for (const ev of ["fault", "wasm_trap", "guest_crash"]) {
                const rep = await bench.evalPage(`__BS__.harness.lastEvent(${JSON.stringify(ev)})`, 20_000).catch((e) => ({ error: String(e) }));
                console.log(`   AOT-HANG ${ev} ` + JSON.stringify(rep).slice(0, 4000));
            }
            const prof = await bench.profileWorker(6_000, 15).catch((e) => ({ error: String(e) } as any));
            console.log("   AOT-HANG cpu-profile " + JSON.stringify(prof).slice(0, 3000));
        }
    }
    // Entry histograms rank by dispatch entries, not time. Confirm the first
    // stall against a real CPU profile before acting on it.
    if (dp === 0 && cpuProfile && !profiledStall) {
        profiledStall = true;
        const prof = await bench.profileWorker(8_000, 12).catch((e) => ({ error: String(e) } as any));
        console.log("   STALL cpu-profile " + JSON.stringify(prof));
        // The profile says the dispatch loop dominates; this says why it is
        // re-entered, which is the difference between a fixable exit cause and
        // an irreducible one.
        await bench.evalPage(`__BS__.harness.dbgCall("dispatchStatsEnable")`, 20_000).catch(() => {});
        await Bun.sleep(6_000);
        const ds = await bench.evalPage(`__BS__.harness.dbgCall("dispatchStats")`, 20_000).catch((e) => ({ error: String(e) }));
        console.log("   STALL dispatch " + JSON.stringify(ds));
        const rt = await bench.evalPage(`__BS__.harness.dbgCall("roundTrips")`, 20_000).catch(() => null);
        console.log("   STALL roundTrips " + JSON.stringify(rt));
        // Names the guest threads and the Win32 primitive they alternate on:
        // ~95k context switches a second is what keeps the JIT cycle budget spent.
        const sp = await bench.evalPage(`__BS__.harness.dbgCall("schedulerPerf")`, 20_000).catch(() => null);
        console.log("   STALL schedulerPerf " + JSON.stringify(sp));
        const ring = await bench.evalPage(`__BS__.harness.dbgCall("ring", 256, 32)`, 20_000).catch(() => null);
        console.log("   STALL ring " + JSON.stringify(ring));
    }
    // A window with no presentations is the one worth naming: it is where the
    // load actually spends its time, and it is invisible to a JS-timer sampler.
    if (hot?.top?.length) {
        const label = dp === 0 ? "STALL" : "moving";
        console.log(`   ${label} hot: ` + hot.top.slice(0, 4)
            .map((r: any) => `${r.module || r.page}=${r.pct}%`).join("  ")
            + ` (collisions ${hot.collisions})`);
    }
    if (process.argv.includes("--attribute-chain-misses")) {
        const ds = await bench.evalPage(`__BS__.harness.dbgCall("dispatchStats")`, 20_000).catch(() => null);
        if (ds) console.log("   chain " + JSON.stringify(ds));
    }
    if (workTarget > 0) {
        const w: any = await bench.dbg("workWindowReport").catch(() => null);
        if (w) {
            console.log(`   work: done=${w.done} retired=${w.instructions ?? "?"}`
                + ` ms=${w.elapsedMs !== undefined ? Math.round(w.elapsedMs) : "?"}`
                + ` mips=${w.mips ?? "?"}`);
        }
    }
    const sl = await sleepStats(bench);
    if (sl) {
        const sp = sl.sleepPaths ?? {};
        const cr = sl.soleRunnableSleepStats ?? {};
        console.log(`   exits: ${JSON.stringify(sl.immediateExitReasons ?? {})}`);
        console.log(`   sleep: soleYield=${sp.soleRunnableYield ?? "?"} blockedWait=${sp.blockedWait ?? "?"}`
            + ` credits=${cr.credits ?? "?"} msCredited=${Math.round(cr.msCredited ?? 0)}`
            + ` realSwitch=${sl.roundTrips?.realSwitch ?? "?"} ticks=${sl.roundTrips?.ticks ?? "?"}`);
    }
    prev = s; prevJit = j; prevInterp = ip;
}
// In-game profile. Every measurement in this project so far has been of the
// loading phase; the warm path is where the largest past wins came from
// (_ftol2_sse alone was -12% of frame time) and it has never been profiled.
if (process.argv.includes("--profile-ingame")) {
    const inGameDeadline = performance.now() + 240_000;
    let live = false;
    while (performance.now() < inGameDeadline) {
        const p = await probe(bench, 6_000);
        if (p.fps > 5) { live = true; break; }
    }
    console.log(`in-game reached=${live}`);
    if (live) {
        await Bun.sleep(20_000);                       // let the scene settle
        const warm = await probe(bench, 10_000);
        console.log(`in-game warm ${JSON.stringify(warm)}`);

        // Paired in-session A/B for any dbg verb, e.g. --dbg-ingame flagLocals=true.
        // Several optimisations in this repo were built and left off "until the
        // in-game gate passes", and that gate was never run.
        // FPS is the wrong instrument for a JIT knob in game: the simulation itself
        // swings between 12 and 25 fps inside one session, which swamps the effect.
        // Timing a fixed number of retired guest instructions measures emulation
        // throughput directly and holds the amount of work constant.
        const ingameMips = async (label: string): Promise<number> => {
            // Reset alongside the work window so the interpreted share describes
            // this arm only. MIPS moves with whatever the scene is doing; this
            // ratio answers "did the change convert interpreted work to compiled
            // work" without depending on the scene being stationary.
            await bench.dbg("interpretedShare", true).catch(() => null);
            await bench.dbg("workWindow", 2_000_000_000).catch(() => null);
            let last: any = null;
            for (let k = 0; k < 40; k++) {
                await Bun.sleep(5_000);
                last = await bench.dbg("workWindowReport").catch(() => null);
                if (last?.done) break;
            }
            const mips = Number(last?.mips ?? 0);
            const share: any = await bench.dbg("interpretedShare").catch(() => null);
            console.log(`in-game MIPS ${label}: ${mips.toFixed(2)} (retired ${last?.instructions ?? "?"})`
                + ` interp=${share?.interpretedPct ?? "?"}% noModule=${share?.blocksNoModule ?? "?"}`
                + ` missEntry=${share?.blocksMissingEntry ?? "?"}`);
            return mips;
        };

        // One throwaway window first: the scene is still compiling right after the
        // load, and that warm-up alone reads as +14% if it lands in the "before"
        // slot — which is exactly how flagLocals first looked like a win.
        if (process.argv.some((a) => a === "--dbg-ingame" || a === "--jit-config-ingame")) {
            await ingameMips("warm-up (discarded)");
        }

        for (let i = 0; i < process.argv.length; i++) {
            if (process.argv[i] !== "--dbg-ingame" || !process.argv[i + 1]) continue;
            const [name, raw] = process.argv[i + 1]!.split("=");
            const val = raw === "false" ? false : raw === "true" ? true : Number(raw);
            // Both arms must sit behind the same settle. Sleeping only after the
            // toggle put every "after" window 60s further into an evolving scene
            // than its "before" — which is how turning a knob OFF could read as
            // an improvement.
            await Bun.sleep(60_000);
            await ingameMips(`before ${name}=${raw}`);
            console.log(`in-game dbg ${name}=${raw} -> ` + JSON.stringify(
                await bench.dbg(name!, val).catch((e) => String(e))));
            await Bun.sleep(60_000);
            await ingameMips(`after ${name}=${raw}`);
        }

        // Paired in-session A/B: the same scene, seconds apart, so the run-to-run
        // variance that swamps a 15% effect across sessions cancels.
        for (let i = 0; i < process.argv.length; i++) {
            if (process.argv[i] !== "--jit-config-ingame" || !process.argv[i + 1]) continue;
            const [idx, val] = process.argv[i + 1]!.split("=").map(Number);
            await ingameMips(`before jit-config ${idx}=${val}`);
            const applied = await bench.dbg("jitConfig", idx, val).catch((e) => String(e));
            console.log(`in-game jit-config ${idx}=${val} -> ${JSON.stringify(applied)}`);
            await Bun.sleep(60_000);                      // let the cache rebuild
            await ingameMips(`after jit-config ${idx}=${val}`);
        }

        await bench.dbg("hotPages", true).catch(() => null);
        await bench.dbg("thunkCensus", true).catch(() => null);
        const cpu = await bench.profileWorker(10_000, 40).catch((e) => ({ error: String(e) } as any));
        console.log("in-game cpu " + JSON.stringify(cpu));
        console.log("in-game hot " + JSON.stringify(await bench.dbg("hotPages", false, 12).catch(() => null)));
        console.log("in-game thunks " + JSON.stringify(await bench.dbg("thunkCensus", false, 14).catch(() => null)));
        console.log("in-game interp " + JSON.stringify(await bench.dbg("interpretedShare").catch(() => null)));
        // The load phase is the leading run of windows before the frame rate
        // recovers, NOT a fixed time slice: averaging a 40s stall together with
        // the gameplay that follows reports the gameplay and hides the stall.
        {
            const lead: number[] = [];
            for (const f of holdFps) { if (f > 10) break; lead.push(f); }
            const avg = lead.length > 0 ? lead.reduce((a, b) => a + b, 0) / lead.length : 0;
            console.log(`load-phase stallSec=${lead.length * 10} fpsDuringStall=${avg.toFixed(2)}`
                + ` windows=${JSON.stringify(lead)}`);
        }
        console.log("in-game hot-profile " + JSON.stringify(await bench.dbg("jitHotProfileStats").catch(() => null)));
        console.log("in-game fpu " + JSON.stringify(await bench.dbg("fpuRelaxedReport").catch(() => null)));
        console.log("in-game d3d9 " + JSON.stringify(await bench.dbg("d3d9Perf").catch(() => null)));
        console.log("in-game fastmem " + JSON.stringify(await bench.dbg("fastmemStats").catch(() => null)));
        console.log("in-game releases " + JSON.stringify(await bench.dbg("releaseKinds").catch(() => null)));
        // Purple characters mean a texture failed, and a failure that retries is
        // a per-frame cost, not a cosmetic one. rgbaScratch is CPU-side, so this
        // reads real pixels even though SwiftShader's readback is black.
        console.log("in-game dxt " + JSON.stringify(await bench.dbg("dxtAdvertiseReport").catch(() => null)));
        console.log("in-game texmem " + JSON.stringify(await bench.dbg("d3d9TextureMemory").catch(() => null)));
        const gallery: any = await bench.evalPage(`__BS__.harness.dbgCall("textures")`, 60_000).catch(() => null);
        if (gallery) {
            const list = Array.isArray(gallery) ? gallery : (gallery.textures ?? gallery.items ?? []);
            const byFormat: Record<string, number> = {};
            for (const t of list) {
                const f = String(t.format ?? t.fmt ?? "?");
                byFormat[f] = (byFormat[f] ?? 0) + 1;
            }
            console.log(`in-game textures count=${list.length} byFormat=${JSON.stringify(byFormat)}`);
        }
        await bench.dbg("jitCompileStats", true).catch(() => null);
        await Bun.sleep(30_000);
        console.log("in-game jit30s " + JSON.stringify(await bench.dbg("jitCompileStats").catch(() => null)));
        if (process.argv.includes("--dispatch-stats")) {
            console.log("in-game dispatch " + JSON.stringify(await bench.dbg("dispatchStats").catch(() => null)));
        }
    }
}

console.log("RESULT " + JSON.stringify({
    reached: true,
    // A default that silently corrupts guest state would still finish the load.
    faults: await bench.evalPage(`__BS__.harness.faults(5)`).catch(() => null),
    // Must be asked of the Worker: `preemption` does not exist in the page.
    rearmOnSwitch: await bench.dbg("rearmOnSwitchStatus").catch(() => null),
    chain: await bench.evalPage(`__BS__.harness.dbgCall("dispatchStats")`, 20_000).catch(() => null),
    // Corruption-class gate for fastmem writes: any danger count means a page is
    // marked fast-writable that is not present+RW, which would silently corrupt.
    fastmemAudit: await bench.dbg("fastmemWriteAudit").catch(() => null),
    stalls: await bench.dbg("stallReport").catch(() => null),
    thunks: await bench.dbg("thunkCensus", false, 14).catch(() => null),
    jitAtLoadStart: jit0,
    jitAtLoadEnd: await jitStats(bench),
    interpretedAtLoadEnd: await interpShare(bench),
    hotProfile: await bench.dbg("jitHotProfileStats").catch(() => null),
}));
if (exportProfile) {
    const b64 = await bench.evalPage<string | null>(
        `__BS__.harness.dbgCall("jitHotProfileExport")`, 60_000).catch(() => null);
    if (typeof b64 === "string" && b64.length > 0) {
        const bytes = Buffer.from(b64, "base64");
        await Bun.write(exportProfile, bytes);
        console.log(`export-profile ${exportProfile}: ${bytes.length} bytes`);
    } else {
        console.log(`export-profile FAILED: ${JSON.stringify(b64)}`);
    }
}
bench.close();
