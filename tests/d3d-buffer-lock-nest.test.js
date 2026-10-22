// Direct3D 8/9 vertex and index buffer locks nest (unlike surface locks): a buffer already locked can be locked again,
// each Unlock ends the latest lock still open and writes its range back (gfx.bufferUpdated), the buffer stays locked
// until the last one. A game that leaves one lock of a dynamic buffer open (BFME 1.08's particles) must keep being
// able to lock it: before, every later Lock failed with D3DERR_INVALIDCALL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';

const INVALIDCALL = 0x8876086c, DISCARD = 0x2000, NOOVERWRITE = 0x1000, READONLY = 0x10;

function device(api9) {
  const E = d3dEnv(null), { mem, ctx, com } = E;
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  if (!api9) { mem.write32(pp + 20, 1); mem.write32(pp + 24, 0); mem.write32(pp + 28, 1); mem.write32(pp + 32, 1); mem.write32(pp + 36, 75); mem.write32(pp + 40, 0); }
  const d3dPtr = E.defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  // (what the backend is told: lockBuffer at each Lock, bufferUpdated at each Unlock that wrote)
  const seen = [];
  dev.gfx = { lockBuffer: (b, flags, off, size) => seen.push(['lock', off, size, flags]), bufferUpdated: (b, off, size) => seen.push(['updated', off, size]) };
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  return { E, mem, com, ctx, out, dev, call, seen };
}

for (const api9 of [false, true]) {
  const v = api9 ? 'D3D9' : 'D3D8';
  for (const kind of ['vertex', 'index']) {
    test(`${v}: ${kind} buffer locks nest; each Unlock ends the latest open lock and writes its range back`, () => {
      const { mem, com, ctx, out, call, seen } = device(api9);
      const create = kind === 'vertex' ? (api9 ? call('CreateVertexBuffer', 4000, 0x208, 0x142, 0, out, 0) : call('CreateVertexBuffer', 4000, 0x208, 0x142, 0, out))
        : (api9 ? call('CreateIndexBuffer', 4000, 0x208, 101, 0, out, 0) : call('CreateIndexBuffer', 4000, 0x208, 101, 0, out));
      assert.equal(create, 0);
      const bp = mem.read32(out), b = com.implAt(bp), p1 = out + 16, p2 = out + 20, p3 = out + 24;
      const lock = (off, size, pp, flags) => b.Lock(ctx([bp, off, size, pp, flags]));
      const unlock = () => b.Unlock(ctx([bp]));
      assert.equal(unlock(), INVALIDCALL, 'Unlock without a lock');
      // a lock left open (the game's DISCARD lock it never unlocks), then locks that come and go under it
      assert.equal(lock(0, 400, p1, DISCARD), 0);
      assert.equal(mem.read32(p1), b.mem);
      assert.equal(lock(400, 200, p2, NOOVERWRITE), 0, 'a second lock of a locked buffer succeeds');
      assert.equal(mem.read32(p2), b.mem + 400);
      assert.equal(unlock(), 0);
      assert.equal(b.locked, true, 'still locked: the first lock is open');
      assert.equal(lock(600, 0, p3, NOOVERWRITE), 0, 'size 0: the rest of the buffer');
      assert.equal(mem.read32(p3), b.mem + 600);
      assert.equal(lock(1000, 100, p2, READONLY), 0);
      assert.equal(unlock(), 0); // (the read-only one: nothing written back)
      assert.equal(unlock(), 0);
      assert.equal(b.locked, true);
      assert.equal(unlock(), 0, 'the first lock ends last');
      assert.equal(b.locked, false);
      assert.equal(unlock(), INVALIDCALL, 'no lock open any more');
      assert.deepEqual(seen, [
        ['lock', 0, 400, DISCARD], ['lock', 400, 200, NOOVERWRITE], ['updated', 400, 200],
        ['lock', 600, 0, NOOVERWRITE], ['lock', 1000, 100, READONLY], ['updated', 600, 3400], ['updated', 0, 400],
      ]);
      // still refused: no pointer, an offset past the end
      assert.equal(lock(0, 0, 0, 0), INVALIDCALL);
      assert.equal(lock(4001, 0, p1, 0), INVALIDCALL);
      assert.equal(b.locked, false);
    });
  }
}
