// Every shader translator must produce GLSL that a real WebGL2 implementation compiles and links:
// fixed-function variants, DX8 vs1.1/ps1.x and DX9 SM 1.x-2.x programs (synthetic token streams),
// compiled in headless Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ffVertexShader, ffFragmentShader, fvfLayout, translateVertexShader, translatePixelShader, TOP } from '../src/gfx/d3d8-shaders.js';
import { translatePixelShader9, translateVertexShader9 } from '../src/gfx/d3d9-shaders.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* playwright not installed */ }

const f = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];
const env = { cube: [], volume: [], projected: [], fog: 0 };
const ff = (stages, extra = {}) => ({ layout: fvfLayout(0x152), lighting: true, lights: [3, 1], colorVertex: true, diffuseSrc: 1, specularSrc: 2, ambientSrc: 0, emissiveSrc: 0, specularEnable: true, localViewer: true, normalize: false, fogVertex: 3, rangeFog: false, stages, rhw: false, blend: 0, pointSize: true, ...extra });
const stage = (colorOp, extra = {}) => ({ colorOp, colorArg1: 2, colorArg2: 1, colorArg0: 1, alphaOp: TOP.MODULATE, alphaArg1: 2, alphaArg2: 1, alphaArg0: 1, resultTemp: false, cube: false, projected: false, bound: true, tci: 0, ttff: 0, ...extra });
const programs = [];
// fixed function: all texture ops, fog modes, alpha test
for (const op of Object.values(TOP)) programs.push(['ff op ' + op, ffVertexShader(ff([stage(TOP.MODULATE), stage(op)])), ffFragmentShader({ stages: [stage(TOP.MODULATE), stage(op)], alphaTest: 5, specular: true, fog: 3 })]);
programs.push(['ff texgen+projected', ffVertexShader(ff([stage(TOP.MODULATE, { tci: 0x20000, ttff: 0x103 })])), ffFragmentShader({ stages: [stage(TOP.MODULATE, { projected: true })], alphaTest: 0, specular: false, fog: -1 })]);
const vsFF = ffVertexShader(ff([stage(TOP.MODULATE)]));
// DX8 ps.1.1: def (0.0 values), tex, co-issued pair, cnd
const ps11 = new Uint32Array([0xffff0101, 0x51, 0xa00f0003, 0, 0, 0, 0, 0x42, 0xb00f0000, 0x42, 0xb00f0001, 0x5, 0x80070000, 0xb0e40000, 0x90e40000, 0x40000001, 0x80080000, 0xb0ff0001, 0x50, 0x800f0001, 0x80ff0000, 0xb0e40000, 0xa0e40003, 0x1, 0x800f0000, 0x80e40001, 0xffff]);
programs.push(['dx8 ps.1.1', vsFF, translatePixelShader(ps11, env)]);
programs.push(['dx9 ps_1_1', vsFF, translatePixelShader9(ps11, env).glsl]);
// DX8 vs.1.1 with def + dp4 to oPos, mov oD0 / oT0
const vs11 = new Uint32Array([0xfffe0101, 0x51, 0xa00f0005, f(1), f(0.5), f(0), f(2), 0x9, 0xc0010000, 0x90e40000, 0xa0e40000, 0x9, 0xc0020000, 0x90e40000, 0xa0e40001, 0x9, 0xc0040000, 0x90e40000, 0xa0e40002, 0x9, 0xc0080000, 0x90e40000, 0xa0e40003, 0x1, 0xd00f0000, 0xa0e40005, 0x1, 0xe00f0000, 0x90e40007, 0xffff]);
const layout8 = { streams: new Map([[0, { stride: 20, attrs: [{ name: 'pos', reg: 0, offset: 0, comps: 3, type: 'float' }, { name: 'tex0', reg: 7, offset: 12, comps: 2, type: 'float' }] }]]) };
programs.push(['dx8 vs.1.1', translateVertexShader(vs11, layout8), translatePixelShader(ps11, env)]);
// DX9 vs_2_0 with dcl + ps_2_0 with dcl sampler + texld
const vs20 = new Uint32Array([0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x03000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x03000009, 0xc0020000, 0x90e40000, 0xa0e40001, 0x03000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x03000009, 0xc0080000, 0x90e40000, 0xa0e40003, 0x02000001, 0xe00f0000, 0x90e40001, 0xffff]);
const ps20 = new Uint32Array([0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0x90000000, 0xa00f0800, 0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x03000005, 0x800f0000, 0x80e40000, 0xa0e40000, 0x02000001, 0x800f0800, 0x80e40000, 0xffff]);
programs.push(['dx9 vs_2_0/ps_2_0', translateVertexShader9(vs20).glsl, translatePixelShader9(ps20, { ...env, alphaTest: 5, fog: 3 }).glsl]);
// the same with v1 declared D3DCOLOR by the vertex declaration (DX9), and a D3DCOLOR input of a DX8 vs.1.1
const vs20c = translateVertexShader9(vs20, new Set(['s5_0'])).glsl;
const layout8c = { streams: new Map([[0, { stride: 16, attrs: [{ name: 'pos', reg: 0, offset: 0, comps: 3, type: 'float' }, { name: 'tex0', reg: 7, offset: 12, comps: 4, type: 'color' }] }]]) };
const vs11c = translateVertexShader(vs11, layout8c);
programs.push(['dx9 vs_2_0 D3DCOLOR input', vs20c, translatePixelShader9(ps20, env).glsl], ['dx8 vs.1.1 D3DCOLOR input', vs11c, translatePixelShader(ps11, env)]);

// Direct3D expands a D3DCOLOR element (bytes B, G, R, A) to (R, G, B, A); GL reads the bytes in memory order
test('D3DCOLOR vertex inputs of vertex shaders are read as (R, G, B, A)', () => {
  assert.match(vs20c, /vec4 i_s5_0 = a_s5_0\.zyxw;/);
  assert.equal(vs20c.match(/a_s5_0/g).length, 2, 'the attribute is only declared and copied: the shader reads the copy');
  assert.match(vs11c, /vec4 i_v7 = a_v7\.zyxw;/);
  assert.doesNotMatch(translateVertexShader9(vs20).glsl, /zyxw/, 'no D3DCOLOR input: no swizzle');
});

test('generated GLSL compiles and links in WebGL2', { skip: !chromium && 'playwright missing', timeout: 60000 }, async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl'] });
  try {
    const page = await browser.newPage();
    const errors = await page.evaluate((progs) => {
      const gl = new OffscreenCanvas(4, 4).getContext('webgl2');
      const out = [];
      for (const [name, vs, fs] of progs) {
        const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? [s, null] : [s, gl.getShaderInfoLog(s)]; };
        const [v, ve] = mk(gl.VERTEX_SHADER, vs), [fr, fe] = mk(gl.FRAGMENT_SHADER, fs);
        if (ve || fe) { out.push(`${name}: ${ve ? 'VS ' + ve : ''}${fe ? 'FS ' + fe : ''}`); continue; }
        const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, fr); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) out.push(`${name}: link ${gl.getProgramInfoLog(p)}`);
      }
      return out;
    }, programs);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
