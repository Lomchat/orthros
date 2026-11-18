// The draw probe's alternation trigger (src/shared/draw-probe.js alternation, run by the flicker probe on SEQ_N
// consecutive frames): the owner's AotR pause menu of 2026-11-18 lost its darkening layer for runs of 2-3 frames out of
// ~6 under commands that changed every frame — no sample of three frames went A-B-A, no still screen kept one
// signature, so the probe never started. The rule must start it on such runs (A-B-B-A, A-B-B-B-A) in a still scene
// whatever their phase, and never on a scroll, an object bouncing back and forth or flashes here and there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GW, GH, SEQ_N, ODD_PPM, alternation, alternates, runOdd } from '../src/shared/draw-probe.js';

let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / (1 << 24);
const scene = Uint8Array.from({ length: GW * GH }, () => 60 + Math.floor(rnd() * 140)); // (textured terrain)
/** a frame of the still scene: `veil` darkens it (x 0.2), a few points of idle animation move in every frame */
const frame = (veil) => { const g = scene.map((v) => (veil ? v * 0.2 : v)); for (let i = 0; i < 6; i++) g[Math.floor(rnd() * GW * GH)] = Math.floor(rnd() * 256); return g; };
const square = (g, x0, y0, n, v = 250) => { for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) g[y * GW + x] = v; return g; };

test('runs of a missing layer in a still scene start the draw probe; a scroll, a bounce and flashes do not', () => {
  // (the owner's frames 0-15: B = the layer missing, D = drawn — runs of 2-3; and runs of 3 and 3 at every phase)
  const owner = 'BBDDDBBDDDBBBDDD'.split('').map((c) => frame(c === 'D'));
  assert.ok(alternates(owner), `the owner's runs: ${JSON.stringify(alternation(owner))}`);
  for (let ph = 0; ph < 6; ph++) {
    const P = Array.from({ length: SEQ_N }, (_, k) => frame(Math.floor((k + ph) / 3) % 2 === 0));
    assert.ok(alternates(P), `runs of 3 and 3, phase ${ph}`);
  }
  // (the draw probe then counts a run's frames as odd, not only an A-B-A's middle one: frame 3 is inside D D D)
  assert.ok(runOdd(owner, 3) >= ODD_PPM, 'a frame inside a run is odd');
  // (a small patch alternating every other frame — the owner's rocks of 2026-11-17 — is an alternation too)
  assert.ok(alternates(Array.from({ length: SEQ_N }, (_, k) => square(frame(false), 30, 20, 5, k % 2 ? 250 : 5))), 'a patch going A-B-A-B');

  // (a scroll: the terrain moves one point a frame — nothing comes back)
  const scroll = Array.from({ length: SEQ_N }, (_, k) => { const g = new Uint8Array(GW * GH); for (let p = 0; p < GW * GH; p++) g[p] = scene[(p + k) % (GW * GH)]; return g; });
  assert.ok(!alternates(scroll), `a scroll: ${JSON.stringify(alternation(scroll))}`);
  // (a 10x10 object bouncing 2 points a frame, turning every 5 frames: it comes back at each turn, elsewhere each time)
  const pos = [0, 2, 4, 6, 8, 10, 8, 6, 4, 2, 0, 2, 4, 6, 8, 10];
  const bounce = pos.map((x) => square(frame(false), 10 + x, 15, 10));
  assert.ok(!alternates(bounce), `a bounce: ${JSON.stringify(alternation(bounce))}`);
  // (flashes for one frame, four of them at four places: four A-B-A, never twice at the same place)
  const flashes = Array.from({ length: SEQ_N }, (_, k) => (k % 4 === 2 ? square(frame(false), 5 + 12 * (k >> 2), 10 + 8 * (k >> 2), 6) : frame(false)));
  const fl = alternation(flashes);
  assert.ok(fl.returns >= 4 && !alternates(flashes), `flashes: ${JSON.stringify(fl)}`);
  // (and the still scene alone)
  assert.ok(!alternates(Array.from({ length: SEQ_N }, () => frame(true))), 'a still screen');
});
