/**
 * Map guest addresses to the translated functions of a batch: which function
 * of the candidates list contains each address, and whether that function's
 * page is in the batch manifest. For a crash dialog's stack trace.
 *
 *   bun tools/aot/which-function.ts --manifest /srv/bfme/data/bfme1-222-multi.wgb.aot-bridge.json \
 *       --candidates /tmp/aot-candidates-v5.json 0xc8ebd3 0x9fdcfd ...
 */
function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const manifestPath = arg("manifest", "/srv/bfme/data/bfme1-222-multi.wgb.aot-bridge.json");
const candidatesPath = arg("candidates", "/tmp/aot-candidates-v5.json");
const addrs = process.argv.slice(2).filter((a) => /^0x[0-9a-f]+$/i.test(a)).map((a) => Number(a));
if (addrs.length === 0) { console.error("give addresses as 0x..."); process.exit(2); }

const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { pages: Array<{ page: number; states: number[] }> };
const pages = new Map<number, number[]>();
for (const pm of manifest.pages) pages.set(pm.page, pm.states);
const cands = (JSON.parse(await Bun.file(candidatesPath).text()).accepted as Array<{ entry: number; instructions: number; extent?: number }>)
    .sort((a, b) => a.entry - b.entry);

for (const a of addrs) {
    const page = a >>> 12;
    const states = pages.get(page);
    // Nearest candidate entry at or below the address.
    let lo = 0, hi = cands.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cands[mid]!.entry <= a) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    const c = best >= 0 ? cands[best]! : null;
    const inBatchPage = !!states;
    const entryInBatch = states?.includes(c?.entry ?? -1) ?? false;
    const resumeInBatch = states?.includes(a) ?? false;
    console.log(`0x${a.toString(16)}: page ${inBatchPage ? "in batch" : "not in batch"}; nearest function 0x${c?.entry.toString(16) ?? "?"}`
        + ` (${c?.instructions ?? "?"} insns, +0x${c ? (a - c.entry).toString(16) : "?"})`
        + `; entry ${entryInBatch ? "translated" : "not translated"}; address ${resumeInBatch ? "is a resume entry" : "not an entry"}`);
}
