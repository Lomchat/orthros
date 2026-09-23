// Direct3D shader bytecode translation details (SM 1.x token stream parsing, depth output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePixelShader9, disasmShader9 } from '../src/gfx/d3d9-shaders.js';
import { translateVertexShader } from '../src/gfx/d3d8-shaders.js';

test('ps_1_1: def constants of 0.0 are values, not instructions (no length field in SM 1.x tokens)', () => {
  // ps_1_1 ; def c3, 0, 0, 0, 0 ; tex t0 ; mov r0, t0
  const code = new Uint32Array([0xffff0101, 0x51, 0xa00f0003, 0, 0, 0, 0, 0x42, 0xb00f0000, 0x1, 0x800f0000, 0xb0e40000, 0xffff]);
  assert.equal(disasmShader9(code), 'ps_1_1\ndef c3, 0, 0, 0, 0\ntex t0\nmov r0, t0');
  const glsl = translatePixelShader9(code, { cube: [], projected: [], fog: 0 }).glsl;
  assert.match(glsl, /t0 = texture\(u_tex0, \(v_tex0\)\.xy\);/);
  assert.match(glsl, /r\[0\] = clamp\(t0\.xyzw, -1\.0, 1\.0\);/);
  assert.doesNotMatch(glsl, /gl_FragDepth/, 'no depth output unless the shader writes depth');
});

test('vs_1_1 (DX8): def constants are local values', () => {
  // vs_1_1 ; def c5, 1, 2, 3, 4 ; mov oPos, c5
  const f = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];
  const code = new Uint32Array([0xfffe0101, 0x51, 0xa00f0005, f(1), f(2), f(3), f(4), 0x1, 0xc00f0000, 0xa0e40005, 0xffff]);
  const glsl = translateVertexShader(code, { streams: new Map() });
  assert.match(glsl, /vec4 c5 = vec4\(1\.000000e\+0, 2\.000000e\+0, 3\.000000e\+0, 4\.000000e\+0\);/);
  assert.match(glsl, /oPos = c5\.xyzw;/);
});

test('ps_1_1: a co-issued instruction reads the registers of before its pair; constants clamp to [-1, 1]', () => {
  // ps_1_1 ; mov r0.rgb, c0 ; +mov r0.a, r0.b   (the co-issued mov must see r0 before the rgb write)
  const code = new Uint32Array([0xffff0101, 0x1, 0x80070000, 0xa0e40000, 0x40000001, 0x80080000, 0x80aa0000, 0xffff]);
  assert.equal(disasmShader9(code), 'ps_1_1\nmov r0.xyz, c0\n+mov r0.w, r0.z');
  const glsl = translatePixelShader9(code, { cube: [], projected: [], fog: 0 }).glsl;
  const lines = glsl.split('\n');
  const snap = lines.findIndex((l) => /vec4 co0 = r\[0\];/.test(l)), rgb = lines.findIndex((l) => /r\[0\]\.xyz = /.test(l)), a = lines.findIndex((l) => /r\[0\]\.w = .*co0\.zzzz/.test(l));
  assert.ok(snap >= 0 && rgb > snap && a > rgb, glsl);
  assert.match(glsl, /clamp\(u_pc\[0\], -1\.0, 1\.0\)/);
});
