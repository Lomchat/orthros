// Render worker, buffer contents through the ring (BUF_DATA): buffers larger than one ring chunk (1 MiB), odd
// lengths, unaligned lock ranges straddling chunk boundaries, a static buffer switched to ring data by a lock that
// meets pending draws, a dynamic buffer created and filled before its first use, and buffers released while draws
// that read them are pending. The replayed backend must issue the same WebGL calls (contents compared by checksum)
// as the in-thread one, and every mirror copy must equal the guest memory at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { d3dEnv } from './d3d-random.js';
import { fakeGl, firstDifference } from './fake-gl.js';

function session(gfx, seed, api9, onEnd) {
  const E = d3dEnv(gfx), { mem, ctx, com } = E;
  let s = seed; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; return ((s >>> 0) % n); };
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  if (!api9) { mem.write32(pp + 20, 1); mem.write32(pp + 24, 0); mem.write32(pp + 28, 1); mem.write32(pp + 32, 1); mem.write32(pp + 36, 75); mem.write32(pp + 40, 0); }
  const d3dPtr = E.defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  const MiB = 1 << 20;
  const create = (len, usage) => { assert.equal(call('CreateVertexBuffer', len, usage, 0x142, 0, out), 0); return mem.read32(out); };
  const fill = (ptr, off, size, flags) => {
    const b = com.implAt(ptr);
    assert.equal(b.Lock(ctx([ptr, off, size, out, flags])), 0);
    const a = mem.read32(out), n = size || b.length - off;
    for (let i = 0; i < n; i++) mem.u8[a + i] = rnd(256);
    b.Unlock(ctx([ptr]));
  };
  const bind = (ptr) => { if (api9) { call('SetStreamSource', 0, ptr, 0, 24); call('SetFVF', 0x142); } else { call('SetStreamSource', 0, ptr, 24); call('SetVertexShader', 0x142); } };
  const draw = (b) => call('DrawPrimitive', 4, Math.max(0, Math.floor((MiB + rnd(4096) - 2048) / 24)), 1 + rnd(Math.min(200, Math.floor(b.length / 72))));
  // a dynamic buffer of 2.5 MiB + 6 bytes, filled whole before its first use; a static one of 1.5 MiB + 2 bytes
  const dyn = create(2.5 * MiB + 6, 0x208), stat = create(1.5 * MiB + 2, 0);
  fill(dyn, 0, 0, 0x2000); fill(stat, 0, 0, 0);
  call('BeginScene');
  for (let step = 0; step < 60; step++) {
    const which = rnd(3) ? dyn : stat, b = com.implAt(which);
    bind(which); draw(b);
    // (an unaligned range, often straddling a chunk boundary of the ring copy; NOOVERWRITE past what draws used, or plain)
    const off = rnd(3) === 0 ? rnd(b.length) : Math.max(0, MiB - rnd(5000)) + rnd(7), size = rnd(4) === 0 ? 0 : Math.min(b.length - off, 1 + rnd(MiB + 3000));
    fill(which, off, size, pick(rnd, [0, 0x1000, 0x2000]));
    bind(which); draw(b);
    if (rnd(8) === 0) { call('EndScene'); call('Present', 0, 0, 0, 0); call('BeginScene'); }
  }
  // released while a draw that reads it may be pending, then a new buffer (memory recycled) written and drawn
  bind(stat); draw(com.implAt(stat)); call('SetStreamSource', 0, 0, 0, ...(api9 ? [0] : []));
  com.release(com.objectAt(stat));
  const again = create(1.5 * MiB + 2, 0); fill(again, 0, 0, 0); bind(again); draw(com.implAt(again));
  call('EndScene'); call('Present', 0, 0, 0, 0);
  onEnd?.(dev, com, [dyn, again]);
}
const pick = (rnd, a) => a[rnd(a.length)];

for (const api9 of [true, false]) {
  test(`Direct3D ${api9 ? 9 : 8}: buffer contents through the ring — large, unaligned, switched and released buffers replayed late give the same WebGL calls`, () => {
    for (const seed of [1, 2, 3]) {
      const A = fakeGl(), B = fakeGl();
      session({ createDevice: (dev) => new WebGLDevice(A.gl, dev, {}) }, seed, api9);
      // (the production ring size: a 1 MiB chunk must fit)
      const words = new Int32Array(1 << 22), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: (m) => new WebGLDevice(B.gl, m, {}) });
      const link = new RenderLink({ words, replayer, ack });
      session({ createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } }, seed, api9, (dev, com, ptrs) => {
        link.publish(true);
        for (const p of ptrs) {
          const b = com.implAt(p), mb = replayer.res.get(b.id);
          if (!mb?.shadow) continue;
          assert.ok(Buffer.from(mb.shadow).equals(Buffer.from(dev.proc.mem.u8.subarray(b.mem, b.mem + b.length))), `seed ${seed}: buffer ${b.id} mirror copy differs from guest memory`);
        }
      });
      const d = firstDifference(A.calls, B.calls);
      assert.equal(d, null, d ? `seed ${seed}: first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nreplayed\n  ${d.b.join('\n  ')}` : '');
      assert.ok(link.stats.eagerBufs >= 2 && link.stats.bufDataBytes > 4 << 20, `eager ${link.stats.eagerBufs}, ${link.stats.bufDataBytes} bytes`);
    }
  });
}
