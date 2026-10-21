// re3 browser ports (docs/browser-ports.md, "re3 ports"): a game version whose manifest says "runtime": "re3" does not
// run in the Win32 runtime. Its page (src/ports/re3/) runs a decompiled engine of the re3 family compiled to
// WebAssembly (Emscripten: SDL2 on WebGL 2, OpenAL on WebAudio, JSPI), a pinned release installed outside Git in
// data_engines/<release>/: its ES module and WebAssembly under engine/, and the engine's own extra game files under
// gamefiles/, laid over the version's files (game-files.js gameLayers: the catalog puts that folder in the manifest's
// `overlays`). This module checks such a manifest entry, tells whether its release is installed and which module the
// page imports. Single player only for now: one game, or several ways to play it (`modes`: their own command-line
// arguments, the player's choice on the page). Nothing here names a game: release, arguments, environment, settings
// and modes come from the manifest; the module's name from the release.
import fs from 'node:fs';
import path from 'node:path';
import { engineFile } from './goldsrc.js';

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const ARG = /^[-+]?[A-Za-z0-9_.=]{1,64}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,31}$/;
const MODE = /^[a-z][a-z0-9-]{0,15}$/;
const PRINTABLE = /^[\x20-\x7e]*$/; // (ASCII: an ini file is edited byte for byte, the environment as C strings)
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const safePath = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && PRINTABLE.test(value) && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'));
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && PRINTABLE.test(value);
// (an ini file's section and key names: one line each, nothing that would open a section, end a name or start a comment)
const sectionOk = (name) => text(name, 1, 64) && !/[[\]]/.test(name) && name.trim() === name;
const keyOk = (name) => text(name, 1, 64) && !/[=[\]]/.test(name) && !/^[;#]/.test(name) && name.trim() === name;
// (a value as an ini reader reads it: without spaces around, which the line's own spacing would merge with)
const valueOk = (value) => text(value, 0, 128) && value.trim() === value;
const within = (obj, max) => isObject(obj) && Object.keys(obj).length <= max;

/** The settings a language puts in the profile's ini files: { <file>: { <section>: { <key>: <value> } } }. */
function iniOk(ini) {
  return within(ini, 8) && Object.entries(ini).every(([file, sections]) => safePath(file) && within(sections, 16)
    && Object.entries(sections).every(([section, keys]) => sectionOk(section) && within(keys, 32) && Object.keys(keys).length > 0
      && Object.entries(keys).every(([key, value]) => keyOk(key) && valueOk(value))));
}

/** What is wrong with a version's `re3` entry, or null. */
export function re3Problem(r) {
  if (!isObject(r)) return 're3 obligatoire pour le runtime re3';
  if (!ID.test(r.engine ?? '')) return 're3.engine doit nommer une release de data_engines/';
  if (r.module !== undefined && (!safePath(r.module) || !/\.mjs$/.test(r.module))) return 're3.module doit être un module .mjs de la release';
  if (r.args !== undefined && (!Array.isArray(r.args) || r.args.length > 32 || !r.args.every((a) => typeof a === 'string' && ARG.test(a)))) return 're3.args : arguments de ligne de commande ([-+]?[A-Za-z0-9_.=], 64 caractères au plus)';
  // (a game language's own: environment variables and settings of the profile's ini files — the player's choice of the
  // version's `languages`, docs/game-frame.md)
  if (r.languages !== undefined && (!within(r.languages, 16) || !Object.entries(r.languages).every(([code, l]) => /^[a-z]{2}$/.test(code) && isObject(l)
    && (l.env === undefined || (within(l.env, 32) && Object.entries(l.env).every(([name, value]) => ENV_NAME.test(name) && text(value, 0, 64))))
    && (l.ini === undefined || iniOk(l.ini)))))
    return 're3.languages : { <langue>: { env: { <NOM>: <valeur> }, ini: { <fichier>: { <section>: { <clé>: <valeur> } } } } }';
  // (defaults set once in a profile, then the player's choice: their record's key is `<section>.<key>` — a section
  // without '=' and not opening a comment, as a key)
  if (r.defaults !== undefined && (!iniOk(r.defaults) || !Object.values(r.defaults).every((sections) => Object.keys(sections).every((section) => !/=|^[;#]/.test(section)))))
    return 're3.defaults : { <fichier>: { <section>: { <clé>: <valeur> } } } (section sans « = » ni « ; » ou « # » au début)';
  // (ways to play the game, in the page's order: each its command-line arguments after re3.args)
  if (r.modes !== undefined && (!within(r.modes, 4) || Object.keys(r.modes).length < 1 || !Object.entries(r.modes).every(([id, m]) => MODE.test(id) && isObject(m)
    && (m.args === undefined || (Array.isArray(m.args) && m.args.length <= 8 && m.args.every((a) => typeof a === 'string' && ARG.test(a)))))))
    return 're3.modes : { <mode>: { args: [<argument>] } }, 1 à 4 modes ([a-z][a-z0-9-]*, 16 caractères au plus)';
  if (r.solo !== undefined && !isObject(r.solo)) return 're3.solo doit être un objet';
  return null;
}

/** The modes a version offers: its own (re3.modes, in order), else single player. */
export const re3Modes = (r) => (r?.modes ? Object.keys(r.modes) : ['solo']);

/** The release's folder of the engine's own game files, laid over the version's (present or not). */
export const re3GameFiles = (enginesDir, release) => path.join(enginesDir, release, 'gamefiles');

/**
 * The engine's ES module, a path of the release (`engine/<name>.mjs`): the manifest's `re3.module`, else the release's
 * only module of engine/ with its WebAssembly beside it (`<name>.wasm`: the Emscripten output; a worker's module has
 * none); null when there is none, or several.
 */
export function re3Module(manifest, enginesDir) {
  const r = manifest.re3;
  if (!ID.test(r?.engine ?? '')) return null;
  if (r.module) return r.module;
  let names; try { names = fs.readdirSync(path.join(enginesDir, r.engine, 'engine')); } catch { return null; }
  const found = names.filter((n) => n.endsWith('.mjs') && names.includes(n.slice(0, -4) + '.wasm'));
  return found.length === 1 ? `engine/${found[0]}` : null;
}

/** The engine release's files an re3 page loads at its start: its module and that module's WebAssembly (installed ones). */
export function re3EngineFiles(manifest, enginesDir) {
  const module = re3Module(manifest, enginesDir);
  return module ? [module, module.slice(0, -4) + '.wasm'].filter((f) => engineFile(enginesDir, manifest.re3.engine, f)) : [];
}

/** The engine release the version names is installed: its release.json, its module and that module's WebAssembly. */
export function re3Installed(manifest, enginesDir) {
  const module = re3Module(manifest, enginesDir);
  return !!module && ['release.json', module, module.slice(0, -4) + '.wasm'].every((f) => engineFile(enginesDir, manifest.re3.engine, f));
}
