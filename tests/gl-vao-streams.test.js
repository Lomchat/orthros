// Vertex streams reach GL exactly: with a declaration over two streams, every draw's vertex array object must point
// each attribute at its stream's buffer, stride and offset (plus the element's offset and the base vertex) — random
// stream changes, the same bindings again, buffers released and recreated. A GL stub keeps every VAO's attribute
// pointers as GL does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';

function vaoGl() {
  const canvas = { width: 640, height: 480 };
  let nextEnum = 0x9000, vao = null, arrayBuf = null;
  const gl = { canvas, drawingBufferWidth: 640, drawingBufferHeight: 480 };
  const nop = () => {}, obj = () => ({});
  gl.createVertexArray = () => ({ attrs: new Map() });
  gl.bindVertexArray = (v) => { vao = v; };
  gl.bindBuffer = (t, b) => { if (t === gl.ARRAY_BUFFER) arrayBuf = b; };
  gl.vertexAttribPointer = (loc, size, type, norm, stride, offset) => { vao.attrs.set(loc, { buf: arrayBuf, stride, offset }); };
  gl.getProgramParameter = () => true; gl.getActiveUniform = () => ({ name: '' }); gl.getUniformLocation = () => ({});
  gl.getParameter = (q) => (q === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? 32 : q === gl.MAX_TEXTURE_SIZE ? 4096 : 0);
  gl.getExtension = () => null; gl.getError = () => 0; gl.getShaderParameter = () => true; gl.getSyncParameter = () => 0;
  gl.checkFramebufferStatus = () => 0;
  gl.currentVao = () => vao;
  return new Proxy(gl, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (/^[A-Z0-9_]+$/.test(k)) return (t[k] = k === 'TEXTURE0' ? 0x84c0 : nextEnum++); if (k === 'then') return undefined; return (t[k] = /^create/.test(k) ? obj : nop); } });
}

const VS20 = [0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x03000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x03000009, 0xc0020000, 0x90e40000, 0xa0e40001, 0x03000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x03000009, 0xc0080000, 0x90e40000, 0xa0e40003, 0x02000001, 0xe00f0000, 0x90e40001, 0xffff];

test('vertex streams: each draw\'s VAO points every attribute at its stream (two streams, random bindings)', () => {
  for (const seed of [1, 2, 3, 4]) {
    const gl = vaoGl();
    let backend = null;
    const E = d3dEnv({ createDevice: (dev) => (backend = new WebGLDevice(gl, dev, {})) }), { mem, ctx, com } = E;
    let s = seed; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s % n; };
    const out = E.alloc(64), pp = E.alloc(64);
    [640, 480, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    const d3d = E.defs.Direct3DCreate9[1](ctx([32]));
    com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
    const dev = com.implAt(mem.read32(out));
    const c = ctx([dev.ptr]), call = (name, ...a) => { for (let i = 1; i < 9; i++) c.args[i] = a[i - 1] ?? 0; return dev[name](c); };
    const code = E.alloc(4 * VS20.length); VS20.forEach((v, i) => mem.write32(code + 4 * i, v));
    call('CreateVertexShader', code, out); call('SetVertexShader', mem.read32(out));
    // position (float3) in stream 0 at offset 4, texcoord (float2) in stream 1 at offset 8
    const el = E.alloc(64); [0x00040000, 0x00000002, 0x00080001, 0x00050001, 0x000000ff, 0x00000011].forEach((v, i) => mem.write32(el + 4 * i, v));
    call('CreateVertexDeclaration', el, out); call('SetVertexDeclaration', mem.read32(out));
    call('CreateIndexBuffer', 4096, 8, 101, 1, out); call('SetIndices', mem.read32(out));
    const vbs = [];
    const newVb = () => { call('CreateVertexBuffer', 4096, 8, 0, 1, out); return mem.read32(out); };
    for (let i = 0; i < 4; i++) vbs.push(newVb());
    const bind = [[0, 0, 0], [0, 0, 0]];
    let draws = 0, checked = 0;
    for (let step = 0; step < 3000; step++) {
      const r = rnd(10);
      if (r < 4) { const n = rnd(2), vb = vbs[rnd(vbs.length)], off = 4 * rnd(3), stride = [20, 24, 32][rnd(3)]; bind[n] = [vb, off, stride]; call('SetStreamSource', n, vb, off, stride); }
      else if (r === 4 && rnd(4) === 0) { const i = rnd(vbs.length), old = vbs[i]; vbs[i] = newVb(); for (const n of [0, 1]) if (bind[n][0] === old) { bind[n] = [vbs[i], bind[n][1], bind[n][2]]; call('SetStreamSource', n, vbs[i], bind[n][1], bind[n][2]); } com.release(com.objectAt(old)); }
      else {
        const base = rnd(3) * 2;
        if (!bind[0][0] || !bind[1][0]) continue;
        call('DrawIndexedPrimitive', 4, base, 0, 4, 0, 2); draws++;
        const v = gl.currentVao(), P = backend.lastProgram.p;
        for (const [name, n, elemOff] of [['a_' + P.attrNames[0].slice(2), 0, 4], ['a_' + P.attrNames[1].slice(2), 1, 8]]) {
          const loc = P.attrNames.indexOf(name), a = v.attrs.get(loc), [vb, off, stride] = bind[n];
          const want = backend.buffers.get(com.implAt(vb).id).buf;
          assert.ok(a, `seed ${seed} draw ${draws}: attribute ${name} set`);
          assert.equal(a.buf, want, `seed ${seed} draw ${draws}: ${name} reads stream ${n}'s buffer`);
          assert.equal(a.stride, stride, `seed ${seed} draw ${draws}: ${name} stride`);
          assert.equal(a.offset, off + base * stride + elemOff, `seed ${seed} draw ${draws}: ${name} offset`);
          checked++;
        }
      }
    }
    assert.ok(draws > 500 && checked === 2 * draws);
  }
});
