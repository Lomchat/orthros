#!/usr/bin/env bun
/**
 * re — thin CLI client for the warm RE backend. Mirrors the harness CLI
 * feel: `bun tools/re.ts decompile 0x401000`. Talks to re-service.py over HTTP
 * ({cmd,args} -> {ok,result|error}); `re start` launches the warm service.
 *
 *   bun tools/re/re.ts start <binary>          launch service + open binary
 *   bun tools/re/re.ts open <binary>
 *   bun tools/re/re.ts decompile <addr|name>
 *   bun tools/re/re.ts disasm <addr> [len]
 *   bun tools/re/re.ts callers|xrefs <addr>
 *   bun tools/re/re.ts symbols | strings | info | doctor
 *   bun tools/re/re.ts resolve <eip> [--base <liveModuleBase>]   wild-EIP -> func
 *   bun tools/re/re.ts exportSymbolMap [--out game.symbols.json] [--module name]
 *
 * The static<->dynamic bridge:
 *  - harness emits fault/breakHit with a live EIP -> `re resolve <eip> --base <liveBase>`
 *    (liveBase from harness.state(['modules'])) -> core.dll!Func+0x.. + decompile.
 *  - `re exportSymbolMap --out <game>.symbols.json` -> the harness loads it via
 *    loadSymbols(module, symbols) so breakOnSymbol('mod!Func') works.
 */

import { openSync } from "node:fs";
import { delimiter as PATH_DELIM } from "node:path";
import { ensureReEnv } from "./bootstrap";

const PORT = 9334;
const HERE = import.meta.dir;

async function call(cmd: string, args: unknown[] = []): Promise<any> {
    const r = await fetch(`http://localhost:${PORT}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, args }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${cmd}: ${j.error}`);
    return j.result;
}

async function serviceUp(): Promise<boolean> {
    try { return (await fetch(`http://localhost:${PORT}/health`)).ok; } catch { return false; }
}

function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function startService(binary?: string): Promise<void> {
    if (!(await serviceUp())) {
        // Resolve (installing into .ghidra/.ghidra-home if absent) Ghidra + JDK 21 + a
        // pyghidra python. Cross-platform — no powershell dependency on POSIX.
        const env = await ensureReEnv();
        const script = `${HERE}/re-service.py`;
        const childEnv: Record<string, string> = {
            ...(process.env as Record<string, string>),
            GHIDRA_INSTALL_DIR: env.ghidraDir,
            JAVA_HOME: env.javaHome,
            PATH: `${env.javaHome}/bin${PATH_DELIM}${process.env.PATH ?? ""}`,
        };
        // Detached so the warm service outlives this CLI process; stdio → log file.
        const fd = openSync(env.logFile, "a");
        if (process.platform === "win32") {
            Bun.spawnSync(["powershell", "-NoProfile", "-Command",
                `Start-Process -FilePath '${env.python}' -ArgumentList '${script}','--port','${PORT}' -WindowStyle Hidden`],
                { env: childEnv });
        } else {
            const child = Bun.spawn([env.python, script, "--port", String(PORT)],
                { env: childEnv, stdin: "ignore", stdout: fd, stderr: fd });
            child.unref();
        }
        for (let i = 0; i < 60; i++) { if (await serviceUp()) break; await Bun.sleep(500); }
        if (!(await serviceUp())) throw new Error(`re-service did not come up; see ${env.logFile} and check \`re doctor\``);
    }
    if (binary) console.log(JSON.stringify(await call("open", [binary]), null, 2));
}

async function main(): Promise<void> {
    const [, , cmd, ...rest] = process.argv;
    // Filter by element index (not indexOf — that finds the first occurrence and
    // mis-pairs when a flag value duplicates a positional value).
    const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
    switch (cmd) {
        case "start": await startService(positional[0]); break;
        case "doctor": console.log(JSON.stringify(await call("doctor"), null, 2)); break;
        case "resolve": {
            const eip = positional[0];
            const liveBase = flag("--base");
            if (liveBase) {
                // Relocate the live EIP into the binary's own image-base space.
                const info = await call("info");
                const rva = (parseInt(eip, 16) >>> 0) - (parseInt(liveBase, 16) >>> 0);
                const staticAddr = ((info.base >>> 0) + rva) >>> 0;
                console.log(JSON.stringify(await call("resolve", ["0x" + staticAddr.toString(16)]), null, 2));
            } else {
                console.log(JSON.stringify(await call("resolve", [eip]), null, 2));
            }
            break;
        }
        case "exportSymbolMap": {
            const map = await call("exportSymbolMap");
            const out = flag("--out");
            const payload = { module: flag("--module") ?? map.module, symbols: map.symbols };
            if (out) { await Bun.write(out, JSON.stringify(payload, null, 2)); console.log(`wrote ${Object.keys(map.symbols).length} symbols -> ${out}`); }
            else console.log(JSON.stringify(payload, null, 2));
            break;
        }
        case "disasm": console.log(JSON.stringify(await call("disasm", [positional[0], positional[1] ? Number(positional[1]) : 64]), null, 2)); break;
        case "open": case "decompile": case "callers": case "xrefs": case "dataAt": case "mkfunc":
            console.log(JSON.stringify(await call(cmd, [positional[0]]), null, 2)); break;
        case "symbols": case "strings": case "info":
            console.log(JSON.stringify(await call(cmd), null, 2)); break;
        default:
            console.log("usage: bun tools/re/re.ts <start|open|decompile|disasm|mkfunc|callers|xrefs|symbols|strings|resolve|exportSymbolMap|info|doctor> [args]");
            process.exit(cmd ? 1 : 0);
    }
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
