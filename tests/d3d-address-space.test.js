// Direct3D resources and the guest address space (docs/address-space.md; Age of the Ring crash of 2026-11-10): small
// surfaces share a heap instead of a 64 KiB reservation each, and a lock that finds no memory fails instead of handing
// out pBits = 0 — the program then wrote a texture's texels from address 0 up, over the process heap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { VMem } from '../src/win32/vmem.js';

const DXT1 = 0x31545844, A1R5G5B5 = 25, MANAGED = 1, E_OUTOFMEMORY = 0x8007000e;

test('D3D9: mip levels share the resource heap; a lock out of address space fails with E_OUTOFMEMORY, nothing written at 0', () => {
  const E = d3dEnv(null), { mem, ctx, com } = E;
  // a real address space of 48 MiB: the bottom 16 MiB are the test's own scratch (d3dEnv's allocator)
  const vmem = new VMem(48 << 20);
  assert.ok(vmem.reserve((16 << 20) - 0x10000, 0x10000, 'test scratch'));
  E.proc.vmem = vmem;
  const out = E.alloc(64), pp = E.alloc(64), lr = E.alloc(16);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  // 400 64x64 DXT1 textures with their 7 levels: one 64 KiB reservation per level took 175 MiB — more than there is
  const ranges = [];
  for (let i = 0; i < 400; i++) {
    assert.equal(dev.CreateTexture(ctx([devPtr, 64, 64, 0, 0, DXT1, MANAGED, out, 0])), 0);
    const tex = mem.read32(out), t = com.implAt(tex);
    for (let l = 0; l < 7; l++) {
      assert.equal(t.LockRect(ctx([tex, l, lr, 0, 0])), 0, `texture ${i} level ${l} locked`);
      const bits = mem.read32(lr + 4);
      assert.equal(bits % 16, 0, 'pBits 16-byte aligned');
      ranges.push([bits, bits + t.levels[l].bytes]);
      assert.equal(t.UnlockRect(ctx([tex, l])), 0);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] >= ranges[i - 1][1], 'levels do not overlap');
  assert.ok(vmem.reservedBytes() < (16 << 20) + (2 << 20), `resources reserved ${(vmem.reservedBytes() >> 10) - (16 << 10)} KiB`);
  // the address space full: a 1024x1024 A1R5G5B5 texture (2 MiB) gets no memory at its first lock
  while (vmem.reserve(0x10000));
  mem.fill(0, 0x10000, 0);
  assert.equal(dev.CreateTexture(ctx([devPtr, 1024, 1024, 1, 0, A1R5G5B5, MANAGED, out, 0])), 0);
  const big = mem.read32(out);
  mem.write32(lr, 0x11111111); mem.write32(lr + 4, 0x22222222);
  assert.equal(com.implAt(big).LockRect(ctx([big, 0, lr, 0, 0])) >>> 0, E_OUTOFMEMORY);
  assert.equal(mem.read32(lr + 4), 0x22222222, 'no pBits written');
  assert.ok(mem.bytes(0, 0x10000).every((b) => b === 0), 'nothing written at the bottom of the address space');
});
