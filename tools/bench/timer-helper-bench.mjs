// The host timer helper variants (src/web/timer-helper.js) in a real Chromium, no game: for each variant the p50
// overshoot of a worker's Atomics.wait(1 ms) (the probe the page runs) and the CPU the browser's processes use while it
// runs (utime+stime of the whole process tree, from /proc). On Linux the baseline is ~0.06 ms: the helper is never started
// (this shows what it would cost if it were). On Windows, run it in the owner's Chrome the same way for the gain.
// Usage: tools/with-browser-slot.sh navig node tools/bench/timer-helper-bench.mjs [--seconds 8] [--q <injected timer ms>]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const seconds = Number(opt('seconds', 8)), q = Number(opt('q', 0));
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
  if (p === '/_bench.html') { res.writeHead(200, { ...h, 'Content-Type': 'text/html' }); res.end('<!doctype html><title>b</title>'); return; }
  const f = path.join(root, p);
  if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, h); res.end(); return; }
  res.writeHead(200, { ...h, 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** the CPU seconds (utime+stime) of a process's descendants (the browser's processes: this script itself is not counted) */
function treeCpu(pid) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'), f = s.slice(s.lastIndexOf(')') + 2).split(' '); (kids.get(Number(f[1])) ?? kids.set(Number(f[1]), []).get(Number(f[1]))).push([Number(d), Number(f[11]) + Number(f[12])]); } catch { /* gone */ }
  }
  let tot = 0; const walk = (p) => { for (const [c, t] of kids.get(p) ?? []) { tot += t; walk(c); } };
  walk(pid);
  return tot / 100;
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const out = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/_bench.html`);
  const names = await page.evaluate(async ({ q }) => {
    const th = await import('/src/web/timer-helper.js');
    window.__th = th; window.__probe = th.createWaitProbe('/src/web/timing-probe.js', q);
    return ['none', ...th.browserVariants(window).map((v) => v.name)];
  }, { q });
  const pid = process.pid;
  for (const name of names) {
    await page.evaluate((n) => { window.__stop = n === 'none' ? null : window.__th.browserVariants(window).find((v) => v.name === n).start(); }, name);
    await page.waitForTimeout(500);
    const c0 = treeCpu(pid), t0 = Date.now();
    const p50s = []; // (probe repeatedly through the window: its own worker's CPU is the same in every row)
    while (Date.now() - t0 < seconds * 1000) { p50s.push(await page.evaluate(() => window.__probe.probe(24))); await page.waitForTimeout(500); }
    const cpu = treeCpu(pid) - c0, wall = (Date.now() - t0) / 1000;
    await page.evaluate(() => { window.__stop?.(); window.__stop = null; });
    p50s.sort((a, b) => a - b);
    out.push({ variant: name, p50: p50s[Math.floor(p50s.length / 2)], cpuPct: Math.round(100 * cpu / wall * 10) / 10, probes: p50s.length });
  }
} finally { await browser.close(); server.close(); }
console.log(JSON.stringify({ seconds, injected: q, rows: out }, null, 1));
