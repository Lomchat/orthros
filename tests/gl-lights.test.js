// Fixed-function lighting reaches each GL program exactly: at every draw the bound program holds the device's material,
// ambient color, enabled lights (in index order, positions and directions in view space) and their count — random
// light, material, ambient, view and enable changes (the backend re-sends only what moved: the ambient color with the
// render states, the lights and material with their version, the enabled order with the program version).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';

function uniformGl() {
  const canvas = { width: 640, height: 480 };
  let nextEnum = 0x9000, cur = null;
  const gl = { canvas, drawingBufferWidth: 640, drawingBufferHeight: 480 };
  const nop = () => {}, obj = () => ({});
  gl.createProgram = () => ({ u: new Map() });
  gl.getUniformLocation = (p, name) => ({ p, name: name.replace(/\[0\]$/, '') });
  gl.getProgramParameter = () => true; gl.getActiveUniform = () => ({ name: '' });
  gl.useProgram = (p) => { cur = p; };
  const put = (l, vals) => { assert.equal(l.p, cur, 'uniform set on the program in use'); let a = l.p.u.get(l.name); if (!a || a.length < vals.length) { const b = new Float64Array(Math.max(vals.length, a?.length ?? 0)); if (a) b.set(a); l.p.u.set(l.name, (a = b)); } for (let i = 0; i < vals.length; i++) a[i] = vals[i]; };
  gl.uniform4fv = (l, data, off = 0, len = data.length - off) => put(l, Array.from(data.subarray ? data.subarray(off, off + len) : data.slice(off, off + len)));
  gl.uniform1i = (l, v) => put(l, [v]); gl.uniform1f = (l, v) => put(l, [v]);
  gl.uniform4f = (l, a, b, c, d) => put(l, [a, b, c, d]); gl.uniform2f = (l, a, b) => put(l, [a, b]);
  gl.uniformMatrix4fv = (l, t, m) => put(l, Array.from(m));
  gl.getParameter = (q) => (q === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? 32 : q === gl.MAX_TEXTURE_SIZE ? 4096 : 0);
  gl.getExtension = () => null; gl.getError = () => 0; gl.getShaderParameter = () => true; gl.getSyncParameter = () => 0;
  gl.checkFramebufferStatus = () => 0;
  gl.current = () => cur;
  return new Proxy(gl, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (/^[A-Z0-9_]+$/.test(k)) return (t[k] = k === 'TEXTURE0' ? 0x84c0 : nextEnum++); if (k === 'then') return undefined; return (t[k] = /^create/.test(k) ? obj : nop); } });
}

const f32 = (x) => Math.fround(x);

test('lighting: every draw\'s program holds the device\'s material, ambient color and enabled lights (Direct3D 8, random changes)', () => {
  for (const seed of [1, 2, 3]) {
    const gl = uniformGl();
    const E = d3dEnv({ createDevice: (dev) => new WebGLDevice(gl, dev, {}) }), { mem, ctx, com } = E;
    let s = seed; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s % n; };
    const out = E.alloc(64), pp = E.alloc(64), buf = E.alloc(256);
    [640, 480, 22, 1, 0, 0, 1, 0, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    const d3d = E.defs.Direct3DCreate8[1](ctx([220]));
    com.implAt(d3d).CreateDevice(ctx([d3d, 0, 1, 0, 0x40, pp, out]));
    const dev = com.implAt(mem.read32(out));
    const c = ctx([dev.ptr]), call = (name, ...a) => { for (let i = 1; i < 9; i++) c.args[i] = a[i - 1] ?? 0; return dev[name](c); };
    call('CreateVertexBuffer', 4096, 8, 0x152, 1, out); call('SetStreamSource', 0, mem.read32(out), 32);
    call('CreateIndexBuffer', 4096, 8, 101, 1, out); call('SetIndices', mem.read32(out), 0);
    call('SetVertexShader', 0x152); call('SetRenderState', 137, 1); // (position, normal, one texture coordinate; LIGHTING on)
    const vals = [0, 0.5, 1, -1, 2.25];
    let draws = 0;
    for (let step = 0; step < 2500; step++) {
      const r = rnd(12);
      if (r < 2) { const i = rnd(5); mem.write32(buf, 1 + rnd(3)); for (let k = 1; k < 26; k++) mem.writeF32(buf + 4 * k, vals[rnd(vals.length)]); call('SetLight', i, buf); }
      else if (r < 4) call('LightEnable', rnd(5), rnd(2));
      else if (r < 6) { for (let k = 0; k < 17; k++) mem.writeF32(buf + 4 * k, vals[rnd(vals.length)]); call('SetMaterial', buf); }
      else if (r < 7) call('SetRenderState', 139, rnd(4) === 0 ? 0 : 0xff000000 + rnd(0xffffff)); // AMBIENT
      else if (r < 8) { for (let k = 0; k < 16; k++) mem.writeF32(buf + 4 * k, k % 5 === 0 ? 1 : vals[rnd(vals.length)] * 0.1); call('SetTransform', 2, buf); } // VIEW
      else if (r < 9) call('SetRenderState', 27, rnd(2)); // (another state: moves stateVersion only)
      else {
        call('DrawIndexedPrimitive', 4, 0, 4, 0, 2); draws++;
        const u = gl.current().u, where = `seed ${seed} draw ${draws}`;
        const mat = u.get('u_mat'); for (let k = 0; k < 17; k++) assert.equal(mat[k], dev.material[k], `${where}: material ${k}`);
        const amb = (dev.rs.get(139) ?? 0) >>> 0, ua = u.get('u_ambient');
        assert.deepEqual(Array.from(ua.slice(0, 4)), [((amb >> 16) & 255) / 255, ((amb >> 8) & 255) / 255, (amb & 255) / 255, (amb >>> 24) / 255].map(f32), `${where}: ambient`);
        const on = [...dev.lightEnabled].filter((i) => dev.lights.get(i)).sort((a, b) => a - b).slice(0, 8);
        assert.equal(u.get('u_numLights')?.[0] ?? 0, on.length, `${where}: number of lights`);
        const view = dev.transforms.get(2) ?? Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), ld = u.get('u_ld');
        on.forEach((i, n) => {
          const l = dev.lights.get(i), o = 28 * n;
          for (let k = 0; k < 12; k++) assert.equal(ld[o + k], l[1 + k], `${where}: light ${i} color ${k}`);
          const px = l[13], py = l[14], pz = l[15], dx = l[16], dy = l[17], dz = l[18];
          assert.equal(ld[o + 12], f32(view[0] * px + view[4] * py + view[8] * pz + view[12]), `${where}: light ${i} position`);
          assert.equal(ld[o + 18], f32(view[2] * dx + view[6] * dy + view[10] * dz), `${where}: light ${i} direction`);
          assert.equal(ld[o + 15], l[0] | 0, `${where}: light ${i} type`);
          assert.equal(ld[o + 23], l[20], `${where}: light ${i} range`);
        });
      }
    }
    assert.ok(draws > 400);
  }
});
