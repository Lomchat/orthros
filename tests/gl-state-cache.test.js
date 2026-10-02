// The WebGL backend's per-draw caches (d3d8-webgl.js applyState: a stage's sampler object kept while its sampler states
// and texture did not change; the depth / stencil / blend / color mask / culling block skipped while the render states
// did not change; glTexture: a texture whose levels are all uploaded and clean not scanned): random Direct3D 8 and 9 sessions (state changes, state blocks, resource work, clears, presents, draws)
// over a GL that tracks its effective state give, at every draw, the same GL state with the caches as without them, and
// the same uploads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomSession } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';

/** A WebGL2 context that keeps the state its calls set, and a snapshot of it at every draw. */
function stateGl() {
  const ids = new WeakMap(); let next = 1;
  const id = (o) => { if (o === null || o === undefined) return 0; if (typeof o !== 'object') return o; let i = ids.get(o); if (!i) ids.set(o, (i = next++)); return i; };
  const val = (x) => (ArrayBuffer.isView(x) ? Array.from(x) : typeof x === 'object' && x !== null ? `#${id(x)}` : x);
  const E = (n) => { let v = 0x10000; for (let i = 0; i < n.length; i++) v = (v * 31 + n.charCodeAt(i)) % 0xfff0000; return v + 0x10000; }; // (by name: the same in every run)
  const src = new WeakMap(), attached = new WeakMap();
  const uniforms = (prog) => { const out = []; for (const sh of attached.get(prog) ?? []) for (const m of (src.get(sh) ?? '').matchAll(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)(\[\d+\])?/g)) { const n = m[1] + (m[2] ? '[0]' : ''); if (!out.includes(n)) out.push(n); } return out; };
  const st = new Map(), draws = [], uploads = [];
  const hash = (x) => { const b = new Uint8Array(x.buffer, x.byteOffset, x.byteLength); let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193); return `${b.length}:${h >>> 0}`; };
  let unit = 0, prog = null, vao = null;
  const set = (k, ...a) => st.set(k, JSON.stringify(a.map(val)));
  const own = {
    shaderSource: (sh, s) => { src.set(sh, s); },
    attachShader: (p, sh) => { (attached.get(p) ?? attached.set(p, []).get(p)).push(sh); },
    getProgramParameter: (p, q) => (q === E('ACTIVE_UNIFORMS') ? uniforms(p).length : q === E('ACTIVE_ATTRIBUTES') ? 0 : true),
    getActiveUniform: (p, i) => ({ name: uniforms(p)[i], size: 1, type: 0 }),
    getShaderParameter: () => true, getExtension: () => null, getParameter: () => 0, getError: () => 0,
    getUniformLocation: (p, n) => ({ n }), getProgramInfoLog: () => '', getShaderInfoLog: () => '', checkFramebufferStatus: () => E('FRAMEBUFFER_COMPLETE'),
    getSyncParameter: () => E('SIGNALED'), isEnabled: () => false,
    enable: (c) => st.set(`en${c}`, true), disable: (c) => st.set(`en${c}`, false),
    activeTexture: (u) => { unit = u; }, bindTexture: (t, x) => set(`tex${unit}:${t}`, x), bindSampler: (u, s) => set(`smp${u}`, s),
    useProgram: (p) => { prog = p; set('prog', p); }, bindVertexArray: (v) => { vao = v; set('vao', v); },
    stencilFuncSeparate: (f, ...a) => set(`stencilFunc${f}`, ...a), stencilOpSeparate: (f, ...a) => set(`stencilOp${f}`, ...a),
    stencilFunc: (...a) => { set(`stencilFunc${E('FRONT')}`, ...a); set(`stencilFunc${E('BACK')}`, ...a); },
    stencilOp: (...a) => { set(`stencilOp${E('FRONT')}`, ...a); set(`stencilOp${E('BACK')}`, ...a); },
    vertexAttribPointer: (i, ...a) => set(`vap${id(vao)}:${i}`, ...a),
    bindBuffer: (t, b) => { if (t === E('ELEMENT_ARRAY_BUFFER')) set(`ib${id(vao)}`, b); else set(`buf${t}`, b); },
    drawElements: (...a) => draws.push(JSON.stringify(['dE', ...a, ...[...st].sort()])),
    drawArrays: (...a) => draws.push(JSON.stringify(['dA', ...a, ...[...st].sort()])),
  };
  const STATEFUL = /^(viewport|depthRange|scissor|depthFunc|depthMask|polygonOffset|stencilMask|blendFuncSeparate|blendEquationSeparate|blendColor|colorMask|frontFace|cullFace|bindFramebuffer|clearColor|clearDepth|clearStencil)$/;
  const gl = Object.create(new Proxy({}, {
    get(t, k, recv) {
      if (typeof k !== 'string') return undefined;
      let v;
      if (/^[A-Z0-9_]+$/.test(k)) v = k === 'TEXTURE0' ? 0x84c0 : E(k);
      else if (own[k]) v = own[k];
      else if (k.startsWith('uniform')) v = (loc, ...a) => set(`u${id(prog)}:${loc?.n}`, k, ...a);
      else if (STATEFUL.test(k)) v = (...a) => set(k, ...a);
      else if (/^(compressedT|t)ex(Sub)?Image[23]D$|^bufferS?u?b?Data$/.test(k)) v = (...a) => { const tex = st.get(`tex${unit}:${a[0]}`); uploads.push(JSON.stringify([k, tex, ...a.map((x, i) => (!ArrayBuffer.isView(x) ? val(x) : x.byteLength > (1 << 20) ? hash(x.subarray(a[i + (k === 'bufferData' ? 2 : 1)], a[i + (k === 'bufferData' ? 2 : 1)] + a[i + (k === 'bufferData' ? 3 : 2)])) : hash(x)))]));  st.set('uploads', uploads.length); }; // (the guest memory: the range given)
      else v = () => ({});
      Object.defineProperty(recv, k, { value: v, writable: true });
      return v;
    },
  }));
  return Object.assign(gl, { canvas: { width: 320, height: 240 }, drawingBufferWidth: 320, drawingBufferHeight: 240, draws, uploads });
}

for (const api9 of [true, false]) {
  test(`GL state at every draw with the backend's sampler and raster caches as without them (Direct3D ${api9 ? 9 : 8})`, () => {
    let compared = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const run = (noStateCache) => { const gl = stateGl(); randomSession({ createDevice: (dev) => new WebGLDevice(gl, dev, { noStateCache }) }, seed, api9, () => {}); return gl; };
      const A = run(false), B = run(true), a = A.draws, b = B.draws;
      assert.deepEqual(A.uploads, B.uploads, `seed ${seed}: texture and buffer uploads`);
      assert.equal(a.length, b.length, `seed ${seed}: draws`);
      for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        const x = JSON.parse(a[i]), y = JSON.parse(b[i]), ks = new Set(y.map((e) => JSON.stringify(e)));
        assert.fail(`seed ${seed}, draw ${i}: with the caches ${JSON.stringify(x.filter((e) => !ks.has(JSON.stringify(e))))}, without ${JSON.stringify(y.filter((e) => !new Set(x.map((f) => JSON.stringify(f))).has(JSON.stringify(e))))}`);
      }
      compared += a.length;
    }
    assert.ok(compared > 500, `draws compared: ${compared}`);
  });
}
