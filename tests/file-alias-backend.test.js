import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemBackend } from '../src/vfs/vfs.js';
import { FileAliasBackend } from '../src/vfs/file-alias-backend.js';

test('language file aliases change the bytes served under the original name', () => {
  const files = new MemBackend();
  files.mkdir('TEXT');
  files.open('TEXT/american.gxt', { create: true }).write(0, new TextEncoder().encode('English'));
  files.open('TEXT/french.gxt', { create: true }).write(0, new TextEncoder().encode('Français'));
  const french = new FileAliasBackend(files, { 'TEXT/american.gxt': 'TEXT/french.gxt' });
  assert.equal(new TextDecoder().decode(french.open('text/AMERICAN.GXT').read(0, 32)), 'Français');
  assert.equal(french.stat('TEXT/american.gxt').size, 9);
  assert.equal(french.readdir('TEXT').find((e) => e.name === 'american.gxt').size, 9);
  assert.equal(new TextDecoder().decode(files.open('TEXT/american.gxt').read(0, 32)), 'English');
  assert.equal(french.open('TEXT/american.gxt', { write: true }), null);
});

test('a language\'s own files are left out of the game folder in the other languages', () => {
  const files = new MemBackend();
  for (const n of ['_patch108.big', '_patch108french.big', '_patch108english.big']) files.open(n, { create: true }).write(0, new TextEncoder().encode(n));
  const english = new FileAliasBackend(files, {}, ['_PATCH108FRENCH.big']);
  assert.deepEqual(english.readdir('').map((e) => e.name).sort(), ['_patch108.big', '_patch108english.big']);
  assert.equal(english.stat('_patch108french.big'), null); assert.equal(english.open('_patch108french.big'), null);
  assert.ok(english.open('_patch108english.big'));
  assert.ok(files.open('_patch108french.big'), 'the folder itself unchanged');
});
