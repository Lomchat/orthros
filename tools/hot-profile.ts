/**
 * Inspect and merge v86 hot-page profiles (`HOTP` v1 images).
 *
 * A profile lists the guest code pages the JIT compiled in a session, with the
 * entry points their modules had and a hash of each page's bytes. Installed
 * before a later session boots, those pages compile at first touch instead of
 * after the interpreted hotness ramp. Profiles from several sessions (menu,
 * different maps, multiplayer) merge by union, so the bundle can ship one.
 *
 *   bun tools/hot-profile.ts stats <profile.bin>
 *   bun tools/hot-profile.ts merge <out.bin> <a.bin> <b.bin> ...
 */

const MAGIC = 0x50544f48;
const VERSION = 1;

interface Page { hash: number; entries: Set<number> }

function parse(bytes: Uint8Array): Map<number, Page> {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 12 || dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) {
        throw new Error("not a HOTP v1 image");
    }
    const count = dv.getUint32(8, true);
    const pages = new Map<number, Page>();
    let i = 12;
    for (let k = 0; k < count; k++) {
        const page = dv.getUint32(i, true);
        const hash = dv.getUint32(i + 4, true);
        const n = dv.getUint32(i + 8, true);
        i += 12;
        const entries = new Set<number>();
        for (let e = 0; e < n; e++) entries.add(dv.getUint16(i + 2 * e, true) & 0xfff);
        i += (2 * n + 3) & ~3;
        pages.set(page, { hash, entries });
    }
    return pages;
}

function serialize(pages: Map<number, Page>): Uint8Array {
    const keys = [...pages.keys()].sort((a, b) => a - b);
    let size = 12;
    for (const k of keys) size += 12 + ((2 * pages.get(k)!.entries.size + 3) & ~3);
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, VERSION, true);
    dv.setUint32(8, keys.length, true);
    let i = 12;
    for (const k of keys) {
        const p = pages.get(k)!;
        const entries = [...p.entries].sort((a, b) => a - b);
        dv.setUint32(i, k, true);
        dv.setUint32(i + 4, p.hash, true);
        dv.setUint32(i + 8, entries.length, true);
        i += 12;
        entries.forEach((e, idx) => dv.setUint16(i + 2 * idx, e, true));
        i += (2 * entries.length + 3) & ~3;
    }
    return out;
}

async function readProfile(path: string): Promise<Map<number, Page>> {
    return parse(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

function stats(pages: Map<number, Page>): string {
    let entries = 0;
    let lo = Infinity, hi = 0;
    for (const [k, p] of pages) {
        entries += p.entries.size;
        lo = Math.min(lo, k);
        hi = Math.max(hi, k);
    }
    return `pages=${pages.size} entries=${entries} avgEntries=${pages.size ? (entries / pages.size).toFixed(1) : 0}` +
        ` range=0x${(lo << 12 >>> 0).toString(16)}-0x${(((hi + 1) << 12) >>> 0).toString(16)}`;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "stats" && rest[0]) {
    const pages = await readProfile(rest[0]);
    console.log(`${rest[0]}: ${stats(pages)}`);
} else if (cmd === "merge" && rest.length >= 2) {
    const [out, ...inputs] = rest;
    const merged = new Map<number, Page>();
    for (const path of inputs) {
        const pages = await readProfile(path);
        for (const [k, p] of pages) {
            const m = merged.get(k);
            if (!m) { merged.set(k, { hash: p.hash, entries: new Set(p.entries) }); continue; }
            if (m.hash !== p.hash) {
                // Different bytes for the same page across inputs: the later
                // input wins, since a merge is only meaningful for one binary.
                m.hash = p.hash;
                m.entries = new Set(p.entries);
                continue;
            }
            for (const e of p.entries) m.entries.add(e);
        }
        console.log(`${path}: ${stats(pages)}`);
    }
    const bytes = serialize(merged);
    await Bun.write(out!, bytes);
    console.log(`${out}: ${stats(merged)} bytes=${bytes.byteLength}`);
} else {
    console.error("usage: hot-profile.ts stats <profile> | merge <out> <in...>");
    process.exit(2);
}
