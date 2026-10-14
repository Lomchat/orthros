// A mirrored in-memory backend (src/vfs/vfs.js MemBackend.changes, seen): what a mirror replays — folders made, files
// removed or renamed — and what a machine saw of each path (seenFingerprint), as the browser profile uses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemBackend, SEEN, seenFingerprint } from '../src/vfs/vfs.js';

test('entries made, removed or renamed are recorded for the mirror', () => {
  const b = new MemBackend();
  b.mkdir('Docs'); b.open('Docs/a.sav', { create: true }).write(0, Uint8Array.of(1)); // (before: not recorded)
  b.changes = new Set();
  b.mkdir('Docs/Empty');
  b.open('Docs/b.sav', { create: true });
  b.open('Docs/a.sav').write(0, Uint8Array.of(2)); // (a write: the mirror finds it by its date)
  b.rename('Docs/b.sav', 'Docs/c.sav');
  b.unlink('Docs/a.sav');
  b.unlink('Docs/none');
  assert.deepEqual([...b.changes].sort(), ['docs/a.sav', 'docs/b.sav', 'docs/c.sav', 'docs/empty']);
});

test('what a machine saw of a path, as far as it looked', () => {
  const b = new MemBackend(); b.seen = new Map();
  b.mkdir('Saves'); b.open('Saves/one.sav', { create: true }).write(0, Uint8Array.of(65));
  b.seen.clear();
  b.stat('Saves/one.sav'); b.readdir('Saves'); b.open('options.ini');
  assert.deepEqual(Object.fromEntries(b.seen), { 'saves/one.sav': SEEN.STAT, saves: SEEN.LIST, 'options.ini': SEEN.DATA });
  const before = seenFingerprint(b, b.seen);
  assert.deepEqual(before, { 'options.ini': [SEEN.DATA, '-'], saves: [SEEN.LIST, 'd:one.sav:1'], 'saves/one.sav': [SEEN.STAT, 'f:1'] });
  b.files.get('saves/one.sav').data[0] = 66; // (changed outside the machine, same size: a stat saw nothing else)
  assert.deepEqual(seenFingerprint(b, b.seen), before);
  b.files.set('saves/two.sav', { data: new Uint8Array(0), len: 0, mtime: 0 }); // (a save added outside the machine)
  assert.notDeepEqual(seenFingerprint(b, b.seen).saves, before.saves);
});
