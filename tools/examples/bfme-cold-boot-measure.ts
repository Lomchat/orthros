import { connect, pageEval } from "../cdp-core";

const { session } = await connect();
const startedAt = performance.now();
if (process.env.BFME_NO_RELOAD !== "1") {
    await session.send("Page.reload", { ignoreCache: true });
}

let firstFps: null | { elapsedMs: number; fps: string; frameMs: string; worker: string | null } = null;
let nextProgressMs = 15_000;
while (performance.now() - startedAt < 240_000) {
    const state = await pageEval(session, `(() => {
        const pill = [...document.querySelectorAll("span")].find(e =>
            [...e.children].some(c => c.textContent?.trim() === "FPS") && e.querySelector("strong"));
        const worker = performance.getEntriesByType("resource")
            .map(e => e.name).filter(n => n.includes("emulator.worker")).at(-1) ?? null;
        return {
            fps: pill?.querySelector("strong")?.textContent?.trim() ?? null,
            frameMs: pill?.querySelector("small")?.textContent?.trim() ?? null,
            worker,
        };
    })()`, { timeoutMs: 1_000 }).catch(() => null) as null | {
        fps: string | null;
        frameMs: string | null;
        worker: string | null;
    };
    if (state?.fps && state.fps !== "—") {
        firstFps = {
            elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
            fps: state.fps,
            frameMs: state.frameMs ?? "",
            worker: state.worker,
        };
        break;
    }
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= nextProgressMs) {
        console.log(JSON.stringify({ waitingSec: Math.round(elapsedMs / 1000), worker: state?.worker ?? null }));
        nextProgressMs += 15_000;
    }
    await Bun.sleep(250);
}

if (!firstFps) throw new Error("no FPS presentation within 240 seconds");
await pageEval(session, `__BS__.harness.perfProfile({enable:true,reset:true})`, { timeoutMs: 5_000 });
await Bun.sleep(10_000);
const report = await pageEval(session, `(async()=>({
    firstFps: ${JSON.stringify(firstFps)},
    perf: await __BS__.harness.perfStats(),
    jit: await __BS__.harness.dbgCall("jitCompileStats"),
    faults: await __BS__.harness.faults(20),
}))()`, { timeoutMs: 10_000 });
console.log(JSON.stringify(report, null, 2));
session.close();
