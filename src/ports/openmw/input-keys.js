// The keyboard layout every OpenMW player gets on Orthros: Activate on E, Jump on Space. The engine's defaults are that
// since orthros-r9.patch (Morrowind's own were the reverse: Activate on Space, Jump on E). A player's saved bindings
// (input_v3.xml in the engine's user config, written when the Options window closes, kept on the account) may still
// hold the old pair: swapped once, before the engine reads them, when Activate is on Space and Jump on E exactly — any
// other layout is the player's own choice and stays. A marker file beside them records that the file was looked at,
// so the old pair chosen again later in Options stays too. Other bindings, mouse and controller ones, are untouched.
// Loaded by the engine page before its engine starts (src/server/ports/openmw.js withInputKeys); the page calls
// window.orthrosInputKeys(FS) once its user files are in place (IDBFS and the account's copy restored).

export const INPUT_FILE = '/userdata/config/openmw/input_v3.xml';
export const MARK_FILE = '/userdata/config/openmw/orthros-input.json';
/** MWInput::Actions (apps/openmw/mwinput/actions.hpp): the controls' names in the file */
export const ACTIVATE = 9, JUMP = 11;
/** SDL scancodes */
export const SPACE = 44, E = 8;

/**
 * The bindings file `xml` with the old pair swapped (Activate's key E, Jump's Space), or null when it does not hold
 * exactly that pair. Only the two `key` attributes change: the file stays as the engine (ICS, TinyXML) wrote it.
 */
export function swapOldPair(xml) {
  const keyOf = (name) => {
    // (a control's element: <Control name="N" …> its binders </Control>; one without bindings is self-closing)
    for (const open of xml.matchAll(/<Control\b[^>]*>/g)) {
      if (open[0].endsWith('/>') || !new RegExp(`\\sname="${name}"`).test(open[0])) continue;
      const start = open.index + open[0].length, end = xml.indexOf('</Control>', start);
      if (end < 0) return null;
      for (const b of xml.slice(start, end).matchAll(/<KeyBinder\b[^>]*>/g)) {
        if (!/\sdirection="INCREASE"/.test(b[0])) continue;
        const key = /\skey="(\d+)"/.exec(b[0]);
        if (!key) return null;
        return { key: Number(key[1]), at: start + b.index + key.index, text: key[0] };
      }
      return null;
    }
    return null;
  };
  const activate = keyOf(ACTIVATE), jump = keyOf(JUMP);
  if (activate?.key !== SPACE || jump?.key !== E) return null;
  // (the later one first: the earlier one's offset stays right)
  const edits = [[activate, E], [jump, SPACE]].sort((a, b) => b[0].at - a[0].at);
  let out = xml;
  for (const [b, key] of edits) out = out.slice(0, b.at) + ` key="${key}"` + out.slice(b.at + b.text.length);
  return out;
}

/**
 * The player's saved bindings brought to the layout, once (`FS`: the engine's Emscripten file system, its user files
 * loaded). Returns what it did: 'done' (looked at in an earlier session), 'none' (no saved bindings: the engine's
 * defaults apply — nothing recorded, a file written later is looked at then), 'swapped' or 'kept' (recorded).
 */
export function migrate(FS, now = () => new Date().toISOString()) {
  if (FS.analyzePath(MARK_FILE).exists) return 'done';
  if (!FS.analyzePath(INPUT_FILE).exists) return 'none';
  const swapped = swapOldPair(FS.readFile(INPUT_FILE, { encoding: 'utf8' }));
  if (swapped !== null) FS.writeFile(INPUT_FILE, swapped);
  FS.writeFile(MARK_FILE, JSON.stringify({ keys: 'activate-e-jump-space', result: swapped !== null ? 'swapped' : 'kept', at: now() }) + '\n');
  return swapped !== null ? 'swapped' : 'kept';
}

// Second change of the layout (orthros-r23.patch): Toggle POV on V, Tab left free (in Vanilla+ a UI Modes overlay opens the
// inventory with it, as I). A saved file whose Toggle POV is on Tab gets it on V, once, when no control uses V already.
export const POV_MARK_FILE = '/userdata/config/openmw/orthros-input-pov.json';
export const TOGGLE_POV = 30;
export const TAB = 43, V = 25;

/** The bindings file `xml` with Toggle POV moved from Tab to V, or null when it is not on Tab or V is taken. */
export function movePov(xml) {
  const binders = [];
  for (const open of xml.matchAll(/<Control\b[^>]*>/g)) {
    if (open[0].endsWith('/>')) continue;
    const name = /\sname="(\d+)"/.exec(open[0]);
    const start = open.index + open[0].length, end = xml.indexOf('</Control>', start);
    if (!name || end < 0) return null;
    for (const b of xml.slice(start, end).matchAll(/<KeyBinder\b[^>]*>/g)) {
      const key = /\skey="(\d+)"/.exec(b[0]);
      if (key) binders.push({ control: Number(name[1]), key: Number(key[1]), increase: /\sdirection="INCREASE"/.test(b[0]), at: start + b.index + key.index, text: key[0] });
    }
  }
  const pov = binders.find((b) => b.control === TOGGLE_POV && b.increase);
  if (pov?.key !== TAB || binders.some((b) => b.key === V)) return null;
  return xml.slice(0, pov.at) + ` key="${V}"` + xml.slice(pov.at + pov.text.length);
}

/** The saved bindings' Toggle POV moved from Tab to V, once (as migrate: 'done', 'none', 'moved' or 'kept'). */
export function migratePov(FS, now = () => new Date().toISOString()) {
  if (FS.analyzePath(POV_MARK_FILE).exists) return 'done';
  if (!FS.analyzePath(INPUT_FILE).exists) return 'none';
  const moved = movePov(FS.readFile(INPUT_FILE, { encoding: 'utf8' }));
  if (moved !== null) FS.writeFile(INPUT_FILE, moved);
  FS.writeFile(POV_MARK_FILE, JSON.stringify({ keys: 'toggle-pov-v', result: moved !== null ? 'moved' : 'kept', at: now() }) + '\n');
  return moved !== null ? 'moved' : 'kept';
}

// Third change (orthros-r24.patch, the owner, 2026-11-08): Left Shift is the sprint's (RUN!, a mod's action, its key
// given by the version), walking and running toggled with Left Alt. A saved file whose Run (held) is on Left Shift loses
// that key, and its Always Run toggle on Caps Lock moves to Left Alt when no control uses Left Alt; once.
export const RUN_MARK_FILE = '/userdata/config/openmw/orthros-input-run.json';
export const RUN = 17, ALWAYS_RUN = 23;
export const LSHIFT = 225, LALT = 226, CAPSLOCK = 57;

/** The bindings file `xml` with Run's Left Shift dropped and Always Run moved from Caps Lock to Left Alt (when free), or null: nothing to change. */
export function moveRun(xml) {
  const binders = [];
  for (const open of xml.matchAll(/<Control\b[^>]*>/g)) {
    if (open[0].endsWith('/>')) continue;
    const name = /\sname="(\d+)"/.exec(open[0]);
    const start = open.index + open[0].length, end = xml.indexOf('</Control>', start);
    if (!name || end < 0) return null;
    for (const b of xml.slice(start, end).matchAll(/[ \t]*<KeyBinder\b[^>]*>\r?\n?/g)) {
      const key = /\skey="(\d+)"/.exec(b[0]);
      if (key) binders.push({ control: Number(name[1]), key: Number(key[1]), increase: /\sdirection="INCREASE"/.test(b[0]), at: start + b.index, line: b[0], keyAt: start + b.index + key.index, keyText: key[0] });
    }
  }
  const edits = [];
  const run = binders.find((b) => b.control === RUN && b.key === LSHIFT);
  if (run) edits.push({ at: run.at, len: run.line.length, text: '' });
  const always = binders.find((b) => b.control === ALWAYS_RUN && b.increase && b.key === CAPSLOCK);
  if (always && !binders.some((b) => b.key === LALT)) edits.push({ at: always.keyAt, len: always.keyText.length, text: ` key="${LALT}"` });
  if (!edits.length) return null;
  let out = xml;
  for (const e of edits.sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len);
  return out;
}

/** The saved bindings' Run off Left Shift and Always Run on Left Alt, once ('done', 'none', 'moved' or 'kept'). */
export function migrateRun(FS, now = () => new Date().toISOString()) {
  if (FS.analyzePath(RUN_MARK_FILE).exists) return 'done';
  if (!FS.analyzePath(INPUT_FILE).exists) return 'none';
  const moved = moveRun(FS.readFile(INPUT_FILE, { encoding: 'utf8' }));
  if (moved !== null) FS.writeFile(INPUT_FILE, moved);
  FS.writeFile(RUN_MARK_FILE, JSON.stringify({ keys: 'run-shift-sprint-alt-toggle', result: moved !== null ? 'moved' : 'kept', at: now() }) + '\n');
  return moved !== null ? 'moved' : 'kept';
}

/** Into the engine page `win`: window.orthrosInputKeys(FS) for its user files' setup (never throws: the game starts). */
export function install(win = globalThis) {
  win.orthrosInputKeys = (FS) => {
    let pov = 'error';
    try { pov = migratePov(FS); } catch (e) { console.warn('[orthros keys]', e); }
    if (pov === 'moved') console.info('[orthros keys] saved bindings: Toggle POV on V');
    let run = 'error';
    try { run = migrateRun(FS); } catch (e) { console.warn('[orthros keys]', e); }
    if (run === 'moved') console.info('[orthros keys] saved bindings: Run off Left Shift, Always Run on Left Alt');
    try { return migrate(FS); } catch (e) { console.warn('[orthros keys]', e); return 'error'; }
  };
}
