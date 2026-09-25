// shlwapi path helpers: the documented behaviour of PathRemoveFileSpec, PathCanonicalize, PathCombine/PathAppend,
// PathFindFileName / PathFindExtension and PathMatchSpec on the usual cases (roots, trailing separators, "." / "..").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeFileSpec, canonicalize, combine, fileNameIndex, extensionIndex, matchSpec, rootLength } from '../src/win32/shlwapi.js';

test('shlwapi paths', () => {
  assert.deepEqual(removeFileSpec('C:\\Game\\game.dat'), ['C:\\Game', true]);
  assert.deepEqual(removeFileSpec('C:\\game.dat'), ['C:\\', true]);
  assert.deepEqual(removeFileSpec('C:\\'), ['C:\\', false]);
  assert.deepEqual(removeFileSpec('C:\\Game\\'), ['C:\\Game', true]);
  assert.deepEqual(removeFileSpec('file.txt'), ['', true]);
  assert.deepEqual(removeFileSpec('\\\\server\\share\\a'), ['\\\\server\\share\\', true]);
  assert.equal(canonicalize('C:\\a\\b\\..\\c'), 'C:\\a\\c');
  assert.equal(canonicalize('C:\\a\\.\\b\\.'), 'C:\\a\\b');
  assert.equal(canonicalize('C:\\a\\..\\..\\b'), 'C:\\b');
  assert.equal(canonicalize('C:\\..'), 'C:\\');
  assert.equal(canonicalize('a\\..'), '\\');
  assert.equal(combine('C:\\Game', 'Data\\INI\\x.ini'), 'C:\\Game\\Data\\INI\\x.ini');
  assert.equal(combine('C:\\Game\\', '..\\Other'), 'C:\\Other');
  assert.equal(combine('C:\\Game', 'D:\\x'), 'D:\\x');
  assert.equal(combine('C:\\Game\\sub', '\\x'), 'C:\\x');
  const p = 'C:\\Game\\Data\\file.name.ini';
  assert.equal(p.slice(fileNameIndex(p)), 'file.name.ini');
  assert.equal(p.slice(extensionIndex(p)), '.ini');
  assert.equal(extensionIndex('C:\\dir.ext\\noext'), 'C:\\dir.ext\\noext'.length);
  assert.equal(rootLength('\\\\srv\\share\\x'), 12);
  assert.ok(matchSpec('Map.BIG', '*.big;*.txt'));
  assert.ok(!matchSpec('map.bi', '*.big'));
});
