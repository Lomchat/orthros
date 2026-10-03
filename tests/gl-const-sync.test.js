// Shader constants reach each GL program exactly: the backend compares only the registers written since a program's
// last draw (WebGLDevice.constTouched, the constant write log) and sends integer / boolean registers only when they
// differ from what the program last received. A GL stub keeps every program's uniform values; at every draw the bound
// program must hold the device's constants — random writes (same values, other programs in between, more writes than
// the log holds), in-thread and through the render worker's recorder and mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';

/** A WebGL2 stub whose programs keep their uniform values (u_vc / u_pc / u_vci / u_pci / u_vcb / u_pcb), as GL does. */
function uniformGl() {
  const canvas = { width: 640, height: 480 };
  let nextEnum = 0x9000, cur = null;
  const gl = { canvas, drawingBufferWidth: 640, drawingBufferHeight: 480, uploads: 0, intUploads: 0 };
  const nop = () => {}, obj = () => ({});
  const known = /^(u_vc|u_pc|u_vci|u_pci|u_vcb|u_pcb)(?:\[(\d+)\])?$/;
  gl.createProgram = () => ({ state: { u_vc: new Float32Array(1024), u_pc: new Float32Array(128), u_vci: new Int32Array(64), u_pci: new Int32Array(64), u_vcb: new Int32Array(16), u_pcb: new Int32Array(16) } });
  gl.getUniformLocation = (p, name) => { const m = known.exec(name); return m ? { p, arr: m[1], idx: Number(m[2] ?? 0) } : { p, arr: null }; };
  gl.getProgramParameter = () => true; gl.getActiveUniform = () => ({ name: '' });
  gl.useProgram = (p) => { cur = p; };
  const put = (l, data, off, len, per) => {
    assert.equal(l.p, cur, 'uniform set on the program in use');
    const a = l.p.state[l.arr], n = len ?? (data.length - (off ?? 0));
    for (let i = 0; i < n; i++) a[l.idx * per + i] = data[(off ?? 0) + i];
    gl.uploads++;
  };
  gl.uniform4fv = (l, data, off, len) => { if (l.arr) put(l, data, off, len, 4); };
  gl.uniform4iv = (l, data, off, len) => { if (l.arr) { put(l, data, off, len, 4); gl.intUploads++; } };
  gl.uniform1i = (l, v) => { if (l.arr) { put(l, [v], 0, 1, 1); gl.intUploads++; } };
  gl.getParameter = (q) => (q === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? 32 : q === gl.MAX_TEXTURE_SIZE ? 4096 : 0);
  gl.getExtension = () => null; gl.getError = () => 0; gl.getShaderParameter = () => true; gl.getSyncParameter = () => 0;
  gl.checkFramebufferStatus = () => 0;
  gl.current = () => cur;
  return new Proxy(gl, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (/^[A-Z0-9_]+$/.test(k)) return (t[k] = k === 'TEXTURE0' ? 0x84c0 : nextEnum++); if (k === 'then') return undefined; return (t[k] = /^create/.test(k) ? obj : nop); } });
}

const VS20 = [0xfffe0200, 0x0200001f, 0x80000000, 0x900f0000, 0x0200001f, 0x80000005, 0x900f0001, 0x03000009, 0xc0010000, 0x90e40000, 0xa0e40000, 0x03000009, 0xc0020000, 0x90e40000, 0xa0e40001, 0x03000009, 0xc0040000, 0x90e40000, 0xa0e40002, 0x03000009, 0xc0080000, 0x90e40000, 0xa0e40003, 0x02000001, 0xe00f0000, 0x90e40001, 0xffff];
const PS20 = [0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0x90000000, 0xa00f0800, 0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x03000005, 0x800f0000, 0x80e40000, 0xa0e40000, 0x02000001, 0x800f0800, 0x80e40000, 0xffff];

/** A random Direct3D 9 session of shader draws and constant writes; `check(dev)` after every draw. */
function session(gfx, seed, check) {
  const E = d3dEnv(gfx), { mem, ctx, com } = E;
  let s = seed >>> 0; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s % n; };
  const out = E.alloc(64), pp = E.alloc(64), scratch = E.alloc(4096);
  [640, 480, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3d = E.defs.Direct3DCreate9[1](ctx([32]));
  com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const c = ctx([devPtr]), call = (name, ...a) => { for (let i = 1; i < 9; i++) c.args[i] = a[i - 1] ?? 0; return dev[name](c); };
  const code = (words) => { const p = E.alloc(4 * words.length); words.forEach((v, i) => mem.write32(p + 4 * i, v)); return p; };
  const shaders = [];
  for (let i = 0; i < 3; i++) {
    // (distinct programs: the pixel shaders differ by a trailing comment token... a constant definition instead)
    const ps = PS20.slice(0, -1).concat([0x05000051, 0xa00f0001 + i, 0x3f800000, 0, 0, 0, 0xffff]);
    call('CreateVertexShader', code(VS20), out); const v = mem.read32(out);
    call('CreatePixelShader', code(ps), out); shaders.push([v, mem.read32(out)]);
  }
  const el = E.alloc(64); [0x00000000, 0x00000002, 0x000c0000, 0x00050001, 0x000000ff, 0x00000011].forEach((v, i) => mem.write32(el + 4 * i, v));
  call('CreateVertexDeclaration', el, out); call('SetVertexDeclaration', mem.read32(out));
  call('CreateVertexBuffer', 4096, 8, 0, 1, out); call('SetStreamSource', 0, mem.read32(out), 0, 20);
  call('CreateIndexBuffer', 4096, 8, 101, 1, out); call('SetIndices', mem.read32(out));
  call('CreateTexture', 8, 8, 1, 0, 21, 1, out); call('SetTexture', 0, mem.read32(out));
  call('SetVertexShader', shaders[0][0]); call('SetPixelShader', shaders[0][1]);
  const values = [0, 1, -2.5, 3.25, 1e-3];
  for (let step = 0; step < 1500; step++) {
    const r = rnd(20);
    if (r < 2) { const sh = shaders[rnd(3)]; call('SetVertexShader', sh[0]); call('SetPixelShader', sh[1]); }
    else if (r < 9) { const n = 1 + rnd(6), reg = rnd(256 - n); for (let i = 0; i < 4 * n; i++) mem.writeF32(scratch + 4 * i, values[rnd(values.length)] + (rnd(4) === 0 ? step : 0)); call('SetVertexShaderConstantF', reg, scratch, n); }
    else if (r < 11) { const n = 1 + rnd(3), reg = rnd(32 - n); for (let i = 0; i < 4 * n; i++) mem.writeF32(scratch + 4 * i, values[rnd(values.length)]); call('SetPixelShaderConstantF', reg, scratch, n); }
    else if (r < 12) { const n = 1 + rnd(2), reg = rnd(16 - n); for (let i = 0; i < 4 * n; i++) mem.write32(scratch + 4 * i, rnd(5) - 2); call(rnd(2) ? 'SetVertexShaderConstantI' : 'SetPixelShaderConstantI', reg, scratch, n); }
    else if (r < 13) { const n = 1 + rnd(3), reg = rnd(16 - n); for (let i = 0; i < n; i++) mem.write32(scratch + 4 * i, rnd(2)); call(rnd(2) ? 'SetVertexShaderConstantB' : 'SetPixelShaderConstantB', reg, scratch, n); }
    else if (r < 14) { for (let k = 0; k < 300; k++) { mem.writeF32(scratch, k); call('SetVertexShaderConstantF', k % 200, scratch, 1); } } // (more writes than the log holds)
    else { call('DrawIndexedPrimitive', 4, 0, 0, 4, 0, 2); check(dev); }
    if (rnd(50) === 0) call('Present', 0, 0, 0, 0);
  }
}

/** the bound program holds the device's constants (registers each of its uniforms covers) */
function expectConstants(gl, dev, where) {
  const p = gl.current(); assert.ok(p, where);
  const st = p.state;
  const eq = (a, b, name) => { for (let i = 0; i < b.length; i++) if (!Object.is(a[i], b[i]) && !(a[i] === b[i])) assert.fail(`${where}: ${name}[${i}] ${a[i]} != ${b[i]}`); };
  eq(st.u_vc, dev.vsConst, 'u_vc'); eq(st.u_pc, dev.psConst, 'u_pc');
  eq(st.u_vci, dev.vsConstI, 'u_vci'); eq(st.u_pci, dev.psConstI, 'u_pci');
  eq(st.u_vcb, Array.from(dev.vsConstB, Number), 'u_vcb'); eq(st.u_pcb, Array.from(dev.psConstB, Number), 'u_pcb');
}

test('constants: every program holds the device\'s constants at each of its draws (in-thread backend)', () => {
  for (const seed of [1, 2, 3]) {
    const gl = uniformGl(); let draws = 0;
    session({ createDevice: (dev) => new WebGLDevice(gl, dev, {}) }, seed, (dev) => expectConstants(gl, dev, `seed ${seed} draw ${++draws}`));
    assert.ok(draws > 300);
  }
});

test('constants: the same through the recorder and the device mirror (render worker path)', () => {
  for (const seed of [4, 5]) {
    const gl = uniformGl(), words = new Int32Array(1 << 20), ack = new Int32Array(1 << 16).fill(-1);
    let mem = null;
    const replayer = new Replayer(words, { get mem() { return mem; }, ack, createBackend: (m) => new WebGLDevice(gl, m, {}) });
    const link = new RenderLink({ words, replayer, ack });
    let draws = 0;
    session({ createDevice: (dev) => { mem = dev.proc.mem; replayer.mem = mem; return new Recorder(link, dev); } }, seed, (dev) => {
      link.publish(true); // (replayed now: the mirror's backend has drawn)
      expectConstants(gl, dev, `seed ${seed} draw ${++draws}`);
    });
    assert.ok(draws > 300);
  }
});

test('constants: integer and boolean registers are sent again only when they change', () => {
  const gl = uniformGl(), E = { draws: 0, before: 0 };
  let devRef = null, sent = 0;
  session({ createDevice: (dev) => { devRef = dev; return new WebGLDevice(gl, dev, {}); } }, 11, (dev) => {
    // (between two draws of the same program with the same integer / boolean registers, nothing of them is sent)
    const key = Array.from(dev.vsConstI).join() + '|' + Array.from(dev.psConstI).join() + '|' + Array.from(dev.vsConstB).join() + '|' + Array.from(dev.psConstB).join() + '|' + dev.vsObj?.handle + '|' + dev.psObj?.handle;
    if (E.key === key && gl.intUploads !== E.before) sent++;
    E.key = key; E.before = gl.intUploads; E.draws++;
  });
  assert.ok(devRef && E.draws > 300);
  assert.equal(sent, 0, 'draws that re-sent unchanged integer / boolean registers');
});
