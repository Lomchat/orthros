// IDirect3DSurface8/9::GetDesc on the dispatcher's fast path (runtime.js FID_SURF_DESC): a surface's COM object carries
// its description after it (d3d8.js Surface.ptrOf); the call is answered by copying it without leaving the translated
// code — the same 32 bytes as the JavaScript handler, for texture levels, cube faces, render targets, depth-stencil
// and plain surfaces of every kind, Direct3D 8 and 9 — while a null output pointer, a released object or an object
// without a description go to JavaScript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { COM_MARKER } from '../src/cpu/jit/runtime.js';
import { d3dEnv } from './d3d-random.js';

const CODE = 0x2000000, SLOT = 0x2001000, IDX = 9, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];

for (const api9 of [false, true]) {
  test(`${api9 ? 'D3D9' : 'D3D8'} GetDesc: the handler's description from the fast path, else JavaScript`, () => {
    const E = d3dEnv(null, false, null), { mem, ctx, com } = E;
    const out = E.alloc(64), pp = E.alloc(64);
    [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    if (!api9) { mem.write32(pp + 20, 1); mem.write32(pp + 24, 0); mem.write32(pp + 28, 1); mem.write32(pp + 32, 1); mem.write32(pp + 36, 75); mem.write32(pp + 40, 0); }
    const d3dPtr = E.defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
    assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
    const devPtr = mem.read32(out), dev = com.implAt(devPtr), call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
    const surfaces = [];
    const take = () => { const p = mem.read32(out); mem.write32(p + 4, COM_MARKER); surfaces.push(p); return p; }; // (the marker com.js writes)
    // texture levels of several formats, sizes, pools and usages
    for (const [w, h, fmt, usage, pool] of [[64, 32, 21, 0, 1], [256, 256, 0x31545844, 0, 1], [17, 9, 23, 0, 2], [128, 128, 25, 0x200, 0], [64, 64, 21, 1, 0]]) {
      assert.equal(call('CreateTexture', w, h, 0, usage, fmt, pool, out, 0), 0);
      const tex = mem.read32(out), t = com.implAt(tex);
      for (let l = 0; l < t.levels.length; l += 2) { assert.equal(t.GetSurfaceLevel(ctx([tex, l, out])), 0); take(); }
    }
    assert.equal(call('CreateCubeTexture', 32, 2, 0, 22, 1, out, 0), 0);
    { const cube = mem.read32(out); assert.equal(com.implAt(cube).GetCubeMapSurface(ctx([cube, 3, 1, out])), 0); take(); }
    assert.equal(call('GetBackBuffer', ...(api9 ? [0, 0, 0, out] : [0, 0, out])), 0); take();
    assert.equal(call('GetDepthStencilSurface', out), 0); take();
    if (api9) {
      assert.equal(call('CreateOffscreenPlainSurface', 40, 30, 22, 2, out, 0), 0); take();
      assert.equal(call('CreateRenderTarget', 50, 20, 21, 0, 0, 1, out, 0), 0); take();
    } else { assert.equal(call('CreateImageSurface', 40, 30, 22, out), 0); take(); }
    const dead = surfaces.pop(); // (one released below)
    // the JavaScript handler's descriptions
    const OUT = E.alloc(64), want = surfaces.map((p) => { mem.fill(OUT, 32, 0xee); assert.equal(com.implAt(p).GetDesc(ctx([p, OUT])), 0); return Array.from(mem.bytes(OUT, 32)); });
    // guest code: GetDesc(surface, out) for every surface into its own buffer, then a null output, then a released surface
    const outs = surfaces.map(() => E.alloc(32));
    const calls = [...surfaces.map((p, i) => [p, outs[i]]), [surfaces[1], 0], [dead, OUT]];
    mem.writeBytes(CODE, Uint8Array.from([...calls.flatMap(([s, o]) => [...push(o), ...push(s), 0xff, 0x15, ...le(SLOT)]), 0xf4]));
    mem.write32(dead + 4, 0); // (released: com.js clears the marker)
    for (const o of outs) mem.fill(o, 32, 0x77);
    const cpu = new CpuState(mem, THREAD_STATES_BASE);
    cpu.reset();
    const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
    jit.cpu = cpu;
    jit.markFast(IDX, `com.dll!IDirect3DSurface${api9 ? 9 : 8}::GetDesc`, true);
    mem.write32(SLOT, THUNK_BASE + IDX * THUNK_SIZE);
    cpu.eip = CODE; cpu.esp = 0x3f09000; cpu.eflags = F.RESERVED1 | F.IF;
    const toJs = [];
    let r;
    for (let n = 0; n < 40; n++) {
      r = jit.run({ maxInsns: 1e6 });
      if (r !== EXIT.THUNK) break;
      toJs.push([mem.read32(cpu.esp + 4), mem.read32(cpu.esp + 8)]);
      cpu.eip = mem.read32(cpu.esp); cpu.esp += 12; cpu.eax = 0;
    }
    assert.equal(r, EXIT.HALT);
    assert.equal(cpu.esp, 0x3f09000, 'stdcall returns');
    assert.deepEqual(toJs, [[surfaces[1], 0], [dead, OUT]], 'a null output and a released object go to JavaScript');
    surfaces.forEach((p, i) => assert.deepEqual(Array.from(mem.bytes(outs[i], 32)), want[i], `surface ${i}`));
    // switched off for a measurement (ORTHROS_D3DX_FAST_OFF): every call to JavaScript
    jit.setD3dxFast(false);
    assert.equal(mem.u8[0x7fd50000 + IDX], 0);
    jit.setD3dxFast(true);
  });
}
