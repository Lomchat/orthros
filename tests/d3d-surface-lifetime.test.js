// Direct3D 8/9 surface lifetimes (review of the keep-alive change): back buffers, the automatic depth-stencil surface
// and texture levels stay valid objects at the same address after their last Release while their owner lives, and are
// destroyed with it (Reset, the device's end, the texture's end); CreateDepthStencilSurface (D3D8) writes its 5th
// argument. Also Win32 path trimming edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { normalizeWin } from '../src/vfs/vfs.js';

function device(api9) {
  const E = d3dEnv(null), { mem, ctx, com } = E;
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  if (!api9) { mem.write32(pp + 20, 1); mem.write32(pp + 24, 0); mem.write32(pp + 28, 1); mem.write32(pp + 32, 1); mem.write32(pp + 36, 75); mem.write32(pp + 40, 0); }
  const d3dPtr = E.defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  const release = (p) => com.release(com.objectAt(p));
  return { E, mem, com, ctx, out, pp, devPtr, dev, call, release };
}

for (const api9 of [false, true]) {
  const v = api9 ? 'D3D9' : 'D3D8';
  test(`${v}: back buffer and auto depth-stencil kept at their address after the last Release, destroyed at Reset / device end`, () => {
    const { mem, com, out, pp, dev, devPtr, call, release } = device(api9);
    const bbArgs = api9 ? [0, 0, 0, out] : [0, 0, out];
    assert.equal(call('GetBackBuffer', ...bbArgs), 0);
    const bb = mem.read32(out), bbImpl = com.implAt(bb), bbMem = bbImpl.mem;
    assert.equal(release(bb), 0);
    assert.equal(com.implAt(bb), bbImpl, 'still the same object');
    assert.equal(bbImpl.mem, bbMem, 'its memory (allocated on first lock) not freed');
    assert.equal(call('GetBackBuffer', ...bbArgs), 0);
    assert.equal(mem.read32(out), bb, 'the same address again');
    assert.equal(com.objectAt(bb).refs, 1);
    release(bb);
    assert.equal(call('GetDepthStencilSurface', out), 0);
    const ds = mem.read32(out); release(ds);
    assert.ok(com.objectAt(ds), 'auto depth-stencil kept');
    // Reset: the old implicit surfaces without references go
    assert.equal(call('Reset', pp), 0);
    assert.equal(com.objectAt(bb), null, 'old back buffer destroyed at Reset');
    assert.equal(com.objectAt(ds), null, 'old depth-stencil destroyed at Reset');
    assert.equal(call('GetBackBuffer', ...bbArgs), 0);
    const bb2 = mem.read32(out); release(bb2);
    assert.ok(com.objectAt(bb2));
    // the device's end takes its implicit surfaces
    assert.equal(com.release(com.objectAt(devPtr)), 0);
    assert.equal(com.objectAt(bb2), null, 'back buffer destroyed with the device');
    void dev;
  });

  test(`${v}: texture levels kept while the texture lives, destroyed with it; a held level survives`, () => {
    const { mem, com, ctx, out, call, release } = device(api9);
    assert.equal(call('CreateTexture', 16, 16, 2, 0, 21, 1, out, 0), 0);
    const tex = mem.read32(out), t = com.implAt(tex);
    assert.equal(t.GetSurfaceLevel(ctx([tex, 0, out])), 0);
    const l0 = mem.read32(out);
    assert.equal(t.GetSurfaceLevel(ctx([tex, 1, out])), 0);
    const l1 = mem.read32(out);
    release(l0);
    assert.ok(com.objectAt(l0), 'released level kept');
    assert.equal(t.GetSurfaceLevel(ctx([tex, 0, out])), 0);
    assert.equal(mem.read32(out), l0, 'same address');
    release(l0);
    // l1 still referenced when the texture goes
    assert.equal(release(tex), 0);
    assert.equal(com.objectAt(l0), null, 'unreferenced level destroyed with the texture');
    assert.ok(com.objectAt(l1), 'a referenced level survives');
    assert.equal(release(l1), 0);
    assert.equal(com.objectAt(l1), null, 'then destroyed at its last Release');
  });
}

test('D3D8 CreateDepthStencilSurface(Width, Height, Format, MultiSample, ppSurface)', () => {
  const { mem, com, out, call } = device(false);
  const sentinel = out + 32; mem.write32(sentinel, 0x12345678);
  assert.equal(call('CreateDepthStencilSurface', 64, 32, 80, 0, out), 0);
  const s = com.implAt(mem.read32(out));
  assert.ok(s, 'surface written through the 5th argument');
  assert.deepEqual([s.width, s.height, s.fmt], [64, 32, 80]);
  assert.equal(com.objectAt(mem.read32(out)).refs, 1);
  // a released created depth-stencil surface has no owner: destroyed at once
  const p = mem.read32(out); com.release(com.objectAt(p));
  assert.equal(com.objectAt(p), null);
  assert.equal(mem.read32(sentinel), 0x12345678);
});

test('Win32 path trimming: only the last segment, not wildcards, not \\\\?\\ paths, dots handled', () => {
  assert.equal(normalizeWin('C:\\Game\\DATA\\MAPS\\x.IDE '), 'C:\\Game\\DATA\\MAPS\\x.IDE');
  assert.equal(normalizeWin('C:\\Game\\file.txt. . '), 'C:\\Game\\file.txt');
  assert.equal(normalizeWin('C:\\Game\\sub. \\file'), 'C:\\Game\\sub. \\file', 'an inner segment is kept');
  assert.equal(normalizeWin('C:\\Game\\*.'), 'C:\\Game\\*.', 'a wildcard pattern is kept');
  assert.equal(normalizeWin('C:\\Game\\sub\\..'), 'C:\\Game');
  assert.equal(normalizeWin('C:\\Game\\sub\\. '), 'C:\\Game\\sub');
  assert.equal(normalizeWin('C:\\Game\\ '), 'C:\\Game');
  assert.equal(normalizeWin('file. ', 'C:\\Game'), 'C:\\Game\\file');
  assert.equal(normalizeWin('\\\\?\\C:\\Game\\file. '), 'C:\\Game\\file. ', 'literal paths kept');
});
