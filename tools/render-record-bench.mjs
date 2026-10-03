// Recording cost of the render worker (docs/render-worker.md, D063): a frame shaped like a game's — per draw a few
// render / stage / sampler state changes, a world matrix, effect constants, sometimes a texture or stream change —
// run through the Direct3D 9 device with no backend, then with a Recorder whose commands are consumed without being
// replayed (only the emulator thread's side). The difference per draw is what recording adds to the emulator thread.
// Usage: node tools/render-record-bench.mjs [draws per frame (400)] [frames (300)]
import { d3dEnv } from '../tests/d3d-random.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';

const DRAWS = Number(process.argv[2] ?? 400), FRAMES = Number(process.argv[3] ?? 300);
function session(gfx) {
  const E = d3dEnv(gfx), { mem, ctx, com } = E;
  const out = E.alloc(64), scratch = E.alloc(4096);
  const pp = E.alloc(64); [1024, 768, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
  com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out]));
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const c = ctx([devPtr]), call = (name, ...a) => { const A = c.args; for (let i = 1; i < 9; i++) A[i] = a[i - 1] ?? 0; return dev[name](c); }; // (up to 8 arguments: CreateTexture's 7th is its out pointer)
  const tex = [], vbs = [];
  for (let i = 0; i < 24; i++) { call('CreateTexture', 64, 64, 1, 0, 21, 1, out); tex.push(mem.read32(out)); }
  for (let i = 0; i < 6; i++) { call('CreateVertexBuffer', 65536, 0x208, 0, 0, out); vbs.push(mem.read32(out)); }
  call('CreateIndexBuffer', 65536, 0x8, 101, 0, out); const ib = mem.read32(out);
  call('SetFVF', 0x152); call('SetIndices', ib);
  for (let i = 0; i < 16; i++) mem.writeF32(scratch + 4 * i, i * 0.25);
  let k = 0;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    call('BeginScene');
    for (let d = 0; d < DRAWS; d++, k++) {
      call('SetRenderState', 27, k & 1); call('SetRenderState', 19, 5 + (k & 1)); call('SetRenderState', 20, 6); call('SetRenderState', 15, (k >> 1) & 1);
      call('SetTextureStageState', 0, 1, 4 + (k & 1)); call('SetTextureStageState', 1, 1, 1); call('SetSamplerState', 0, 5, 2); call('SetSamplerState', 0, 6, 2 + (k & 1));
      mem.writeF32(scratch + 48, k); call('SetTransform', 256, scratch);
      for (let i = 0; i < 8; i++) dev.vsConst[16 + i] = k + i; dev.gfx?.constTouched?.(0, 16, 24); dev.constVersion++;
      if ((k & 3) === 0) call('SetTexture', 0, tex[k % tex.length]);
      if ((k & 7) === 0) call('SetStreamSource', 0, vbs[k % vbs.length], 0, 36);
      call('DrawIndexedPrimitive', 4, 0, 0, 100, 0, 50);
    }
    call('EndScene'); call('Present', 0, 0, 0, 0);
  }
  return performance.now() - t0;
}
// (a link whose consumer takes everything at once without replaying it: only the recording is measured)
const words = new Int32Array(1 << 20);
const link = new RenderLink({ words, replayer: { reader: { consumed: 0 }, run() { this.reader.consumed = link.w.produced; } } });
link.drain = function () { this.w.consumed = this.replayer.reader.consumed = this.w.produced; };
const none = { createDevice: () => null }, rec = { createDevice: (dev) => new Recorder(link, dev) };
const runs = [];
for (let i = 0; i < 6; i++) runs.push([i & 1 ? 'recorded' : 'no backend', session(i & 1 ? rec : none)]);
const per = (ms) => (ms * 1000 / (DRAWS * FRAMES)).toFixed(3);
for (const [k, ms] of runs) console.log(`${k.padEnd(10)} ${ms.toFixed(0)} ms, ${per(ms)} us per draw (incl. the Direct3D layer), ${(ms / FRAMES).toFixed(3)} ms per frame`);
const base = runs.filter((r) => r[0] === 'no backend').slice(1).map((r) => r[1]), recd = runs.filter((r) => r[0] === 'recorded').slice(1).map((r) => r[1]);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`recording: ${per(avg(recd) - avg(base))} us per draw, ${((avg(recd) - avg(base)) / FRAMES).toFixed(3)} ms per frame of ${DRAWS} draws; ${(link.w.produced * 4 / FRAMES / 3 / 1024).toFixed(0)} KiB of commands per frame`);
