import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardClientUi } from '../tools/openmw/guard-client-ui.mjs';
import { openmwProblem } from '../src/host/openmw.js';

function fixture(t, declaration = 'PLAYER: scripts/menu/player.lua\nMENU: scripts/menu/settings.lua\nCUSTOM: scripts/menu/actor.lua\n') {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-ui-compat-'));
  t.after(() => fs.rmSync(game, { recursive: true, force: true }));
  const data = path.join(game, 'versions/one/mods/menu-0'); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'Menu.omwscripts'), declaration);
  const spec = { versions: [{ id: 'one', dir: 'one', openmw: { engine: 'engine', files: ['Game.esm'], mods: [
    { id: 'menu', name: 'Menu', installed: true, parts: [{ dir: 'mods/menu-0', sentinel: 'Menu.omwscripts', plugins: ['Menu.omwscripts'], archives: [] }] },
  ] } }] };
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify(spec));
  return { game, data, declaration };
}

test('OpenMW client UI guards preserve the author files and give both peers one matching plugin selection', (t) => {
  const f = fixture(t), result = guardClientUi(f.game, 'one', ['menu']);
  assert.deepEqual(result, { plugins: ['Menu.omwscripts'], wrappers: 2 });
  assert.equal(fs.readFileSync(path.join(f.data, 'Menu.omwscripts'), 'utf8'), f.declaration);
  const config = JSON.parse(fs.readFileSync(path.join(f.game, 'manifest.json'))).versions[0].openmw;
  assert.equal(openmwProblem(config), null);
  assert.deepEqual(config.mods.flatMap((m) => m.parts.flatMap((p) => p.plugins)), ['Menu.omwscripts']);
  const compat = path.join(f.game, 'versions/one', config.mods.at(-1).parts[0].dir);
  const entries = fs.readFileSync(path.join(compat, 'Menu.omwscripts'), 'utf8').trim().split('\n');
  assert.equal(entries[2], 'CUSTOM: scripts/menu/actor.lua', 'Explicit attachment keeps its registered script identity');
  for (const [index, entry] of entries.slice(0, 2).entries()) {
    const wrapper = fs.readFileSync(path.join(compat, entry.split(': ')[1]), 'utf8');
    assert.match(wrapper, /mp\.isSystem\(\) then return \{\} end/);
    assert.ok(wrapper.includes(index ? 'scripts.menu.settings' : 'scripts.menu.player'));
  }
  const manifest = fs.readFileSync(path.join(f.game, 'manifest.json'));
  assert.throws(() => guardClientUi(f.game, 'one', ['menu']), /already installed/);
  assert.deepEqual(fs.readFileSync(path.join(f.game, 'manifest.json')), manifest);
});

test('OpenMW rejects unsupported UI declarations before changing the installation', (t) => {
  const f = fixture(t, 'PLAYER: ../escape.lua\n');
  const manifest = fs.readFileSync(path.join(f.game, 'manifest.json'));
  assert.throws(() => guardClientUi(f.game, 'one', ['menu']), /Unsupported/);
  assert.deepEqual(fs.readFileSync(path.join(f.game, 'manifest.json')), manifest);
  assert.equal(fs.existsSync(path.join(f.game, 'versions/one/mods/client-ui-compat-0')), false);
});
