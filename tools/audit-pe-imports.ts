#!/usr/bin/env bun
/** Compare a PE's static imports with the live BottleShip API registry.
 *
 * Usage: bun tools/audit-pe-imports.ts /path/to/program.exe
 * Requires the normal harness page/worker to be running.
 */
import { connect, workerEval } from "./cdp-core";
import { resolveThunkedDllAlias } from "../src/worker/core/dll-aliases";

const pePath = process.argv[2];
if (!pePath) throw new Error("usage: bun tools/audit-pe-imports.ts <program.exe>");

const proc = Bun.spawn(["objdump", "-p", pePath], { stdout: "pipe", stderr: "pipe" });
const output = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;
if (exitCode !== 0) throw new Error(`objdump failed (${exitCode}): ${stderr}`);

const imports: Array<{ dll: string; canonicalDll: string; name: string }> = [];
let dll = "";
for (const line of output.split(/\r?\n/)) {
    const dllMatch = line.match(/^\s*DLL Name:\s*(\S+)/i);
    if (dllMatch) {
        dll = dllMatch[1];
        continue;
    }
    if (!dll) continue;
    const funcMatch = line.match(/^\s*[0-9a-f]+\s+\d+\s+(\S+)\s*$/i);
    if (!funcMatch) continue;
    imports.push({ dll, canonicalDll: resolveThunkedDllAlias(dll), name: funcMatch[1] });
}

const { session } = await connect();
const payload = JSON.stringify(imports);
const result = await workerEval(session, `(() => {
    const registry = System.getInstance().process.loader.apiRegistry;
    return ${payload}.map(i => ({
        ...i,
        thunked: registry.hasModule(i.canonicalDll),
        argCount: registry.getArgCount(i.canonicalDll, i.name),
        stackCleanupBytes: registry.getStackCleanupBytes(i.canonicalDll, i.name),
        callingConvention: registry.getCallingConvention(i.canonicalDll, i.name),
    }));
})()`);

const missing = result.filter((i: any) => i.thunked && i.argCount === undefined);
const realDll = result.filter((i: any) => !i.thunked);
console.log(JSON.stringify({
    pePath,
    importCount: result.length,
    thunkedCount: result.length - realDll.length,
    missingCount: missing.length,
    missing,
    realDlls: [...new Set(realDll.map((i: any) => i.dll))],
}, null, 2));

session.close();
process.exit(missing.length === 0 ? 0 : 2);
