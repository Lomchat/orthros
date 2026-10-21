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

// (both ways buffer bytes travel: at Unlock, ORTHROS_VB_LAZY=0 — the same WebGL calls; at the draws that read them —
// the same draws, compared by what they read, no stale read found by the check, and every byte not still pending
// equal to guest memory)
for (const api9 of [true, false]) for (const lazy of [false, true]) {
  test(`Direct3D ${api9 ? 9 : 8}: buffer contents through the ring — large, unaligned, switched and released buffers replayed late give the same WebGL ${lazy ? 'draws (bytes copied at draws)' : 'calls'}`, () => {
    globalThis.ORTHROS_VB_LAZY = lazy ? undefined : 0; globalThis.ORTHROS_VB_CHECK = lazy ? 1 : undefined;
    try { for (const seed of [1, 2, 3]) {
      const A = fakeGl(800, 600, { reads: lazy }), B = fakeGl(800, 600, { reads: lazy });
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
          const sh = Buffer.from(mb.shadow), g = Buffer.from(dev.proc.mem.u8.subarray(b.mem, b.mem + b.length)), lz = b.rec.lz ?? [];
          if (!lazy) { assert.ok(sh.equals(g), `seed ${seed}: buffer ${b.id} mirror copy differs from guest memory`); continue; }
          // (outside the bytes still pending, the mirror's copy is guest memory)
          for (let i = 0, at = 0; at <= b.length; i += 2) {
            const end = i < lz.length ? lz[i] : b.length;
            assert.ok(sh.subarray(at, end).equals(g.subarray(at, end)), `seed ${seed}: buffer ${b.id} differs in [${at}, ${end}) outside its pending bytes`);
            if (i >= lz.length) break;
            at = lz[i + 1];
          }
        }
      });
      const d = firstDifference(A.calls, B.calls);
      assert.equal(d, null, d ? `seed ${seed}: first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nreplayed\n  ${d.b.join('\n  ')}` : '');
      assert.ok(link.stats.eagerBufs >= 2 && link.stats.bufDataBytes > 4 << 20, `eager ${link.stats.eagerBufs}, ${link.stats.bufDataBytes} bytes`);
      if (lazy) assert.ok(link.stats.vbChecked > 100 && link.stats.vbStale === 0, `seed ${seed}: ${link.stats.vbChecked} draws checked, ${link.stats.vbStale} read stale bytes`);
    } } finally { globalThis.ORTHROS_VB_LAZY = undefined; globalThis.ORTHROS_VB_CHECK = undefined; }
  });
}

// Bytes copied at the draws that read them: what a draw reads is bounded by its index data, not by MinIndex /
// NumVertices (understated here), with base vertices, stream offsets, a second stream (Direct3D 9 declaration), partial
// NOOVERWRITE locks and draws over parts of what was written. Replayed late, the draws must read the same bytes as
// in-thread, the check must find no stale read, and fewer bytes must travel than with copies at Unlock.
function partialSession(gfx, seed, api9) {
  const E = d3dEnv(gfx), { mem, ctx, com } = E;
  let s = seed; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; return ((s >>> 0) % n); };
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  if (!api9) { mem.write32(pp + 20, 1); mem.write32(pp + 24, 0); mem.write32(pp + 28, 1); mem.write32(pp + 32, 1); mem.write32(pp + 36, 75); mem.write32(pp + 40, 0); }
  const d3dPtr = E.defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  assert.equal(call('CreateVertexBuffer', 24 * 4096, 0x208, 0x142, 0, out), 0); const vb = mem.read32(out);
  assert.equal(call('CreateVertexBuffer', 4 * 4096 + 8, 0x208, 0, 0, out), 0); const colors = mem.read32(out);
  assert.equal(call('CreateIndexBuffer', 2 * 3000, 0x208, 101, 0, out), 0); const ib = mem.read32(out);
  const lock = (ptr, off, size, flags, f) => { const b = com.implAt(ptr); assert.equal(b.Lock(ctx([ptr, off, size, out, flags])), 0); f(mem.read32(out), size || b.length - off); b.Unlock(ctx([ptr])); };
  const randomBytes = (a, n) => { for (let i = 0; i < n; i++) mem.u8[a + i] = rnd(256); };
  let decl = 0;
  if (api9) { // (stream 0: FLOAT3 position; stream 1: D3DCOLOR color)
    const d = E.alloc(32);
    [0 | (0 << 16), 2 | (0 << 16), 1 | (0 << 16), 4 | (10 << 16), 0xff, 17].forEach((w, i) => mem.write32(d + 4 * i, w));
    assert.equal(call('CreateVertexDeclaration', d, out), 0); decl = mem.read32(out);
  }
  call('BeginScene');
  for (let frame = 0; frame < 12; frame++) {
    lock(vb, 0, 0, 0x2000, randomBytes); // (DISCARD: all of it written, parts drawn)
    lock(colors, 0, 0, 0x2000, randomBytes);
    // indices in [lo, lo + 200), the calls claiming 4 vertices from lo
    const lo = rnd(3000);
    lock(ib, 0, 0, 0x2000, (a, n) => { for (let i = 0; i < n / 2; i++) mem.write16(a + 2 * i, lo + rnd(200)); });
    for (let k = 0; k < 10; k++) {
      const twoStreams = api9 && rnd(2) === 1, base = rnd(400), start = rnd(2000), prims = 1 + rnd(60);
      if (twoStreams) { call('SetVertexDeclaration', decl); call('SetStreamSource', 0, vb, 24 * rnd(4), 24); call('SetStreamSource', 1, colors, 4 * rnd(2) + (rnd(2) ? 8 : 0), 4); }
      else if (api9) { call('SetFVF', 0x142); call('SetStreamSource', 0, vb, 24 * rnd(4), 24); call('SetStreamSource', 1, 0, 0, 0); }
      else call('SetVertexShader', 0x142), call('SetStreamSource', 0, vb, 24);
      if (api9) { call('SetIndices', ib); call('DrawIndexedPrimitive', 4, base, lo, 4, start, prims); } else { call('SetIndices', ib, base); call('DrawIndexedPrimitive', 4, lo, 4, start, prims); }
      // a part rewritten without discarding, then a non-indexed draw over another part
      const v0 = rnd(4000);
      lock(vb, 24 * v0, 24 * Math.min(50, 4096 - v0), 0x1000, randomBytes);
      if (api9) { call('SetFVF', 0x142); call('SetStreamSource', 0, vb, 0, 24); call('SetStreamSource', 1, 0, 0, 0); }
      call('DrawPrimitive', 4, rnd(4000), 1 + rnd(30));
    }
    call('EndScene'); call('Present', 0, 0, 0, 0); call('BeginScene');
  }
  call('EndScene'); call('Present', 0, 0, 0, 0);
}

for (const api9 of [true, false]) {
  test(`Direct3D ${api9 ? 9 : 8}: buffer bytes copied at the draws that read them — bounded by the index data, not the call's vertex range; fewer bytes, the same draws`, () => {
    const bytes = {};
    try {
      for (const lazy of [false, true]) {
        globalThis.ORTHROS_VB_LAZY = lazy ? undefined : 0; globalThis.ORTHROS_VB_CHECK = 1;
        bytes[lazy] = 0;
        for (const seed of [1, 2, 3]) {
          const A = fakeGl(800, 600, { reads: true }), B = fakeGl(800, 600, { reads: true });
          partialSession({ createDevice: (dev) => new WebGLDevice(A.gl, dev, {}) }, seed, api9);
          const words = new Int32Array(1 << 20), ack = new Int32Array(1 << 16).fill(-1);
          const replayer = new Replayer(words, { mem: null, ack, createBackend: (m) => new WebGLDevice(B.gl, m, {}) });
          const link = new RenderLink({ words, replayer, ack });
          partialSession({ createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } }, seed, api9);
          link.publish(true);
          const d = firstDifference(A.calls, B.calls);
          assert.equal(d, null, d ? `seed ${seed}, lazy ${lazy}: first difference at call ${d.index} (${d.lengths}):\nin-thread\n  ${d.a.join('\n  ')}\nreplayed\n  ${d.b.join('\n  ')}` : '');
          assert.ok(A.calls.filter((c) => c[0] === 'drawElements').length >= 100, 'indexed draws');
          assert.equal(link.stats.vbStale, 0, `seed ${seed}, lazy ${lazy}: draws that read stale bytes`);
          assert.ok(link.stats.vbChecked >= 200, `${link.stats.vbChecked} draws checked`);
          bytes[lazy] += link.stats.bufDataBytes;
        }
      }
    } finally { globalThis.ORTHROS_VB_LAZY = undefined; globalThis.ORTHROS_VB_CHECK = undefined; }
    assert.ok(bytes.true < bytes.false / 2, `bytes copied at draws ${bytes.true}, at Unlock ${bytes.false}`);
  });
}

test('pending buffer ranges: random writes and reads against a byte map — reads copy exactly the pending bytes they meet (merged ranges: at least)', () => {
  let s = 7; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; return ((s >>> 0) % n); };
  const link = new RenderLink({ words: new Int32Array(1 << 10), replayer: { reader: { consumed: 0 }, run() {} } });
  const LEN = 5000, copied = new Uint8Array(LEN);
  link.bufData = (b, start, size) => { for (let i = start; i < start + size; i++) { assert.equal(copied[i], 0, `byte ${i} copied twice by one read`); copied[i] = 1; } };
  const rr = {}, b = { length: LEN }, pending = new Uint8Array(LEN);
  for (let step = 0; step < 20000; step++) {
    const lo = rnd(LEN), hi = Math.min(LEN, lo + 1 + rnd(step % 7 === 0 ? LEN : 60));
    if (rnd(2)) { link.lazyAdd(rr, lo, hi); pending.fill(1, lo, hi); continue; }
    copied.fill(0);
    link.lazyTake(b, rr, lo, hi);
    for (let i = 0; i < LEN; i++) {
      if (i >= lo && i < hi) { if (pending[i]) assert.equal(copied[i], 1, `step ${step}: pending byte ${i} in [${lo}, ${hi}) not copied`); }
      else assert.equal(copied[i], 0, `step ${step}: byte ${i} outside [${lo}, ${hi}) copied`);
    }
    pending.fill(0, lo, hi);
    // (the ranges: sorted, disjoint, every pending byte inside one)
    const p = rr.lz;
    for (let i = 0; i + 2 < p.length; i += 2) assert.ok(p[i] < p[i + 1] && p[i + 1] < p[i + 2], `step ${step}: ranges ${p.slice(i, i + 4)}`);
    let k = 0; for (let i = 0; i < LEN; i++) { if (!pending[i]) continue; while (k < p.length && p[k + 1] <= i) k += 2; assert.ok(k < p.length && p[k] <= i, `step ${step}: pending byte ${i} in no range`); }
  }
  assert.equal(link.lazyN, rr.lz.length ? 1 : 0);
});
