/**
 * Turn per-page CPU profiles into explicit batch targets.
 *
 * The batch's --top-pages filter ranks pages by dispatcher entries, and a
 * long loop has much time and few entries, so the pages that dominate a
 * phase can stay with the JIT for ever. With JIT modules named jit_<page>
 * in profiles, this tool reads the PLAY-PROFILE / GAME-PROFILE lines a
 * harness log carries (or nav-probe's `cpuprofile` JSON lines), sums the
 * share of each JIT page, keeps the pages at or
 * above --min-pct, and writes every accepted candidate function whose entry
 * lies on those pages — one address per line for build-batch --entries-file.
 *
 *   bun tools/aot/targets-from-profile.ts --candidates /tmp/aot-candidates-v6.json \
 *       --out /tmp/aot-targets-time.txt [--min-pct 0.3] [--pad-pages 1] log1 log2 ...
 */
function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const candidatesPath = arg("candidates", "");
const outPath = arg("out", "");
const minPct = Number(arg("min-pct", "0.3"));
const pad = Number(arg("pad-pages", "0"));
const logs = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--")));
if (!candidatesPath || !outPath || logs.length === 0) {
    console.error("usage: targets-from-profile.ts --candidates <json> --out <txt> [--min-pct P] [--pad-pages N] <harness log>...");
    process.exit(2);
}
const share = new Map<number, number>();
for (const log of logs) {
    const text = await Bun.file(log).text();
    for (const line of text.split("\n")) {
        if (line.startsWith('{"step":"cpuprofile')) {
            // nav-probe's `cpuprofile` action: {"step":"cpuprofile MS","result":{"top":[{"fn":"jit_<page>","pct":N},...]}}
            try {
                const top = (JSON.parse(line) as { result?: { top?: Array<{ fn: string; pct: number }> } }).result?.top ?? [];
                for (const t of top) {
                    const m = /^jit_([0-9a-f]+)(?:_\d+)?$/.exec(t.fn);
                    if (!m) continue;
                    const page = parseInt(m[1]!, 16) >>> 12;
                    share.set(page, (share.get(page) ?? 0) + Number(t.pct));
                }
            } catch { /* the action caps its line; a truncated one is skipped */ }
            continue;
        }
        if (!/(PLAY|GAME)-PROFILE/.test(line)) continue;
        const top = /top=\[([^\]]*)\]/.exec(line)?.[1] ?? "";
        for (const item of top.split(",")) {
            const m = /^"?jit_([0-9a-f]+)(?:_\d+)?:([0-9.]+)"?$/.exec(item.trim());
            if (!m) continue;
            const page = parseInt(m[1]!, 16) >>> 12;
            share.set(page, (share.get(page) ?? 0) + Number(m[2]));
        }
    }
}
const hot = [...share.entries()].filter(([, pct]) => pct >= minPct).sort((a, b) => b[1] - a[1]);
const pages = new Set<number>();
for (const [p] of hot) for (let d = -pad; d <= pad; d++) pages.add(p + d);
const accepted = (JSON.parse(await Bun.file(candidatesPath).text()).accepted as Array<{ entry: number; instructions: number }>);
const picked = accepted.filter((f) => pages.has(f.entry >>> 12));
await Bun.write(outPath, picked.map((f) => `0x${f.entry.toString(16)}`).join("\n") + "\n");
console.log(`profiles: ${logs.length}; hot JIT pages >= ${minPct}%: ${hot.length} (${hot.slice(0, 10).map(([p, s]) => `0x${(p << 12 >>> 0).toString(16)}:${s.toFixed(1)}`).join(" ")}${hot.length > 10 ? " …" : ""})`);
console.log(`pages after padding: ${pages.size}; candidate functions on them: ${picked.length} (${picked.reduce((a, f) => a + f.instructions, 0)} instructions) -> ${outPath}`);
