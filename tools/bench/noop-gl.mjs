// A WebGL2 context that does nothing, answering queries as a working one: the cost of the backend's own work without a
// GPU (tools/bench/backend-draw-bench.mjs, tools/bench/framebench.mjs). Uniforms: those a program's sources declare and use, as a
// GLSL compiler keeps them; constants: the names the backend reads, as plain properties.
import fs from 'node:fs';
import path from 'node:path';

const GFX = new URL('../../src/gfx/', import.meta.url).pathname;

/**
 * A WebGL2 context that does nothing, answering queries as a working one (uniforms: those the sources declare).
 * `compileMs` (> 0): program builds take that long, as a GPU process compiling on its own threads (`compileThreads` of
 * them: a build waits for a free one) — ANGLE over Direct3D 11 takes 100-270 ms per program on the owner's machine
 * (telemetry 2026-11): KHR_parallel_shader_compile is offered (COMPLETION_STATUS_KHR answers without waiting) and a link
 * status query on a program not built yet blocks the thread until it is, counted in `gl.sim` (waits, ms, builds).
 * `drawHash`: every draw hashed with its program's sources (`gl.drawHash`).
 */
export function noopGl(width = 1024, height = 768, { compileMs = 0, compileThreads = 4, drawHash = false } = {}) {
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
  if (drawHash) {
    // (a hash of every draw — its arguments and its program's sources —: two runs of the same guest work under the
    // virtual clock compare what they drew, e.g. with and without a change to how programs are found or built)
    const d = gl.drawHash = { h: 0x811c9dc5, draws: 0 }, mix = (v) => { d.h = Math.imul(d.h ^ (v | 0), 0x01000193); };
    let cur = null;
    const link0 = gl.linkProgram;
    gl.linkProgram = (p) => { link0(p); let h = 0x811c9dc5; for (const s of p.shaders) for (let i = 0; i < s.src.length; i++) h = Math.imul(h ^ s.src.charCodeAt(i), 0x01000193); p.srcHash = h; };
    gl.useProgram = (p) => { cur = p; };
    gl.drawArrays = (m, f, c) => { d.draws++; mix(cur?.srcHash ?? 0); mix(m); mix(f); mix(c); };
    gl.drawElements = (m, c, t, o) => { d.draws++; mix(cur?.srcHash ?? 0); mix(m); mix(c); mix(t); mix(o); };
    gl.drawElementsInstanced = (m, c, t, o, n) => { d.draws++; mix(cur?.srcHash ?? 0); mix(m); mix(c); mix(t); mix(o); mix(n); };
  }
  if (compileMs > 0) {
    const free = new Float64Array(Math.max(1, compileThreads)), sleeper = new Int32Array(new SharedArrayBuffer(4));
    const sim = gl.sim = { builds: 0, waits: 0, waitMs: 0, maxWaitMs: 0 };
    const link = gl.linkProgram;
    gl.linkProgram = (p) => {
      link(p);
      let t = 0; for (let i = 1; i < free.length; i++) if (free[i] < free[t]) t = i;
      p.readyAt = free[t] = Math.max(performance.now(), free[t]) + compileMs; sim.builds++;
    };
    const ext = { COMPLETION_STATUS_KHR: gl.COMPLETION_STATUS_KHR ?? 0x91b1 };
    gl.COMPLETION_STATUS_KHR = ext.COMPLETION_STATUS_KHR;
    gl.getExtension = (n) => (n === 'KHR_parallel_shader_compile' ? ext : null);
    gl.getProgramParameter = (p, q) => {
      if (q === ext.COMPLETION_STATUS_KHR) return performance.now() >= (p.readyAt ?? 0);
      const w = (p.readyAt ?? 0) - performance.now();
      if (w > 0) { Atomics.wait(sleeper, 0, 0, w); sim.waits++; sim.waitMs += w; sim.maxWaitMs = Math.max(sim.maxWaitMs, w); }
      return q === gl.ACTIVE_UNIFORMS ? p.names.length : true;
    };
  }
  return gl;
}
