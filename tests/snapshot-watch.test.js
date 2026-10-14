// The automatic snapshot's timing (src/host/snapshot-watch.js, docs/snapshot.md stage 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotWatch } from '../src/host/snapshot-watch.js';

test('a capture is due once no file was opened for a while as frames went on; kept once the session went on', () => {
  const w = new SnapshotWatch({ quietMs: 4000, minFps: 5, tries: 2, keepMs: 20000, keepFrames: 100 });
  assert.equal(w.due(0, 0, 10), false); // (first sight)
  assert.equal(w.due(3000, 60, 10), false); // (not long enough)
  assert.equal(w.due(3500, 70, 11), false); // (a file opened: the stretch starts again)
  assert.equal(w.due(7400, 200, 11), false);
  assert.equal(w.due(7600, 200, 11), true);
  const still = new SnapshotWatch({ quietMs: 4000, minFps: 5 }); still.due(0, 0, 1);
  assert.equal(still.due(5000, 5, 1), false); // (few frames meanwhile: a hang, not a screen)
  w.tried(false, 7600, 200); // (refused: another stretch first)
  assert.equal(w.due(9000, 250, 11), false);
  assert.equal(w.due(11700, 400, 11), true);
  w.tried(true, 11700, 400);
  assert.equal(w.due(12000, 410, 11), false); // (taken: no other)
  assert.equal(w.ripe(20000, 600), false);
  assert.equal(w.ripe(31800, 600), true);
  w.kept();
  assert.equal(w.ripe(40000, 900), false); // (once)
  assert.equal(w.done, true);
});

test('refused as many times as it may be tried: no more captures', () => {
  const w = new SnapshotWatch({ quietMs: 1000, minFps: 0, tries: 2 });
  w.due(0, 0, 1); assert.equal(w.due(1000, 0, 1), true); w.tried(false, 1000, 0);
  assert.equal(w.due(2000, 0, 1), true); w.tried(false, 2000, 0);
  assert.equal(w.done, true); assert.equal(w.due(9000, 0, 1), false);
});

test('a snapshot dropped (the profile changed after it) is taken again after another settled stretch', () => {
  const w = new SnapshotWatch({ quietMs: 1000, minFps: 0, tries: 3, keepMs: 5000, keepFrames: 0 });
  w.due(0, 0, 1); assert.equal(w.due(1000, 0, 1), true); w.tried(true, 1000, 0);
  assert.equal(w.due(2000, 0, 1), false);
  assert.equal(w.ripe(6000, 0), true); w.dropped(6000, 0);
  assert.equal(w.ripe(7000, 0), false); assert.equal(w.due(6500, 0, 2), false);
  assert.equal(w.due(7600, 0, 2), true); w.tried(true, 7600, 0);
  assert.equal(w.ripe(12600, 0), true); w.kept(); assert.equal(w.done, true);
});
