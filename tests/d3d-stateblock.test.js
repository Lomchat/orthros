// Direct3D state blocks (src/win32/d3d-stateblock.js). Direct3D 9's CreateStateBlock answered D3DERR_INVALIDCALL for
// every type (its wrapper gave the Direct3D 8 method no output pointer); Direct3D 8's took D3DSBT_VERTEXSTATE (3) for
// "everything" and D3DSBT_ALL (1) for pixel state without transforms. A recorded block applied the states set while it
// recorded only for some setters (transforms, streams, lights... were applied to the device at once and never recorded),
// and a block's textures were bound without a reference: a texture the game released came back as a dangling pointer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';

const INVALIDCALL = 0x8876086c, ALL = 1, PIXEL = 2, VERTEX = 3;
const RS_ZENABLE = 7, RS_ALPHABLENDENABLE = 27, RS_LIGHTING = 137, TSS_ADDRESSU8 = 13;

function device(api9) {
  const E = d3dEnv(null), { mem, ctx, com, defs, alloc } = E;
  const pp = alloc(64), out = alloc(16), scratch = alloc(256);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  if (!api9) [[20, 1], [24, 0], [28, 1], [32, 1], [36, 75], [40, 0]].forEach(([o, v]) => mem.write32(pp + o, v)); // (D3DPRESENT_PARAMETERS of Direct3D 8)
  const d3dPtr = defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220])), d3d = com.implAt(d3dPtr);
  assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
  const make = (name, ...args) => { assert.equal(call(name, ...args, out), 0, name); return mem.read32(out); };
  const words = (list, at = scratch) => { list.forEach((v, i) => mem.write32(at + 4 * i, v)); return at; };
  const floats = (list, at = scratch) => { list.forEach((v, i) => mem.writeF32(at + 4 * i, v)); return at; };
  const block = (ptr, m) => { const o = com.implAt(ptr); return o[m](ctx([ptr])); }; // (IDirect3DStateBlock9::Apply / Capture)
  return { E, mem, com, dev, call, make, words, floats, block, out };
}

test('Direct3D 9 CreateStateBlock: each type holds its documented states and references what it holds', () => {
  const { com, dev, call, make, words, floats, block, mem, out } = device(true);
  const tex = make('CreateTexture', 8, 8, 1, 0, 21, 1);
  const vs = make('CreateVertexShader', words([0xfffe0200, 0x0000ffff])), ps = make('CreatePixelShader', words([0xffff0200, 0x0000ffff]));
  const vp = () => [dev.viewport.x, dev.viewport.y, dev.viewport.w, dev.viewport.h];
  // the state the blocks capture
  call('SetRenderState', RS_ALPHABLENDENABLE, 1); call('SetRenderState', RS_LIGHTING, 0);
  call('SetTexture', 0, tex); call('SetVertexShader', vs); call('SetPixelShader', ps);
  call('SetViewport', words([10, 20, 100, 50])); mem.writeF32(0, 0);
  call('SetTransform', 2, floats([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]));
  const blocks = {};
  for (const [name, type] of Object.entries({ ALL, PIXEL, VERTEX })) blocks[name] = make('CreateStateBlock', type);
  assert.equal(call('CreateStateBlock', 4, out), INVALIDCALL, 'not a state block type');
  // everything changed; the game releases its texture (the blocks keep it alive)
  const change = () => {
    call('SetRenderState', RS_ALPHABLENDENABLE, 0); call('SetRenderState', RS_LIGHTING, 1);
    call('SetTexture', 0, 0); call('SetVertexShader', 0); call('SetPixelShader', 0);
    call('SetViewport', words([0, 0, 320, 240])); call('SetTransform', 2, floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  };
  change();
  com.release(com.objectAt(tex));
  assert.ok(com.objectAt(tex), 'held by the blocks');
  const state = () => ({ blend: dev.rs.get(RS_ALPHABLENDENABLE), lighting: dev.rs.get(RS_LIGHTING), tex: dev.textures[0], vs: dev.vsObj?.ptr ?? 0, ps: dev.psObj?.ptr ?? 0, vp: vp().join(), view: dev.transforms.get(2)?.[0] });
  assert.equal(block(blocks.PIXEL, 'Apply'), 0);
  assert.deepEqual(state(), { blend: 1, lighting: 1, tex: 0, vs: 0, ps, vp: '0,0,320,240', view: 1 }, 'pixel state: blending and the pixel shader, not lighting nor the vertex shader');
  change();
  assert.equal(block(blocks.VERTEX, 'Apply'), 0);
  assert.deepEqual(state(), { blend: 0, lighting: 0, tex: 0, vs, ps: 0, vp: '0,0,320,240', view: 1 }, 'vertex state: lighting and the vertex shader');
  change();
  assert.equal(block(blocks.ALL, 'Apply'), 0);
  assert.deepEqual(state(), { blend: 1, lighting: 0, tex, vs, ps, vp: '10,20,100,50', view: 2 }, 'all of it: textures, viewport, transforms too');
  // the references: the device's binding and the three blocks'; released with them
  assert.equal(com.objectAt(tex).refs, 2, 'bound (1) and held by the ALL block (1)');
  for (const b of Object.values(blocks)) com.release(com.objectAt(b));
  call('SetTexture', 0, 0);
  assert.equal(com.objectAt(tex), null, 'the last reference gone with the blocks');
});

test('recorded state blocks: the device keeps its state while recording; Apply and Capture touch only the recorded states', () => {
  const { com, dev, call, make, words, floats, block, out } = device(true);
  const vb = make('CreateVertexBuffer', 256, 0, 0, 1);
  const mat = [3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1];
  const other = make('CreateStateBlock', PIXEL);
  assert.equal(call('BeginStateBlock'), 0);
  call('SetRenderState', RS_ZENABLE, 0); call('SetTransform', 256, floats(mat)); call('SetStreamSource', 0, vb, 16, 32);
  call('LightEnable', 3, 1); call('SetVertexShaderConstantF', 4, floats([1, 2, 3, 4]), 1);
  assert.equal(block(other, 'Apply'), INVALIDCALL, 'no Apply while recording');
  assert.equal(block(other, 'Capture'), INVALIDCALL, 'no Capture while recording');
  const sb = make('EndStateBlock');
  assert.equal(dev.rs.get(RS_ZENABLE), 1, 'nothing applied while recording');
  assert.equal(dev.transforms.get(256), undefined); assert.equal(dev.streams[0].vb, 0); assert.equal(dev.lightEnabled.has(3), false); assert.equal(dev.vsConst[16], 0);
  assert.equal(com.objectAt(vb).refs, 2, 'the block holds the buffer it recorded');
  assert.equal(block(sb, 'Apply'), 0);
  assert.equal(dev.rs.get(RS_ZENABLE), 0);
  assert.deepEqual([...dev.transforms.get(256)], mat);
  assert.deepEqual([dev.streams[0].vb, dev.streams[0].offset, dev.streams[0].stride], [vb, 16, 32]);
  assert.equal(com.objectAt(vb).refs, 3, 'bound by Apply with a reference of its own');
  assert.equal(dev.lightEnabled.has(3), true); assert.deepEqual([...dev.vsConst.subarray(16, 20)], [1, 2, 3, 4]);
  // Capture reads back the recorded states only
  call('SetRenderState', RS_ZENABLE, 1); call('SetRenderState', RS_ALPHABLENDENABLE, 1);
  assert.equal(block(sb, 'Capture'), 0);
  call('SetRenderState', RS_ZENABLE, 0); call('SetRenderState', RS_ALPHABLENDENABLE, 0);
  assert.equal(block(sb, 'Apply'), 0);
  assert.equal(dev.rs.get(RS_ZENABLE), 1, 'captured');
  assert.equal(dev.rs.get(RS_ALPHABLENDENABLE), 0, 'not in the block: left alone');
  void words; void out;
});

test('Direct3D 8 CreateStateBlock tokens: D3DSBT_PIXELSTATE holds the pixel states, D3DSBT_VERTEXSTATE the vertex ones', () => {
  const { dev, call, make, floats } = device(false);
  call('SetRenderState', RS_ALPHABLENDENABLE, 1); call('SetRenderState', RS_LIGHTING, 0); call('SetTextureStageState', 0, TSS_ADDRESSU8, 3);
  call('SetTransform', 3, floats([5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1]));
  const pixel = make('CreateStateBlock', PIXEL), vertex = make('CreateStateBlock', VERTEX), all = make('CreateStateBlock', ALL);
  const change = () => { call('SetRenderState', RS_ALPHABLENDENABLE, 0); call('SetRenderState', RS_LIGHTING, 1); call('SetTextureStageState', 0, TSS_ADDRESSU8, 1); call('SetTransform', 3, floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])); };
  const state = () => [dev.rs.get(RS_ALPHABLENDENABLE), dev.rs.get(RS_LIGHTING), dev.tss[0].get(TSS_ADDRESSU8), dev.transforms.get(3)[0]];
  change(); assert.equal(call('ApplyStateBlock', vertex), 0); assert.deepEqual(state(), [0, 0, 1, 1], 'vertex: lighting only');
  change(); assert.equal(call('ApplyStateBlock', pixel), 0); assert.deepEqual(state(), [1, 1, 3, 1], 'pixel: blending and the stage\'s address mode');
  change(); assert.equal(call('ApplyStateBlock', all), 0); assert.deepEqual(state(), [1, 0, 3, 5], 'all: with the projection');
  assert.equal(call('DeleteStateBlock', all), 0); assert.equal(call('ApplyStateBlock', all), INVALIDCALL);
});
