// The rendering mode the emulator worker chooses (render-host.js renderMode): the render worker by default, the page's
// ?glworker= first, then the manifest's compat flag glWorker (docs/render-worker.md section 8.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMode } from '../src/gfx/render-host.js';

test('renderMode: the render worker unless the page or the manifest asks otherwise', () => {
  assert.equal(renderMode(undefined, undefined), '1', 'default: the render worker');
  assert.equal(renderMode('', undefined), '1', 'an empty ?glworker= is no choice');
  assert.equal(renderMode(undefined, false), '0', 'manifest glWorker: false keeps the in-thread backend');
  assert.equal(renderMode(undefined, 0), '0', 'manifest glWorker: 0 keeps the in-thread backend');
  assert.equal(renderMode(undefined, true), '1');
  assert.equal(renderMode(undefined, 1), '1');
  assert.equal(renderMode(undefined, 'inline'), 'inline');
  assert.equal(renderMode('0', undefined), '0', '?glworker=0: the in-thread backend');
  assert.equal(renderMode('0', true), '0', 'the page wins over the manifest');
  assert.equal(renderMode('1', false), '1', 'the page wins over the manifest');
  assert.equal(renderMode('compare-worker', 0), 'compare-worker');
});
