// Partial texture uploads: a level whose change is confined to the rectangles locked since its last upload gets only
// that rectangle (as the Direct3D runtime uploads the dirty region of a managed texture); any other kind of change
// uploads the whole level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { d3dCore, FMT } from '../src/win32/d3d8.js';
import { WebGLDevice, surfaceToRgba } from '../src/gfx/d3d8-webgl.js';

const mem = new GuestMemory({ sizeBytes: 1 << 20 });
let heap = 0x10000;
const proc = { mem, vmem: { alloc: (n) => { const a = heap; heap += (n + 15) & ~15; return a; }, release() {} } };
const core = d3dCore({ mem, com: {} });
const c = { proc, retAddr: 0 };
const RECT = 0x100, OUT = 0x200;
const lock = (s, rect, flags = 0) => {
  if (rect) rect.forEach((v, i) => mem.write32(RECT + 4 * i, v));
  assert.equal(s.lock(c, OUT, rect ? RECT : 0, flags), 0);
  return mem.read32(OUT + 4);
};

test('the dirty rectangle is the union of the rectangles locked since the last upload', () => {
  const s = new core.Surface({}, null, FMT.A8R8G8B8, 64, 32, 0, 1, 0);
  lock(s, [4, 5, 10, 12]); s.unlock();
  assert.equal(s.dirty, true); assert.deepEqual(s.dirtyRect, [4, 5, 10, 12]);
  lock(s, [20, 1, 30, 6]); s.unlock();
  assert.deepEqual(s.dirtyRect, [4, 1, 30, 12], 'union');
  s.dirty = false; // (uploaded)
  assert.equal(s.dirtyRect, null);
  lock(s, [-5, 20, 100, 40]); s.unlock();
  assert.deepEqual(s.dirtyRect, [0, 20, 64, 32], 'clamped to the surface');
  lock(s, null); s.unlock();
  assert.equal(s.dirtyRect, null, 'a whole lock: the whole surface');
  lock(s, [1, 1, 2, 2]); s.unlock();
  assert.equal(s.dirtyRect, null, 'still the whole surface until uploaded');
  s.dirty = false;
  lock(s, [1, 1, 2, 2], 0x10); s.unlock();
  assert.equal(s.dirty, false, 'a read-only lock changes nothing');
  lock(s, [3, 3, 3, 9]); s.unlock();
  assert.equal(s.dirtyRect, null, 'an empty rectangle: the whole surface');
  s.dirty = false;
  lock(s, [1, 1, 2, 2]); s.unlock();
  s.dirty = true; // changed another way (a copy, D3DX...)
  assert.equal(s.dirtyRect, null);
  s.dirty = false;
  s.dirty = true; // (the other way first)
  lock(s, [1, 1, 2, 2]); s.unlock();
  assert.equal(s.dirtyRect, null, 'a rectangle locked after a whole change keeps the whole surface');
});

function recordingGl() {
  const calls = []; let next = 1;
  const s3tc = { COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1, COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2, COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3 };
  const rec = (name) => (...a) => calls.push([name, ...a.map((x) => (ArrayBuffer.isView(x) ? Uint8Array.from(x) : x))]);
  const base = {
    canvas: { width: 800, height: 600 }, drawingBufferWidth: 800, drawingBufferHeight: 600,
    TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
    createTexture: () => ({ id: next++ }), getParameter: (p) => (p === 0x8b4d ? 32 : 0),
    getExtension: (n) => (n === 'WEBGL_compressed_texture_s3tc' ? s3tc : null),
    texImage2D: rec('texImage2D'), texSubImage2D: rec('texSubImage2D'), compressedTexImage2D: rec('compressedTexImage2D'), compressedTexSubImage2D: rec('compressedTexSubImage2D'),
  };
  const gl = new Proxy(base, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return k.length; return () => ({}); } });
  return { gl, calls };
}
const backend = (gl) => new WebGLDevice(gl, { proc, pp: { width: 800, height: 600 }, backBuffers: [] }, {});

test('an A8R8G8B8 level locked in part: only the rectangle is converted and uploaded', () => {
  const R = recordingGl(), W = backend(R.gl);
  const s = new core.Surface({}, null, FMT.A8R8G8B8, 16, 8, 0, 1, 0);
  const base = lock(s, null); for (let i = 0; i < 16 * 8 * 4; i++) mem.u8[base + i] = i * 7; s.unlock();
  const tex = { id: 501, fmt: FMT.A8R8G8B8, levels: [s] };
  W.glTexture(tex);
  assert.equal(R.calls.at(-1)[0], 'texImage2D', 'first upload: the whole level');
  R.calls.length = 0;
  const p = lock(s, [3, 2, 9, 5]); // written through the pointer to the rectangle's corner
  assert.equal(p, base + 2 * s.pitch + 3 * 4);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6 * 4; x++) mem.u8[p + y * s.pitch + x] = 200 + x + y;
  s.unlock();
  W.glTexture(tex);
  assert.equal(R.calls.length, 1);
  const [name, , level, x, y, w, h, , , data] = R.calls[0];
  assert.deepEqual([name, level, x, y, w, h], ['texSubImage2D', 0, 3, 2, 6, 3]);
  const full = surfaceToRgba(mem, s.fmt, s.mem, 16, 8, s.pitch);
  const want = new Uint8Array(6 * 3 * 4);
  for (let r = 0; r < 3; r++) want.set(full.subarray(((2 + r) * 16 + 3) * 4, ((2 + r) * 16 + 9) * 4), r * 6 * 4);
  assert.deepEqual(data, want);
  assert.equal(s.dirty, false); assert.equal(s.dirtyRect, null);
  // changed another way: the whole level again
  R.calls.length = 0; s.dirty = true; W.glTexture(tex);
  assert.deepEqual(R.calls[0].slice(0, 7), ['texSubImage2D', 0x0de1, 0, 0, 0, 16, 8]);
});

test('a DXT1 level locked in part: whole blocks of the rectangle, packed rows', () => {
  const R = recordingGl(), W = backend(R.gl);
  const s = new core.Surface({}, null, FMT.DXT1, 16, 16, 0, 1, 0); // 4x4 blocks of 8 bytes, pitch 32
  const base = lock(s, null); for (let i = 0; i < 128; i++) mem.u8[base + i] = i; s.unlock();
  const tex = { id: 502, fmt: FMT.DXT1, levels: [s] };
  W.glTexture(tex);
  assert.equal(R.calls.at(-1)[0], 'compressedTexImage2D');
  R.calls.length = 0;
  lock(s, [5, 6, 9, 7]); s.unlock(); // blocks x 1..2, y 1
  W.glTexture(tex);
  const [name, , level, x, y, w, h, f, data] = R.calls[0];
  assert.deepEqual([name, level, x, y, w, h, f], ['compressedTexSubImage2D', 0, 4, 4, 8, 4, 0x83f1]);
  assert.deepEqual(data, Uint8Array.from({ length: 16 }, (_, i) => 32 + 8 + i));
  // a rectangle reaching the right edge of a level whose width is not a multiple of 4 ends at the edge
  const t = new core.Surface({}, null, FMT.DXT1, 12, 12, 0, 1, 0);
  lock(t, null); t.unlock(); W.glTexture({ id: 503, fmt: FMT.DXT1, levels: [t] });
  R.calls.length = 0; lock(t, [0, 0, 12, 3]); t.unlock(); W.glTexture({ id: 503, fmt: FMT.DXT1, levels: [t] });
  assert.deepEqual(R.calls[0].slice(2, 7), [0, 0, 0, 12, 4]);
});
