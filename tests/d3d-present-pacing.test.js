// Present's presentation interval (d3d8.js Device8.vsyncRefreshes / Present): a Present that waits for the vertical
// retrace parks its thread until one refresh (or two, three, four) after the previous present's slot — a game without a
// frame limiter of its own (Vice City's menu: 250-360 frames/s in the browser before) runs at the display's rate as on
// Windows; a frame slower than the refresh is not held; IMMEDIATE, a Direct3D 8 windowed device without COPY_VSYNC
// and ?dbg=ORTHROS_VSYNC=0 never wait. The re-executed call after the wait completes without presenting again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { PARK } from '../src/core/sched.js';

const IMMEDIATE = 0x80000000;

/** a device with the given present parameters, a settable clock and a scheduler recording the parks */
function device(api9, { windowed, swap = 1, refresh = 0, interval = 0 }) {
  const E = d3dEnv(null), { mem, ctx, com, vm } = E;
  const clock = { t: 1000, now() { return this.t; } };
  const parks = [];
  vm.clock = clock;
  vm.sched = { park(thread, cond, ms, reason) { parks.push({ tid: thread.id, ms, reason, cond: cond() }); return PARK; } };
  const out = E.alloc(64), pp = E.alloc(64);
  // D3D8: width height format count msaa swap hwnd windowed autoDepth depthFormat flags refresh interval
  // D3D9: width height format count msaa msq swap hwnd windowed autoDepth depthFormat flags refresh interval
  const words = api9 ? [320, 240, 22, 1, 0, 0, swap, 0, windowed ? 1 : 0, 1, 75, 0, refresh, interval] : [320, 240, 22, 1, 0, swap, 0, windowed ? 1 : 0, 1, 75, 0, refresh, interval];
  words.forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs[api9 ? 'Direct3DCreate9' : 'Direct3DCreate8'][1](ctx([api9 ? 32 : 220]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr);
  const thread = { id: 7, resuming: false };
  const present = () => dev.Present({ ...ctx([devPtr, 0, 0, 0, 0]), thread });
  return { dev, clock, parks, thread, present };
}

test('D3D8 fullscreen, DEFAULT interval: one frame per 60 Hz refresh, the re-executed call presents nothing', () => {
  const { dev, clock, parks, thread, present } = device(false, { windowed: false });
  assert.equal(present(), 0, 'the first present: nothing to wait for');
  assert.equal(parks.length, 0);
  assert.equal(dev.frames, 1);
  clock.t += 2; // a cheap frame: 2 ms later
  assert.equal(present(), PARK);
  assert.equal(parks.length, 1);
  assert.ok(Math.abs(parks[0].ms - (1000 / 60 - 2)) < 1e-9, `waits ${parks[0].ms} ms`);
  assert.equal(parks[0].reason, 'vsync'); assert.equal(parks[0].cond, false); assert.equal(parks[0].tid, 7);
  assert.equal(dev.frames, 2, 'presented before the wait');
  // woken: the dispatcher re-executes the call
  clock.t = 1000 + 1000 / 60; thread.resuming = true;
  assert.equal(present(), 0);
  assert.equal(dev.frames, 2, 'not presented twice');
  assert.equal(parks.length, 1);
  thread.resuming = false;
  // the next cheap frame waits for the next slot, counted from the previous one (no drift)
  clock.t += 1;
  assert.equal(present(), PARK);
  assert.ok(Math.abs(parks[1].ms - (1000 / 60 - 1)) < 1e-9, `waits ${parks[1].ms} ms`);
});

test('a frame slower than the refresh is not held to the next one (a 30 fps limiter keeps its 33 ms frames)', () => {
  const { dev, clock, parks, present } = device(false, { windowed: false, interval: 1 });
  for (let i = 0; i < 10; i++) { assert.equal(present(), 0); clock.t += 33.3; }
  assert.equal(parks.length, 0);
  assert.equal(dev.frames, 10);
});

test('intervals TWO / THREE / FOUR and a fullscreen refresh rate', () => {
  for (const [interval, n] of [[2, 2], [4, 3], [8, 4]]) {
    const { clock, parks, present } = device(false, { windowed: false, interval });
    present(); clock.t += 1; assert.equal(present(), PARK);
    assert.ok(Math.abs(parks[0].ms - (n * 1000 / 60 - 1)) < 1e-9, `interval ${interval}: ${parks[0].ms}`);
  }
  const { clock, parks, present } = device(false, { windowed: false, refresh: 75 });
  present(); clock.t += 1; present();
  assert.ok(Math.abs(parks[0].ms - (1000 / 75 - 1)) < 1e-9, `75 Hz: ${parks[0].ms}`);
});

test('no wait: IMMEDIATE, D3D8 windowed without COPY_VSYNC, ORTHROS_VSYNC=0; D3D8 windowed COPY_VSYNC and D3D9 windowed DEFAULT wait', () => {
  const run = (api9, o) => { const d = device(api9, o); d.present(); d.clock.t += 1; return d.present() === PARK; };
  assert.equal(run(false, { windowed: false, interval: IMMEDIATE }), false);
  assert.equal(run(true, { windowed: false, interval: IMMEDIATE }), false);
  assert.equal(run(true, { windowed: true, interval: IMMEDIATE }), false);
  assert.equal(run(false, { windowed: true, swap: 1 }), false, 'D3D8 windowed DISCARD');
  assert.equal(run(false, { windowed: true, swap: 4 }), true, 'D3D8 windowed COPY_VSYNC');
  assert.equal(run(true, { windowed: true }), true, 'D3D9 windowed DEFAULT');
  assert.equal(run(true, { windowed: false, interval: 1 }), true, 'D3D9 fullscreen ONE');
  globalThis.ORTHROS_VSYNC = '0';
  try { assert.equal(run(false, { windowed: false }), false, 'switched off'); } finally { delete globalThis.ORTHROS_VSYNC; }
});
