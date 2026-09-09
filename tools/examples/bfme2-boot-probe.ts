/**
 * bfme2-boot-probe — boot a title to its first presentation and report what
 * the bring-up instruments saw, without navigating the menus:
 *   D3DX-ASM   shader sources D3DXAssembleShader received, successes, failures
 *   API-CENSUS unimplemented imports / vtable slots called, by hit count
 *   AOT/JIT    compile stats and faults
 *
 *   bun tools/examples/bfme2-boot-probe.ts --profile <chromium profile> --port 9551 [--game bfme2]
 *       [--boot-timeout 900] [--settle 30]
 */
import { openBenchSession } from "../bench-session";

const arg = (name: string, def: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const game = arg("game", "bfme2");
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme2-b6c6795");
const port = Number(arg("port", "9551"));
const bootTimeoutSec = Number(arg("boot-timeout", "900"));
const settleSec = Number(arg("settle", "30"));

const bench = await openBenchSession({ profile, port, url: `http://127.0.0.1:5173/?game=${game}&bench=probe` });
const t0 = performance.now();
let present = 0;
while (performance.now() - t0 < bootTimeoutSec * 1_000) {
    const p: any = await bench.dbg("d3d9Perf").catch(() => null);
    present = p?.api?.present ?? 0;
    if (present > 0) break;
    await Bun.sleep(2_000);
}
console.log(`first present after ${Math.round((performance.now() - t0) / 1000)}s (present=${present})`);
await Bun.sleep(settleSec * 1_000);
console.log("boot jit " + JSON.stringify(await bench.dbg("jitCompileStats").catch(() => null)).slice(0, 600));
const asm: any = await bench.dbg("d3dxShaderAssembly").catch((e) => ({ error: String(e) }));
console.log(`D3DX-ASM ${JSON.stringify(asm)}`.slice(0, 3000));
const census: any = await bench.evalPage(`__BS__.harness.__runSteps([{ cmd: "stubs", args: [] }])`, 30_000).catch(() => null);
const stubs: any[] = census?.steps?.[0]?.result ?? [];
const sorted = [...stubs].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
console.log(`API-CENSUS n=${sorted.length} ${sorted.slice(0, 40).map((s) => `${s.api}:${s.count}@${s.firstCallerSym ?? s.firstCaller}`).join(" ")}`);
const hr: any = await bench.dbg("report").catch(() => null);
if (hr?.graphicsHresultFailures) console.log(`HRESULT-FAILURES ${JSON.stringify(hr.graphicsHresultFailures).slice(0, 1500)}`);
if (present === 0) {
    // No presentation: say where the guest went instead — dialogs it built,
    // the last files it opened or failed to open, its last Win32 calls and
    // where its threads sit.
    const boxes: any = await bench.dbg("messageBoxes").catch(() => null);
    console.log(`NO-PRESENT message boxes ${JSON.stringify(boxes).slice(0, 800)}`);
    const files: any[] = await bench.dbg("recentFiles").catch(() => []);
    console.log(`NO-PRESENT recent files ${JSON.stringify(files.slice(-24).map((f) => f.path))}`.slice(0, 2500));
    const rep: any = await bench.evalPage(`__BS__.harness.__runSteps([{ cmd: "report", args: [] }])`, 60_000).catch(() => null);
    const r = rep?.steps?.[0]?.result ?? {};
    console.log(`NO-PRESENT missing files ${JSON.stringify((r.missingFiles ?? []).slice(-12))}`.slice(0, 2000));
    console.log(`NO-PRESENT last thunks ${JSON.stringify((r.lastThunks ?? r.recentThunks ?? []).slice(-16))}`.slice(0, 2500));
    console.log(`NO-PRESENT threads ${JSON.stringify(r.threads ?? r.scheduler ?? null)}`.slice(0, 1500));
    console.log(`NO-PRESENT cpu ${JSON.stringify(r.cpu ?? r.registers ?? null)}`.slice(0, 600));
    console.log(`NO-PRESENT backtrace ${JSON.stringify(r.backtrace ?? null)}`.slice(0, 1500));
    const txt: any = await bench.dbg("recentText").catch(() => null);
    console.log(`NO-PRESENT guest text ${JSON.stringify((txt ?? []).slice(-24))}`.slice(0, 2000));
}
console.log("faults " + JSON.stringify(await bench.dbg("faults").catch(() => null)).slice(0, 400));
console.log("worker errors " + JSON.stringify(bench.workerErrors()).slice(0, 600));
bench.close();
process.exit(0);
