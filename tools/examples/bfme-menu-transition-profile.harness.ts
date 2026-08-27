import { harness } from "../harness";

// Profiles the two menu transitions that the long skirmish benchmark used to
// hide behind fixed sleeps. Run against an already booted main menu with
// BFME_SKIP_BOOT=1, or let this script load BFME and wait for the main menu.
const bundle = "/apps/bfme.wgb";
const skipBoot = process.env.BFME_SKIP_BOOT === "1";
const trace = process.env.BFME_TRACE === "1";
const hot = process.env.BFME_HOT === "1";
const hotThread = Number(process.env.BFME_HOT_THREAD ?? 0);
const blockChain = process.env.BFME_BLOCK_CHAIN === "1";
const baseThreshold = Number(process.env.BFME_JIT_BASE_THRESHOLD ?? 0);

function print(phase: string, result: unknown): void {
    console.log(JSON.stringify({ phase, result }, null, 2));
}

if (!skipBoot) {
    const opened = await harness()
        .openWgb(bundle)
        .call("stopLogs")
        .audioGesture()
        .watchFrames(true)
        .run();
    print("opened", opened);
    if (!opened.ok) process.exit(1);

    if (Number.isFinite(baseThreshold) && baseThreshold > 0) {
        const configured = await harness()
            .call("dbgCall", "jitBaseThreshold", baseThreshold)
            .run();
        print("jit-base-threshold", configured);
        if (!configured.ok) process.exit(1);
    }

    if (blockChain) {
        const configured = await harness()
            .call("dbgCall", "jitBlockChain", true)
            .run();
        print("jit-block-chain", configured);
        if (!configured.ok) process.exit(1);
    }

    // Cold BFME startup varies from ~2 to >5 minutes under VPS SwiftShader.
    // Wait for an actual presentation instead of clicking after a guessed delay;
    // keep each wait below the per-CDP evaluation timeout.
    let settled = null;
    for (let attempt = 0; attempt < 10; attempt++) {
        settled = await harness()
            .waitForEvent("frameRendered", { timeoutMs: 55_000 })
            .run();
        const frameStep = settled.steps.find((step: any) => step.cmd === "waitForEvent");
        print(`main-menu-wait-${attempt + 1}`, settled);
        if (!settled.ok) process.exit(1);
        if (frameStep?.result) break;
    }
    if (!settled?.steps.find((step: any) => step.cmd === "waitForEvent")?.result) {
        console.error("No BFME frame after 550 seconds");
        process.exit(1);
    }
    const menuWarm = await harness().sleep(5_000).run();
    print("main-menu-settled", menuWarm);
    if (!menuWarm.ok) process.exit(1);
}

const baseline = await harness()
    .perfProfile({ enable: true, reset: true })
    .sleep(3_000)
    .perfStats()
    .perfSpikes({ top: 12, minMs: 35 })
    .run();
print("main-menu-baseline", baseline);
if (!baseline.ok) process.exit(1);

// D3D9 exclusive mode now synchronizes the Win32 desktop to the 800x600 game
// surface, so these are direct game-screen coordinates. Holding the click spans
// several DirectInput polls even if the transition itself becomes slow.
const solo = await harness()
    .move(90, 575)
    .sleep(1_200)
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .call("dbgCall", "schedulerPerf", true)
    .call("clickHold", 90, 575, 700)
    .sleep(1_300)
    .perfStats()
    .perfSpikes({ top: 12, minMs: 35 })
    .profilerStats({ top: 30, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "schedulerPerf")
    .call("dbgCall", "tier2Stats")
    .run();
print("solo-transition-0-2s", solo);
if (!solo.ok) process.exit(1);

const soloSettled = await harness()
    .perfProfile({ enable: true, reset: true })
    .sleep(4_000)
    .perfStats()
    .perfSpikes({ top: 12, minMs: 35 })
    .run();
print("solo-screen-2-6s", soloSettled);
if (!soloSettled.ok) process.exit(1);

const skirmishEarly = await harness()
    .move(320, 575)
    .sleep(1_200)
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .call("dbgCall", "gdiDibSyncDiag", true, true)
    .call("dbgCall", "ioTrace", true, 2048)
    .call("dbgCall", "schedulerPerf", true)
    .call("clickHold", 320, 575, 700)
    .sleep(800)
    .perfStats()
    .perfSpikes({ top: 16, minMs: 35 })
    .profilerStats({ top: 40, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "tier2Stats")
    .run();
print("skirmish-transition-0-1.5s", skirmishEarly);
if (!skirmishEarly.ok) process.exit(1);

const skirmishMiddleChain = harness();
if (trace) {
    skirmishMiddleChain
        .call("dbgCall", "trace2Reset")
        .call("dbgCall", "trace2WatchTier2", 64);
}
skirmishMiddleChain
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true);
if (hot) {
    // Samples live EIP without instrumenting guest pages, and returns the JIT-page
    // to module/RVA mapping needed to interpret a simultaneous Chrome CPU trace.
    skirmishMiddleChain.call(
        "dbgCall",
        "hotJit",
        2_500,
        2,
        80,
        Number.isFinite(hotThread) && hotThread > 0 ? hotThread : 0,
    );
} else {
    skirmishMiddleChain.sleep(2_500);
}
if (trace) skirmishMiddleChain.call("dbgCall", "trace2UnwatchAll");
skirmishMiddleChain
    .perfStats()
    .perfSpikes({ top: 16, minMs: 35 })
    .profilerStats({ top: 40, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "schedulerPerf")
    .call("dbgCall", "gdiDibSyncDiag", false, false)
    .call("dbgCall", "gdiDibSyncReport")
    .call("dbgCall", "ioTraceReport", true)
    .call("dbgCall", "romCacheStats")
    .call("dbgCall", "tier2Stats");
if (trace) {
    skirmishMiddleChain
        .call("dbgCall", "trace2Stats")
        .call("dbgCall", "trace2PageHistogram")
        .call("dbgCall", "trace2Blocks", 100)
        .call("dbgCall", "trace2Indirects", 100);
}
const skirmishMiddle = await skirmishMiddleChain.run();
print("skirmish-transition-1.5-4s", skirmishMiddle);
if (!skirmishMiddle.ok) process.exit(1);

const skirmishLate = await harness()
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .sleep(5_000)
    .perfStats()
    .perfSpikes({ top: 16, minMs: 35 })
    .profilerStats({ top: 40, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "tier2Stats")
    .call("dbgCall", "d3d9Perf")
    .call("dbgCall", "shadowDiff")
    .faults(20)
    .run();
print("skirmish-screen-4-9s", skirmishLate);
if (!skirmishLate.ok) process.exit(1);
