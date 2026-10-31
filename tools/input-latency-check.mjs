// The input-latency measure (tools/input-latency.mjs) checked on a plain page: a canvas animated every frame, its thread
// held by a busy loop (--block ms, default 2000) while generateInputs sends a move every --every ms (50) and a key
// every second, traced; every move made during the block must show a latency of the block's rest plus a frame or two
// (blockCheck's residual), the moves before and after it a frame or two. One JSON line on stdout; the trace kept with
// --trace <file>. The same check on an engine: tools/openmw/place-load.mjs --input-trace --input-block 2000.
//   tools/with-browser-slot.sh node tools/input-latency-check.mjs [--block 2000] [--every 50] [--trace out.json.gz]
import { chromium } from 'playwright';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { launchOptions, startTrace, stopTrace } from './port-perf.mjs';
import { INPUT_TRACE_CATEGORIES, generateInputs, inputLatency, blockCheck, stampsOf } from './input-latency.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const blockMs = Number(arg('block', 2000)), every = Number(arg('every', 50)), keep = arg('trace', null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = keep ?? `/tmp/orthros-scratch/input-latency-check-${process.pid}.json.gz`;
fs.mkdirSync('/tmp/orthros-scratch', { recursive: true });
const browser = await chromium.launch(launchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<canvas id=c width=400 height=300></canvas><script>
    const g = document.getElementById('c').getContext('2d'); let n = 0;
    addEventListener('mousemove', () => {}); addEventListener('keydown', () => {});
    (function f() { g.fillStyle = 'hsl(' + (n++ % 360) + ',50%,50%)'; g.fillRect(0, 0, 400, 300); requestAnimationFrame(f); })();
    window.block = (ms) => { console.timeStamp('block-start'); const t = performance.now(); while (performance.now() - t < ms); console.timeStamp('block-end'); };
  </script>`);
  await sleep(500);
  const tr = await startTrace(page, INPUT_TRACE_CATEGORIES);
  await sleep(300);
  const gen = await generateInputs(page, { moveMs: every, keyMs: 1000 });
  await sleep(1500);
  await page.evaluate((ms) => setTimeout(() => window.block(ms), 0), blockMs);
  await sleep(blockMs + 2000);
  const sent = await gen.stop();
  await sleep(500);
  await stopTrace(tr, file);
  const trace = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const [start] = stampsOf(trace, 'block-start'), [end] = stampsOf(trace, 'block-end');
  const all = inputLatency(trace);
  const before = inputLatency(trace, { to: start, types: ['MOUSE_MOVED_EVENT'] }), after = inputLatency(trace, { from: end + 100000, types: ['MOUSE_MOVED_EVENT'] });
  const block = blockCheck(trace, { start, end });
  const ok = block.events >= Math.floor(blockMs / every) - 2 && Math.abs(block.firstMs - blockMs) < 250 && block.residual.min >= -5 && block.residual.max < 250 && before.p95Ms < 250 && after.p95Ms < 250;
  console.log(JSON.stringify({ ok, sent, all: { ...all, list: undefined }, before, after, block }));
  if (!keep) fs.rmSync(file, { force: true });
  process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); }
