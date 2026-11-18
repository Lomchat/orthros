// Settings a manifest puts in a NEW player's profile ("newProfileIni"): for a player who has no settings of their own yet
// (the profile was empty when the session started — no browser copy, no account copy), keys set in the ini files of
// the profile once the shared first-launch files are in place (src/shared/profile-seed.js), before the game sees them —
// e.g. the highest resolution the player's screen offers instead of the one a first launch measured. Afterwards the
// files are the player's: never touched again. Generic: the files, sections and keys come from the manifest; a value may
// name the player's machine — {modeWidth} and {modeHeight}, the largest display mode it lists (display-modes.js
// largestMode) — and such a manifest's snapshots are kept per mode (snapshot-key.js).
//
// Only a file the profile has is edited (the shared first-launch file): a game that finds a settings file skips its
// first-launch measurements, and one holding a single key would leave the others unmeasured. A key set in place, a
// missing one added to its section, the rest of the file byte for byte (src/shared/ini.js).
//
// { <profile path, '/'-separated>: { <section; '' = the top of the file, before any header>: { <key>: <value> } } }

import { setIni, readIni, bytesToText, textToBytes } from '../shared/ini.js';
import { profilePathOk } from './profile-moves.js';

const MAX_FILES = 8, MAX_SECTIONS = 16, MAX_KEYS = 32;
const SECTION = /^(?:|[^\s[\]](?:[^[\]]{0,62}[^\s[\]])?)$/;
const KEY = /^[^\s=;#[\]](?:[^=[\]]{0,62}[^\s=[\]])?$/;
const VALUE = /^(?:[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?)?$/;
/** The machine's values a setting may name, as {name}. */
export const PROFILE_INI_VARS = Object.freeze(['modeWidth', 'modeHeight']);
const VAR = /\{([A-Za-z]+)\}/g;
const MODE = /\{mode(?:Width|Height)\}/;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/** What is wrong with a manifest's newProfileIni (undefined: none declared), or null when it is valid. */
export function newProfileIniProblem(spec) {
  if (spec === undefined) return null;
  if (!isObj(spec) || Object.keys(spec).length > MAX_FILES) return `newProfileIni doit être un objet de ${MAX_FILES} fichiers au plus`;
  for (const [file, sections] of Object.entries(spec)) {
    if (!profilePathOk(file)) return `newProfileIni : ${file} n'est pas un chemin relatif du profil (séparé par /)`;
    if (!isObj(sections) || !Object.keys(sections).length || Object.keys(sections).length > MAX_SECTIONS) return `newProfileIni : ${file} doit donner de 1 à ${MAX_SECTIONS} sections`;
    for (const [section, keys] of Object.entries(sections)) {
      if (!SECTION.test(section)) return `newProfileIni : nom de section invalide « ${section} »`;
      if (!isObj(keys) || !Object.keys(keys).length || Object.keys(keys).length > MAX_KEYS) return `newProfileIni : la section « ${section} » de ${file} doit donner de 1 à ${MAX_KEYS} clés`;
      for (const [key, value] of Object.entries(keys)) {
        if (!KEY.test(key)) return `newProfileIni : nom de clé invalide « ${key} »`;
        if (typeof value !== 'string' || !VALUE.test(value)) return `newProfileIni : la valeur de ${key} doit être de l'ASCII imprimable (128 caractères au plus, sans espace au début ni à la fin)`;
        for (const [, name] of value.matchAll(VAR)) if (!PROFILE_INI_VARS.includes(name)) return `newProfileIni : {${name}} inconnu dans ${key} (connus : ${PROFILE_INI_VARS.map((v) => `{${v}}`).join(', ')})`;
      }
    }
  }
  return null;
}

/** Does a manifest's newProfileIni name the display mode (its sessions, and so its snapshots, differ by mode)? */
export const profileIniUsesMode = (spec) => isObj(spec) && !newProfileIniProblem(spec)
  && Object.values(spec).some((sections) => Object.values(sections).some((keys) => Object.values(keys).some((v) => MODE.test(v))));

/**
 * The display mode a player's own settings name, [width, height], or null: the value of a newProfileIni key naming
 * {modeWidth} and {modeHeight}, read back from the profile with the same pattern ("Resolution = {modeWidth}
 * {modeHeight}" -> "Resolution = 2560 1440"). The machine then lists that mode even on a smaller screen (display-modes.js
 * extraModes): a profile saved on a larger screen asks the game for it, and a game finding its saved mode missing from
 * the list may fail to start (Age of the Ring did, 2026-11-18).
 */
export function profileIniMode(backend, spec) {
  if (!isObj(spec) || newProfileIniProblem(spec)) return null;
  for (const [file, sections] of Object.entries(spec)) {
    for (const [section, keys] of Object.entries(sections)) {
      for (const [key, value] of Object.entries(keys)) {
        if (!value.includes('{modeWidth}') || !value.includes('{modeHeight}')) continue;
        const st = backend.stat(file);
        if (!st || st.isDir || st.size > 1 << 20) continue;
        const have = readIni(bytesToText(backend.open(file).read(0, st.size))).get(section.toLowerCase())?.get(key.toLowerCase());
        if (have === undefined) continue;
        const order = [...value.matchAll(/\{mode(Width|Height)\}/g)].map((m) => m[1]);
        const re = new RegExp('^' + value.split(/\{mode(?:Width|Height)\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+')).join('(\\d{3,5})') + '$');
        const m = re.exec(have.trim());
        if (!m) continue;
        const w = Number(m[1 + order.indexOf('Width')]), h = Number(m[1 + order.indexOf('Height')]);
        if (w >= 320 && h >= 200 && w <= 7680 && h <= 4320) return [w, h];
      }
    }
  }
  return null;
}

/**
 * Sets a manifest's newProfileIni in the profile held at the root of `backend` (MemBackend: the page's profile). `mode`:
 * the largest display mode, [width, height], or null when unknown (a key naming it is then left as the file has it).
 * @returns {string[]} the files changed
 */
export function applyNewProfileIni(backend, spec, { mode = null } = {}) {
  const changed = [];
  if (!isObj(spec) || newProfileIniProblem(spec)) return changed;
  const vars = mode ? { modeWidth: String(mode[0]), modeHeight: String(mode[1]) } : {};
  for (const [file, sections] of Object.entries(spec)) {
    const st = backend.stat(file);
    if (!st || st.isDir) continue; // (none: the game's first launch writes its own)
    const want = {};
    for (const [section, keys] of Object.entries(sections)) {
      for (const [key, value] of Object.entries(keys)) {
        let unknown = false;
        const v = value.replace(VAR, (_, name) => vars[name] ?? ((unknown = true), ''));
        if (!unknown) (want[section] ??= {})[key] = v;
      }
    }
    const f = backend.open(file), text = bytesToText(f.read(0, st.size)), out = setIni(text, want);
    if (out === text) continue;
    backend.open(file, { truncate: true }).write(0, textToBytes(out));
    changed.push(file);
  }
  return changed;
}
