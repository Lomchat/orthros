// Per-draw cost of the Direct3D work on the thread that does it, without a GPU: frames shaped like the games' — a
// Direct3D 9 shader scene (vertex / pixel shaders, effect-style constants, a texture and a stream per draw, a few render
// states, a dynamic vertex buffer refilled before every third draw) and a Direct3D 8 fixed-function one (world matrix, material, lights, texture stages per draw) — run through
// the Direct3D layer alone ("none"), the WebGL backend over a no-op WebGL2 context ("backend": the in-thread path, or
// what the render worker does), and the render worker's recorder with its commands dropped ("recorder": what the
// emulator thread does with ?glworker=1). Prints µs per draw (the Direct3D layer's own share included in each).
// Usage: node tools/backend-draw-bench.mjs [d3d9 | d3d8 | both] [draws per frame (300)] [frames (200)]
//        node --cpu-prof tools/backend-draw-bench.mjs d3d9 300 2000 backend   (one variant, for a profile)
// (ROUNDS=n rounds of each variant, alternated; the fastest of each after the first is reported)
import fs from 'node:fs';
import path from 'node:path';
import { d3dEnv } from '../tests/d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';

const GFX = new URL('../src/gfx/', import.meta.url).pathname;
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const which = process.argv[2] ?? 'both', DRAWS = Number(process.argv[3] ?? 300), FRAMES = Number(process.argv[4] ?? 200), only = process.argv[5] ?? null;

/** A WebGL2 context that does nothing, answering queries as a working one (uniforms: those the sources declare). */
export function noopGl(width = 1024, height = 768) {
  const canvas = { width, height };
  const enums = new Map(); let nextEnum = 0x8000;
  const gl = { canvas, get drawingBufferWidth() { return canvas.width; }, get drawingBufferHeight() { return canvas.height; } };
  const nop = () => {};
  for (const n of 'activeTexture attachShader bindAttribLocation bindBuffer bindFramebuffer bindRenderbuffer bindSampler bindTexture bindVertexArray blendColor blendEquationSeparate blendFuncSeparate blitFramebuffer bufferData bufferSubData clear clearColor clearDepth clearStencil colorMask compileShader compressedTexImage2D compressedTexSubImage2D cullFace deleteBuffer deleteFramebuffer deleteProgram deleteRenderbuffer deleteSampler deleteShader deleteSync deleteTexture deleteVertexArray depthFunc depthMask depthRange disable drawArrays drawElements enable enableVertexAttribArray flush framebufferRenderbuffer framebufferTexture2D pixelStorei polygonOffset readPixels renderbufferStorage samplerParameterf samplerParameteri scissor stencilFunc stencilFuncSeparate stencilMask stencilOp stencilOpSeparate texImage2D texImage3D texParameteri texSubImage2D uniform1f uniform1i uniform2f uniform4f uniform4fv uniform4iv uniformMatrix4fv useProgram vertexAttribPointer viewport'.split(' ')) gl[n] = nop;
  const obj = () => ({});
  for (const n of 'createBuffer createFramebuffer createRenderbuffer createSampler createTexture createVertexArray fenceSync'.split(' ')) gl[n] = obj;
  // programs: the uniforms their sources declare (arrays: name[i] within the size), as a linked program's active ones
  gl.createShader = () => ({ src: '' }); gl.shaderSource = (s, src) => { s.src = src; };
  gl.createProgram = () => ({ shaders: [], uniforms: null, names: [] });
  gl.attachShader = (p, s) => p.shaders.push(s);
  gl.linkProgram = (p) => {
    p.uniforms = new Map();
    // (active: declared and used — a GLSL compiler drops the uniforms a program never reads)
    for (const s of p.shaders) for (const m of s.src.matchAll(/uniform\s+\w+\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?/g)) if (s.src.split(new RegExp(`\\b${m[1]}\\b`)).length > 2) p.uniforms.set(m[1], m[2] ? Number(m[2]) : 0);
    p.names = [...p.uniforms].map(([n, size]) => (size ? `${n}[0]` : n));
    p.locs = new Map();
  };
  gl.getUniformLocation = (p, name) => {
    let l = p.locs.get(name); if (l !== undefined) return l;
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(name), size = m ? p.uniforms.get(m[1]) : undefined;
    l = size === undefined || (m[2] !== undefined && Number(m[2]) >= Math.max(1, size)) ? null : { name };
    p.locs.set(name, l); return l;
  };
  gl.getProgramParameter = (p, q) => (q === gl.ACTIVE_UNIFORMS ? p.names.length : true);
  gl.getActiveUniform = (p, i) => ({ name: p.names[i] });
  gl.getShaderParameter = () => true; gl.getProgramInfoLog = () => ''; gl.getShaderInfoLog = () => '';
  gl.getExtension = () => null; gl.getError = () => 0; gl.getVertexAttrib = () => 0; gl.isEnabled = () => false;
  gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_COMPLETE; gl.getSyncParameter = () => gl.SIGNALED;
  gl.getParameter = (p) => (p === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? 32 : p === gl.MAX_TEXTURE_SIZE ? 4096 : p === gl.RENDERER ? 'noop' : 0);
  // (constants: the names the backend uses, as plain properties — a browser context has them on its prototype)
  for (const f of fs.readdirSync(GFX)) if (f.endsWith('.js')) for (const m of fs.readFileSync(path.join(GFX, f), 'utf8').matchAll(/\b(?:gl|this\.gl|ext|this\.aniso)\.([A-Z][A-Z0-9_]+)\b/g)) if (!enums.has(m[1])) enums.set(m[1], m[1] === 'TEXTURE0' ? 0x84c0 : nextEnum++);
  for (const [k, v] of enums) gl[k] = v;
  for (const n of 'frontFace hint lineWidth sampleCoverage stencilMaskSeparate drawBuffers invalidateFramebuffer'.split(' ')) gl[n] ??= nop;
  return gl;
}

// vs_2_0: m4x4 oPos, v0, c0; mov oT0, v1 — ps_2_0: texld r0, t0, s0; mul r0, r0, c0; mov oC0, r0
const VS20 = [0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x03000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x03000009, 0xc0020000, 0x90e40000, 0xa0e40001, 0x03000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x03000009, 0xc0080000, 0x90e40000, 0xa0e40003, 0x02000001, 0xe00f0000, 0x90e40001, 0xffff];
const PS20 = [0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0x90000000, 0xa00f0800, 0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x03000005, 0x800f0000, 0x80e40000, 0xa0e40000, 0x02000001, 0x800f0800, 0x80e40000, 0xffff];

function session(api9, gfx) {
  const E = d3dEnv(gfx), { mem, ctx, com } = E;
  const out = E.alloc(64), scratch = E.alloc(4096);
  const pp = E.alloc(64);
  let dev, devPtr;
  if (api9) {
    [1024, 768, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    const d3d = E.defs.Direct3DCreate9[1](ctx([32]));
    com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
  } else {
    [1024, 768, 22, 1, 0, 0, 1, 0, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    const d3d = E.defs.Direct3DCreate8[1](ctx([220]));
    com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
  }
  devPtr = mem.read32(out); dev = com.implAt(devPtr);
  const c = ctx([devPtr]), call = (name, ...a) => { const A = c.args; for (let i = 1; i < 9; i++) A[i] = a[i - 1] ?? 0; return dev[name](c); };
  const words = (a) => { a.forEach((v, i) => mem.write32(scratch + 4 * i, v)); return scratch; };
  const tex = [], vbs = [];
  for (let i = 0; i < 24; i++) { call('CreateTexture', 64, 64, 1, 0, 21, 1, out); tex.push(mem.read32(out)); }
  for (let i = 0; i < 6; i++) { if (api9) call('CreateVertexBuffer', 65536, 0x8, 0, 1, out); else call('CreateVertexBuffer', 65536, 0x8, 0x152, 1, out); vbs.push(mem.read32(out)); }
  // a dynamic buffer refilled (DISCARD) before every third draw, as games stream particles and interface quads
  if (api9) call('CreateVertexBuffer', 65536, 0x208, 0, 0, out); else call('CreateVertexBuffer', 65536, 0x208, 0x152, 0, out);
  const dyn = mem.read32(out), dynObj = com.implAt(dyn), dynCtx = ctx([dyn]);
  const refill = (k) => {
    const A = dynCtx.args; A[1] = 0; A[2] = 1280; A[3] = out; A[4] = 0x2000; dynObj.Lock(dynCtx);
    const p = mem.read32(out); for (let i = 0; i < 320; i++) mem.write32(p + 4 * i, k + i);
    dynObj.Unlock(dynCtx);
  };
  const ibs = [];
  for (let i = 0; i < 3; i++) { if (api9) call('CreateIndexBuffer', 65536, 0x8, 101, 1, out); else call('CreateIndexBuffer', 65536, 0x8, 101, 1, out); ibs.push(mem.read32(out)); }
  const consts = E.alloc(4096);
  for (let i = 0; i < 256; i++) mem.writeF32(consts + 4 * i, i * 0.125);
  let shaders = [];
  if (api9) {
    const vsc = E.alloc(4 * VS20.length), psc = E.alloc(4 * PS20.length);
    VS20.forEach((v, i) => mem.write32(vsc + 4 * i, v)); PS20.forEach((v, i) => mem.write32(psc + 4 * i, v));
    for (let i = 0; i < 3; i++) { call('CreateVertexShader', vsc, out); const vs = mem.read32(out); call('CreatePixelShader', psc, out); shaders.push([vs, mem.read32(out)]); }
    // position float3, texcoord float2 (two declarations of the same elements, as games create per mesh)
    const el = E.alloc(64); [0x00000000, 0x00000002, 0x000c0000, 0x00050001, 0x000000ff, 0x00000011].forEach((v, i) => mem.write32(el + 4 * i, v));
    call('CreateVertexDeclaration', el, out); const d1 = mem.read32(out); call('CreateVertexDeclaration', el, out); shaders.decls = [d1, mem.read32(out)];
  } else {
    // two directional lights, a material
    const L = E.alloc(128); for (let i = 0; i < 26; i++) mem.writeF32(L + 4 * i, 0.5); mem.write32(L, 3);
    call('SetLight', 0, L); call('SetLight', 1, L); call('LightEnable', 0, 1); call('LightEnable', 1, 1); call('SetRenderState', 137, 1);
    shaders.light = L;
  }
  const mat = E.alloc(128), m4 = E.alloc(64);
  for (let i = 0; i < 16; i++) mem.writeF32(m4 + 4 * i, i === 0 || i === 5 || i === 10 || i === 15 ? 1 : 0);
  call('SetTransform', 2, m4); call('SetTransform', 3, m4);
  let k = 0;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    call('BeginScene');
    for (let d = 0; d < DRAWS; d++, k++) {
      if (api9) {
        if (k % 10 === 0) { const s = shaders[(k / 10) % 3 | 0]; call('SetVertexShader', s[0]); call('SetPixelShader', s[1]); call('SetVertexDeclaration', shaders.decls[(k / 10) & 1]); }
        mem.writeF32(consts, k * 0.01); call('SetVertexShaderConstantF', 0, consts, 4); call('SetVertexShaderConstantF', 4, consts + 64, 8);
        if ((k & 3) === 0) call('SetPixelShaderConstantF', 0, consts + 16 * (k & 7), 2);
        call('SetTexture', 0, tex[k % tex.length]); if (k % 3 === 0) call('SetTexture', 1, tex[(k * 7) % tex.length]);
        call('SetSamplerState', 0, 5, 2); call('SetSamplerState', 0, 6, 2); call('SetSamplerState', 0, 1, 1 + ((k >> 4) & 1));
        if ((k & 7) === 0) { call('SetRenderState', 27, (k >> 3) & 1); call('SetRenderState', 14, ((k >> 4) & 1)); call('SetRenderState', 22, 2 + ((k >> 5) & 1)); }
        if (k % 3 === 0) { refill(k); call('SetStreamSource', 0, dyn, 0, 20); } else call('SetStreamSource', 0, vbs[k % vbs.length], 0, 20);
        if ((k & 7) === 0) call('SetIndices', ibs[(k >> 3) % ibs.length]);
        call('DrawIndexedPrimitive', 4, 0, 0, 100, 0, 50);
      } else {
        mem.writeF32(m4 + 48, k * 0.01); call('SetTransform', 256, m4);
        if (k & 1) { for (let i = 0; i < 17; i++) mem.writeF32(mat + 4 * i, ((k >> 1) & 3) * 0.25); call('SetMaterial', mat); }
        call('SetTexture', 0, tex[k % tex.length]);
        if (k % 5 === 0) { call('SetTextureStageState', 0, 1, 4 + ((k / 5) & 1)); call('SetTextureStageState', 0, 4, 4); }
        if ((k & 7) === 0) { call('SetRenderState', 27, (k >> 3) & 1); call('SetRenderState', 14, ((k >> 4) & 1)); }
        if (k % 3 === 0) { refill(k); call('SetStreamSource', 0, dyn, 36); } else call('SetStreamSource', 0, vbs[k % vbs.length], 36);
        call('SetIndices', ibs[k % ibs.length], 0);
        call('DrawIndexedPrimitive', 4, 0, 100, 0, 50);
      }
    }
    call('EndScene'); call('Present', 0, 0, 0, 0);
  }
  return performance.now() - t0;
}

const variants = {
  none: () => ({ createDevice: () => null }),
  backend: () => { const gl = noopGl(); return { createDevice: (dev) => new WebGLDevice(gl, dev, {}) }; },
  recorder: () => {
    const words = new Int32Array(new SharedArrayBuffer(4 << 20)); // (shared, as the render worker's ring)
    const link = new RenderLink({ words, replayer: { reader: { consumed: 0 }, run() { this.reader.consumed = link.w.produced; } } });
    link.drain = function () { this.w.consumed = this.replayer.reader.consumed = this.w.produced; };
    return { createDevice: (dev) => new Recorder(link, dev) };
  },
  // (recorded, then replayed on this thread into a mirror whose backend draws over the no-op context: minus "recorder",
  // the render worker's work per draw)
  replay: () => {
    const words = new Int32Array(new SharedArrayBuffer(4 << 20)), gl = noopGl();
    let mem = null;
    const replayer = new Replayer(words, { get mem() { return mem; }, ack: null, createBackend: (m) => new WebGLDevice(gl, m, {}) });
    const link = new RenderLink({ words, replayer });
    return { createDevice: (dev) => { mem = dev.proc.mem; replayer.mem = mem; return new Recorder(link, dev); } };
  },
};
const per = (ms) => ms * 1000 / (DRAWS * FRAMES);
for (const api9 of which === 'both' ? [true, false] : [which === 'd3d9']) {
  const names = only ? [only] : Object.keys(variants);
  const res = new Map(names.map((n) => [n, []]));
  for (let r = 0; r < (only ? 1 : ROUNDS); r++) for (const n of names) res.get(n).push(per(session(api9, variants[n]())));
  // (the first round warms the code up; of the others the fastest: on a shared machine the slower rounds measure its load)
  const mean = (a) => Math.min(...(a.length > 1 ? a.slice(1) : a));
  console.log(`${api9 ? 'Direct3D 9 shader scene' : 'Direct3D 8 fixed-function scene'}, ${DRAWS} draws x ${FRAMES} frames: ` + names.map((n) => `${n} ${mean(res.get(n)).toFixed(2)} us/draw [${res.get(n).map((x) => x.toFixed(2)).join(' ')}]`).join('; '));
  if (!only) console.log(`  backend adds ${(mean(res.get('backend')) - mean(res.get('none'))).toFixed(2)} us/draw, recorder adds ${(mean(res.get('recorder')) - mean(res.get('none'))).toFixed(2)} us/draw`);
}
