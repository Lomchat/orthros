// The OpenMW engine page's quality tier from the GPU and the frames measured (src/ports/openmw/tier.js, put into the
// page by src/host/openmw.js withQualityTier), and the GPU's kind every runtime reads (src/host/web/gpu-class.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gpuClass } from '../src/host/web/gpu-class.js';
import { chooseTier, framesLook, install, FRAMES, KEY } from '../src/ports/openmw/tier.js';
import { withQualityTier } from '../src/host/openmw.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';

test('the GPU\'s kind from the renderer string WebGL gives', () => {
  const cases = {
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)': 'software',
    'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)': 'software',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)': 'software',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)': 'integrated',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002560) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    'ANGLE (Intel, Intel(R) Arc(TM) A380 Graphics (0x000056A5) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    'ANGLE (Intel, Intel(R) Arc(TM) A370M Graphics (0x00005693) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    'ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics (0x0000E20B) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    'ANGLE (Intel, Intel(R) Arc(TM) Pro A60 Graphics (0x000056B2) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    // (the laptops' integrated Arc: Meteor Lake, Lunar Lake, Arrow Lake)
    'ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (Intel, Intel(R) Arc(TM) 140V GPU (16GB) (0x000064A0) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (Intel, Intel(R) Arc(TM) 130T GPU (0x00007D67) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (Intel, Mesa Intel(R) Arc(tm) Graphics (MTL), OpenGL 4.6)': 'integrated',
    // (AMD's APUs with an "RX Vega N" name, the Vega 56/64 card)
    'ANGLE (AMD, AMD Radeon RX Vega 11 Graphics (0x000015D8) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (AMD, AMD Radeon(TM) RX Vega 10 Graphics (0x000015D8) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'integrated',
    'ANGLE (AMD, Radeon RX Vega (0x0000687F) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'discrete',
    'Adreno (TM) 740': 'integrated', 'Mali-G78': 'integrated',
    'WebKit WebGL': 'unknown', '': 'unknown', null: 'unknown',
  };
  for (const [r, kind] of Object.entries(cases)) assert.equal(gpuClass(r === 'null' ? null : r), kind, r);
});

test('the tier: software low, integrated mid, discrete high; 4 GB or less low; an unknown GPU as the page\'s own rule', () => {
  const tier = (gpu, deviceMemory, saved) => chooseTier({ gpu, deviceMemory, saved }).tier;
  const iris = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const rtx = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const swift = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
  assert.equal(tier(iris, 8), 'mid', 'the owner\'s case: an 8 GB+ laptop with Iris Xe, high before');
  assert.equal(tier(rtx, 8), 'high'); assert.equal(tier(rtx, 0), 'high', 'deviceMemory unknown');
  assert.equal(tier(swift, 32), 'low', 'software rendering, whatever the memory');
  assert.equal(tier(rtx, 4), 'low'); assert.equal(tier(iris, 2), 'low');
  assert.deepEqual([8, 4, 0, 6].map((m) => tier(null, m)), ['high', 'low', 'mid', 'mid'], 'unknown GPU: deviceMemory as before');
  // (a session's frames measured long: a tier lower on that GPU only)
  assert.equal(tier(rtx, 8, { gpu: rtx, tier: 'mid' }), 'mid');
  assert.equal(tier(rtx, 8, { gpu: iris, tier: 'low' }), 'high', 'another GPU: not its verdict');
  assert.equal(tier(iris, 8, { gpu: iris, tier: 'high' }), 'mid', 'never higher than the GPU says');
});

test('a minute in the world with long frames: the next session a tier lower; short frames, or menus, leave it', () => {
  const run = (p99, tier = 'high', inWorld = true) => {
    const s = { p99s: [], done: false }; let next = null;
    for (let i = 0; i < FRAMES.looks + 5; i++) next = framesLook(s, { frames: { p99 }, inWorld, tier }) ?? next;
    return { next, done: s.done };
  };
  assert.deepEqual(run(80), { next: 'mid', done: true });
  assert.deepEqual(run(80, 'mid'), { next: 'low', done: true });
  assert.deepEqual(run(80, 'low'), { next: null, done: true });
  assert.deepEqual(run(30), { next: null, done: true });
  assert.deepEqual(run(80, 'high', false), { next: null, done: false }, 'not in the world: no look');
});

test('installed in the page: its tier choice asks it, the verdict stored for the next session, ?tier= left alone', () => {
  const rtx = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const storage = new Map(), store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  let tick = null;
  const win = { location: { search: '' }, orthrosFrames: { p99: 90 } };
  install(win, { gpu: rtx, storage: store, inWorld: () => true, setInterval: (f) => { tick = f; return 1; }, clearInterval: () => { tick = null; } });
  assert.equal(win.orthrosTier(8), 'high'); assert.equal(win.orthrosTierChoice.kind, 'discrete');
  while (tick) tick();
  assert.deepEqual(JSON.parse(storage.get(KEY)), { gpu: rtx, tier: 'mid' });
  const next = { location: { search: '' } };
  install(next, { gpu: rtx, storage: store, inWorld: () => false, setInterval: () => 1, clearInterval() {} });
  assert.equal(next.orthrosTier(8), 'mid', 'the next session');
  let watched = false; const forced = { location: { search: '?tier=high' } };
  install(forced, { gpu: rtx, storage: store, setInterval: () => { watched = true; return 1; }, clearInterval() {} });
  forced.orthrosTier(8); assert.equal(watched, false, '?tier=: no verdict');
});

test('the engine page asks the tier module before its own rule, its log saying the GPU\'s kind', () => {
  const html = `<html><head></head><body><script>
    var __tier = (/[?&]tier=(low|mid|high)/.exec(location.search) || [])[1]
              || (__devMem >= 8 ? 'high' : (__devMem > 0 && __devMem <= 4 ? 'low' : 'mid'));
    append('[tier] '+__tier+' (navigator.deviceMemory='+(__devMem||'unknown')+')');
  </script></body></html>`;
  const out = withQualityTier(html);
  assert.ok(out.startsWith(`<html><head><script>window.orthrosTierReady = import('/src/ports/openmw/tier.js')`));
  assert.ok(out.includes("|| (window.orthrosTier ? window.orthrosTier(__devMem) : (__devMem >= 8 ? 'high'"));
  assert.ok(out.includes("(window.orthrosTierChoice ? ' (gpu: '+window.orthrosTierChoice.kind+')' : '')"));
  for (const id of ['openmw-web-v1.5.3', 'openmw-web-v1.5.3-orthros-r1', 'openmw-web-v1.5.3-orthros-r2', 'openmw-web-v1.5.3-orthros-r3']) {
    const release = path.join(DEFAULT_ENGINES_DIR, id, 'index.html');
    if (!fs.existsSync(release)) continue;
    const real = withQualityTier(fs.readFileSync(release, 'utf8'));
    for (const k of ['orthrosTierReady = import', 'window.orthrosTier(__devMem)', 'orthrosTierChoice.kind']) assert.equal(real.split(k).length - 1, 1, `${id}: ${k}`);
  }
});

test('installed in the page: the world as view-grow.js sees it (joined and simulated) — no look while it still loads', () => {
  const rtx = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const storage = new Map(), store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  let tick = null;
  const win = { location: { search: '' }, orthrosFrames: { p99: 90 }, __omwMPEnabled: true, omw: { state: { state: 'Joined' } } };
  install(win, { gpu: rtx, storage: store, setInterval: (f) => { tick = f; return 1; }, clearInterval: () => { tick = null; } });
  win.orthrosTier(8);
  for (let i = 0; i < FRAMES.looks * 3; i++) tick();
  assert.equal(storage.has(KEY), false, 'joined, not simulated yet: the loading\'s frames not looked at');
  win.omw.state.simReady = '1';
  for (let i = 0; i < FRAMES.looks * 3 && tick; i++) tick();
  assert.deepEqual(JSON.parse(storage.get(KEY)), { gpu: rtx, tier: 'mid' });
});
