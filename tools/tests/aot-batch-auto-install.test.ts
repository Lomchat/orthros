import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    aotBatchState,
    cancelAotAutoInstall,
    installAotBatch,
    scheduleAotAutoInstall,
    setAotAutoEnabled,
    setAotAutoPollMs,
    setAotExportsProvider,
} from "../../src/worker/core/cpu/aot-batch";

// A module exporting `page_401000(i32)` that does nothing: enough for the
// instantiate + table registration path; the imports it does not declare are
// simply ignored by WebAssembly.instantiate.
const PAGE_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x01, 0x7f, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x0f, 0x01, 0x0b, 0x70, 0x61, 0x67, 0x65, 0x5f, 0x34, 0x30, 0x31, 0x30, 0x30, 0x30, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);
const MANIFEST = { pages: [{ page: 0x401, name: "page_401000", states: [0x401000, 0x401010] }] };

function fakeV86(flags: { value: number }) {
    const registered: Array<[number, number, number, number]> = [];
    const table: Array<[number, unknown]> = [];
    let externalFirst = 0;
    const ex = {
        jit_register_external_module: (index: number, addr: number, f: number, state: number) => { registered.push([index, addr, f, state]); return 1; },
        jit_external_module_first_index: () => 4096,
        jit_external_module_slots: () => 4096,
        jit_get_current_state_flags: () => flags.value,
        jit_set_external_first: (on: number) => { externalFirst = on; },
        jit_get_external_first: () => externalFirst,
        get_eflags: () => 0,
        jit_run_until: () => 1,
    };
    const cpu = {
        mem8: new Uint8Array(new ArrayBuffer(65536)),
        wasm_memory: new WebAssembly.Memory({ initial: 1 }),
        wm: { exports: ex, wasm_table: { set: (i: number, fn: unknown) => { table.push([i, fn]); } } },
    };
    return { cpu, ex, registered, table, externalFirst: () => externalFirst };
}

function mockFetch(published: boolean): { calls: string[] } {
    const calls: string[] = [];
    (globalThis as any).fetch = async (input: string, init?: { method?: string }) => {
        calls.push(`${init?.method ?? "GET"} ${input}`);
        if (!published) return new Response(null, { status: 404 });
        if (input.endsWith(".json")) return new Response(init?.method === "HEAD" ? null : JSON.stringify(MANIFEST), { status: 200 });
        if (input.endsWith(".wasm")) return new Response(PAGE_WASM, { status: 200 });
        return new Response(null, { status: 404 });
    };
    return { calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;

describe("AOT batch automatic install", () => {
    beforeEach(() => { setAotAutoPollMs(5); setAotAutoEnabled(true); });
    afterEach(() => { cancelAotAutoInstall(); setAotExportsProvider(null); (globalThis as any).fetch = realFetch; setAotAutoEnabled(true); });

    test("waits for a 32-bit flat guest, then installs and turns external-first on", async () => {
        const flags = { value: 0 };
        const v = fakeV86(flags);
        setAotExportsProvider(() => ({ cpu: v.cpu, ex: v.ex }));
        const f = mockFetch(true);
        const pagesBefore = aotBatchState.pages;
        scheduleAotAutoInstall("/apps/bfme.wgb");
        await sleep(60);
        expect(v.registered.length).toBe(0);
        expect(f.calls.length).toBe(0);
        flags.value = 0x3; // 32-bit but not flat yet
        await sleep(40);
        expect(v.registered.length).toBe(0);
        flags.value = 0xb;
        await sleep(120);
        expect(f.calls[0]).toBe("HEAD /apps/bfme.wgb.aot-bridge.json");
        expect(v.registered.map((r) => [r[1], r[2], r[3]])).toEqual([[0x401000, 0xb, 0], [0x401010, 0xb, 1]]);
        expect(v.registered[0]![0]).toBe(4096);
        expect(v.table.length).toBe(1);
        expect(v.externalFirst()).toBe(1);
        expect(aotBatchState.pages - pagesBefore).toBe(1);
        expect(aotBatchState.autoUrl).toBe("/apps/bfme.wgb.aot-bridge");
    });

    test("the switch turned off stops a pending install", async () => {
        const flags = { value: 0 };
        const v = fakeV86(flags);
        setAotExportsProvider(() => ({ cpu: v.cpu, ex: v.ex }));
        const f = mockFetch(true);
        scheduleAotAutoInstall("/apps/bfme.wgb");
        await sleep(30);
        setAotAutoEnabled(false);
        flags.value = 0xb;
        await sleep(80);
        expect(v.registered.length).toBe(0);
        expect(f.calls.length).toBe(0);
        expect(v.externalFirst()).toBe(0);
    });

    test("a bundle without a published batch installs nothing", async () => {
        const flags = { value: 0xb };
        const v = fakeV86(flags);
        setAotExportsProvider(() => ({ cpu: v.cpu, ex: v.ex }));
        const f = mockFetch(false);
        scheduleAotAutoInstall("/apps/other.wgb");
        await sleep(80);
        expect(f.calls).toEqual(["HEAD /apps/other.wgb.aot-bridge.json"]);
        expect(v.registered.length).toBe(0);
        expect(v.externalFirst()).toBe(0);
        expect(aotBatchState.lastError).toBe("no batch published for /apps/other.wgb");
    });

    test("a module whose imports the worker cannot satisfy records the link error", async () => {
        const flags = { value: 0xb };
        const v = fakeV86(flags);
        setAotExportsProvider(() => ({ cpu: v.cpu, ex: v.ex }));
        // A module importing `env.missing_import` (i32)->void: instantiate throws a
        // LinkError, which the automatic path must record rather than swallow.
        const needy = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x05, 0x01, 0x60, 0x01, 0x7f, 0x00,
            0x02, 0x16, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x0e, 0x6d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x5f, 0x69, 0x6d, 0x70, 0x6f, 0x72, 0x74, 0x00, 0x00,
            0x03, 0x02, 0x01, 0x00,
            0x07, 0x0f, 0x01, 0x0b, 0x70, 0x61, 0x67, 0x65, 0x5f, 0x34, 0x30, 0x31, 0x30, 0x30, 0x30, 0x00, 0x01,
            0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
        ]);
        (globalThis as any).fetch = async (input: string, init?: { method?: string }) =>
            input.endsWith(".json") ? new Response(init?.method === "HEAD" ? null : JSON.stringify(MANIFEST), { status: 200 }) : new Response(needy, { status: 200 });
        scheduleAotAutoInstall("/apps/bfme.wgb");
        await sleep(120);
        expect(v.registered.length).toBe(0);
        expect(v.externalFirst()).toBe(0);
        expect(aotBatchState.lastError ?? "").toMatch(/LinkError|missing_import/);
    });

    test("a region whose live bytes differ from the translated image is skipped", async () => {
        const flags = { value: 0xb };
        const v = fakeV86(flags);
        setAotExportsProvider(() => ({ cpu: v.cpu, ex: v.ex }));
        // Region 0x2000..0x2100 of the fake memory: hash it as it is (match), and
        // once with a wrong digest (mismatch); pages inside a stale region skip.
        v.cpu.mem8.fill(0x90, 0x2000, 0x2100);
        const digest = await crypto.subtle.digest("SHA-256", v.cpu.mem8.slice(0x2000, 0x2100).buffer);
        const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const manifest = (hash: string) => ({
            pages: [{ page: 2, name: "page_401000", states: [0x2000, 0x2010] }, { page: 0x401, name: "page_401000", states: [0x401000] }],
            regions: [{ base: 0x2000, size: 0x100, sha256: hash }],
        });
        (globalThis as any).fetch = async (input: string) =>
            input.endsWith(".json") ? new Response(JSON.stringify(manifest(sha)), { status: 200 }) : new Response(PAGE_WASM, { status: 200 });
        const ok = await installAotBatch("/apps/x.aot-bridge");
        expect(ok).toEqual({ pages: 2, entries: 3, failed: 0, bytes: PAGE_WASM.byteLength });
        v.registered.length = 0;
        (globalThis as any).fetch = async (input: string) =>
            input.endsWith(".json") ? new Response(JSON.stringify(manifest("00")), { status: 200 }) : new Response(PAGE_WASM, { status: 200 });
        const stale = await installAotBatch("/apps/x.aot-bridge");
        expect(stale).toEqual({ pages: 1, entries: 1, failed: 0, bytes: PAGE_WASM.byteLength });
        expect(v.registered.map((r) => r[1])).toEqual([0x401000]);
    });

    test("an explicit install honours the page-list filter", async () => {
        const flags = { value: 0xb };
        const v = fakeV86(flags);
        setAotExportsProvider(() => ({ cpu: v.cpu, ex: v.ex }));
        mockFetch(true);
        // Two manifest pages backed by the same export: "0.5:1" is the second one only.
        const two = { pages: [{ page: 0x401, name: "page_401000", states: [0x401000] }, { page: 0x402, name: "page_401000", states: [0x402000, 0x402020] }] };
        (globalThis as any).fetch = async (input: string) =>
            input.endsWith(".json") ? new Response(JSON.stringify(two), { status: 200 }) : new Response(PAGE_WASM, { status: 200 });
        const r = await installAotBatch("/apps/bfme.wgb.aot-bridge", "0.5:1");
        expect(r).toEqual({ pages: 1, entries: 2, failed: 0, bytes: PAGE_WASM.byteLength });
        expect(v.registered.map((x) => x[1])).toEqual([0x402000, 0x402020]);
    });
});
