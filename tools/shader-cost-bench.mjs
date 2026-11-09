#!/usr/bin/env node
// SwiftShader cost of the lean shaders (d3d8-shaders.js leanShaders) against the earlier GLSL, per program of a game:
// the programs a game's sessions learned (the server's programs2-<manifest>.json files, e.g. a --learn directory of
// tools/headless.mjs). Fixed-function programs are regenerated from their key both ways; shader programs need both
// sources learned for the same key (a session that switched dbg ORTHROS_LEAN_SHADERS_OFF, e.g. tools/scenarios/*-lean-ab.txt).
// Pixel shaders: over 4 layers of a full 1024x768 target (blending on), fed by a common vertex shader writing every
// varying; vertex shaders: over 360 k vertices drawn into a 1x1 scissor, with a pixel shader reading every varying (no
// output dead). Times with a 1-pixel readback (waits for the GPU process), best of 3 rounds. Starts a browser: run it
// through tools/with-browser-slot.sh.
// Usage: tools/with-browser-slot.sh node tools/shader-cost-bench.mjs <out.json> <programs2-*.json>...
import fs from 'node:fs';
import { chromium } from 'playwright';
import { ffProgramFromKey } from '../src/gfx/d3d8-shaders.js';
import { ffKeyRegenerable } from '../src/gfx/program-id.js';
const pairs = [];
for (const f of process.argv.slice(3)) {
  const game = f.replace(/.*programs2-|\.json$/g, '');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const by = new Map();
  for (const e of j.programs) { const k = e[1]; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
  for (const [k, a] of by) {
    if (ffKeyRegenerable(k)) {
      globalThis.ORTHROS_LEAN_SHADERS_OFF = undefined; const L = ffProgramFromKey(k);
      globalThis.ORTHROS_LEAN_SHADERS_OFF = 1; const O = ffProgramFromKey(k);
      globalThis.ORTHROS_LEAN_SHADERS_OFF = undefined;
      if (L && (L.vs !== O.vs || L.fs !== O.fs)) pairs.push({ game, key: k, ff: true, vsL: L.vs, fsL: L.fs, vsO: O.vs, fsO: O.fs, attrs: L.attrs });
      continue;
    }
    const old = a.find((e) => e[3].includes('vec4 r[32]') || e[2].includes('vec4 r[32]')), lean = a.find((e) => e !== old && !e[3].includes('vec4 r[32]'));
    if (old && lean) pairs.push({ game, key: k, ff: false, vsL: lean[2], fsL: lean[3], vsO: old[2], fsO: old[3], attrs: Array.isArray(lean[4][0]) ? lean[4][0] : lean[4] });
  }
}
console.log(`${pairs.length} program pairs`);
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  const res = await page.evaluate(async (pairs) => {
    const W = 1024, H = 768, gl = new OffscreenCanvas(W, H).getContext('webgl2', { antialias: false });
    const fb = gl.createFramebuffer(), rb = gl.createRenderbuffer(), db = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
    gl.bindRenderbuffer(gl.RENDERBUFFER, db); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, db);
    gl.viewport(0, 0, W, H);
    let seed = 1; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) / 16777216; };
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, Uint8Array.from({ length: 256 * 256 * 4 }, () => Math.floor(rnd() * 256)));
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const cube = gl.createTexture(); gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube); for (let f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64).fill(128));
    const vol = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, vol); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 4, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256).fill(128));
    for (let i = 0; i < 16; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube); gl.bindTexture(gl.TEXTURE_3D, vol); }
    const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src); return s; };
    const link = (vs, fs, attrs) => { const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); (attrs ?? []).forEach((a, i) => gl.bindAttribLocation(p, i, a)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
    const fl = (fs) => (/flat in vec4 v_color0/.test(fs) ? 'flat ' : '');
    const commonVs = (flat) => `#version 300 es\nprecision highp float;\nin vec4 a_p;\n${flat}out vec4 v_color0; ${flat}out vec4 v_color1; out float v_fog;\n${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `out vec4 v_tex${i};`).join('\n')}\nvoid main() { gl_Position = vec4(a_p.xy, 0.5, 1.0); v_color0 = vec4(a_p.xy * 0.5 + 0.5, 0.7, 0.8); v_color1 = v_color0.yxzw; v_fog = a_p.x * 0.5 + 0.5;\n${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `v_tex${i} = vec4(a_p.xy * ${(1 + i * 0.3).toFixed(1)}, 0.5, 1.0);`).join(' ')} }`;
    const sinkFs = (flat) => `#version 300 es\nprecision highp float;\n${flat}in vec4 v_color0; ${flat}in vec4 v_color1; in float v_fog;\n${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `in vec4 v_tex${i};`).join('\n')}\nout vec4 o; void main() { o = v_color0 + v_color1 + vec4(v_fog) + ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `v_tex${i}`).join(' + ')}; }`;
    // full-screen grid: 4 layers of 16x12 quads
    const grid = []; for (let l = 0; l < 4; l++) for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) { const x0 = x / 8 - 1, x1 = (x + 1) / 8 - 1, y0 = y / 6 - 1, y1 = (y + 1) / 6 - 1; grid.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1); }
    const gridBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW);
    const NV = 360000, vbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbuf); gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from({ length: NV * 4 }, () => rnd() * 2 - 1), gl.STATIC_DRAW);
    const uniforms = (p, L) => {
      gl.useProgram(p);
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const u = gl.getActiveUniform(p, i), l = gl.getUniformLocation(p, u.name); seed = 99 + i;
        const v = (k) => Float32Array.from({ length: k * u.size }, () => rnd() * 2 - 1);
        if (u.type === gl.FLOAT_VEC4) gl.uniform4fv(l, v(4)); else if (u.type === gl.FLOAT) gl.uniform1fv(l, v(1)); else if (u.type === gl.FLOAT_VEC2) gl.uniform2fv(l, v(2));
        else if (u.type === gl.FLOAT_MAT4) gl.uniformMatrix4fv(l, false, v(16)); else if (u.type === gl.INT_VEC4) gl.uniform4iv(l, new Int32Array(4 * u.size).fill(1));
        else if (u.type === gl.SAMPLER_2D || u.type === gl.SAMPLER_CUBE || u.type === gl.SAMPLER_3D) gl.uniform1i(l, Number(/\d+/.exec(u.name)?.[0] ?? 0) & 15);
        else if (u.type === gl.INT) gl.uniform1i(l, u.name === 'u_numLights' ? L.n : 1);
      }
      const ld = gl.getUniformLocation(p, 'u_ld[0]');
      if (ld) { const d = Float32Array.from({ length: 56 * 4 }, () => rnd()); L.types.forEach((t, i) => { d[i * 28 + 15] = t; d[i * 28 + 19] = 1e6; }); gl.uniform4fv(ld, d); }
      const vp = gl.getUniformLocation(p, 'u_viewport'); if (vp) gl.uniform4f(vp, 0, 0, W, H);
    };
    const wait = () => { const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const time = (f) => { wait(); const t0 = performance.now(); f(); wait(); return performance.now() - t0; };
    const out = [];
    for (const pr of pairs) {
      const lights = (() => { if (!pr.ff) return []; const v = pr.key.split('|')[0].split(':'); return v[3] ? v[3].split(',').map(Number) : []; })();
      const nLights = { n: lights.length, types: lights };
      const r = { game: pr.game, key: pr.key.slice(0, 90), ff: pr.ff };
      try {
        // pixel shaders
        const fp = [pr.fsL, pr.fsO].map((fs) => link(commonVs(fl(fs)), fs, ['a_p']));
        const fsT = [[], []];
        for (let round = 0; round < 3; round++) for (let k = 0; k < 2; k++) {
          const p = fp[k]; uniforms(p, nLights); gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
          for (let a = 0; a < 16; a++) gl.disableVertexAttribArray(a);
          gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
          gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.SCISSOR_TEST);
          fsT[k].push(time(() => { for (let n = 0; n < 3; n++) gl.drawArrays(gl.TRIANGLES, 0, grid.length / 2); }) / 3);
        }
        // vertex shaders
        const vp = [pr.vsL, pr.vsO].map((vs) => link(vs, sinkFs(fl(pr.fsL)), pr.attrs));
        const vsT = [[], []];
        for (let round = 0; round < 3; round++) for (let k = 0; k < 2; k++) {
          const p = vp[k]; uniforms(p, nLights); gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
          for (let a = 0; a < 16; a++) gl.disableVertexAttribArray(a);
          for (let a = 0; a < pr.attrs.length; a++) { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 0, 0); }
          gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 1, 1);
          vsT[k].push(time(() => gl.drawArrays(gl.TRIANGLES, 0, NV)));
        }
        gl.disable(gl.SCISSOR_TEST);
        r.fsL = Math.min(...fsT[0]); r.fsO = Math.min(...fsT[1]); r.vsL = Math.min(...vsT[0]); r.vsO = Math.min(...vsT[1]);
      } catch (e) { r.error = String(e.message).slice(0, 300); }
      out.push(r);
    }
    return out;
  }, pairs);
  fs.writeFileSync(process.argv[2], JSON.stringify(res, null, 1));
  const by = {};
  for (const r of res) { if (r.error) { console.log('ERROR', r.key, r.error); continue; } const g = (by[r.game + (r.ff ? ' ff' : ' shaders')] ??= { n: 0, fsL: 0, fsO: 0, vsL: 0, vsO: 0 }); g.n++; for (const k of ['fsL', 'fsO', 'vsL', 'vsO']) g[k] += r[k]; }
  for (const [k, g] of Object.entries(by)) console.log(`${k}: ${g.n} programs; pixel shaders (4 layers of 1024x768) lean ${(g.fsL / g.n).toFixed(1)} ms vs earlier ${(g.fsO / g.n).toFixed(1)} ms (x${(g.fsL / g.fsO).toFixed(2)}); vertex shaders (360 k vertices) lean ${(g.vsL / g.n).toFixed(1)} ms vs earlier ${(g.vsO / g.n).toFixed(1)} ms (x${(g.vsL / g.vsO).toFixed(2)})`);
} finally { await browser.close(); }
