#!/usr/bin/env node
// Browser check of the worker's short-sleep scheduling (src/host/web/worker.js schedulePump): in a cross-origin-isolated
// Chromium worker, a chain of short sleeps where each timer callback sleeps again (every pump returning 'sleep'), armed
// directly with setTimeout (the HTML nesting clamp: >= 4 ms after five levels) and through a MessageChannel hop (what
// schedulePump does from a timer callback), reports the mean / p50 / p99 oversleep per requested length. (A negative
// oversleep: setTimeout truncates its fractional delay to whole ms — the worker's pump then waits the rest inside runFor.)
// Measured 2026-10-21 (Linux Chromium headless): from the timer callback 1/2/3 ms sleeps oversleep 3.07/2.07/1.07 ms
// (the 4 ms clamp); through the hop -0.82/-0.85/-0.87 ms mean, p99 +0.08 ms.
// Usage: tools/with-browser-slot.sh node tools/timer-clamp-check.mjs [--n 200]
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = createRequire('/srv/orthros/package.json')('playwright')); }
const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--n') + 1] || 200);

const workerSrc = `
const N = ${N};
function chain(ms, hop) {
  return new Promise((done) => {
    const ch = new MessageChannel(); let due = 0, k = 0, last = 0; const over = [];
    ch.port1.onmessage = () => setTimeout(tick, Math.max(0, due - performance.now()));
    function arm() { last = performance.now(); due = last + ms; if (hop) ch.port2.postMessage(0); else setTimeout(tick, ms); }
    function tick() { over.push(performance.now() - due); if (++k >= N) { done(over); return; } arm(); }
    arm();
  });
}
onmessage = async () => {
  const out = [];
  for (const ms of [1, 2, 3]) for (const hop of [false, true]) {
    const o = (await chain(ms, hop)).slice(10).sort((a, b) => a - b);
    out.push({ ms, hop, mean: o.reduce((a, b) => a + b, 0) / o.length, p50: o[o.length >> 1], p99: o[Math.floor(o.length * 0.99)] });
  }
  postMessage(out);
};`;
const page = `<!doctype html><script>
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSrc)}], { type: 'text/javascript' })));
window.result = new Promise((r) => { w.onmessage = (e) => r(e.data); }); w.postMessage(0);
</script>`;
const server = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }); s.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
try {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  const res = await p.evaluate(() => window.result);
  for (const r of res) console.log(`${r.ms} ms sleep, ${r.hop ? 'armed from a message (hop)' : 'armed from the timer callback'}: oversleep mean ${r.mean.toFixed(3)} ms, p50 ${r.p50.toFixed(3)}, p99 ${r.p99.toFixed(3)}`);
} finally { await browser.close(); server.close(); }
