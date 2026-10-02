// Cost of the Direct3D 9 state setters the JIT queues (runtime.js DEFER_SPECS) when JavaScript runs them (Vm.drainDeferred):
// each handler called directly with a reused argument holder, values alternating so that every call changes state (the
// redundant ones never reach JavaScript: the issued-state filter drops them). ns per call, through a device with the
// WebGL backend (its no-op setter hooks), as in a game.
// Usage: node tools/setter-bench.mjs [calls (200000)]
import { d3dEnv } from '../tests/d3d-random.js';
import { createWebGLBackend } from '../src/gfx/d3d8-webgl.js';

const N = Number(process.argv[2] ?? 200000);
const glStub = () => { const gl = Object.create(new Proxy({}, { get(t, k, r) { if (typeof k !== 'string') return undefined; const v = /^[A-Z0-9_]+$/.test(k) ? 0x1000 + k.length : k === 'getExtension' ? () => null : k === 'getParameter' ? () => 0 : () => ({}); Object.defineProperty(r, k, { value: v }); return v; } })); return Object.assign(gl, { canvas: { width: 1024, height: 768 } }); };
const backend = createWebGLBackend({ getContext: glStub }, () => {});
const E = d3dEnv(backend), { mem, ctx, com } = E;
const out = E.alloc(64), scratch = E.alloc(4096);
const pp = E.alloc(64); [1024, 768, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out]));
const devPtr = mem.read32(out), dev = com.implAt(devPtr);
const c = ctx([devPtr]), A = c.args;
const tex = []; for (let i = 0; i < 4; i++) { A[1] = 64; A[2] = 64; A[3] = 1; A[4] = 0; A[5] = 21; A[6] = 1; A[7] = out; A[8] = 0; dev.CreateTexture(c); tex.push(mem.read32(out)); }
const vbs = []; for (let i = 0; i < 4; i++) { A[1] = 65536; A[2] = 0x208; A[3] = 0; A[4] = 0; A[5] = out; A[6] = 0; dev.CreateVertexBuffer(c); vbs.push(mem.read32(out)); }
for (let i = 0; i < 16; i++) mem.writeF32(scratch + 4 * i, i);
const cases = {
  SetRenderState: (k) => { A[1] = 27; A[2] = k & 1; },
  SetTextureStageState: (k) => { A[1] = 0; A[2] = 1; A[3] = 2 + (k & 1); },
  SetSamplerState: (k) => { A[1] = 0; A[2] = 5; A[3] = 1 + (k & 1); },
  SetTexture: (k) => { A[1] = 0; A[2] = tex[k & 3]; },
  SetStreamSource: (k) => { A[1] = 0; A[2] = vbs[k & 3]; A[3] = 0; A[4] = 32; },
  SetTransform: (k) => { mem.writeF32(scratch, k); A[1] = 256; A[2] = scratch; },
  SetFVF: (k) => { A[1] = k & 1 ? 0x152 : 0x142; },
};
for (const [name, prep] of Object.entries(cases)) {
  const f = dev[name].bind(dev);
  let best = Infinity;
  for (let r = 0; r < 5; r++) { const t0 = performance.now(); for (let k = 0; k < N; k++) { prep(k); f(c); } best = Math.min(best, performance.now() - t0); }
  console.log(`${name.padEnd(22)} ${(best * 1e6 / N).toFixed(0)} ns`);
}
