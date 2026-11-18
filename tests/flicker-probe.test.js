// The flicker counter runs at every present of every session (gfx/flicker-probe.js): it must never break a present
// (the back buffer's framebuffer bound again for the blit to the screen, the caller told when its GL state cache is
// stale), must measure a sample of three consecutive frames with one asynchronous readback, and must count a flicker
// confined to a few pixels of the frame where it is. (The per-pixel A-B-A rule runs on the GPU: checked in Chrome by
// tools/check/flicker-probe-check.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlickerProbe, PERIOD_MS, W, H, blockEdges } from '../src/gfx/flicker-probe.js';
import { fakeGl } from './fake-gl.js';

test('a sample: three presents compared in one draw, read back without a stall; a flicker in one block counted there', () => {
  const { gl, calls } = fakeGl(800, 600);
  // (the sample's readback: block (10, 20) — 12 x 13 pixels of the frame — had every pixel go A-B-A where nothing moved;
  // block (30, 5) A-B-A pixels whose surroundings moved — a scroll's — which are no flicker)
  const bi = 10, bj = 20, xs = blockEdges(800, W), ys = blockEdges(600, H), nBlock = (xs[bi + 1] - xs[bi]) * (ys[bj + 1] - ys[bj]);
  gl.getBufferSubData = (target, off, px) => { const k = 4 * (bj * W + bi); px[k] = 255; px[k + 1] = 255; px[k + 2] = 128; px[k + 3] = 255; const m = 4 * (5 * W + 30); px[m] = 64; px[m + 1] = 64; };
  let t = 0;
  const logs = [], probe = new FlickerProbe(gl, { now: () => t, log: (m) => logs.push(m) }), fbo = { back: true };
  for (let i = 0; i < 5; i++) { assert.equal(probe.present(fbo, 800, 600), false); t += 33; }
  assert.equal(calls.filter((c) => c[0] === 'blitFramebuffer' || c[0] === 'readPixels').length, 0, 'nothing before the period');
  t += PERIOD_MS;
  const stale = [];
  for (let i = 0; i < 5; i++) {
    stale.push(probe.present(fbo, 800, 600)); t += 33;
    const binds = calls.filter((c) => c[0] === 'bindFramebuffer'), back = binds.find((c) => c[1] === gl.READ_FRAMEBUFFER)[2]; // (the first source of a blit: the back buffer)
    assert.deepEqual(binds[binds.length - 1].slice(1), [gl.FRAMEBUFFER, back], 'the back buffer bound last');
  }
  assert.deepEqual(stale, [true, false, true, false, false], 'the caller told when GL state was set behind its cache');
  assert.equal(calls.filter((c) => c[0] === 'blitFramebuffer' && c[7] === 800 && c[8] === 600).length, 3, 'three frames copied'); // (the others: the alternation sample's small grids)
  assert.equal(calls.filter((c) => c[0] === 'drawArrays').length, 1, 'compared in one draw');
  assert.equal(calls.filter((c) => c[0] === 'readPixels').length, 1, 'one readback');
  assert.equal(calls.filter((c) => c[0] === 'clientWaitSync' || c[0] === 'finish').length, 0, 'no wait for the GPU');
  const st = probe.stats;
  assert.equal(st.n, 1, 'one sample measured');
  const nScroll = (xs[31] - xs[30]) * (ys[6] - ys[5]);
  assert.equal(st.still, Math.round(nBlock / 480000 * 1e6), 'its pixels counted, a share of the whole frame');
  assert.equal(st.aba, Math.round((nBlock + 64 / 255 * nScroll) / 480000 * 1e6), 'A-B-A anywhere: the moving block too');
  assert.equal(st.alt, 1, 'what changed came back: an alternating sample');
  assert.deepEqual(st.recent, [[1, st.still]]);
  const mask = /mask 64x48 ([0-9a-f]+)/.exec(logs[0] ?? '')?.[1], k = bj * W + bi;
  assert.ok(mask, 'logged');
  assert.equal((parseInt(mask[k >> 2], 16) >> (3 - (k & 3))) & 1, 1, 'where it flickered');
  assert.equal([...mask].filter((d) => d !== '0').length, 1, 'there only');
  assert.equal(st.abaAlt, 0);
  // (the next sample: A-B-A that dominates what changed in a block whose surroundings moved — something alternating while
  // the camera moved a little, which the still rule cannot see — counted apart and logged with the A-B-A blocks)
  gl.getBufferSubData = (target, off, px) => { const m = 4 * (5 * W + 30); px[m] = 255; px[m + 1] = 255; };
  t += PERIOD_MS;
  for (let i = 0; i < 5; i++) { probe.present(fbo, 800, 600); t += 33; }
  assert.deepEqual([st.n, st.alt, st.abaAlt], [2, 1, 1]);
  const moved = /while the picture moved.*mask 64x48 ([0-9a-f]+)/.exec(logs[1] ?? '')?.[1], m = 5 * W + 30;
  assert.ok(moved && (parseInt(moved[m >> 2], 16) >> (3 - (m & 3))) & 1, 'logged where it alternated');
  // (the device signs its frames' commands for the sampled frames only — d3d8-webgl.js sigMix —: asked one present
  // before the sample, told to stop after its third frame; the three signatures compared in the sample's line)
  const dev = { sigOn: false }, signing = [];
  t += PERIOD_MS;
  for (let i = 0; i < 5; i++) { signing.push(dev.sigOn); probe.present(fbo, 800, 600, dev, dev.sigOn ? 0xabc : undefined); t += 33; }
  assert.deepEqual(signing, [false, true, true, true, false]);
  assert.match(logs[2] ?? '', /commands same \(abc\/abc\/abc\)/);
});
