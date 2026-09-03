/**
 * Ahead-of-time translated modules ("AOT batch"): one WebAssembly module per
 * bundle, built on the server from the game's hot pages (tools/aot), served as
 * `<bundle url>.aot-bridge.wasm/.json` and installed into v86's external
 * module table. Each page module owns the entries the manifest lists; with
 * external-first on, the dispatcher enters them before any JIT module.
 *
 * Installation needs the guest in the CPU state the entries were keyed with
 * (32-bit, flat segments), so the automatic install waits for that state
 * rather than for a fixed time after boot.
 */
import { System } from '../system';
import { Logger, LogCategory } from '../logger';

export interface AotBatchState {
    /** Next free slot among the external module table indices. */
    nextSlot: number;
    pages: number;
    entries: number;
    bytes: number;
    guardExits: number;
    /** URL of the batch installed by the automatic path, once done. */
    autoUrl: string | null;
}

/** Installed modules of this worker, across installs. */
export const aotBatchState: AotBatchState = { nextSlot: 0, pages: 0, entries: 0, bytes: 0, guardExits: 0, autoUrl: null };

export interface AotInstallResult { pages: number; entries: number; failed: number; bytes: number }

interface AotManifest {
    pages: Array<{ page: number; name: string; states: number[] }>;
    /** Code translated from an image outside the executable; its pages are only
     *  registered when the live bytes still hash to the image's digest. */
    regions?: Array<{ base: number; size: number; sha256: string }>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    // A copy on its own ArrayBuffer: v86's memory is a SharedArrayBuffer view,
    // which subtle.digest does not accept.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Regions whose live bytes no longer match the image they were translated from. */
async function staleRegions(cpu: any, regions: AotManifest["regions"]): Promise<Array<{ base: number; size: number }>> {
    const stale: Array<{ base: number; size: number }> = [];
    for (const r of regions ?? []) {
        const mem8 = cpu.mem8 as Uint8Array;
        if (r.base + r.size > mem8.length) { stale.push(r); continue; }
        const live = await sha256Hex(mem8.slice(r.base, r.base + r.size));
        if (live !== r.sha256) stale.push(r);
    }
    return stale;
}

type ExportsProvider = () => { cpu: any; ex: any } | null;

function defaultProvider(): { cpu: any; ex: any } | null {
    const proc = (System.getInstance() as any).process;
    const v86 = proc?.v86;
    const cpu = v86?.cpu ?? v86?.v86?.cpu;
    const ex = cpu?.wm?.exports;
    if (!cpu || !ex?.jit_register_external_module || !ex.jit_external_module_first_index) return null;
    return { cpu, ex };
}

let provider: ExportsProvider = defaultProvider;
/** Tests substitute a fake v86; production keeps the process's. */
export function setAotExportsProvider(p: ExportsProvider | null): void { provider = p ?? defaultProvider; }
function v86Exports(): { cpu: any; ex: any } | null { return provider(); }

/**
 * Fetch `<url>.wasm` + `<url>.json`, instantiate the module over v86's memory and
 * register its page modules. `filter` = "lo:hi" installs that fraction of the
 * manifest's page list only (bisection of a misbehaving batch).
 */
export async function installAotBatch(url: string, filter?: string): Promise<AotInstallResult | null> {
    const v = v86Exports();
    if (!v) { Logger.warn(LogCategory.SYSTEM, '[AOT] install: v86 or its external-module exports unavailable'); return null; }
    const { cpu, ex } = v;
    const [wasmRes, jsonRes] = await Promise.all([fetch(`${url}.wasm`), fetch(`${url}.json`)]);
    if (!wasmRes.ok || !jsonRes.ok) { Logger.warn(LogCategory.SYSTEM, `[AOT] install: ${url} not found (${wasmRes.status}/${jsonRes.status})`); return null; }
    const bytes = new Uint8Array(await wasmRes.arrayBuffer());
    const manifest = await jsonRes.json() as AotManifest;
    const memBase = cpu.mem8.byteOffset >>> 0;
    const { instance } = await WebAssembly.instantiate(bytes, { env: {
        memory: cpu.wasm_memory,
        mem_base: () => memBase,
        // A translated instruction about to touch memory past guest RAM exits
        // to the dispatcher instead; count how often that happens.
        guard_exit: () => { aotBatchState.guardExits++; },
        // An instruction the translation leaves to the interpreter: v86
        // bypasses the external table once at that address.
        slow_exit: ex.jit_ext_interpret_once ?? (() => {}),
        // A translated block that consumes flags no producer of its own set
        // reads v86's effective flags (lazy flags materialised).
        get_eflags: ex.get_eflags,
        // A callee the batch does not own runs under the nested dispatcher
        // until it returns to the caller's frame.
        run_until: ex.jit_run_until ?? ((_ret: number, _esp: number, _max: number) => 1),
        // A stub's port write performed by the translation itself.
        hypercall_out: ex.jit_hypercall_out ?? ((_v: number) => {}),
        // rdtsc from a translation: the virtual counter with pending instructions folded in.
        read_tsc: ex.read_tsc_jit ?? (() => 0n),
    } });
    const first = ex.jit_external_module_first_index() >>> 0;
    const slots = ex.jit_external_module_slots?.() >>> 0 || 256;
    const flags = ex.jit_get_current_state_flags() >>> 0;
    let entries = 0, failed = 0, pages = 0, skippedStale = 0;
    const stale = await staleRegions(cpu, manifest.regions);
    for (const r of stale) Logger.warn(LogCategory.SYSTEM, `[AOT] region 0x${r.base.toString(16)}+0x${r.size.toString(16)} differs from the translated image; its pages are skipped`);
    const inStale = (addr: number): boolean => stale.some((r) => addr >= r.base && addr < r.base + r.size);
    let lo = 0, hi = manifest.pages.length;
    if (filter) {
        const [a, b] = filter.split(':').map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) { lo = Math.floor(a * manifest.pages.length); hi = Math.floor(b * manifest.pages.length); }
    }
    for (const [pi, pm] of manifest.pages.entries()) {
        if (pi < lo || pi >= hi) continue;
        if (inStale((pm.page << 12) >>> 0)) { skippedStale += pm.states.length; continue; }
        if (aotBatchState.nextSlot >= slots) { failed += pm.states.length; continue; }
        const fn = (instance.exports as any)[pm.name];
        if (typeof fn !== 'function') { failed += pm.states.length; continue; }
        const index = first + aotBatchState.nextSlot++;
        cpu.wm.wasm_table.set(index + 1024, fn);
        pages++;
        pm.states.forEach((addr, i) => {
            if ((ex.jit_register_external_module(index, addr >>> 0, flags, i) >>> 0) === 1) entries++;
            else failed++;
        });
    }
    aotBatchState.pages += pages; aotBatchState.entries += entries; aotBatchState.bytes += bytes.byteLength;
    Logger.info(LogCategory.SYSTEM, `[AOT] ${url}: ${pages} page modules, ${entries} entries, ${failed} failed, ${skippedStale} skipped (stale region), ${bytes.byteLength} bytes, state flags 0x${flags.toString(16)}`);
    return { pages, entries, failed, bytes: bytes.byteLength };
}

/** External modules take precedence over JIT modules at dispatch. */
export function setAotExternalFirst(on: boolean): boolean {
    const v = v86Exports();
    if (!v?.ex.jit_set_external_first) return false;
    v.ex.jit_set_external_first(on ? 1 : 0);
    return !!(v.ex.jit_get_external_first?.() ?? (on ? 1 : 0));
}
export function getAotExternalFirst(): boolean {
    const v = v86Exports();
    return !!(v?.ex.jit_get_external_first?.() ?? 0);
}

// --- automatic install -------------------------------------------------------

let AUTO_POLL_MS = 250;
/** Tests shorten the poll. */
export function setAotAutoPollMs(ms: number): void { AUTO_POLL_MS = ms; }
const AUTO_GIVE_UP_MS = 10 * 60_000;
// CachedStateFlags bits: is_32 (1), ss32 (2), cpl3 (4), flat segments (8). A
// Win32 process runs 32-bit flat; the batch's entries are keyed with the
// flags current at install, so installing in any other state would register
// entries the dispatcher never matches.
const STATE_IS_32 = 1, STATE_FLAT = 8;

// Opt-in until the batch with Orthros's runtime bodies is measured: `aot=1`
// in the URL or dbg.aotAuto(true) installs it (sequential A/Bs alone on the
// VPS already put the batch ahead of the JIT alone: 32.3 vs 29.8 FPS mean).
let autoEnabled = false;
let autoTimer: number | null = null;

/** Opt-in switch for the automatic install (dbg.aotAuto, the `aot=1` URL option). */
export function setAotAutoEnabled(on: boolean): void {
    autoEnabled = on;
    if (!on) cancelAotAutoInstall();
}
export function isAotAutoEnabled(): boolean { return autoEnabled; }

export function cancelAotAutoInstall(): void {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
}

/**
 * Install `<bundleUrl>.aot-bridge` once the guest runs 32-bit flat code, if the
 * server publishes one. Polls cheaply until then; gives up after a while.
 */
export function scheduleAotAutoInstall(bundleUrl: string): void {
    cancelAotAutoInstall();
    if (!autoEnabled || !bundleUrl) return;
    const url = `${bundleUrl}.aot-bridge`;
    const started = performance.now();
    let probed: boolean | null = null;
    let installing = false;
    const tick = (): void => {
        autoTimer = null;
        if (!autoEnabled || installing) return;
        if (performance.now() - started > AUTO_GIVE_UP_MS) { Logger.info(LogCategory.SYSTEM, '[AOT] auto install: gave up waiting for a 32-bit flat guest'); return; }
        const v = v86Exports();
        const flags = v ? (v.ex.jit_get_current_state_flags() >>> 0) : 0;
        if (!v || (flags & STATE_IS_32) === 0 || (flags & STATE_FLAT) === 0) {
            autoTimer = setTimeout(tick, AUTO_POLL_MS) as unknown as number;
            return;
        }
        installing = true;
        void (async () => {
            try {
                if (probed === null) {
                    const head = await fetch(`${url}.json`, { method: 'HEAD' });
                    probed = head.ok;
                }
                if (!probed) { Logger.log(LogCategory.SYSTEM, `[AOT] no batch published for ${bundleUrl}`); return; }
                if (!autoEnabled) return;
                const r = await installAotBatch(url);
                if (r && r.pages > 0) {
                    aotBatchState.autoUrl = url;
                    setAotExternalFirst(true);
                    Logger.info(LogCategory.SYSTEM, `[AOT] auto install done: ${r.pages} pages, ${r.entries} entries, external-first on`);
                }
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[AOT] auto install failed: ${String(e).slice(0, 160)}`);
            } finally {
                installing = false;
            }
        })();
    };
    autoTimer = setTimeout(tick, AUTO_POLL_MS) as unknown as number;
}
