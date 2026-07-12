/**
 * dbg — generic RPC bridge to the worker's dbg command table (dbg-commands.ts),
 * with the return value delivered over harness_rpc instead of console.log.
 *
 * The legacy `{type:'dbg'}` channel is fire-and-forget: results go to the log
 * firehose and an agent has to grep them back out. `dbgCall` invokes the same
 * functions and returns whatever they return (dispatchStats' counter object,
 * jitcfg's void, ...) as the step result — so measurement-gate runs
 * (d3d9Perf / dispatchStats / trace2PageHistogram A/Bs) read as plain POJOs
 * from a harness chain: `.call("dbgCall", "dispatchStats")`.
 *
 * Functions that only console.log their JSON (e.g. d3d9Perf) still do; their
 * return value (if any) rides the RPC reply.
 */

import type { HarnessService } from "../service";
import { dbg } from "../../core/debug/dbg-commands";

export function registerDbgCommands(svc: HarnessService): void {
    /** dbgCall(name, ...args) — invoke dbg[name](...args), return its result. */
    svc.register("dbgCall", (args) => {
        const [name, ...rest] = args as [string, ...unknown[]];
        const fn = (dbg as Record<string, unknown>)[name];
        if (typeof fn !== "function") {
            throw new Error(`dbgCall: unknown dbg command '${name}'`);
        }
        return (fn as (...a: unknown[]) => unknown)(...rest) ?? null;
    });

    /** setWorkerFlag(name, value) — set a worker-global kill switch (the boot-time
     *  `globalThis.__no*` A/B flags like __noDrawWbuf / __noSetterShadow /
     *  __noStateBlockWbuf). Must run BEFORE the game load that registers the affected
     *  path (registration reads the flag once). Returns the previous value. */
    svc.register("setWorkerFlag", (args) => {
        const [name, value] = args as [string, unknown];
        if (typeof name !== "string" || !name.startsWith("__")) {
            throw new Error(`setWorkerFlag: refusing non-dunder flag '${String(name)}'`);
        }
        const g = globalThis as Record<string, unknown>;
        const prev = g[name];
        g[name] = value;
        return { name, value, prev: prev ?? null };
    });
}
