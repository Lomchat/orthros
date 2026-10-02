// Randomized Direct3D 8/9 sessions for the render worker tests: a minimal VM (guest memory, allocator, COM objects)
// and a reproducible sequence of state changes, resource work (locks, copies, fills, readbacks), draws and presents.
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { registerDirect3D9 } from '../src/win32/d3d9.js';
import { registerDirect3D8 } from '../src/win32/d3d8.js';

/** A minimal VM for Direct3D: guest memory, allocator, COM objects (pointers reused once released), a call context. */
export function d3dEnv(gfx, shared = false) {
  const mem = new GuestMemory({ sizeBytes: 64 << 20, shared });
  let top = 0x100000; const freed = new Map(); // size -> addresses (reused: memory recycled like a real heap)
  const alloc = (n) => { n = (Math.max(n, 16) + 15) & ~15; const l = freed.get(n); if (l?.length) return l.pop(); const a = top; top += n; if (top > (60 << 20)) throw new Error('test heap full'); return a; };
  const sizes = new Map();
  const vmem = { alloc: (n) => { const a = alloc(n); sizes.set(a, (Math.max(n, 16) + 15) & ~15); return a; }, release: (a) => { const n = sizes.get(a); if (!n) throw new Error(`release of ${a.toString(16)}: not allocated`); sizes.delete(a); mem.fill(a, n, 0xcd); (freed.get(n) ?? freed.set(n, []).get(n)).push(a); } };
  const proc = { mem, vmem, processHeap: { alloc: (n) => vmem.alloc(n), free_: (p) => vmem.release(p) }, symbolize: () => '?' };
  const objects = new Map();
  const com = {
    objects, interface() {}, supports: () => true,
    create(p, iface, impl) { const ptr = proc.processHeap.alloc(16); const obj = { ptr, impl, refs: 1, proc: p }; objects.set(ptr, obj); impl.comObject = obj; return ptr; },
    objectAt: (ptr) => objects.get(ptr >>> 0) ?? null, implAt: (ptr) => objects.get(ptr >>> 0)?.impl ?? null,
    addRef: (o) => ++o.refs,
    release(o) { if (--o.refs > 0) return o.refs; if (o.impl.keepAlive) { o.refs = 0; return 0; } com.dispose(o); return 0; },
    unpin(impl) { const o = impl?.comObject; if (o && objects.get(o.ptr) === o && o.refs <= 0) com.dispose(o); },
    dispose(o) { objects.delete(o.ptr); try { o.impl.destroy?.(o); } finally { proc.processHeap.free_(o.ptr); } },
  };
  const vm = { mem, com, proc, host: { gfx }, log() {}, clock: { now: () => 0 }, recentApiCalls: () => [], startApiBurst() {} };
  const defs = {};
  const api = { define(dll, d) { Object.assign(defs, d); } };
  registerDirect3D8(api, vm); registerDirect3D9(api, vm);
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const ctx = (args) => ({ args, proc, thread: { id: 1 }, retAddr: 0, arg(i) { return (this.args[i] ?? 0) >>> 0; }, sarg(i) { return (this.args[i] ?? 0) | 0; }, argF32(i) { u32[0] = this.args[i] ?? 0; return f32[0]; }, out32(i, v) { const a = this.arg(i); if (a) mem.write32(a, v >>> 0); } });
  return { mem, proc, com, vm, defs, ctx, alloc: vmem.alloc };
}

/**
 * Drive one device with a random but reproducible sequence of state changes, resource work and draws. `after(dev)`
 * is called after every draw and present.
 */
export function randomSession(gfx, seed, api9, after, shared = false) {
  const E = d3dEnv(gfx, shared), { mem, ctx, com } = E;
  let s = seed; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; return ((s >>> 0) % n); };
  const pick = (a) => a[rnd(a.length)];
  const scratch = E.alloc(4096), out = E.alloc(64);
  const words = (list) => { list.forEach((v, i) => mem.write32(scratch + 4 * i, v)); return scratch; };
  const floats = (n) => { for (let i = 0; i < n; i++) mem.writeF32(scratch + 4 * i, rnd(5) === 0 ? 0 : (rnd(2001) - 1000) / 37); return scratch; };
  const pp = E.alloc(64); [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  if (!api9) { mem.write32(pp + 20, 1); mem.write32(pp + 24, 0); mem.write32(pp + 28, 1); mem.write32(pp + 32, 1); mem.write32(pp + 36, 75); mem.write32(pp + 40, 0); }
  const d3dPtr = E.defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
  const d3d = com.implAt(d3dPtr);
  assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  const textures = [], buffers = [], ibs = [], decls = [], shaders = [], blocks = [];
  const vsCode = words([0xfffe0200, 0x0000ffff]).valueOf(); void vsCode;
  const RS = [7, 8, 9, 14, 15, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 34, 35, 36, 37, 38, 52, 53, 56, 57, 58, 59, 60, 137, 139, 140, 141, 143, 145, 146, 147, 148, 151, 152, 154, 168, 171, 174, 175, 185, 186, 189, 193, 195, 206, 207, 208, 209, 300, 70000];
  const value = () => pick([0, 1, 2, 3, 4, 5, 8, 15, 0xff, 0xffffffff, 0x3f800000, 0x80000000, rnd(1 << 30)]);
  const createTexture = () => {
    const kind = api9 ? rnd(6) : 0, fmt = pick([21, 22, 23, 25, 26, 28, 50, 0x31545844, 0x35545844]), w = pick([8, 16, 32]), h = pick([8, 16, 32]), levels = rnd(3), pool = pick([0, 1, 2]);
    let r;
    if (kind === 4) r = call('CreateCubeTexture', w, levels, 0, fmt, pool, out);
    else if (kind === 5 && fmt < 100) r = call('CreateVolumeTexture', w, h, 4, levels, 0, fmt, pool, out);
    else r = call('CreateTexture', w, h, levels, rnd(4) === 0 ? 1 : 0, fmt, pool, out);
    if (r === 0) textures.push(mem.read32(out));
  };
  const lockTexture = () => {
    if (!textures.length) return;
    const p = pick(textures), t = com.implAt(p);
    if (!t || !(t.levels || t.faces)) return; // (a state block's texture is not reference-counted: it may be gone)
    if (t.depth) { const lvl = rnd(t.levels.length); if (t.LockBox(ctx([p, lvl, out, 0, 0])) !== 0) return; const a = mem.read32(out + 8); for (let i = 0; i < Math.min(64, t.levels[lvl].bytes); i++) mem.u8[a + i] = rnd(256); t.UnlockBox(ctx([p, lvl])); return; }
    const face = t.faces ? rnd(6) : -1, list = t.faces ? t.faces[face] : t.levels, lvl = rnd(list.length), l = list[lvl];
    const rect = rnd(3) === 0 ? 0 : words([rnd(l.width), rnd(l.height), rnd(l.width + 1), rnd(l.height + 1)]);
    const flags = pick([0, 0, 0x10, 0x2000]);
    const args = t.faces ? [p, face, lvl, out, rect, flags] : [p, lvl, out, rect, flags];
    if (t.LockRect(ctx(args)) !== 0) return;
    const a = mem.read32(out + 4), room = l.mem + l.bytes - a; // (never past the level's memory)
    if (!(flags & 0x10)) for (let i = 0; i < Math.min(48, room); i++) mem.u8[a + i] = rnd(256);
    t.UnlockRect(ctx(t.faces ? [p, face, lvl] : [p, lvl]));
  };
  const createBuffer = (ib) => {
    const len = pick([256, 1024, 4096]), usage = pick([0, 0x200, 0x208]);
    const r = ib ? call('CreateIndexBuffer', len, usage, pick([101, 102]), pick([0, 1]), out) : call('CreateVertexBuffer', len, usage, 0x142, pick([0, 1]), out);
    if (r !== 0) return;
    const ptr = mem.read32(out); (ib ? ibs : buffers).push(ptr);
    fillBuffer(ptr, 0);
  };
  // (as an application uses a dynamic buffer: DISCARD, then NOOVERWRITE appends after what it wrote — never over
  // data a draw may still use; plain locks anywhere)
  const fillBuffer = (ptr, flags) => {
    const b = com.implAt(ptr); if (!b) return;
    let off = rnd(4) === 0 ? 4 * rnd(b.length / 8) : 0, size = rnd(3) === 0 ? 0 : 4 * (1 + rnd((b.length - off) / 4));
    if (flags & 0x1000) { off = b.appendPos ?? b.length; size = 4 * (1 + rnd(16)); if (off + size > b.length) { flags = 0x2000; off = 0; } }
    if (flags & 0x2000) { size = size || b.length; off = 0; }
    if (!(flags & 0x10)) b.appendPos = flags & 0x2000 || flags & 0x1000 ? off + (size || b.length - off) : b.length;
    if (b.Lock(ctx([ptr, off, size, out, flags])) !== 0) return;
    const a = mem.read32(out), n = size || b.length - off;
    if (!(flags & 0x10)) for (let i = 0; i < n; i += 4) mem.writeF32(a + i, b.type === 7 ? 0 : (rnd(200) - 100) / 10);
    if (b.type === 7 && !(flags & 0x10)) for (let i = 0; i < n; i += 2) mem.write16(a + i, rnd(8));
    b.Unlock(ctx([ptr]));
  };
  const release = (list) => { if (!list.length) return; const i = rnd(list.length), ptr = list[i]; list.splice(i, 1); const o = com.objectAt(ptr); if (o) com.release(o); };
  const draw = () => {
    const k = rnd(5);
    if (k === 0) call('DrawPrimitive', pick([1, 2, 3, 4, 5, 6]), rnd(4), 1 + rnd(5));
    else if (k === 1) { if (api9) call('DrawIndexedPrimitive', 4, rnd(3) - 1, 0, 8, rnd(4), 1 + rnd(3)); else call('DrawIndexedPrimitive', 4, 0, 8, rnd(4), 1 + rnd(3)); }
    else if (k === 2) { const p = floats(64); call('DrawPrimitiveUP', pick([4, 5]), 1 + rnd(3), p, 24); }
    else if (k === 3) { const v = floats(96), ix = E.alloc(64); for (let i = 0; i < 12; i++) mem.write16(ix + 2 * i, rnd(6)); call('DrawIndexedPrimitiveUP', 4, 0, 6, 2, ix, 101, v, 24); }
    else call('Clear', rnd(2), rnd(2) ? words([1, 2, 30, 40, 5, 5, 9, 9]) : 0, 1 + rnd(7), rnd(1 << 30), u32of(rnd(100) / 100), rnd(256));
    after(dev);
  };
  // surface copies, fills, readbacks, gamma (the paths that read or write resource memory outside locks)
  const surfaces = [];
  const surfaceWork = () => {
    const k = rnd(9);
    if (k === 0 || surfaces.length < 2) { // a lockable plain surface, or a render target
      const rt = rnd(2) === 0, w = pick([8, 16]), h = pick([8, 16]);
      const r = api9 ? (rt ? call('CreateRenderTarget', w, h, 21, 0, 0, rnd(2), out) : call('CreateOffscreenPlainSurface', w, h, 21, pick([0, 2]), out)) : (rt ? call('CreateRenderTarget', w, h, 21, 0, rnd(2), out) : call('CreateImageSurface', w, h, 21, out));
      if (r === 0) surfaces.push(mem.read32(out));
      return;
    }
    const sp = pick(surfaces), sf = com.implAt(sp); if (!sf) return;
    const level0 = () => { const t = textures.length ? com.implAt(pick(textures)) : null; return t?.levels?.[0]?.fmt === 21 && t.levels[0].width ? t.levels[0] : null; };
    switch (k) {
      case 1: if (sf.LockRect(ctx([sp, out, 0, pick([0, 0x10])])) === 0) { const a = mem.read32(out + 4); for (let i = 0; i < Math.min(32, sf.bytes); i++) mem.u8[a + i] = rnd(256); sf.UnlockRect(ctx([sp])); } break;
      case 2: { const l = level0(); if (!l) break; const dp = l.ptrOf(ctx([])); if (api9) call('UpdateSurface', sp, 0, dp, 0); else call('CopyRects', sp, 0, 0, dp, 0); break; }
      case 3: if (api9) { const d2 = pick(surfaces); call('StretchRect', sp, rnd(2) ? words([0, 0, 4, 4]) : 0, d2, 0, rnd(3)); } else { const d2 = pick(surfaces); call('CopyRects', sp, words([0, 0, 4, 4]), 1, d2, words([1, 1])); } break;
      case 4: if (api9) call('ColorFill', sp, rnd(2) ? words([0, 0, 4, 4]) : 0, rnd(1 << 30)); break;
      case 5: if (api9) { const d2 = pick(surfaces); call('GetRenderTargetData', dev.backBuffers[0].ptrOf(ctx([])), d2); } else call('GetFrontBuffer', sp); break;
      case 6: { const ramp = E.alloc(1536); for (let i = 0; i < 768; i++) mem.write16(ramp + 2 * i, rnd(2) ? (i % 256) * 257 : (i % 256) * 128); if (api9) call('SetGammaRamp', 0, 0, ramp); else call('SetGammaRamp', 0, ramp); break; }
      case 7: if (textures.length > 1) { const a = com.implAt(pick(textures)), b = com.implAt(pick(textures)); if (a?.levels && b?.levels && a !== b) call('UpdateTexture', a.comObject.ptr, b.comObject.ptr); } break;
      case 8: { const t = textures.length ? com.implAt(pick(textures)) : null; if (t?.levels && !t.depth) t.AddDirtyRect(ctx([])); else if (surfaces.length > 4) release(surfaces); break; }
    }
  };
  // (a vertex buffer on stream 0 from the start: the backend's first-draw diagnostics read it)
  createBuffer(false); if (api9) { call('SetStreamSource', 0, buffers[0], 0, 24); call('SetFVF', 0x142); } else { call('SetStreamSource', 0, buffers[0], 24); call('SetVertexShader', 0x142); }
  for (let step = 0; step < 2000; step++) {
    const k = rnd(40);
    switch (k) {
      case 0: case 1: case 2: call('SetRenderState', pick(RS), value()); break;
      case 3: case 4: call('SetTextureStageState', rnd(8), 1 + rnd(32), value()); break;
      case 5: if (api9) call('SetSamplerState', pick([0, 1, 2, 3, 15, 256, 257]), 1 + rnd(13), value()); else call('SetTextureStageState', rnd(8), 13 + rnd(16), value()); break;
      case 6: call('SetTransform', pick([2, 3, 16, 17, 23, 256, 257, 259]), floats(16)); break;
      case 7: if (rnd(3) === 0) call('MultiplyTransform', pick([2, 256]), floats(16)); else call('SetTransform', 256, floats(16)); break;
      case 8: { const p = floats(26); mem.write32(p, 1 + rnd(3)); call('SetLight', rnd(10), p); break; }
      case 9: call('LightEnable', rnd(10), rnd(2)); break;
      case 10: call('SetMaterial', floats(17)); break;
      case 11: call('SetViewport', words([rnd(50), rnd(50), 10 + rnd(300), 10 + rnd(200), u32of(rnd(2) / 2), u32of(1)])); break;
      case 12: if (api9) call('SetScissorRect', words([rnd(20), rnd(20), 50 + rnd(300), 50 + rnd(200)])); break;
      case 13: if (api9) call('SetFVF', pick([0x142, 0x152, 0x44, 0x102, 0x112])); else call('SetVertexShader', pick([0x142, 0x152, 0x44, 0x102, 0x112, ...shaders])); break;
      case 14: if (api9) { const elems = words([0 | (0 << 16), 2 | (0 << 8) | (0 << 16), 0 | (12 << 16), 4 | (10 << 16), 0 | (16 << 16), 1 | (5 << 16), 0xff, 17]); if (call('CreateVertexDeclaration', elems, out) === 0) decls.push(mem.read32(out)); } break;
      case 15: if (api9 && decls.length) call('SetVertexDeclaration', rnd(4) === 0 ? 0 : pick(decls)); break;
      case 16: {
        if (api9) { const vs = rnd(2) === 0, code = words([vs ? 0xfffe0200 : 0xffff0200, 0x0000ffff]); if (call(vs ? 'CreateVertexShader' : 'CreatePixelShader', code, out) === 0) shaders.push(mem.read32(out)); }
        else { const vs = rnd(2) === 0; if (vs) { const decl = E.alloc(64); [0x20000000, 0x40020000, 0xffffffff].forEach((v, i) => mem.write32(decl + 4 * i, v)); if (call('CreateVertexShader', decl, words([0xfffe0101, 0x0000ffff]), out, 0) === 0) shaders.push(mem.read32(out)); } else if (call('CreatePixelShader', words([0xffff0101, 0x0000ffff]), out) === 0) shaders.push(-mem.read32(out)); }
        break;
      }
      case 17: if (shaders.length) { const sh = pick(shaders); if (api9) { const o = com.implAt(sh); if (o) call(o.kind === 'vs' ? 'SetVertexShader' : 'SetPixelShader', rnd(4) === 0 ? 0 : sh); } else if (sh < 0) call('SetPixelShader', rnd(4) === 0 ? 0 : -sh); else call('SetVertexShader', sh); } break;
      case 18: if (shaders.length && rnd(3) === 0) { if (api9) release(shaders); else { const i = rnd(shaders.length), h = shaders[i]; shaders.splice(i, 1); call(h < 0 ? 'DeletePixelShader' : 'DeleteVertexShader', Math.abs(h)); } } break;
      case 19: { const n = 1 + rnd(4), reg = rnd(api9 ? 200 : 90); floats(4 * n); call(api9 ? 'SetVertexShaderConstantF' : 'SetVertexShaderConstant', reg, scratch, n); break; }
      case 20: { const n = 1 + rnd(3), reg = rnd(api9 ? 28 : 6); floats(4 * n); call(api9 ? 'SetPixelShaderConstantF' : 'SetPixelShaderConstant', reg, scratch, n); break; }
      case 21: if (api9) { const n = 1 + rnd(3); words(Array.from({ length: 4 * n }, () => rnd(9) - 4)); call(pick(['SetVertexShaderConstantI', 'SetPixelShaderConstantI', 'SetVertexShaderConstantB', 'SetPixelShaderConstantB']), rnd(12), scratch, n); } break;
      case 22: if (rnd(2)) createTexture(); else lockTexture(); break;
      case 23: if (textures.length && com.implAt(textures.at(-1))?.fmt) call('SetTexture', api9 ? pick([0, 1, 2, 7, 15, 257]) : rnd(8), rnd(5) === 0 ? 0 : pick(textures)); break;
      case 24: if (rnd(3) === 0) release(textures); else lockTexture(); break;
      case 25: if (buffers.length < 6) createBuffer(false); else if (ibs.length < 4) createBuffer(true); else release(rnd(2) ? buffers : ibs); break;
      case 26: if (buffers.length) { const st = rnd(3), vb = rnd(5) === 0 ? 0 : pick(buffers); if (api9) call('SetStreamSource', st, vb, 4 * rnd(8), pick([24, 28, 32])); else call('SetStreamSource', st, vb, pick([24, 28, 32])); } break;
      case 27: if (ibs.length) { if (api9) call('SetIndices', rnd(5) === 0 ? 0 : pick(ibs)); else call('SetIndices', rnd(5) === 0 ? 0 : pick(ibs), rnd(5)); } break;
      case 28: { const all = [...buffers, ...ibs]; if (all.length) fillBuffer(pick(all), pick([0, 0x2000, 0x2000, 0x1000, 0x10])); break; }
      case 29: if (rnd(2)) { if (call('BeginStateBlock') === 0) { for (let i = 0; i < 4; i++) call('SetRenderState', pick(RS), value()); call('SetTextureStageState', rnd(8), 1 + rnd(32), value()); call('SetTransform', 256, floats(16)); if (api9) call('SetSamplerState', rnd(4), 1 + rnd(13), value()); call('EndStateBlock', out); blocks.push(api9 ? mem.read32(out) : mem.read32(out)); } } else if (call('CreateStateBlock', 1 + rnd(2), out) === 0) blocks.push(mem.read32(out)); break; // (no textures in state blocks: Direct3D layer does not reference-count them)
      case 30: if (blocks.length) { const b = pick(blocks); if (api9) { const o = com.implAt(b); if (o) (rnd(3) ? o.Apply : o.Capture).call(o, ctx([b])); } else call(rnd(3) ? 'ApplyStateBlock' : 'CaptureStateBlock', b); } break;
      case 31: if (rnd(4) === 0 && textures.length) { const t = com.implAt(pick(textures)); if (t?.levels && t.usage & 1 && t.levels[0].width) { const sf = t.levels[0].ptrOf(ctx([])); if (api9) call('SetRenderTarget', 0, sf); else call('SetRenderTarget', sf, 0); } } else if (rnd(3) === 0) { const bb = dev.backBuffers[0].ptrOf(ctx([])); if (api9) call('SetRenderTarget', 0, bb); else call('SetRenderTarget', bb, 0); } break;
      case 32: if (rnd(12) === 0) { assert.equal(call('Reset', pp), 0); } break;
      case 33: if (api9 && textures.length) { // effect-like direct constant writes (d3dx9-effect.js setConsts)
        const o = 4 * rnd(250), n = 4 * (1 + rnd(2)); for (let i = 0; i < n; i++) dev.vsConst[o + i] = rnd(100) / 3; dev.gfx?.constTouched?.(0, o, o + n); dev.constVersion++;
      } break;
      case 34: call('BeginScene'); break;
      case 35: call('EndScene'); break;
      case 36: case 37: case 38: draw(); break;
      case 39: if (rnd(3)) { call('Present', 0, 0, 0, 0); after(dev); } else surfaceWork(); break;
    }
  }
  call('Present', 0, 0, 0, 0); after(dev);
  return dev;
}
const u32of = (v) => { const f = new Float32Array([v]); return new Uint32Array(f.buffer)[0]; };
