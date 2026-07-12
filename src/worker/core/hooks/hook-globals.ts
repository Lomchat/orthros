/**
 * Worker-console helpers for the hot-spot hook framework. Mirrors the
 * asyncParkReport/yieldReport diagnostics so you can drive A/B from the console
 * or tools/cdp-fpu-ab.ts:
 *
 *   hookReport()            — per-hook hits / self-time / path / oracle mismatches
 *   hookReset()             — zero the counters (scope a clean A/B window)
 *   setHookEnabled(id, on)  — flip one hook between simd (on) and scalar (off)
 *   setHookOracle(on)       — dev: run BOTH paths every call and byte-diff outputs
 *   hookList()              — list registered hooks
 *
 * Typical A/B: hookReset(); <play scene>; hookReport(); setHookEnabled('galaxy.outConvert', false); hookReset(); <replay>; hookReport().
 */

import { hookRegistry } from './hook-registry';

function fmtUs(ms: number, hits: number): string {
    if (hits === 0) return '—';
    return `${((ms / hits) * 1000).toFixed(2)}µs`;
}

function hookReport(): void {
    const rows = hookRegistry.getReport();
    if (rows.length === 0) {
        console.log('[hooks] No hooks registered.');
        return;
    }
    console.log('[hooks] id                       module       rva       patched  hits      simd/scalar   self(ms)  avg     oracle✗');
    for (const r of rows) {
        console.log(
            `[hooks] ${r.id.padEnd(24)} ${r.module.padEnd(12)} 0x${r.rva.toString(16).padEnd(7)} ` +
            `${(r.unpatched ? 'UNPATCHED' : r.patched ? 'yes' : 'no').padEnd(8)} ` +
            `${String(r.hits).padEnd(9)} ${`${r.simdHits}/${r.scalarHits}`.padEnd(13)} ` +
            `${r.selfTimeMs.toFixed(1).padEnd(9)} ${fmtUs(r.selfTimeMs, r.hits).padEnd(7)} ${r.oracleMismatches}`);
    }
}

function hookReset(): void {
    hookRegistry.reset();
    console.log('[hooks] counters reset.');
}

function setHookEnabled(id: string, on: boolean): void {
    if (hookRegistry.setEnabled(id, !!on)) {
        console.log(`[hooks] ${id} → ${on ? 'simd' : 'scalar'} (run hookReset() to scope a fresh A/B window)`);
    }
}

function setHookOracle(on: boolean): void {
    hookRegistry.setOracle(!!on);
    console.log(`[hooks] correctness oracle ${on ? 'ON (dev — runs scalar+simd every call)' : 'off'}`);
}

function hookList(): void {
    const specs = hookRegistry.list();
    if (specs.length === 0) {
        console.log('[hooks] No hooks registered.');
        return;
    }
    for (const s of specs) {
        console.log(`[hooks] ${s.id}  ${s.module}+0x${s.rva.toString(16)}  ${s.abi.conv}  simd=${s.handler.simd ? 'yes' : 'no'}  enabledDefault=${s.enabled()}`);
    }
}

if (typeof globalThis !== 'undefined') {
    (globalThis as any).hookReport = hookReport;
    (globalThis as any).hookReset = hookReset;
    (globalThis as any).setHookEnabled = setHookEnabled;
    (globalThis as any).setHookOracle = setHookOracle;
    (globalThis as any).hookList = hookList;
}
