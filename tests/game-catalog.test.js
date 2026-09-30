import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGameCatalog, defaultGameManifest } from '../src/host/game-catalog.js';
import { createServer } from '../src/host/server.js';

function game(root, id, spec) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'base'), { recursive: true });
  for (const version of spec.versions) fs.mkdirSync(path.join(dir, 'versions', version.dir), { recursive: true });
  fs.writeFileSync(path.join(dir, 'base', 'Game.exe'), id);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, name: id, defaultVersion: spec.versions[0].id, ...spec }));
  return dir;
}

test('catalog discovers a new game folder and serves its version without source changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-games-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  game(root, 'alpha', { versions: [{ id: 'alpha-1', dir: '1.0', version: '1.0', exe: 'game.exe' }] });
  const server = createServer({ gamesDir: root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(`${base}/api/manifests`)).json()).map((m) => m.name), ['alpha-1']);
  game(root, 'beta', { versions: [{ id: 'beta-1', dir: '1.0', version: '1.0', exe: 'Game.exe' }] });
  assert.deepEqual((await (await fetch(`${base}/api/manifests`)).json()).map((m) => m.name), ['alpha-1', 'beta-1']);
  assert.equal(await (await fetch(`${base}/game/beta-1/Game.exe`)).text(), 'beta');
});

test('catalog enforces the manifest and resolves declared game dependencies', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-games-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'incomplete'));
  assert.throws(() => loadGameCatalog(root), /manifest.json obligatoire/);
  fs.rmdirSync(path.join(root, 'incomplete'));
  game(root, 'alpha', { versions: [{ id: 'alpha-1', dir: '1.0', version: '1.0', exe: 'Game.exe' }] });
  game(root, 'beta', { versions: [{ id: 'beta-1', dir: '1.0', version: '1.0', exe: 'Game.exe', requires: [{ game: 'alpha', version: 'alpha-1', mount: 'C:\\Alpha' }] }] });
  assert.deepEqual(loadGameCatalog(root).get('beta-1').extraMounts, [{ mount: 'C:\\Alpha', manifest: 'alpha-1' }]);
  assert.deepEqual(defaultGameManifest(path.join(root, 'beta')).extraMounts, [{ mount: 'C:\\Alpha', manifest: 'alpha-1' }]);
  const file = path.join(root, 'beta', 'manifest.json');
  const bad = JSON.parse(fs.readFileSync(file, 'utf8'));
  bad.versions[0].requires[0].version = 'missing';
  fs.writeFileSync(file, JSON.stringify(bad));
  assert.throws(() => loadGameCatalog(root), /dépendance introuvable/);
});
