// The one merge of a player's profile copies (src/vfs/profile-merge.js): the only code that decides, when a game's
// versions start sharing one profile, which save is kept where — a bug here loses a player's saves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProfiles } from '../src/vfs/profile-merge.js';
import { migrateProfile, mergedMarker } from '../src/vfs/profile-share.js';

const f = (path, text, mtime) => ({ path, data: new TextEncoder().encode(text), ...(mtime !== undefined ? { mtime } : {}) });
const text = (files) => Object.fromEntries(files.map((x) => [x.path, new TextDecoder().decode(x.data)]));

test('mergeProfiles: union, one copy of the same bytes, newest settings, every distinct save kept', () => {
  const v108 = { label: 'bfme1-108', at: 1000, files: [f('Saves/Rohan.sav', 'old rohan', 500), f('Options.ini', 'res=800'), f('Saves/Only108.sav', 'a'), f('Maps/same.map', 'M')] };
  const v222 = { label: 'bfme-vanilla', at: 2000, files: [f('saves/rohan.sav', 'new rohan', 1500), f('options.INI', 'res=1024'), f('Maps/Same.map', 'M'), f('Saves/Rohan (bfme1-108).sav', 'taken')] };
  const { files, report } = mergeProfiles([v222, v108]);
  assert.deepEqual(text(files), {
    'Maps/Same.map': 'M', // (identical: one, the first casing seen)
    'Saves/Only108.sav': 'a',
    'saves/rohan (bfme1-108 2).sav': 'old rohan', // (beside it, the label's name taken by other bytes: a counter)
    'Saves/Rohan (bfme1-108).sav': 'taken',
    'options.INI': 'res=1024', // (a settings file: the newest copy only)
    'saves/rohan.sav': 'new rohan', // (the newest at its path)
  });
  assert.ok(report.some((r) => r.action === 'newest' && r.path === 'options.INI'));
  // (done again — an interrupted migration, the profile's own copy among the sources: nothing more)
  assert.deepEqual(text(mergeProfiles([{ label: 'bfme1', at: 3000, files }, v222, v108]).files), text(files));
  // (a file's own date wins over its copy's; manifest globs make a settings file of any name)
  const dated = mergeProfiles([{ label: 'a', at: 9000, files: [f('s/x.sav', 'A', 10), f('player.dat', 'A')] }, { label: 'b', at: 1, files: [f('s/x.sav', 'B', 20), f('player.dat', 'B')] }], { settings: ['*.dat'] });
  assert.deepEqual(text(dated.files), { 'player.dat': 'A', 's/x (a).sav': 'A', 's/x.sav': 'B' });
});

test('migrateProfile: merged once, a copy new or changed since merged again, an unreadable one retried later', async () => {
  const store = new Map(), storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const copies = { v1: [f('s/a.sav', 'a', 1)], v2: [f('s/b.sav', 'b', 2)] };
  let profile = [], writes = 0, busy = false;
  const run = (names) => migrateProfile({ key: 'game', storage, hashOf: async (n, files) => JSON.stringify(text(files)),
    sources: names.map((name) => ({ name, read: async () => { if (busy && name === 'v3') throw new Error('busy'); return copies[name] ?? null; } })),
    target: { read: async () => profile, write: async (files) => { profile = files; writes++; } } });
  await run(['v1', 'v2']);
  assert.deepEqual(text(profile), { 's/a.sav': 'a', 's/b.sav': 'b' });
  profile = profile.filter((x) => x.path !== 's/a.sav'); // (the player deletes a save in the shared profile)
  await run(['v1', 'v2']); assert.equal(writes, 1, 'nothing new: nothing written, the deleted save not back');
  copies.v2 = [f('s/b.sav', 'b', 2), f('s/late.sav', 'L', 3)]; // (a page of before, still open, saved there)
  copies.v3 = [f('s/c.sav', 'c', 4)]; busy = true; // (a version joining the game, its copy not readable now)
  await assert.rejects(run(['v1', 'v2', 'v3']), /busy/);
  busy = false; await run(['v1', 'v2', 'v3']);
  assert.deepEqual(text(profile), { 's/b.sav': 'b', 's/c.sav': 'c', 's/late.sav': 'L' });
  assert.deepEqual(mergedMarker('game', null, storage).sources.map((s) => s.name), ['v1', 'v2', 'v3']);
});
