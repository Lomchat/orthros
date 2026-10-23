// End-to-end check of the bench suite (docs/real-machine-bench.md, "The bench suite") in headless Chromium, as the
// owner runs it: a fresh browser (no profile: every game's first launch) opens /?benchsuite=<suite> on a running Orthros
// server, clicks the intro's start button, and leaves the page alone until the summary; along the way, the banner's
// line every 15 s and a screenshot of each game, at the end the summary's screenshot and the suite's record (the
// server keeps the records when it runs with --telemetry: read them with tools/telemetry-report.mjs --suite).
// Exit status 0 when the summary came with a record for every game (whatever their outcomes), 1 otherwise.
// Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/bench-suite-check.mjs [--url http://127.0.0.1:8080] [--suite all]
//     [--gl-discard] [--minutes 60] [--size 1280x800] [--out /tmp/orthros-scratch/bench-suite-check]
//   --gl-discard: the games' rasterizer discarded (this server's software GPU without its drawing: ?gldiscard=1)
//   --suite: a suite of tools/scenarios/bench/index.json, or bench names separated by commas
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2), arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const base = arg('--url', 'http://127.0.0.1:8080'), suite = arg('--suite', 'all'), minutes = Number(arg('--minutes', 60));
const out = arg('--out', '/tmp/orthros-scratch/bench-suite-check');
const [width, height] = arg('--size', '1280x800').split('x').map(Number);
fs.mkdirSync(out, { recursive: true }); process.env.TMPDIR = out;
const query = new URLSearchParams({ benchsuite: suite });
if (args.includes('--gl-discard')) query.set('gldiscard', '1');
for (const kv of (arg('--query', '') || '').split('&').filter(Boolean)) { const [k, v = ''] = kv.split('='); query.set(k, v); }

// (Chromium itself: Playwright's lighter headless shell stops a minute into some games — docs/browser-ports.md)
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let status = 1;
try {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('crash', () => console.log('CRASH'));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const url = `${base}/?${query}`;
  console.log('OPEN', url);
  await page.goto(url);
  await page.locator('#suiteStart').click({ timeout: 60000 });
  const t0 = Date.now(); let lastIndex = 0, lastLine = 0;
  while (Date.now() - t0 < minutes * 60000) {
    await page.waitForTimeout(5000);
    const s = await page.evaluate(() => {
      const r = window.orthrosSuite; if (!r) return null;
      return { state: r.state, results: r.results.length, of: r.suite.items.length, line: document.querySelector('#suite')?.innerText?.replace(/\s+/g, ' ').trim() ?? null };
    }).catch((e) => ({ error: e.message }));
    if (!s) continue;
    if (Date.now() - lastLine > 15000) { lastLine = Date.now(); console.log('PROGRESS', Math.round((Date.now() - t0) / 1000), JSON.stringify(s)); }
    // (a screenshot near each game's end: the frame's last image before the next game)
    if (s.results > lastIndex) { lastIndex = s.results; console.log('GAME DONE', JSON.stringify(await page.evaluate((i) => { const r = window.orthrosSuite.results[i - 1]; return { bench: r.bench, outcome: r.outcome, detail: r.detail, seconds: r.seconds, renderer: r.renderer, sent: r.sent, phases: (r.phases ?? []).map((p) => `${p.label} ${p.seconds}s ${p.fps}fps p99 ${p.dt?.p99} >40/min ${p.per40} gpu ${p.gpu?.frames ? p.gpu.p50 : p.gpu?.state ?? '-'} data ${p.dataWaitMs}`) }; }, s.results))); }
    if (s.state === 'running' && Date.now() - (globalThis.shotAt ?? 0) > Number(arg("--shots", 30)) * 1000) { globalThis.shotAt = Date.now(); await page.screenshot({ path: path.join(out, `game-${s.results + 1}-${Math.round((Date.now() - t0) / 1000)}s.png`) }).catch(() => {}); }
    if (s.state === 'done') break;
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(out, 'summary.png') }).catch(() => {});
  const final = await page.evaluate(() => { const r = window.orthrosSuite; return r?.record ? { record: r.record, sentLine: document.querySelector('#suiteSent')?.textContent ?? null } : null; });
  if (final) {
    fs.writeFileSync(path.join(out, 'suite.json'), JSON.stringify(final.record, null, 1));
    console.log('SUMMARY', final.sentLine);
    for (const r of final.record.results) console.log('RESULT', r.bench, r.manifest, r.outcome, r.detail ?? '', JSON.stringify(r.phases.map((p) => [p.label, p.seconds, p.fps, p.dt?.p99, p.per40, p.gpu?.p50 ?? p.gpu?.state ?? null, p.dataWaitMs])));
    status = final.record.results.length === final.record.games && final.record.games > 0 ? 0 : 1;
  } else console.log('NO SUMMARY after', minutes, 'minutes');
} finally { await browser.close(); }
process.exitCode = status;
