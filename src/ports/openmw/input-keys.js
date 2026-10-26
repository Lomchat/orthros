// The keyboard layout every OpenMW player gets on Orthros: Activate on E, Jump on Space. The engine's defaults are that
// since orthros-r9.patch (Morrowind's own were the reverse: Activate on Space, Jump on E). A player's saved bindings
// (input_v3.xml in the engine's user config, written when the Options window closes, kept on the account) may still
// hold the old pair: swapped once, before the engine reads them, when Activate is on Space and Jump on E exactly — any
// other layout is the player's own choice and stays. A marker file beside them records that the file was looked at,
// so the old pair chosen again later in Options stays too. Other bindings, mouse and controller ones, are untouched.
// Loaded by the engine page before its engine starts (src/host/openmw.js withInputKeys); the page calls
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

/** Into the engine page `win`: window.orthrosInputKeys(FS) for its user files' setup (never throws: the game starts). */
export function install(win = globalThis) {
  win.orthrosInputKeys = (FS) => {
    try { return migrate(FS); } catch (e) { console.warn('[orthros keys]', e); return 'error'; }
  };
}
