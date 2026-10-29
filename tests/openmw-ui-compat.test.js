import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

/** One more installed script mod in the fixture's version (its plugin `<Id>.omwscripts` holding `declaration`). */
function addMod(f, id, declaration) {
  const data = path.join(f.game, `versions/one/mods/${id}-0`), plugin = `${id}.omwscripts`, file = path.join(f.game, 'manifest.json');
  fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, plugin), declaration);
  const spec = JSON.parse(fs.readFileSync(file));
  spec.versions[0].openmw.mods.push({ id, name: id, installed: true, parts: [{ dir: `mods/${id}-0`, sentinel: plugin, plugins: [plugin], archives: [] }] });
  fs.writeFileSync(file, JSON.stringify(spec));
  return { data, plugin };
}

test('OpenMW guards only the selected declaration types of a mod with gameplay scripts; the rest still runs on simulation peers', (t) => {
  const f = fixture(t), declaration = 'MENU: scripts/inv/settings.lua\nGLOBAL: scripts/inv/global.lua\nPLAYER: scripts/inv/player.lua\n'
    + 'CUSTOM: scripts/inv/equip.lua\nCONTAINER: scripts/inv/container.lua\nARMOR, BOOK: scripts/inv/item.lua\n';
  const inv = addMod(f, 'inv', declaration), only = addMod(f, 'world', 'GLOBAL: scripts/world/global.lua\n');
  assert.throws(() => guardClientUi(f.game, 'one', ['world:MENU,PLAYER']), /No enabled UI script plugin: world/, 'nothing of those types to guard');
  assert.throws(() => guardClientUi(f.game, 'one', ['inv:menu']), /Expected <mod-id> or <mod-id>:TYPE/);
  const result = guardClientUi(f.game, 'one', ['menu', 'inv:MENU,PLAYER']);
  assert.deepEqual(result, { plugins: ['Menu.omwscripts', 'inv.omwscripts'], wrappers: 4 });
  assert.equal(fs.readFileSync(path.join(inv.data, inv.plugin), 'utf8'), declaration, 'the author file is unchanged');
  const mods = JSON.parse(fs.readFileSync(path.join(f.game, 'manifest.json'))).versions[0].openmw.mods, compat = mods.at(-1);
  assert.deepEqual(mods.find((m) => m.id === 'inv').parts[0].plugins, [], 'the plugin selection moves to the generated root');
  assert.deepEqual(mods.find((m) => m.id === 'world').parts[0].plugins, [only.plugin]);
  assert.deepEqual(compat.guardedPlugins, [{ mod: 'menu', plugin: 'Menu.omwscripts' }, { mod: 'inv', plugin: 'inv.omwscripts', guardedTypes: ['MENU', 'PLAYER'] }]);
  assert.deepEqual(compat.unguardedEntries.map((e) => e.entry), ['GLOBAL: scripts/inv/global.lua', 'CONTAINER: scripts/inv/container.lua', 'ARMOR, BOOK: scripts/inv/item.lua']);
  const generated = fs.readFileSync(path.join(f.game, 'versions/one', compat.parts[0].dir, inv.plugin), 'utf8');
  assert.equal(generated, 'MENU: scripts/orthros_client_ui/2.lua\nGLOBAL: scripts/inv/global.lua\nPLAYER: scripts/orthros_client_ui/3.lua\n'
    + 'CUSTOM: scripts/inv/equip.lua\nCONTAINER: scripts/inv/container.lua\nARMOR, BOOK: scripts/inv/item.lua\n');
});

test('OpenMW refuses a declaration that mixes guarded and kept types, before changing the installation', (t) => {
  const f = fixture(t); addMod(f, 'mixed', 'PLAYER, GLOBAL: scripts/mixed/both.lua\n');
  const manifest = fs.readFileSync(path.join(f.game, 'manifest.json'));
  assert.throws(() => guardClientUi(f.game, 'one', ['mixed:MENU,PLAYER']), /mixes guarded and kept types/);
  assert.deepEqual(fs.readFileSync(path.join(f.game, 'manifest.json')), manifest);
  assert.equal(fs.existsSync(path.join(f.game, 'versions/one/mods/client-ui-compat-0')), false);
});

test('OpenMW guards UI addons installed later in a second root with its own wrappers', (t) => {
  const f = fixture(t);
  guardClientUi(f.game, 'one', ['menu']);
  const later = addMod(f, 'later', 'PLAYER: scripts/later/player.lua\n');
  assert.throws(() => guardClientUi(f.game, 'one', ['later']), /already installed/);
  assert.throws(() => guardClientUi(f.game, 'one', ['later'], { id: 'Bad id' }), /Invalid compatibility mod id/);
  assert.deepEqual(guardClientUi(f.game, 'one', ['later'], { id: 'later-ui-compat' }), { plugins: [later.plugin], wrappers: 1 });
  const mods = JSON.parse(fs.readFileSync(path.join(f.game, 'manifest.json'))).versions[0].openmw.mods;
  assert.deepEqual(mods.map((m) => m.id), ['menu', 'client-ui-compat', 'later', 'later-ui-compat']);
  assert.equal(openmwProblem({ engine: 'engine', files: ['Game.esm'], mods }), null);
  const root = path.join(f.game, 'versions/one/mods/later-ui-compat-0');
  assert.equal(fs.readFileSync(path.join(root, later.plugin), 'utf8'), 'PLAYER: scripts/orthros_later_ui/0.lua\n');
  assert.match(fs.readFileSync(path.join(root, 'scripts/orthros_later_ui/0.lua'), 'utf8'), /require\("scripts\.later\.player"\)/);
  assert.ok(fs.existsSync(path.join(f.game, 'versions/one/mods/client-ui-compat-0/scripts/orthros_client_ui/0.lua')), 'the first root unchanged');
  // a wrapper folder an earlier root already holds is refused
  fs.mkdirSync(path.join(f.game, 'versions/one/mods/later-0/scripts/orthros_third_ui'), { recursive: true });
  addMod(f, 'third', 'PLAYER: scripts/third/player.lua\n');
  assert.throws(() => guardClientUi(f.game, 'one', ['third'], { id: 'third-ui-compat' }), /already exists in mods\/later-0/);
});

test('OpenMW installs a mod data root holding only Lua scripts or l10n texts (an overlay, a translation)', (t) => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-install-mod-'));
  t.after(() => fs.rmSync(game, { recursive: true, force: true }));
  const src = path.join(game, 'src'), tool = new URL('../tools/openmw/install-mod.mjs', import.meta.url).pathname;
  fs.mkdirSync(path.join(src, 'l10n/Mod'), { recursive: true }); fs.writeFileSync(path.join(src, 'l10n/Mod/fr.yaml'), 'key: "valeur"\n');
  fs.mkdirSync(path.join(game, 'versions/one'), { recursive: true });
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ versions: [{ id: 'one', dir: 'one', openmw: { engine: 'engine', files: ['Game.esm'],
    mods: [{ id: 'texts-fr', name: 'Texts', installed: false }] } }] }));
  const run = spawnSync(process.execPath, [tool, game, 'one', 'texts-fr', src, '--part', '.'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const mod = JSON.parse(fs.readFileSync(path.join(game, 'manifest.json'))).versions[0].openmw.mods[0];
  assert.equal(mod.installed, true);
  assert.deepEqual(mod.parts[0], { dir: 'mods/texts-fr-0', source: '.', sentinel: 'l10n/Mod/fr.yaml', plugins: [], archives: [], files: 1, bytes: 14 });
  assert.equal(fs.readFileSync(path.join(game, 'versions/one/mods/texts-fr-0/l10n/Mod/fr.yaml'), 'utf8'), 'key: "valeur"\n');
});
