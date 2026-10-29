// The engine page's settings defaults a version adds (src/host/openmw.js withSettingsDefaults, put into the page by
// src/host/server.js): OpenMW's locales in the version's language first, English after, dialogue topics coloured, then
// the version's own (manifest openmw.settings) — appended to what the page writes to /settings.cfg, under the player's
// own settings.cfg; and the version's own for its native simulation peers (openmwSimSettings, tools/openmw/server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/host/server.js';
import { OPENMW_SIM_SETTINGS, openmwLocales, openmwProblem, openmwSettingsDefaults, openmwSimSettings, openmwVersionSettings, withSettingsDefaults } from '../src/host/openmw.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';
import { DEFAULT_GAMES_DIR } from '../src/host/game-catalog.js';

/**
 * OpenMW's settings file reader (components/settings/parser.cpp, SettingsFileParser::loadSettingsFile) on a text: a
 * `[section]` header (again or not) sets the section, `key = value` trimmed, '#' a comment. With `overrideExisting`
 * (the additional defaults, settings.cpp) a later key replaces an earlier one, else a key seen twice is an error.
 */
function loadSettings(text, settings, overrideExisting) {
  let category = '';
  const skip = (line, i) => { while (i < line.length && /\s/.test(line[i])) i++; return i; };
  for (const line of text.split('\n')) {
    let i = skip(line, 0);
    if (i >= line.length || line[i] === '#') continue;
    if (line[i] === '[') {
      const end = line.indexOf(']', i);
      if (end < 0) throw new Error('unterminated category');
      category = line.slice(i + 1, end).trim(); i = end + 1;
    }
    i = skip(line, i);
    if (i >= line.length) continue;
    if (!category) throw new Error('empty category name');
    const eq = line.indexOf('=', i);
    if (eq < 0) throw new Error('unterminated setting name');
    const key = `[${category}] ${line.slice(i, eq).trim()}`, value = line.slice(eq + 1).trim();
    if (!overrideExisting && settings.has(key)) throw new Error(`duplicate setting: ${key}`);
    settings.set(key, value);
  }
  return settings;
}

/**
 * The engine's settings (Settings::Manager::load): `defaults` (its settings-default.cfg), the page's /settings.cfg as
 * additional defaults (overriding), the player's own settings.cfg over them — a key's value as the engine reads it.
 */
function engineSettings(defaults, pageCfg, userCfg = '') {
  const d = loadSettings(defaults, new Map(), false);
  loadSettings(pageCfg, d, true);
  const user = loadSettings(userCfg, new Map(), false);
  return (key) => user.get(key) ?? d.get(key);
}

/** The settings the page writes, as its script runs: `pageScript` around the write, `vars` its variables. */
function written(pageScript, vars = {}) {
  const files = new Map(), log = [];
  const FS = { writeFile: (p, d) => files.set(p, String(d)) };
  new Function('FS', 'append', ...Object.keys(vars), pageScript)(FS, (t) => log.push(t), ...Object.values(vars));
  return { cfg: files.get('/settings.cfg'), log };
}

const ENGINE_DEFAULTS = '[GUI]\ncolor topic enable = false\ncolor topic specific = 0.45 0.5 0.8 1\nsubtitles = false\n[General]\nanisotropy = 4\npreferred locales = en\ngmst overrides l10n = true\n'
  + '[Game]\nbest attack = false\nshow owned = 0\nstrength influences hand to hand = 0\nNPCs avoid collisions = false\n[Map]\nallow zooming = false\n[Video]\nframerate limit = 300\n';
const PAGE = "var settingsCfg = '[Video]\\nwindow mode = 2\\n' + '[General]\\n' + 'anisotropy = 16\\n';\n"
  + "FS.writeFile('/settings.cfg', settingsCfg);\nappend('[cfg] render resolution');";

test('a version\'s locales: its languages first, then English; nothing but locale codes', () => {
  assert.equal(openmwLocales({ languages: ['fr'] }), 'fr,en');
  assert.equal(openmwLocales({ languages: ['en'] }), 'en');
  assert.equal(openmwLocales({ languages: ['fr', 'en'] }), 'fr,en');
  assert.equal(openmwLocales({ languages: ['de-AT'] }), 'de-AT,en');
  assert.equal(openmwLocales({}), 'en', 'no languages: OpenMW\'s own default');
  assert.equal(openmwLocales(null), 'en');
  assert.equal(openmwLocales({ languages: ['fr\n[GUI]', '../x', 'FR', 3] }), 'en', 'no other text in the settings file');
  assert.deepEqual(openmwSettingsDefaults({ languages: ['fr'] }), { General: { 'preferred locales': 'fr,en' }, GUI: { 'color topic enable': 'true' } });
});

test('the page\'s defaults with the version\'s after them: its own [General] keys kept, a [GUI] section, the player\'s settings over them', () => {
  const out = withSettingsDefaults(PAGE, { languages: ['fr'] });
  assert.equal(withSettingsDefaults('<html>no settings write</html>', { languages: ['fr'] }), '<html>no settings write</html>', 'another page: unchanged');
  const { cfg, log } = written(out);
  assert.equal(cfg, '[Video]\nwindow mode = 2\n[General]\nanisotropy = 16\n\n[General]\npreferred locales = fr,en\n[GUI]\ncolor topic enable = true\n');
  assert.deepEqual(log, ['[orthros] settings defaults: [General] preferred locales = fr,en; [GUI] color topic enable = true', '[cfg] render resolution']);
  const get = engineSettings(ENGINE_DEFAULTS, cfg);
  assert.equal(get('[General] preferred locales'), 'fr,en');
  assert.equal(get('[General] anisotropy'), '16', '[General] opened again: the page\'s own key kept');
  assert.equal(get('[General] gmst overrides l10n'), 'true');
  assert.equal(get('[GUI] color topic enable'), 'true');
  assert.equal(get('[GUI] color topic specific'), '0.45 0.5 0.8 1', 'OpenMW\'s own colours');
  assert.equal(get('[Video] window mode'), '2');
  // (the Options menu's Language choice, written to the player's settings.cfg, wins; their file without it: the default)
  assert.equal(engineSettings(ENGINE_DEFAULTS, cfg, '[General]\npreferred locales = en\n')('[General] preferred locales'), 'en');
  assert.equal(engineSettings(ENGINE_DEFAULTS, cfg, '[Video]\ngamma = 1.4\n')('[General] preferred locales'), 'fr,en');
  assert.equal(engineSettings(ENGINE_DEFAULTS, cfg, '[GUI]\ncolor topic enable = false\n')('[GUI] color topic enable'), 'false');
  // (a key written twice is an error in the player's file only: the additional defaults take the later one)
  assert.equal(loadSettings('[General]\npreferred locales = en\n[General]\npreferred locales = fr,en\n', new Map(), true).get('[General] preferred locales'), 'fr,en');
  assert.throws(() => loadSettings('[General]\na = 1\n[General]\na = 2\n', new Map(), false), /duplicate setting/);
  const en = written(withSettingsDefaults(PAGE, { languages: ['en'] })).cfg;
  assert.equal(engineSettings(ENGINE_DEFAULTS, en)('[General] preferred locales'), 'en');
  assert.equal(engineSettings(ENGINE_DEFAULTS, en)('[GUI] color topic enable'), 'true');
});

test('a version\'s own settings: OpenMW\'s names and plain values only, after Orthros\' own, under the player\'s choices', () => {
  const base = { engine: 'v1', files: ['Morrowind.esm'] };
  const settings = { Game: { 'best attack': true, 'show owned': 3, 'NPCs avoid collisions': true }, GUI: { subtitles: true },
    Map: { 'allow zooming': true }, General: { 'preferred locales': 'de,en' }, 'Post Processing': { 'chain': 'bloom,adjustments' } };
  assert.equal(openmwProblem({ ...base, settings }), null);
  assert.equal(openmwProblem({ ...base, settings: {} }), null);
  assert.equal(openmwProblem({ ...base, settings: { Game: { 'swim upward coef': -0.5 } } }), null);
  for (const bad of [[], 'x', null, { Game: [] }, { Game: { 'best attack': null } }, { Game: { 'best attack': { a: 1 } } },
    { Game: { 'best attack': ['true'] } }, { Game: { 'best attack': Infinity } }, { Game: { 'a': 1e21 } },
    { 'Game]\n[Video': { a: 1 } }, { '': { a: 1 } }, { ' Game': { a: 1 } }, { Game: { 'a = 1\nb': 1 } }, { Game: { 'a=b': 1 } },
    { Game: { '# a': 1 } }, { Game: { 'best attack ': true } }, { Game: { a: 'x\ny' } }, { Game: { a: '</script><script>alert(1)' } },
    { Game: { a: ' padded' } }, { Game: { a: 'x'.repeat(201) } }, { Game: { ['k'.repeat(65)]: 1 } }, { Game: { __proto__x: 1 } }])
    assert.ok(openmwProblem({ ...base, settings: bad }), JSON.stringify(bad));
  assert.deepEqual(openmwVersionSettings({ openmw: { ...base, settings } }), {
    Game: { 'best attack': 'true', 'show owned': '3', 'NPCs avoid collisions': 'true' }, GUI: { subtitles: 'true' },
    Map: { 'allow zooming': 'true' }, General: { 'preferred locales': 'de,en' }, 'Post Processing': { chain: 'bloom,adjustments' } });
  assert.deepEqual(openmwVersionSettings({ openmw: { ...base, settings: { Game: { a: 'x\ny' } } } }), {}, 'invalid: none');
  assert.deepEqual(openmwVersionSettings({}), {});
  // (Orthros' own first, the version's after them: a key of both is the version's)
  const man = { languages: ['fr'], openmw: { ...base, settings } };
  assert.deepEqual(openmwSettingsDefaults(man), {
    General: { 'preferred locales': 'de,en' }, GUI: { 'color topic enable': 'true', subtitles: 'true' },
    Game: { 'best attack': 'true', 'show owned': '3', 'NPCs avoid collisions': 'true' }, Map: { 'allow zooming': 'true' },
    'Post Processing': { chain: 'bloom,adjustments' } });
  const { cfg, log } = written(withSettingsDefaults(PAGE, man));
  assert.equal(cfg.split('[General]').length - 1, 2, 'the page\'s [General], then Orthros\' — one block each');
  assert.match(log[0], /^\[orthros\] settings defaults: \[General\] preferred locales = de,en; \[GUI\] color topic enable = true; \[GUI\] subtitles = true; \[Game\] best attack = true; /);
  const get = engineSettings(ENGINE_DEFAULTS, cfg);
  assert.equal(get('[Game] best attack'), 'true');
  assert.equal(get('[Game] show owned'), '3');
  assert.equal(get('[GUI] subtitles'), 'true');
  assert.equal(get('[Map] allow zooming'), 'true');
  assert.equal(get('[GUI] color topic enable'), 'true');
  assert.equal(get('[Game] strength influences hand to hand'), '0', 'a key the version does not name: the engine\'s');
  // (the player's own settings.cfg — the Options menu's Best attack, Subtitles — still wins; their file without them: the version's)
  const player = engineSettings(ENGINE_DEFAULTS, cfg, '[Game]\nbest attack = false\n[GUI]\nsubtitles = false\n');
  assert.equal(player('[Game] best attack'), 'false');
  assert.equal(player('[GUI] subtitles'), 'false');
  assert.equal(player('[Game] show owned'), '3');
  // (a value that could end the page's script is refused, so the page gets none of an invalid set)
  assert.equal(written(withSettingsDefaults(PAGE, { languages: ['en'], openmw: { ...base, settings: { Game: { a: '</script>' } } } })).cfg.includes('[Game]'), false);
});

test('the simulation peers: the version\'s settings as additional defaults, the gateway\'s own peer settings over them', () => {
  assert.equal(OPENMW_SIM_SETTINGS, '/usr/local/etc/openmw/settings.cfg');
  const man = { openmw: { engine: 'v1', files: ['Morrowind.esm'], settings: {
    Game: { 'NPCs avoid collisions': true, 'strength influences hand to hand': 2 }, Video: { 'framerate limit': 60 } } } };
  const text = openmwSimSettings(man);
  assert.match(text, /^# Orthros: /);
  assert.equal(text.split('\n').slice(1).join('\n'), '[Game]\nNPCs avoid collisions = true\nstrength influences hand to hand = 2\n[Video]\nframerate limit = 60\n');
  assert.ok(!/preferred locales|color topic/.test(text), 'the page\'s own defaults stay in the page');
  // (the native engine's config dirs for a peer: the image's global one — defaults.bin, this file as additional defaults —
  // then the world's peer-config, whose settings.cfg the gateway writes at each world start: the last, the peer's own)
  const peerCfg = '# GENERATED by openmw-mp for the Phase H simulation peer. Edits are overwritten.\n[Video]\nframerate limit = 20\nvsync mode = 0\n';
  const get = engineSettings(ENGINE_DEFAULTS, text, peerCfg);
  assert.equal(get('[Game] NPCs avoid collisions'), 'true');
  assert.equal(get('[Game] strength influences hand to hand'), '2');
  assert.equal(get('[Video] framerate limit'), '20', 'the gateway\'s pacing wins');
  assert.equal(get('[Game] best attack'), 'false');
  // (a version without settings: a comment only, nothing changed)
  const none = openmwSimSettings({ openmw: { engine: 'v1', files: ['x'] } });
  assert.equal(none.split('\n').filter((l) => l && !l.startsWith('#')).length, 0);
  assert.equal(engineSettings(ENGINE_DEFAULTS, none, peerCfg)('[Game] NPCs avoid collisions'), 'false');
});

test('the installed versions\' settings are OpenMW\'s, with values of their type', () => {
  const source = path.join(DEFAULT_ENGINES_DIR, 'src/openmw-web-v1.5.3/openmw-web-v1.5.3/openmw/files/settings-default.cfg');
  if (!fs.existsSync(source) || !fs.existsSync(DEFAULT_GAMES_DIR)) return;
  const defaults = loadSettings(fs.readFileSync(source, 'utf8'), new Map(), false);
  const kind = (v) => /^(true|false)$/.test(v) ? 'boolean' : /^-?\d+$/.test(v) ? 'integer' : /^-?\d*\.\d+$/.test(v) ? 'number' : 'text';
  for (const game of fs.readdirSync(DEFAULT_GAMES_DIR)) {
    let spec; try { spec = JSON.parse(fs.readFileSync(path.join(DEFAULT_GAMES_DIR, game, 'manifest.json'), 'utf8')); } catch { continue; }
    for (const v of [spec.defaults ?? {}, ...(spec.versions ?? [])]) {
      for (const [section, kv] of Object.entries(openmwVersionSettings(v))) for (const [key, value] of Object.entries(kv)) {
        const name = `${game} ${v.id ?? 'defaults'} [${section}] ${key}`, engine = defaults.get(`[${section}] ${key}`);
        // (an unknown key in additional defaults is kept without a word, and never read)
        assert.ok(engine !== undefined, `${name}: not an OpenMW setting`);
        assert.ok(kind(engine) === kind(value) || (kind(engine) === 'number' && kind(value) === 'integer'), `${name} = ${value}: OpenMW's is ${engine}`);
      }
    }
  }
});

test('the engine page served for a version carries its language\'s locales', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-openmw-settings-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), game = path.join(games, 'sample');
  for (const d of ['base', 'versions/en', 'versions/fr']) fs.mkdirSync(path.join(game, d), { recursive: true });
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'sample', name: 'Sample', defaultVersion: 'sample-en',
    defaults: { runtime: 'openmw', openmw: { engine: 'test-engine', files: [], example: true } },
    versions: [{ id: 'sample-en', dir: 'en', version: 'EN', languages: ['en'] },
      { id: 'sample-fr', dir: 'fr', version: 'FR', languages: ['fr'], openmw: { engine: 'test-engine', files: [], example: true, settings: { Game: { 'best attack': true }, GUI: { subtitles: true } } } }] }));
  const release = path.join(engines, 'test-engine');
  fs.mkdirSync(path.join(release, 'e/abc'), { recursive: true });
  fs.writeFileSync(path.join(release, 'index.html'), `<html><head></head><body><script>${PAGE}</script></body></html>`);
  fs.writeFileSync(path.join(release, 'e/abc/openmw.wasm'), 'wasm');
  fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify({ runtime: 'openmw', files: ['e/abc/openmw.wasm'] }));
  const server = createServer({ gamesDir: games, enginesDir: engines });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [id, locales] of [['sample-fr', 'fr,en'], ['sample-en', 'en']]) {
    const page = await (await fetch(`${base}/ports/openmw/${id}/app/index.html`)).text();
    const script = /<script>(var settingsCfg[\s\S]*?)<\/script>/.exec(page)[1];
    const get = engineSettings(ENGINE_DEFAULTS, written(script).cfg);
    assert.equal(get('[General] preferred locales'), locales, id);
    assert.equal(get('[GUI] color topic enable'), 'true', id);
    // (the French version's own settings in its page only; the other keeps the engine's)
    assert.equal(get('[Game] best attack'), id === 'sample-fr' ? 'true' : 'false', id);
    assert.equal(get('[GUI] subtitles'), id === 'sample-fr' ? 'true' : 'false', id);
  }
});

test('the releases\' settings block: the settings written once, the whole file read as OpenMW reads it', () => {
  const source = path.join(DEFAULT_ENGINES_DIR, 'src/openmw-web-v1.5.3/openmw-web-v1.5.3/openmw/files/settings-default.cfg');
  const engineDefaults = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : ENGINE_DEFAULTS;
  if (engineDefaults !== ENGINE_DEFAULTS) {
    // (the keys are OpenMW's: an unknown one in the additional defaults would be ignored without a word)
    const defaults = loadSettings(engineDefaults, new Map(), false);
    assert.equal(defaults.get('[General] preferred locales'), 'en');
    assert.equal(defaults.get('[GUI] color topic enable'), 'false');
  }
  const releases = fs.existsSync(DEFAULT_ENGINES_DIR) ? fs.readdirSync(DEFAULT_ENGINES_DIR).filter((d) => /^openmw-web-/.test(d) && fs.existsSync(path.join(DEFAULT_ENGINES_DIR, d, 'index.html'))) : [];
  for (const id of releases) {
    const html = withSettingsDefaults(fs.readFileSync(path.join(DEFAULT_ENGINES_DIR, id, 'index.html'), 'utf8'), { languages: ['fr'] });
    assert.equal(html.split("settingsCfg + \"\\n[General]\\npreferred locales = fr,en\\n[GUI]\\ncolor topic enable = true\\n\")").length - 1, 1, id);
    // (the page's own block, run as the page runs it on a plain URL, then the version's write)
    const from = html.indexOf('var settingsCfg ='), to = html.indexOf("append('[cfg] render resolution", from);
    const tier = { vd: '12288', minSize: '0.01', shadowRes: '4096', shadowDist: '768', rtt: '1024', actors: '7168', lru: 96 };
    const { cfg } = written(html.slice(from, to), { rW: 1280, rH: 720, TIER: tier, location: { search: '' }, ENV: {} });
    const get = engineSettings(engineDefaults, cfg);
    assert.equal(get('[General] preferred locales'), 'fr,en', id);
    assert.equal(get('[General] anisotropy'), '16', id);
    assert.equal(get('[GUI] color topic enable'), 'true', id);
    assert.equal(get('[Video] resolution x'), '1280', id);
  }
});
