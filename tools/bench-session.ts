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

import { CHROME_PATH, connect, pageEval, type CdpSession } from "./cdp-core";

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
    close(): void;
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
    Bun.spawn(["sh", "-c",
        `exec setsid -f "$0" "$@" >> ${chromeLogPath(port)} 2>&1`,
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

export async function openBenchSession(opts: BenchSessionOptions): Promise<BenchSession> {
    const { profile, url, port } = opts;
    const readyTimeoutSec = opts.readyTimeoutSec ?? 90;

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
        close: () => session.close(),
    };

    await api.assertIsolated();
    console.log(`[bench] isolated session ready — worker=${workerUrl?.split("/").at(-1) ?? "?"}`);
    return api;
}
