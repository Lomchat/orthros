// D3DX effect shader constants: a pass binding a vertex shader loads the constants its constant table names from the
// effect's parameters. The values are converted again only when the parameter changed (d3dx9-effect.js bindShader:
// the version of the top-level parameter), so every way of changing a parameter must reach the device at the next
// CommitChanges: the whole array (SetVectorArray, SetValue), one element (SetVector on "A[1]", by name or handle),
// a parameter block; and a device constant changed by someone else is restored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './fx-env.js';


test('effect constants: every change of a parameter reaches the device at CommitChanges, and only then', () => {
  const { dev, fx, fxPtr, ctx, name, vec } = setup();
  const c = (i) => Array.from(dev.vsConst.subarray(4 * i, 4 * i + 4));
  const A = name('A'), A1 = name('A[1]'), B = name('B');
  fx.SetVectorArray(ctx(fxPtr, A, vec(1, 2, 3, 4, 5, 6, 7, 8), 2));
  fx.SetVector(ctx(fxPtr, B, vec(9, 10, 11, 12)));
  assert.equal(fx.Begin(ctx(fxPtr, 0, 0)), 0);
  fx.BeginPass(ctx(fxPtr, 0));
  assert.equal(dev.vs, 0x7000, 'the pass sets its vertex shader');
  assert.deepEqual([c(0), c(1), c(4)], [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);

  // one element, by name: the array's binding is converted again
  fx.SetVector(ctx(fxPtr, A1, vec(-1, -2, -3, -4)));
  assert.deepEqual(c(1), [5, 6, 7, 8], 'nothing reaches the device before CommitChanges');
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual([c(0), c(1), c(4)], [[1, 2, 3, 4], [-1, -2, -3, -4], [9, 10, 11, 12]]);

  // one element, by handle
  const h1 = fx.GetParameterElement(ctx(fxPtr, fx.GetParameterByName(ctx(fxPtr, 0, A)), 0));
  fx.SetVector(ctx(fxPtr, h1, vec(0.5, 0.25, 0.125, 2)));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(0), [0.5, 0.25, 0.125, 2]);

  // the whole array as raw bytes
  const raw = vec(11, 12, 13, 14, 15, 16, 17, 18);
  fx.SetValue(ctx(fxPtr, A, raw, 32));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual([c(0), c(1)], [[11, 12, 13, 14], [15, 16, 17, 18]]);

  // a device constant overwritten by someone else (another effect, SetVertexShaderConstantF) is set again
  dev.vsConst[5] = 99; dev.vsConst[16] = 98; dev.constVersion++; // (as SetVertexShaderConstantF does)
  const v0 = dev.constVersion;
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual([c(1), c(4)], [[15, 16, 17, 18], [9, 10, 11, 12]]);
  assert.ok(dev.constVersion > v0, 'a restored constant moves the device version');

  // nothing changed: no constant version move
  const v1 = dev.constVersion;
  fx.CommitChanges(ctx(fxPtr));
  assert.equal(dev.constVersion, v1);

  // a parameter block recorded, the parameter changed, the block applied again
  fx.BeginParameterBlock(ctx(fxPtr));
  fx.SetVector(ctx(fxPtr, B, vec(1, 1, 1, 1)));
  const block = fx.EndParameterBlock(ctx(fxPtr));
  fx.SetVector(ctx(fxPtr, B, vec(2, 2, 2, 2)));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(4), [2, 2, 2, 2]);
  fx.ApplyParameterBlock(ctx(fxPtr, block));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(4), [1, 1, 1, 1]);

  // SetFloatArray over the array's words
  fx.SetFloatArray(ctx(fxPtr, A, vec(21, 22, 23, 24, 25, 26, 27, 28), 8));
  fx.EndPass(ctx(fxPtr));
  fx.BeginPass(ctx(fxPtr, 0));
  assert.deepEqual([c(0), c(1)], [[21, 22, 23, 24], [25, 26, 27, 28]]);
  fx.End(ctx(fxPtr));
});

test('effect state manager: the calls the JIT queues go to JavaScript while one is set', () => {
  const { mem, fx, fxPtr, ctx } = setup();
  const block = mem.read32(fxPtr + 12);
  assert.ok(block !== 0, 'the handle block at +12');
  fx.SetStateManager(ctx(fxPtr, 0x12340000));
  assert.equal(mem.read32(fxPtr + 12), 0, 'cleared: nothing queued (runtime.js DEFER_OBJ / DEFER_HANDLE)');
  fx.SetStateManager(ctx(fxPtr, 0));
  assert.equal(mem.read32(fxPtr + 12), block, 'restored');
});

test('effect constants: values sent to a state manager are sent to the device again once it is removed', () => {
  // (a state manager may keep or drop what it receives: the device's registers then still hold the values of before)
  const { mem, dev, fx, fxPtr, ctx, name, vec, vm } = setup();
  const c = (i) => Array.from(dev.vsConst.subarray(4 * i, 4 * i + 4));
  const B = name('B');
  fx.SetVector(ctx(fxPtr, B, vec(1, 2, 3, 4)));
  fx.Begin(ctx(fxPtr, 0, 0)); fx.BeginPass(ctx(fxPtr, 0));
  assert.deepEqual(c(4), [1, 2, 3, 4]);
  const vt = 0x20000000, mgr = 0x20001000; // (a guest state manager: a vtable of dummy method addresses)
  for (let i = 0; i < 32; i++) mem.write32(vt + 4 * i, 0x30000000 + 4 * i);
  mem.write32(mgr, vt);
  fx.SetStateManager(ctx(fxPtr, mgr));
  fx.SetVector(ctx(fxPtr, B, vec(5, 6, 7, 8)));
  fx.CommitChanges(ctx(fxPtr));
  assert.ok(vm.guestCalls.length > 0, 'the constants went to the state manager');
  assert.deepEqual(c(4), [1, 2, 3, 4], 'the device untouched');
  fx.SetStateManager(ctx(fxPtr, 0));
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(4), [5, 6, 7, 8], 'the device receives the current value');
  fx.EndPass(ctx(fxPtr)); fx.End(ctx(fxPtr));
});

// BeginPass publishes, at +20 of the effect's guest object, the device states its CommitChanges may set (runtime.js
// COMMIT_LIST) for the JIT's issued-state filter: none here (a vertex shader without samplers); "any" without a shadow.
test('effect commit list: the shadowed states CommitChanges may set, published at BeginPass', () => {
  const { mem, dev, fx, fxPtr, ctx } = setup();
  fx.Begin(ctx(fxPtr, 0, 0));
  fx.BeginPass(ctx(fxPtr, 0));
  let list = mem.read32(fxPtr + 20);
  assert.ok(list, 'a list');
  assert.deepEqual([mem.read32(list), mem.read32(list + 4)], [0, 0xffffffff], 'a device without a shadow: any state');
  fx.EndPass(ctx(fxPtr)); fx.End(ctx(fxPtr));
  dev.shadow = 0x12340000;
  fx.Begin(ctx(fxPtr, 0, 0));
  fx.BeginPass(ctx(fxPtr, 0));
  list = mem.read32(fxPtr + 20);
  assert.deepEqual([mem.read32(list), mem.read32(list + 4)], [0x12340000, 0], 'the pass sets no render, stage or sampler state at CommitChanges');
});

test('effect constants with per-stage versions (Direct3D devices): a vertex constant overwritten is restored, a pixel change leaves the vertex bindings alone', () => {
  const { dev, fx, fxPtr, ctx, name, vec } = setup();
  dev.vsConstVersion = 1; dev.psConstVersion = 1; // (as Device8.resetState: the device's vertex / pixel constant versions)
  const c = (i) => Array.from(dev.vsConst.subarray(4 * i, 4 * i + 4));
  fx.SetVector(ctx(fxPtr, name('B'), vec(9, 10, 11, 12)));
  fx.Begin(ctx(fxPtr, 0, 0)); fx.BeginPass(ctx(fxPtr, 0));
  assert.deepEqual(c(4), [9, 10, 11, 12]);
  const vv = dev.vsConstVersion;
  dev.psConst[0] = 7; dev.constVersion++; dev.psConstVersion++; // (SetPixelShaderConstantF)
  fx.CommitChanges(ctx(fxPtr));
  assert.equal(dev.vsConstVersion, vv, 'no vertex constant written');
  dev.vsConst[16] = 98; dev.constVersion++; dev.vsConstVersion++; // (SetVertexShaderConstantF over B)
  fx.CommitChanges(ctx(fxPtr));
  assert.deepEqual(c(4), [9, 10, 11, 12], 'restored');
  fx.End(ctx(fxPtr));
});
