/**
 * nav-probe — blind menu navigation with sensors, driven by an actions file.
 *
 * Boots a title to its first presentation, then polls an actions file every
 * second and executes each new line, printing the sensors after it:
 *   dpf/fps (draws per present, presentations per second), sound starts
 *   (Miles _AIL_start_sample count since the previous action), the files
 *   opened since the previous action (dbg.recentFiles: archives, movies,
 *   screen definitions), and, on request, the guest text ring.
 *
 * Actions (one per line, `#` comments):
 *   click X,Y            move, pause, click-and-hold 600 ms
 *   move X,Y             hover only
 *   key NAME             keyHold (enter, escape, tab, f1 …)
 *   type TEXT            type a string
 *   wait SECONDS
 *   scan X0,Y0,X1,Y1,STEP  hover a grid, report cells whose dpf or sound count changes
 *   text                 print dbg.recentText()
 *   files                print every recent file (not only the delta)
 *   sample               print the sensors without acting
 *   shot NAME            page screenshot (canvas may be black on SwiftShader)
 *   quit
 *
 *   bun tools/examples/nav-probe.ts --game bfme2 --profile <dir> --port 9551 --actions /tmp/nav.txt
 *       [--boot-timeout 900]
 */
import { openBenchSession, type BenchSession } from "../bench-session";

const arg = (name: string, def: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const game = arg("game", "bfme2");
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme2-b6c6795");
const port = Number(arg("port", "9551"));
const actionsPath = arg("actions", "/tmp/nav.txt");
const bootTimeoutSec = Number(arg("boot-timeout", "900"));

type Sensors = { present: number; draws: number; dpf: number; sounds: number; files: number; seq: number };

async function sensors(b: BenchSession): Promise<Sensors> {
    const p: any = await b.dbg("d3d9Perf").catch(() => null);
    const a = p?.api ?? {};
    const present = a.present ?? 0;
    const draws = (a.drawPrimitive ?? 0) + (a.drawIndexedPrimitive ?? 0) + (a.drawPrimitiveUP ?? 0) + (a.drawIndexedPrimitiveUP ?? 0);
    const census: any = await b.dbg("thunkCensus", null, 400).catch(() => null);
    let sounds = 0;
    for (const [name, count] of (census?.top ?? []) as Array<[string, number]>) {
        if (/_AIL_start_sample|_AIL_quick_play|_AIL_start_stream/.test(name)) sounds += count;
    }
    const files: any[] = await b.dbg("recentFiles").catch(() => []);
    const seq = files.length ? files[files.length - 1].seq : 0;
    return { present, draws, dpf: present ? Math.round(draws / present) : 0, sounds, files: files.length, seq };
}

async function delta(b: BenchSession, before: Sensors, seconds: number, label: string): Promise<Sensors> {
    const after = await sensors(b);
    const fps = (after.present - before.present) / Math.max(0.001, seconds);
    const dpf = after.present > before.present ? Math.round((after.draws - before.draws) / (after.present - before.present)) : 0;
    const files: any[] = await b.dbg("recentFiles").catch(() => []);
    const opened = files.filter((f) => f.seq > before.seq).map((f) => f.path.replace(/^.*\\/, "").toLowerCase());
    console.log(JSON.stringify({ step: label, fps: Math.round(fps * 10) / 10, dpf, sounds: after.sounds - before.sounds, opened: opened.slice(0, 12) }));
    return after;
}

const bench = await openBenchSession({ profile, port, url: `http://127.0.0.1:5173/?game=${game}&bench=nav` });
const t0 = performance.now();
let present = 0;
while (performance.now() - t0 < bootTimeoutSec * 1_000) {
    const p: any = await bench.dbg("d3d9Perf").catch(() => null);
    present = p?.api?.present ?? 0;
    if (present > 0) break;
    await Bun.sleep(2_000);
}
console.log(`first present after ${Math.round((performance.now() - t0) / 1000)}s (present=${present})`);
await bench.dbg("thunkCensus", true).catch(() => null);
await Bun.sleep(5_000);
let state = await sensors(bench);
console.log(JSON.stringify({ step: "boot", dpf: state.dpf, files: state.files }));
console.log(`ready — append actions to ${actionsPath}`);

let done = 0;
const startedAt = performance.now();
while (performance.now() - startedAt < 3 * 3600 * 1000) {
    const text = await Bun.file(actionsPath).text().catch(() => "");
    const lines = text.split("\n").map((l) => l.trim());
    if (lines.length <= done + 1 && !(lines.length === done + 1 && lines[done])) { await Bun.sleep(1_000); continue; }
    const line = lines[done] ?? "";
    done++;
    if (!line || line.startsWith("#")) continue;
    const [cmd, ...rest] = line.split(/\s+/);
    const argText = rest.join(" ");
    const t = performance.now();
    if (cmd === "quit") break;
    if (cmd === "click" || cmd === "move") {
        const [x, y] = argText.split(",").map(Number);
        if (cmd === "click") {
            await bench.evalPage(`(async () => { await __BS__.harness.move(${x}, ${y}); await new Promise(r => setTimeout(r, 900)); return __BS__.harness.clickHold(${x}, ${y}, 600); })()`, 30_000).catch(() => {});
        } else {
            await bench.evalPage(`__BS__.harness.move(${x}, ${y})`, 30_000).catch(() => {});
        }
        await Bun.sleep(4_000);
        state = await delta(bench, state, (performance.now() - t) / 1000, `${cmd} ${x},${y}`);
        continue;
    }
    if (cmd === "key") {
        await bench.evalPage(`__BS__.harness.keyHold(${JSON.stringify(argText)}, 120)`, 20_000).catch(() => {});
        await Bun.sleep(4_000);
        state = await delta(bench, state, (performance.now() - t) / 1000, `key ${argText}`);
        continue;
    }
    if (cmd === "type") {
        await bench.evalPage(`__BS__.harness.type(${JSON.stringify(argText)})`, 30_000).catch(() => {});
        await Bun.sleep(3_000);
        state = await delta(bench, state, (performance.now() - t) / 1000, `type ${argText}`);
        continue;
    }
    if (cmd === "wait") {
        const s = Number(argText) || 1;
        await Bun.sleep(s * 1000);
        state = await delta(bench, state, s, `wait ${s}`);
        continue;
    }
    if (cmd === "scan") {
        const [x0, y0, x1, y1, step] = argText.split(",").map(Number);
        const hits: string[] = [];
        let prev = await sensors(bench);
        for (let y = y0!; y <= y1!; y += step!) {
            for (let x = x0!; x <= x1!; x += step!) {
                await bench.evalPage(`__BS__.harness.move(${x}, ${y})`, 10_000).catch(() => {});
                await Bun.sleep(250);
                const cur = await sensors(bench);
                const dpfPrev = prev.present ? prev.dpf : 0;
                const dpfNow = cur.present > prev.present ? Math.round((cur.draws - prev.draws) / (cur.present - prev.present)) : dpfPrev;
                if (cur.sounds !== prev.sounds || Math.abs(dpfNow - dpfPrev) >= 3) hits.push(`${x},${y}:dpf${dpfNow}${cur.sounds !== prev.sounds ? "+snd" : ""}`);
                prev = cur;
            }
        }
        console.log(JSON.stringify({ step: `scan ${argText}`, hits: hits.slice(0, 80) }));
        state = await sensors(bench);
        continue;
    }
    if (cmd === "text") {
        const t2: any = await bench.dbg("recentText").catch(() => null);
        console.log(JSON.stringify({ step: "text", text: (t2 ?? []).slice(-24) }).slice(0, 2000));
        continue;
    }
    if (cmd === "files") {
        const files: any[] = await bench.dbg("recentFiles").catch(() => []);
        console.log(JSON.stringify({ step: "files", files: files.map((f) => f.path).slice(-40) }).slice(0, 3000));
        continue;
    }
    if (cmd === "sample") { state = await delta(bench, state, 1, "sample"); continue; }
    if (cmd === "shot") {
        const png = await bench.evalPage<string>(`__BS__.harness.shot ? __BS__.harness.shot() : null`, 30_000).catch(() => null);
        if (png) await Bun.write(`/tmp/nav-${argText || "shot"}.png`, Buffer.from(String(png).replace(/^data:image\/png;base64,/, ""), "base64"));
        console.log(JSON.stringify({ step: "shot", saved: !!png }));
        continue;
    }
    console.log(JSON.stringify({ step: line, error: "unknown action" }));
}
bench.close();
process.exit(0);
