// The engine page's settings defaults a version adds (src/host/openmw.js withSettingsDefaults, put into the page by
// src/host/server.js): OpenMW's locales in the version's language first, English after, and dialogue topics coloured —
// appended to what the page writes to /settings.cfg, under the player's own settings.cfg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/host/server.js';
import { openmwLocales, openmwSettingsDefaults, withSettingsDefaults } from '../src/host/openmw.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';

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

const ENGINE_DEFAULTS = '[GUI]\ncolor topic enable = false\ncolor topic specific = 0.45 0.5 0.8 1\n[General]\nanisotropy = 4\npreferred locales = en\ngmst overrides l10n = true\n';
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

test('the engine page served for a version carries its language\'s locales', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-openmw-settings-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), game = path.join(games, 'sample');
  for (const d of ['base', 'versions/en', 'versions/fr']) fs.mkdirSync(path.join(game, d), { recursive: true });
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'sample', name: 'Sample', defaultVersion: 'sample-en',
    defaults: { runtime: 'openmw', openmw: { engine: 'test-engine', files: [], example: true } },
    versions: [{ id: 'sample-en', dir: 'en', version: 'EN', languages: ['en'] }, { id: 'sample-fr', dir: 'fr', version: 'FR', languages: ['fr'] }] }));
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
