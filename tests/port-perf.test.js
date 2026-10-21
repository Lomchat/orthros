// tools/port-perf.mjs: the ports' shared frame measurement — launch flags by rendering mode, the page probe (WebGL
// calls by kind, the synchronous ones, the rasterizer discarded, the work a browser frame), the reports kept off the
// server. The probe runs here on a fake window (its init script is a plain function).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeArgs, addProbe, quietReports, startMeasure, readMeasure, SYNC_CALLS } from '../tools/port-perf.mjs';

test('launch flags: SwiftShader for swiftshader and discard, none for gpu; null refused', () => {
  assert.ok(chromeArgs('swiftshader').includes('--use-angle=swiftshader'));
  assert.deepEqual(chromeArgs('discard'), chromeArgs('swiftshader'));
  assert.ok(!chromeArgs('gpu').some((a) => a.startsWith('--use-angle')));
  assert.throws(() => chromeArgs('null'), /ignored/);
  assert.throws(() => chromeArgs('vulkan'), /one of/);
});

test('reports: posts to telemetry and learning answered locally, reads go through', async () => {
  let pattern, handler;
  await quietReports({ route: async (p, h) => { pattern = p; handler = h; } });
  for (const u of ['/api/telemetry', '/api/prefetch/x', '/api/profile-seed/x', '/api/heat/x']) assert.ok(pattern.test(u), u);
  assert.ok(!pattern.test('/api/tree/x') && !pattern.test('/api/manifest/x'));
  const seen = [];
  const route = (method) => ({ request: () => ({ method: () => method }), continue: () => seen.push('continue'), fulfill: (r) => seen.push(r.status) });
  handler(route('GET')); handler(route('POST'));
  assert.deepEqual(seen, ['continue', 200]);
});

/** A fake page: a window with a WebGL2 context type, canvases, frames on demand. */
async function fakePage(opts) {
  const log = [], frames = [];
  let now = 0;
  class WebGL2RenderingContext {
    getExtension() { return { UNMASKED_RENDERER_WEBGL: 1 }; }
    getParameter(p) { return p === 1 ? 'Fake Renderer' : 0; }
    enable(c) { log.push(['enable', c]); }
    disable(c) { log.push(['disable', c]); }
    drawArrays() { now += 2; }
    getError() { return 0; }
    bindBuffer() {}
  }
  const ctx = new WebGL2RenderingContext();
  const win = { WebGL2RenderingContext, HTMLCanvasElement: class { getContext() { return ctx; } }, performance: { now: () => now, memory: null },
    requestAnimationFrame: (cb) => frames.push(cb) };
  win.window = win;
  let script;
  await addProbe({ addInitScript: async (fn, arg) => { script = [fn, arg]; } }, opts);
  // (the init script and the page's evaluations run with the fake window's names in scope)
  const run = (fn, arg) => {
    const names = Object.keys(win);
    return new Function(...names, 'fn', 'arg', 'return fn(arg);')(...names.map((n) => win[n]), new Function(...names, `return (${fn.toString()});`)(...names.map((n) => win[n])), arg);
  };
  run(...script);
  const page = { evaluate: async (fn, arg) => run(fn, arg) };
  /** One browser frame at time t: every callback asked for so far. */
  const frame = (t) => { now = t; for (const cb of frames.splice(0)) cb(t); };
  return { win, ctx: () => new win.HTMLCanvasElement().getContext('webgl2'), log, page, frame, advance: (ms) => { now += ms; }, probe: () => win.perfProbe };
}

test('probe: renderer, discard kept on, calls a frame with the synchronous ones, work a browser frame', async () => {
  const f = await fakePage({ discard: true, stacks: ['getError'] });
  const gl = f.ctx();
  assert.equal(f.probe().renderer, 'Fake Renderer');
  assert.deepEqual(f.log, [['enable', 0x8C89]]);
  gl.disable(0x8C89); gl.disable(0x0B71);
  assert.deepEqual(f.log.slice(1), [['disable', 0x0B71]], 'the engine cannot turn the discard off');
  await startMeasure(f.page);
  // (two loops a frame — the engine's and a meter's: one frame each time, the work up to the engine's last request)
  const engine = () => { gl.bindBuffer(); gl.drawArrays(); gl.getError(); f.advance(3); f.win.requestAnimationFrame(engine); };
  const meter = () => f.win.requestAnimationFrame(meter);
  f.win.requestAnimationFrame(meter); f.win.requestAnimationFrame(engine);
  for (let i = 1; i <= 11; i++) f.frame(i * 100);
  const m = await readMeasure(f.page);
  assert.equal(m.frames, 11);
  assert.equal(m.draws, 1);
  assert.equal(m.top.drawArrays, 1); assert.equal(m.top.getError, 1);
  assert.equal(m.syncCalls, 1); assert.deepEqual(m.sync, { getError: 1 });
  assert.equal(m.work.p50, 5, 'draw 2 ms + 3 ms, from the frame start to the engine asking for the next one');
  assert.equal(m.gaps.p50, 100);
  assert.equal(m.stacks.length, 1); assert.equal(m.stacks[0].n, 11);
  assert.ok(SYNC_CALLS.includes('checkFramebufferStatus') && !SYNC_CALLS.includes('drawArrays'));
});

test('probe without discard: the engine’s disable goes through', async () => {
  const f = await fakePage({});
  f.ctx().disable(0x8C89);
  assert.deepEqual(f.log, [['disable', 0x8C89]]);
});
