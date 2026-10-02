// Direct3D 9 draw submission through the WebGL backend over a GL that only counts its calls: the JavaScript cost per
// draw of the device + backend (state application, uniforms, attributes, buffers) and the GL calls a draw issues, by
// name. A frame shaped like a game's: per draw a few render / stage / sampler state changes, a world matrix, shader
// constants, sometimes a texture, stream or index buffer change, a dynamic vertex buffer locked and filled.
// Usage: node tools/draw-bench.mjs [draws per frame (150)] [frames (400)] [--calls]
import { d3dEnv } from '../tests/d3d-random.js';
import { createWebGLBackend } from '../src/gfx/d3d8-webgl.js';

const DRAWS = Number(process.argv[2] ?? 150), FRAMES = Number(process.argv[3] ?? 400), SHOW = process.argv.includes('--calls');
const counts = new Map();
let total = 0;
function countingGl() {
  const base = { canvas: { width: 1024, height: 768 }, drawingBufferWidth: 1024, drawingBufferHeight: 768 };
  const enums = new Map(), E = (n) => { let v = enums.get(n); if (v === undefined) enums.set(n, (v = 0x1000 + enums.size)); return v; };
  // programs know their uniforms from the sources (the backend looks every active uniform up by name)
  const src = new WeakMap(), attached = new WeakMap(), uniforms = (prog) => {
    const out = [];
    for (const sh of attached.get(prog) ?? []) for (const m of (src.get(sh) ?? '').matchAll(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)(\[\d+\])?/g)) { const n = m[1] + (m[2] ? '[0]' : ''); if (!out.includes(n)) out.push(n); }
    return out;
  };
  const own = {
    shaderSource: (sh, s) => { src.set(sh, s); },
    attachShader: (p, sh) => { (attached.get(p) ?? attached.set(p, []).get(p)).push(sh); },
    getProgramParameter: (p, q) => (q === E('ACTIVE_UNIFORMS') ? uniforms(p).length : q === E('ACTIVE_ATTRIBUTES') ? 0 : true),
    getActiveUniform: (p, i) => ({ name: uniforms(p)[i], size: 1, type: 0 }),
    getShaderParameter: () => true, getExtension: () => null, getParameter: () => 0, getError: () => 0,
    getUniformLocation: (p, n) => ({ n }), getProgramInfoLog: () => '', getShaderInfoLog: () => '', checkFramebufferStatus: () => E('FRAMEBUFFER_COMPLETE'),
    getSyncParameter: () => E('SIGNALED'), isEnabled: () => false,
  };
  // (a plain object: a name is resolved once by the prototype proxy, then read as an own property as WebGL's are)
  const gl = Object.create(new Proxy({}, {
    get(t, k, recv) {
      if (typeof k !== 'string') return undefined;
      let v;
      if (/^[A-Z0-9_]+$/.test(k)) v = k === 'TEXTURE0' ? 0x84c0 : E(k);
      else { const o = own[k]; v = (...a) => { total++; counts.set(k, (counts.get(k) ?? 0) + 1); return o ? o(...a) : {}; }; }
      Object.defineProperty(recv, k, { value: v, writable: true });
      return v;
    },
  }));
  return Object.assign(gl, base);
}

function session() {
  const backend = createWebGLBackend({ getContext: () => countingGl() }, () => {});
  const E = d3dEnv(backend), { mem, ctx, com } = E;
  const out = E.alloc(64), scratch = E.alloc(4096);
  const pp = E.alloc(64); [1024, 768, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
  com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out]));
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const c = ctx([devPtr]), call = (name, ...a) => { const A = c.args; for (let i = 1; i <= 8; i++) A[i] = a[i - 1] ?? 0; return dev[name](c); };
  const comCall = (ptr, name, ...a) => com.implAt(ptr)[name](ctx([ptr, ...a]));
  const tex = [], vbs = [];
  for (let i = 0; i < 24; i++) { call('CreateTexture', 64, 64, 1, 0, 21, 1, out); tex.push(mem.read32(out)); }
  for (let i = 0; i < 6; i++) { call('CreateVertexBuffer', 65536, 0x208, 0, 0, out); vbs.push(mem.read32(out)); }
  call('CreateVertexBuffer', 1 << 20, 0x208, 0, 0, out); const dyn = mem.read32(out);
  call('CreateIndexBuffer', 65536, 0x8, 101, 0, out); const ib = mem.read32(out);
  call('SetFVF', 0x152); call('SetIndices', ib);
  for (let i = 0; i < 16; i++) mem.writeF32(scratch + 4 * i, i * 0.25);
  let k = 0, dynPos = 0;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    call('BeginScene');
    for (let d = 0; d < DRAWS; d++, k++) {
      call('SetRenderState', 27, k & 1); call('SetRenderState', 19, 5 + (k & 1)); call('SetRenderState', 20, 6); call('SetRenderState', 15, (k >> 1) & 1);
      call('SetTextureStageState', 0, 1, 4 + (k & 1)); call('SetTextureStageState', 1, 1, 1); call('SetSamplerState', 0, 5, 2); call('SetSamplerState', 0, 6, 2 + (k & 1));
      mem.writeF32(scratch + 48, k); call('SetTransform', 256, scratch);
      if ((k & 3) === 0) call('SetTexture', 0, tex[k % tex.length]);
      if ((k & 7) === 0) call('SetStreamSource', 0, vbs[k % vbs.length], 0, 36);
      if ((k & 15) === 5) { // a dynamic buffer filled with NOOVERWRITE / DISCARD
        const bytes = 36 * 64, flags = dynPos + bytes > (1 << 20) ? 0x2000 : 0x1000; if (flags === 0x2000) dynPos = 0;
        comCall(dyn, 'Lock', dynPos, bytes, out, flags); mem.fill(mem.read32(out), bytes, k & 0xff); comCall(dyn, 'Unlock');
        call('SetStreamSource', 0, dyn, dynPos, 36); dynPos += bytes;
      }
      call('DrawIndexedPrimitive', 4, 0, 0, 100, 0, 50);
    }
    call('EndScene'); call('Present', 0, 0, 0, 0);
  }
  return performance.now() - t0;
}
const runs = [];
for (let i = 0; i < 5; i++) { counts.clear(); total = 0; runs.push(session()); }
const best = Math.min(...runs.slice(1));
console.log(`${(best * 1000 / (DRAWS * FRAMES)).toFixed(3)} us per draw (best of ${runs.length - 1}; device + backend, GL calls counted only), ${(total / (DRAWS * FRAMES)).toFixed(2)} GL calls per draw`);
if (SHOW) for (const [n, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${n.padEnd(28)} ${(v / (DRAWS * FRAMES)).toFixed(3)} per draw`);
