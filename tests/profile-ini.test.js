// A new player's settings (manifest newProfileIni, src/vfs/profile-ini.js): set in the profile's existing ini file — a
// file of no sections, as SAGE's Options.ini — only the key changed, the rest byte for byte; set again, nothing; a file
// the profile does not have is left to the game's first launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemBackend } from '../src/vfs/vfs.js';
import { applyNewProfileIni, newProfileIniProblem, profileIniUsesMode } from '../src/vfs/profile-ini.js';

const FILE = 'AppData/Roaming/Age of the Ring/Options.ini';
const SPEC = { [FILE]: { '': { Resolution: '{modeWidth} {modeHeight}' } }, 'AppData/Roaming/Other/Options.ini': { '': { Resolution: '{modeWidth} {modeHeight}' } } };
// (the shared first-launch file as the server offers it)
const SEED = 'AudioLOD = High\r\nHasSeenLogoMovies = yes\r\nIdealStaticGameLOD = Medium\r\nResolution = 1024 768\r\nStaticGameLOD = Medium\r\nTimesInGame = 1\r\n';

test('a new player\'s settings: the key set in the existing file, the rest kept, once; no file made', () => {
  assert.equal(newProfileIniProblem(SPEC), null);
  assert.ok(profileIniUsesMode(SPEC));
  assert.match(newProfileIniProblem({ [FILE]: { '': { Resolution: '{modeWide}' } } }), /inconnu/);
  const b = new MemBackend();
  for (const d of ['AppData', 'AppData/Roaming', 'AppData/Roaming/Age of the Ring']) b.mkdir(d);
  b.open(FILE, { create: true }).write(0, new TextEncoder().encode(SEED));
  const read = () => new TextDecoder().decode(b.open(FILE).read(0, b.stat(FILE).size));
  assert.deepEqual(applyNewProfileIni(b, SPEC, { mode: [2560, 1440] }), [FILE]);
  assert.equal(read(), SEED.replace('Resolution = 1024 768', 'Resolution = 2560 1440'));
  assert.deepEqual(applyNewProfileIni(b, SPEC, { mode: [2560, 1440] }), []);
  assert.deepEqual(applyNewProfileIni(b, SPEC, { mode: null }), [], 'no mode known: the key as the file has it');
  assert.equal(b.stat('AppData/Roaming/Other/Options.ini'), null);
});
