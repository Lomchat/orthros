// A GoldSrc release's own archives as loose game files (tools/goldsrc/release-gamefiles.py, docs/browser-ports.md
// "The release's own game files"): each member under gamefiles/<the archive's folder>/, listed in release.json, its
// time its bytes'; what the game's server precaches at every map's load listed (mapPrecache); a release derived from an
// installed one without rebuilding it; collisions and an installed release refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/goldsrc/release-gamefiles.py');
const run = (...args) => spawnSync('python3', ['-I', TOOL, ...args], { encoding: 'utf8' });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** A .pk3 (zip) at `file` with `members` { name: text }, written by Python's zipfile. */
function pk3(file, members) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync('python3', ['-I', '-c', 'import json, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:\n  for n, t in json.loads(sys.argv[2]).items(): z.writestr(n, t)', file, JSON.stringify(members)]);
  assert.equal(r.status, 0, String(r.stderr));
}

function release(t) {
  const engines = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-release-gamefiles-'));
  t.after(() => fs.rmSync(engines, { recursive: true, force: true }));
  const dir = path.join(engines, 'rel-r1');
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine', 'xash.wasm'), 'wasm');
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ id: 'rel-r1', engine: 'e', files: [{ path: 'engine/xash.wasm', sha256: sha('wasm'), bytes: 4 }] }));
  pk3(path.join(dir, 'mod', 'cstrike', 'bots.pk3'), { 'BotProfile.db': 'profiles', 'maps/m1.nav': 'mesh 1', 'maps/m2.nav': 'mesh 2' });
  pk3(path.join(dir, 'mod', 'cstrike', 'pets.pk3'), { 'models/pet/a.mdl': 'model', 'sound/pet/a.wav': 'sound' });
  return { engines, dir };
}

test('an archive\'s members as loose files under gamefiles/<its folder>/, each listed in release.json with its digest', (t) => {
  const { dir } = release(t);
  const r = run(dir, 'mod/cstrike/bots.pk3', '--map-precache=mod/cstrike/pets.pk3');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /5 game files/);
  assert.equal(fs.readFileSync(path.join(dir, 'gamefiles', 'cstrike', 'maps', 'm2.nav'), 'utf8'), 'mesh 2');
  assert.equal(fs.readFileSync(path.join(dir, 'gamefiles', 'cstrike', 'models', 'pet', 'a.mdl'), 'utf8'), 'model');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
  assert.deepEqual(meta.gameFilesFrom, ['mod/cstrike/bots.pk3', 'mod/cstrike/pets.pk3']);
  // (the archive marked: its members, relative to the game folder — the page announces them with each map)
  assert.deepEqual(meta.mapPrecache, ['models/pet/a.mdl', 'sound/pet/a.wav']);
  assert.deepEqual(meta.files.map((f) => f.path), ['engine/xash.wasm', 'gamefiles/cstrike/BotProfile.db', 'gamefiles/cstrike/maps/m1.nav', 'gamefiles/cstrike/maps/m2.nav',
    'gamefiles/cstrike/models/pet/a.mdl', 'gamefiles/cstrike/sound/pet/a.wav']);
  assert.deepEqual(meta.files[2], { path: 'gamefiles/cstrike/maps/m1.nav', sha256: sha('mesh 1'), bytes: 6 });
  // (the archives stay: an older manifest's goldsrc.extras names them)
  assert.ok(fs.existsSync(path.join(dir, 'mod', 'cstrike', 'bots.pk3')));
});

test('a loose file\'s time is its bytes\': two builds whose archives differ in time only give the same keys, a changed file another', (t) => {
  const { dir } = release(t), { dir: again } = release(t);
  // (the second build's archive written later, one member changed at the same size)
  pk3(path.join(again, 'mod', 'cstrike', 'bots.pk3'), { 'BotProfile.db': 'profiles', 'maps/m1.nav': 'mesh 1', 'maps/m2.nav': 'mesh 3' });
  fs.utimesSync(path.join(again, 'mod', 'cstrike', 'bots.pk3'), new Date('2030-01-01'), new Date('2030-01-01'));
  assert.equal(run(dir, 'mod/cstrike/bots.pk3').status, 0); assert.equal(run(again, 'mod/cstrike/bots.pk3').status, 0);
  const time = (d, rel) => fs.statSync(path.join(d, 'gamefiles', 'cstrike', rel)).mtimeMs;
  assert.equal(time(again, 'maps/m1.nav'), time(dir, 'maps/m1.nav'));
  assert.equal(time(again, 'BotProfile.db'), time(dir, 'BotProfile.db'));
  assert.notEqual(time(again, 'maps/m2.nav'), time(dir, 'maps/m2.nav'), 'same size, other bytes: another key');
  assert.notEqual(time(dir, 'maps/m1.nav'), time(dir, 'maps/m2.nav'));
  for (const rel of ['maps/m1.nav', 'maps/m2.nav']) {
    const s = time(again, rel) / 1000;
    assert.ok(s >= Date.UTC(1980, 0, 1) / 1000 && s < Date.now() / 1000, 'from 1980, never in the future');
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')).mapPrecache, undefined, 'none marked: no list');
});

test('two archives giving one path, a member outside its folder, a path already there: refused', (t) => {
  const { dir } = release(t);
  pk3(path.join(dir, 'mod', 'cstrike', 'more.pk3'), { 'MAPS/M1.NAV': 'other mesh' });
  assert.match(run(dir, 'mod/cstrike/bots.pk3', 'mod/cstrike/more.pk3').stderr, /in mod\/cstrike\/bots\.pk3 and mod\/cstrike\/more\.pk3/);
  pk3(path.join(dir, 'mod', 'cstrike', 'evil.pk3'), { '../escape.txt': 'x' });
  assert.match(run(dir, 'mod/cstrike/evil.pk3').stderr, /outside its folder/);
  assert.equal(fs.existsSync(path.join(dir, 'gamefiles', 'escape.txt')), false);
  const { dir: again } = release(t);
  assert.equal(run(again, 'mod/cstrike/bots.pk3').status, 0);
  assert.match(run(again, 'mod/cstrike/bots.pk3').stderr, /already in the release/);
  assert.match(run(again, 'engine/xash.wasm').stderr, /not an archive/);
});

test('a release derived from an installed one: its files copied, its id and origin, the archives\' members; never over an installed one', (t) => {
  const { engines, dir } = release(t);
  const r = run('--derive', engines, 'rel-r1', 'rel-r2', 'mod/cstrike/bots.pk3');
  assert.equal(r.status, 0, r.stderr);
  const meta = JSON.parse(fs.readFileSync(path.join(engines, 'rel-r2', 'release.json'), 'utf8'));
  assert.equal(meta.id, 'rel-r2'); assert.equal(meta.derivedFrom, 'rel-r1'); assert.equal(meta.engine, 'e');
  assert.equal(fs.readFileSync(path.join(engines, 'rel-r2', 'engine', 'xash.wasm'), 'utf8'), 'wasm');
  assert.equal(fs.statSync(path.join(engines, 'rel-r2', 'engine', 'xash.wasm')).mtimeMs, fs.statSync(path.join(dir, 'engine', 'xash.wasm')).mtimeMs, 'times kept');
  assert.equal(fs.readFileSync(path.join(engines, 'rel-r2', 'gamefiles', 'cstrike', 'maps', 'm1.nav'), 'utf8'), 'mesh 1');
  assert.equal(fs.existsSync(path.join(dir, 'gamefiles')), false, 'the installed release untouched');
  assert.equal(fs.readdirSync(engines).some((n) => n.startsWith('.')), false, 'no staging left');
  assert.match(run('--derive', engines, 'rel-r1', 'rel-r2', 'mod/cstrike/bots.pk3').stderr, /never overwritten/);
  assert.match(run('--derive', engines, 'rel-r2', 'rel-r3', 'mod/cstrike/pets.pk3').stderr, /gamefiles\/ already/);
  pk3(path.join(dir, 'mod', 'cstrike', 'evil.pk3'), { '../escape.txt': 'x' });
  assert.match(run('--derive', engines, 'rel-r1', 'rel-r4', 'mod/cstrike/evil.pk3').stderr, /outside its folder/);
  assert.deepEqual(fs.readdirSync(engines).sort(), ['rel-r1', 'rel-r2'], 'a refused derivation leaves nothing');
});

test('the lock: only the builds that say gameFiles get loose files (an older id rebuilds as pinned); a precached asset in such a build only', () => {
  const lock = JSON.parse(fs.readFileSync(path.resolve(path.dirname(TOOL), 'lock.json'), 'utf8'));
  const builds = new Map(lock.modules.builds.map((b) => [b.id, b]));
  for (const id of ['xash3d-web-1.2.2-cs16-15278ca-r2', 'xash3d-web-1.2.2-cs16-15278ca-arsenal-r12']) assert.equal(builds.get(id).gameFiles, undefined, id);
  for (const id of ['xash3d-web-1.2.2-cs16-15278ca-r3', 'xash3d-web-1.2.2-cs16-15278ca-arsenal-r13']) assert.equal(builds.get(id).gameFiles, true, id);
  for (const b of builds.values()) for (const a of b.assets ?? []) if (a.mapPrecache !== undefined) assert.ok(a.mapPrecache === true && b.gameFiles === true, b.id);
  const script = fs.readFileSync(path.resolve(path.dirname(TOOL), 'build-modules.sh'), 'utf8');
  assert.match(script, /if build_spec\.get\('gameFiles'\):\n\s+archives = /);
});
