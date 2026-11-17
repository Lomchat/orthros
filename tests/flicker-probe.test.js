// The flicker counter runs at every present of every session (gfx/flicker-probe.js): it must never break a present
// (the back buffer's framebuffer bound again for the blit to the screen), must measure a sample of three consecutive
// frames from their asynchronous readbacks, and must tell an alternating picture from a still one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlickerProbe, flickerShares, PERIOD_MS, W, H } from '../src/gfx/flicker-probe.js';
import { fakeGl } from './fake-gl.js';

test('a sample: three presents read back without a stall, the back buffer bound again after each', () => {
  const { gl, calls } = fakeGl(800, 600);
  let t = 0;
  const probe = new FlickerProbe(gl, { now: () => t }), fbo = { back: true };
  for (let i = 0; i < 5; i++) { probe.present(fbo, 800, 600); t += 33; }
  assert.equal(calls.filter((c) => c[0] === 'readPixels').length, 0, 'nothing before the period');
  t += PERIOD_MS;
  for (let i = 0; i < 5; i++) {
    probe.present(fbo, 800, 600); t += 33;
    const binds = calls.filter((c) => c[0] === 'bindFramebuffer'), back = binds.find((c) => c[1] === gl.READ_FRAMEBUFFER)[2]; // (the first source of a blit: the back buffer)
    assert.deepEqual(binds[binds.length - 1].slice(1), [gl.FRAMEBUFFER, back], 'the back buffer bound last');
  }
  assert.equal(calls.filter((c) => c[0] === 'readPixels').length, 3, 'three frames');
  assert.equal(calls.filter((c) => c[0] === 'clientWaitSync' || c[0] === 'finish').length, 0, 'no wait for the GPU');
  assert.equal(probe.stats.n, 1, 'one sample measured');
});

test('an alternating picture flickers, a still or moving one does not', () => {
  const n = W * H, frame = (f) => { const px = new Uint8Array(4 * n); for (let i = 0; i < n; i++) { const v = f(i); px.set([v, v, v, 255], 4 * i); } return px; };
  const a = frame(() => 40), b = frame(() => 200);
  assert.equal(flickerShares(a, b, a, n).aba, 1);
  assert.equal(flickerShares(a, a, a, n).aba, 0);
  const ramp = (s) => frame((i) => ((i % W) * 4 + s) % 256);
  assert.equal(flickerShares(ramp(0), ramp(40), ramp(80), n).aba, 0, 'a scroll is not flicker');
});
