/**
 * bench-session — a Chrome session that is guaranteed clean enough to benchmark in.
 *
 * A benchmark is only meaningful if exactly one emulator is running. Chrome's
 * persistent profiles restore their previous tabs, and each restored tab starts
 * its own Worker and its own v86; a killed launcher also leaves the browser
 * process group alive. Both failure modes are silent — the numbers still come
 * out, they are just measured under CPU contention against other emulators.
 *
 * This module makes that state a hard error instead of a footnote:
 *   1. kill the browser process group bound to the profile,
 *   2. relaunch with session restore disabled,
 *   3. close every page target except the one under test,
 *   4. assert the surviving page count and the Worker build actually loaded.
 *
 * Reuses OPFS (the cached WGB) by keeping the profile directory, so a clean run
 * still does not re-download several gigabytes.
 */

import { CHROME_PATH, CdpSession, connect, pageEval } from "./cdp-core";

export interface BenchSessionOptions {
    /** Chrome user-data-dir. Kept across runs so the OPFS WGB cache survives. */
    profile: string;
    /** Page to open, e.g. "http://127.0.0.1:5173/bfme?run=x". */
    url: string;
    port: number;
    /** Fail unless the page loaded a Worker whose URL contains this substring. */
    expectWorker?: string;
    /** Substring identifying our tab among CDP targets; defaults to the query string. */
    matchToken?: string;
    /** Seconds to wait for the page to expose the harness facade. */
    readyTimeoutSec?: number;
}

export interface BenchSession {
    session: CdpSession;
    /** Worker URL the page actually loaded, for the record in any result. */
    workerUrl: string | null;
    /** Invoke a `dbg.*` command in the Worker and return its result. */
    dbg<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
    /** Evaluate an expression in the page. */
    evalPage<T = unknown>(expr: string, timeoutMs?: number): Promise<T>;
    /** Re-assert that this is still the only game page. Call before recording. */
    assertIsolated(): Promise<void>;
    /** Sample the emulator Worker's CPU for `ms` and return self time by
     *  function. The Worker is where guest execution lives, so a page-side
     *  profile shows almost nothing. */
    profileWorker(ms: number, top?: number): Promise<WorkerProfile>;
    /** Exceptions and console errors the emulator Worker reported since the
     *  session opened (a silent freeze after boot is usually one of these). */
    workerErrors(): string[];
    /** Page dialogs (alert/confirm) seen and dismissed: a modal blocks every page eval. */
    dialogs(): string[];
    /** Evaluate in the emulator Worker's own context (works while the page is blocked). */
    evalWorker(expr: string, timeoutMs?: number): Promise<any>;
    /** CPU profile of the page's main thread (the inspector interrupts a busy isolate). */
    profilePage(ms: number, top?: number): Promise<WorkerProfile>;
    /** Uncaught exceptions and console errors of the page itself. */
    pageErrors(): string[];
    /** Renderer thread states from /proc (works when the page's DevTools agent is dead). */
    rendererThreads(): Promise<string[]>;
    /** Close the CDP session AND kill the browser this session launched. */
    close(): void;
}

export interface WorkerProfile {
    totalSamples: number;
    durationMs: number;
    /** Self time share, descending. */
    top: Array<{ fn: string; url: string; pos: string; pct: number; samples: number }>;
    /** Self time share per subsystem. Generated JIT modules are one function
     *  each, so they never surface in `top` however much they cost in total —
     *  only the sum says whether the guest's own code or the runtime around it
     *  dominates. */
    buckets: Record<string, number>;
    /** Callers of the hottest JS frames, two levels up. */
    callers?: Record<string, Array<{ fn: string; pos: string; samples: number }>>;
    /** Inclusive time share (self + callees) of Worker JS functions: what a
     *  whole path such as a draw call costs, which a flat self-time list of
     *  twenty 0.5 % helpers cannot say. */
    inclusive?: Array<{ fn: string; pos: string; pct: number; samples: number }>;
}

/** Which subsystem a sampled frame belongs to. */
function classifyFrame(fn: string, url: string): string {
    if (/^(\(idle\)|\(program\)|\(garbage collector\)|\(root\))$/.test(fn)) return "runtime";
    if (url.includes("emulator.worker")) return "worker-js";
    if (!url.includes("v86.wasm")) {
        // Each compiled page is its own module at its own blob URL, so anything
        // else presenting as wasm is generated guest code.
        return /^wasm-function/.test(fn) ? "jit-code" : "other";
    }
    // cycle_internal is NOT interpretation: it runs on every block entry, including
    // the ones that go on to execute a compiled module. Folding it into
    // "interpreter" overstates what removing interpreted blocks can win.
    if (/cycle_internal/.test(fn)) return "dispatcher";
    if (/interpreter|run_prefix|modrm_resolve/.test(fn)) return "interpreter";
    if (/fpu_|softfloat|F80|fxsave|fxrstor/.test(fn)) return "x87";
    if (/find_cache_entry|dynamic_chaining/.test(fn)) return "chain-lookup";
    if (/jit_|codegen|analysis|wasmgen|WasmBuilder/.test(fn)) return "jit-compiler";
    if (/safe_read|safe_write|translate_address|page_walk|read_write_addr|tlb/.test(fn)) return "memory";
    return "v86-other";
}

/**
 * Attach to the emulator Worker target and take a CPU profile.
 *
 * A stall inside one long synchronous guest slice is exactly what a JS-timer
 * sampler cannot see, and dispatch-entry histograms count entries rather than
 * time — code full of short branchy blocks scores high without necessarily
 * costing the most. V8's sampling profiler settles that: it attributes real
 * time, including time inside the wasm helpers x87 emulation runs through.
 */
async function profileWorkerTarget(
    session: CdpSession, sessionId: string | null, ms: number, top: number, page = false,
): Promise<WorkerProfile> {
    if (!sessionId && !page) throw new Error("no emulator Worker session (auto-attach saw none)");
    const sid = page ? undefined : sessionId!;

    await session.send("Profiler.enable", {}, sid);
    await session.send("Profiler.setSamplingInterval", { interval: 200 }, sid);
    await session.send("Profiler.start", {}, sid);
    const started = performance.now();
    await Bun.sleep(ms);
    const stopped: any = await session.send("Profiler.stop", {}, sid);
    const durationMs = performance.now() - started;
    await session.send("Profiler.disable", {}, sid).catch(() => {});

    // send() resolves the whole CDP message, so the payload is under `result`.
    // Reading it one level too high yields an empty profile rather than an error.
    const profile = stopped?.result?.profile;
    if (!profile?.samples?.length) {
        throw new Error(`Worker profile came back empty (keys: ${Object.keys(stopped ?? {}).join(",")})`);
    }
    const nodes: any[] = profile?.nodes ?? [];
    const byId = new Map<number, any>(nodes.map((n) => [n.id, n]));
    const self = new Map<number, number>();
    for (const id of profile?.samples ?? []) self.set(id, (self.get(id) ?? 0) + 1);
    const totalSamples = (profile?.samples ?? []).length;

    // Minified bundles name almost nothing, so an "(anonymous)" row at 3% of the
    // profile is unactionable without its position: the offset is what locates
    // the function in the built worker.
    const agg = new Map<string, { fn: string; url: string; samples: number; pos: string }>();
    const bucketSamples = new Map<string, number>();
    for (const [id, count] of self) {
        const f = byId.get(id)?.callFrame;
        if (!f) continue;
        const fn = f.functionName || "(anonymous)";
        const url = f.url || "";
        const key = `${fn}|${url}|${f.lineNumber}:${f.columnNumber}`;
        const e = agg.get(key)
            ?? { fn, url, samples: 0, pos: `${f.lineNumber ?? "?"}:${f.columnNumber ?? "?"}` };
        e.samples += count;
        agg.set(key, e);
        const b = classifyFrame(fn, url);
        bucketSamples.set(b, (bucketSamples.get(b) ?? 0) + count);
    }
    const buckets: Record<string, number> = {};
    for (const [name, count] of [...bucketSamples.entries()].sort((a, b) => b[1] - a[1])) {
        buckets[name] = totalSamples > 0 ? Math.round((count / totalSamples) * 1000) / 10 : 0;
    }
    const rows = [...agg.values()].sort((a, b) => b.samples - a.samples).slice(0, top)
        .map((e) => ({ fn: e.fn, url: e.url.split("/").at(-1) ?? "", pos: e.pos,
            pct: totalSamples > 0 ? Math.round((e.samples / totalSamples) * 1000) / 10 : 0,
            samples: e.samples }));
    // Who calls the hottest JS frames: a tiny helper at 1% of the profile is
    // only actionable through its callers. Parents are aggregated by
    // function and position over every node of that frame.
    const parentOf = new Map<number, number>();
    for (const n of nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
    // Two levels of callers ("parent < grandparent"), for the top JS rows.
    const callers: Record<string, Array<{ fn: string; pos: string; samples: number }>> = {};
    for (const row of rows.slice(0, 24)) {
        if (!row.url.endsWith(".js")) continue;
        const byParent = new Map<string, { fn: string; pos: string; samples: number }>();
        for (const [id, count] of self) {
            const f = byId.get(id)?.callFrame;
            if (!f) continue;
            const fn = f.functionName || "(anonymous)";
            if (fn !== row.fn || `${f.lineNumber ?? "?"}:${f.columnNumber ?? "?"}` !== row.pos) continue;
            const pid = parentOf.get(id) ?? -1;
            const p = byId.get(pid)?.callFrame;
            if (!p) continue;
            const g = byId.get(parentOf.get(pid) ?? -1)?.callFrame;
            const name = (c: any) => (c?.functionName || "(anonymous)");
            const pk = `${name(p)}@${p.lineNumber}:${p.columnNumber}<${g ? name(g) : ""}`;
            const e = byParent.get(pk) ?? { fn: `${name(p)} < ${g ? name(g) : "?"}`, pos: `${p.lineNumber}:${p.columnNumber}`, samples: 0 };
            e.samples += count;
            byParent.set(pk, e);
        }
        callers[`${row.fn}@${row.pos}`] = [...byParent.values()].sort((a, b) => b.samples - a.samples).slice(0, 4);
    }
    // Inclusive time of JS frames: each sample credits every distinct function
    // on its stack once (recursion counted once), so a row reads as "the share
    // of samples with this function somewhere on the stack".
    const incl = new Map<string, { fn: string; pos: string; samples: number }>();
    for (const [id, count] of self) {
        const seen = new Set<string>();
        for (let cur: number | undefined = id; cur !== undefined; cur = parentOf.get(cur)) {
            const f = byId.get(cur)?.callFrame;
            if (!f) break;
            if (!(f.url || "").includes("emulator.worker")) continue;
            const fn = f.functionName || "(anonymous)";
            const pos = `${f.lineNumber ?? "?"}:${f.columnNumber ?? "?"}`;
            const key = `${fn}@${pos}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const e = incl.get(key) ?? { fn, pos, samples: 0 };
            e.samples += count;
            incl.set(key, e);
        }
    }
    const inclusive = [...incl.values()].sort((a, b) => b.samples - a.samples).slice(0, 32)
        .map((e) => ({ fn: e.fn, pos: e.pos, samples: e.samples,
            pct: totalSamples > 0 ? Math.round((e.samples / totalSamples) * 1000) / 10 : 0 }));
    return { totalSamples, durationMs: Math.round(durationMs), top: rows, buckets, callers, inclusive };
}

async function fetchJson(port: number, path: string): Promise<any> {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    if (!r.ok) throw new Error(`CDP ${path} -> ${r.status}`);
    return r.json();
}

async function listTargets(port: number): Promise<any[]> {
    return fetchJson(port, "/json/list");
}

/**
 * Kill every process whose command line mentions this profile. Chrome forks a
 * browser, a zygote, a GPU process and one renderer per tab; killing only the
 * launcher leaves the renderers spinning, which is how "6 BFME II pages at once"
 * happened.
 */
export async function killProfileProcesses(profile: string): Promise<number> {
    // Match Chrome's own flag, not the bare path: a runner invoked with
    // `--profile <path>` carries that path in its own command line and would
    // otherwise kill itself here.
    const pattern = `--user-data-dir=${profile}`;
    const self = new Set([process.pid, process.ppid]);
    // `--` terminates option parsing: without it pgrep reads the pattern's own
    // leading `--` as a long option, silently matches nothing, and every stale
    // browser survives into the measurement.
    const survivors = () => Bun.spawnSync(["pgrep", "-f", "--", pattern]).stdout.toString()
        .trim().split("\n").filter(Boolean)
        .map(Number).filter((pid) => Number.isFinite(pid) && !self.has(pid));

    const pids = survivors();
    if (pids.length === 0) { clearSingletonLocks(profile); return 0; }
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    for (let i = 0; i < 40; i++) {
        if (survivors().length === 0) { clearSingletonLocks(profile); return pids.length; }
        await Bun.sleep(250);
    }
    for (const pid of survivors()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await Bun.sleep(1_000);
    clearSingletonLocks(profile);
    return pids.length;
}

/**
 * Synchronous variant for teardown: `close()` cannot await, and a browser left
 * running keeps a GPU process and a renderer burning CPU into whatever measures
 * next — contention that shows up as a slower run, not as an error.
 */
export function killProfileProcessesSync(profile: string): number {
    const pattern = `--user-data-dir=${profile}`;
    const self = new Set([process.pid, process.ppid]);
    const survivors = () => Bun.spawnSync(["pgrep", "-f", "--", pattern]).stdout.toString()
        .trim().split("\n").filter(Boolean)
        .map(Number).filter((pid) => Number.isFinite(pid) && !self.has(pid));

    const pids = survivors();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    clearSingletonLocks(profile);
    return pids.length;
}

/**
 * Chrome removes these on a graceful exit only. A killed browser leaves them
 * behind and the next launch aborts with "Failed to create a ProcessSingleton",
 * which looks identical to "CDP never came up".
 */
function clearSingletonLocks(profile: string): void {
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try { Bun.spawnSync(["rm", "-f", `${profile}/${name}`]); } catch { /* best effort */ }
    }
}

function chromeLogPath(port: number): string {
    return `/tmp/orthros-bench-chrome-${port}.log`;
}

function launchChrome(profile: string, port: number): void {
    // Keep stderr: a launch abort (stale SingletonLock, missing lib) is otherwise
    // indistinguishable from a slow start.
    Bun.spawnSync(["sh", "-c", `: > ${chromeLogPath(port)}`]);
    // ORTHROS_BENCH_CPUS="12-23,36-47" pins the whole browser (renderer, GPU
    // process, worker) to those cores. On a shared box other sessions' browsers
    // and the frequency governor are the largest sources of run-to-run noise.
    const cpus = process.env.ORTHROS_BENCH_CPUS?.trim();
    const pin = cpus ? `taskset -c ${cpus} ` : "";
    Bun.spawn(["sh", "-c",
        `exec ${pin}setsid -f "$0" "$@" >> ${chromeLogPath(port)} 2>&1`,
        CHROME_PATH,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-unsafe-webgpu",
        "--use-angle=swiftshader",
        "--ozone-platform=headless",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        // Session restore is the single largest source of invalid measurements
        // in this project's history: a restored tab is a second live emulator.
        "--no-restore-last-session",
        "--hide-crash-restore-bubble",
        "--disable-session-crashed-bubble",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        "--autoplay-policy=no-user-gesture-required",
        "--window-size=1400,1050",
        "about:blank",
    ], { stdout: "ignore", stderr: "ignore" }).unref();
}

function chromeLogTail(port: number): string {
    try { return Bun.spawnSync(["tail", "-3", chromeLogPath(port)]).stdout.toString().trim(); }
    catch { return ""; }
}

/**
 * pageEval falls back to the raw CDP result descriptor when a call returns null,
 * so a genuine `null` arrives as `{type:"object",subtype:"null"}` — which is
 * truthy. A caller polling "did this command apply yet?" would stop on the first
 * failure. Collapse it back to null.
 */
function unwrapNull(value: unknown): unknown {
    const v = value as { type?: string; subtype?: string; value?: unknown } | null;
    if (v && typeof v === "object" && v.type === "object" && v.subtype === "null") return null;
    if (v && typeof v === "object" && v.type === "undefined") return undefined;
    return value;
}

/**
 * Refuse to start while another bench run owns this profile.
 *
 * Killing stale browsers is not enough: two harnesses launched against the same
 * profile each kill the other's browser at startup and then interleave their
 * boots, producing plausible-looking numbers from two different configurations.
 * The page-level isolation assert cannot see this, because each session really
 * is alone at the instant it checks.
 */
function acquireProfileLock(profile: string, port: number): () => void {
    const lockPath = `/tmp/orthros-bench-${profile.replace(/[^A-Za-z0-9]/g, "_")}.lock`;
    const existing = Bun.spawnSync(["cat", lockPath]).stdout.toString().trim();
    if (existing) {
        const pid = Number(existing.split(" ")[0]);
        const alive = Number.isFinite(pid) && Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0;
        if (alive && pid !== process.pid) {
            throw new Error(
                `another bench run (pid ${pid}) already owns ${profile}. ` +
                `Measurements from two concurrent harnesses interleave silently — stop it first.`,
            );
        }
    }
    Bun.spawnSync(["sh", "-c", `printf '%s %s' ${process.pid} ${port} > ${lockPath}`]);
    const release = () => { Bun.spawnSync(["rm", "-f", lockPath]); };
    process.on("exit", release);
    return release;
}

export async function openBenchSession(opts: BenchSessionOptions): Promise<BenchSession> {
    const { profile, url, port } = opts;
    const readyTimeoutSec = opts.readyTimeoutSec ?? 90;

    const releaseLock = acquireProfileLock(profile, port);
    void releaseLock;
    const killed = await killProfileProcesses(profile);
    if (killed > 0) console.log(`[bench] killed ${killed} stale process(es) for ${profile}`);

    launchChrome(profile, port);
    let up = false;
    for (let i = 0; i < 80; i++) {
        try { await fetchJson(port, "/json/version"); up = true; break; } catch { await Bun.sleep(250); }
    }
    if (!up) throw new Error(`chrome did not expose CDP on :${port}\n${chromeLogTail(port)}`);

    // Close whatever the profile decided to restore before opening ours, so the
    // page under test is never racing another emulator during its own boot.
    for (const t of await listTargets(port)) {
        if (t.type === "page") await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
    }
    await Bun.sleep(500);

    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    if (!created) throw new Error(`could not open ${url}`);

    // A restore can still land after our tab exists; sweep once more.
    await Bun.sleep(1_000);
    for (const t of await listTargets(port)) {
        if (t.type === "page" && t.id !== created.id) {
            await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
        }
    }

    // Match on the caller's unique run token, not on the module-level default
    // filter (a const captured at import time, so setting the env var here is
    // too late to take effect).
    const matchToken = opts.matchToken ?? new URL(url).search.slice(1).split("&")[0] ?? url;
    const { session } = await connect({ port, urlMatch: matchToken });

    // A dedicated Worker is not a discoverable target and is absent from both
    // /json/list and Target.getTargets; auto-attach is the only way its session
    // is ever announced. Arm it before the page boots so the emulator Worker is
    // caught as it is created.
    let workerSessionId: string | null = null;
    const workerErrors: string[] = [];
    const describe = (v: any): string => {
        if (!v) return "";
        if (v.description) return String(v.description).split("\n").slice(0, 4).join(" | ");
        if (v.value !== undefined) return String(v.value);
        return String(v.className ?? v.type ?? "");
    };
    const pageErrors: string[] = [];
    session.on("Runtime.exceptionThrown", (p: any, sid?: string) => {
        if (!sid || sid !== workerSessionId) {
            const d = p?.exceptionDetails;
            if (pageErrors.length < 50) pageErrors.push(`${d?.text ?? "exception"} ${describe(d?.exception)} at ${d?.url ?? ""}:${d?.lineNumber ?? "?"}`);
            if (sid !== workerSessionId) return;
        }
        const d = p?.exceptionDetails;
        const text = `${d?.text ?? "exception"} ${describe(d?.exception)} at ${d?.url ?? ""}:${d?.lineNumber ?? "?"}:${d?.columnNumber ?? "?"}`;
        if (workerErrors.length < 50) workerErrors.push(text);
    });
    session.on("Runtime.consoleAPICalled", (p: any, sid?: string) => {
        if ((!sid || sid !== workerSessionId) && p?.type === "error" && pageErrors.length < 50) {
            pageErrors.push(`console.error ${(p.args ?? []).map(describe).join(" ").slice(0, 400)}`);
        }
        if (sid !== workerSessionId || p?.type !== "error") return;
        const text = (p.args ?? []).map(describe).join(" ").slice(0, 400);
        if (workerErrors.length < 50) workerErrors.push(`console.error ${text}`);
    });
    // A guest fault halt ends in a page alert(); left open it blocks every
    // Runtime.evaluate on the page and reads as a hung Worker. Dismiss and keep
    // the text.
    const dialogs: string[] = [];
    session.on("Page.javascriptDialogOpening", (p: any, sid?: string) => {
        if (sid && sid === workerSessionId) return;
        dialogs.push(`${p?.type ?? "dialog"}: ${String(p?.message ?? "").slice(0, 400)}`);
        session.send("Page.handleJavaScriptDialog", { accept: true }, sid).catch(() => {});
    });
    session.send("Page.enable", {}).catch(() => {});
    session.on("Target.attachedToTarget", (p: any) => {
        if (p?.targetInfo?.type === "worker"
            && String(p.targetInfo.url ?? "").includes("emulator.worker")) {
            workerSessionId = p.sessionId;
            session.send("Runtime.enable", {}, p.sessionId).catch(() => {});
        }
    });
    await session.send("Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});

    const deadline = Date.now() + readyTimeoutSec * 1_000;
    let ready = false;
    while (Date.now() < deadline) {
        ready = await pageEval(session, "!!(window.__BS__ && window.__BS__.harness)", { timeoutMs: 4_000 })
            .catch(() => false) as boolean;
        if (ready) break;
        await Bun.sleep(500);
    }
    if (!ready) throw new Error("harness facade never appeared");

    const workerUrl = await pageEval(session, `performance.getEntriesByType("resource")
        .map(e => e.name).filter(n => n.includes("emulator.worker")).at(-1) ?? null`,
        { timeoutMs: 5_000 }).catch(() => null) as string | null;

    if (opts.expectWorker && !(workerUrl ?? "").includes(opts.expectWorker)) {
        throw new Error(`expected Worker containing "${opts.expectWorker}", page loaded ${workerUrl}`);
    }

    const api: BenchSession = {
        session,
        workerUrl,
        evalPage: <T>(expr: string, timeoutMs = 20_000) =>
            pageEval(session, expr, { timeoutMs }).then(unwrapNull) as Promise<T>,
        dbg: <T>(name: string, ...args: unknown[]) =>
            pageEval(session, `__BS__.harness.dbgCall(${JSON.stringify(name)}${args.length ? "," + args.map((a) => JSON.stringify(a)).join(",") : ""})`,
                { timeoutMs: 30_000 }).then(unwrapNull) as Promise<T>,
        async assertIsolated() {
            const targets = await listTargets(port);
            const pages = targets.filter((t) => t.type === "page");
            const workers = targets.filter((t) => t.type === "worker" || t.type === "service_worker");
            if (pages.length !== 1) {
                throw new Error(`benchmark not isolated: ${pages.length} pages alive (${pages.map((p) => p.url).join(", ")})`);
            }
            // One emulator Worker per page is expected; more means a leaked run.
            const emulators = workers.filter((w) => (w.url ?? "").includes("emulator.worker"));
            if (emulators.length > 1) {
                throw new Error(`benchmark not isolated: ${emulators.length} emulator Workers alive`);
            }
        },
        profileWorker: (ms: number, top = 25) => profileWorkerTarget(session, workerSessionId, ms, top),
        workerErrors: () => workerErrors.slice(),
        dialogs: () => dialogs.slice(),
        pageErrors: () => pageErrors.slice(),
        profilePage: (ms: number, top = 25) => Promise.race([
            profileWorkerTarget(session, null as any, ms, top, true),
            Bun.sleep(ms + 15_000).then(() => { throw new Error(`profilePage: page session did not answer within ${ms + 15_000}ms`); }),
        ]),
        /** What the browser's renderer threads are doing right now, from /proc: the
         *  view that survives a page whose DevTools agent no longer answers. */
        rendererThreads: async () => {
            const ps = Bun.spawnSync(["ps", "-eo", "pid,ppid,args"]);
            const rows = ps.stdout.toString().split("\n");
            // Renderers are children of the zygote, not of the browser: take every
            // renderer of this Chrome build (the bench owns the only Chrome here).
            const renderers = rows.filter((r) => r.includes("--type=renderer") && r.includes("chrome"))
                .map((r) => Number(r.trim().split(/\s+/)[0]));
            const out: string[] = [];
            for (const pid of renderers) {
                const tasks = Bun.spawnSync(["ls", `/proc/${pid}/task`]).stdout.toString().split("\n").filter(Boolean);
                const threads: string[] = [];
                for (const tid of tasks) {
                    const comm = Bun.spawnSync(["cat", `/proc/${pid}/task/${tid}/comm`]).stdout.toString().trim();
                    const stat = Bun.spawnSync(["cat", `/proc/${pid}/task/${tid}/stat`]).stdout.toString();
                    const wchan = Bun.spawnSync(["cat", `/proc/${pid}/task/${tid}/wchan`]).stdout.toString().trim();
                    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                    const state = f[0], utime = Number(f[11]), stime = Number(f[12]);
                    // The main thread keeps the process name as its comm: select it by
                    // tid === pid. Thread-pool workers are noise unless they run.
                    const isMain = Number(tid) === pid;
                    if (isMain || /DedicatedWorker|Compositor|VizCompositor/.test(comm) || state === "R") {
                        threads.push(`${isMain ? "MAIN:" : ""}${comm}[${tid}] ${state} cpu=${utime + stime} wchan=${wchan}`);
                    }
                }
                out.push(`renderer ${pid}: ` + threads.join("; "));
            }
            return out;
        },
        evalWorker: async (expr: string, timeoutMs = 15_000) => {
            if (!workerSessionId) throw new Error("no emulator Worker session");
            const r: any = await Promise.race([
                session.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, workerSessionId),
                Bun.sleep(timeoutMs).then(() => ({ __timeout: true })),
            ]);
            if (r?.__timeout) throw new Error(`evalWorker timed out after ${timeoutMs}ms`);
            // send() resolves the whole CDP message: the payload sits under `result`.
            const payload = r?.result ?? r;
            if (payload?.exceptionDetails) throw new Error(`evalWorker: ${payload.exceptionDetails.text ?? "exception"} ${describe(payload.exceptionDetails.exception)}`);
            return payload?.result?.value;
        },
        close: () => {
            try { session.close(); } catch { /* transport already gone */ }
            killProfileProcessesSync(profile);
        },
    };

    await api.assertIsolated();
    console.log(`[bench] isolated session ready — worker=${workerUrl?.split("/").at(-1) ?? "?"}`);
    return api;
}
