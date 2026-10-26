// The OpenMW players' keyboard layout (src/ports/openmw/input-keys.js, put into the engine page by src/host/openmw.js
// withInputKeys): Activate on E, Jump on Space — a saved bindings file holding Morrowind's old pair swapped once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { swapOldPair, migrate, install, INPUT_FILE, MARK_FILE } from '../src/ports/openmw/input-keys.js';
import { withInputKeys, withProgressiveView } from '../src/host/openmw.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';

// (as the engine's ICS writes it through TinyXML: a control per action, named by its id; Activate 9, Jump 11)
const control = (name, binders) => binders === null
  ? `    <Control name="${name}" autoChangeDirectionOnLimitsAfterStop="false" autoReverseToInitialValue="false" initialValue="0" stepSize="MAX" stepsPerSeconds="MAX" />\n`
  : `    <Control name="${name}" autoChangeDirectionOnLimitsAfterStop="false" autoReverseToInitialValue="false" initialValue="0" stepSize="MAX" stepsPerSeconds="MAX">\n${binders.map((b) => `        ${b}\n`).join('')}        <Channel number="${name}" direction="DIRECT" />\n    </Control>\n`;
const file = ({ activate = 44, jump = 8, extra = '' } = {}) => '<Controller>\n'
  + control(1, null)
  + control(3, ['<KeyBinder key="26" direction="INCREASE" />'])
  + control(9, [`<KeyBinder key="${activate}" direction="INCREASE" />`, '<MouseButtonBinder button="4" direction="INCREASE" />'])
  + control(10, ['<KeyBinder key="9" direction="INCREASE" />'])
  + control(11, [`<KeyBinder key="${jump}" direction="INCREASE" />`])
  + control(19, ['<KeyBinder key="44" direction="DECREASE" />', '<KeyBinder key="8" direction="INCREASE" />'])
  + extra + '</Controller>\n';

test('the old pair (Activate on Space, Jump on E) swapped, and nothing else in the file', () => {
  const before = file(), after = swapOldPair(before);
  assert.equal(after, file({ activate: 8, jump: 44 }));
});

test('any other layout is the player\'s own: left as it is', () => {
  assert.equal(swapOldPair(file({ activate: 8, jump: 44 })), null, 'already the layout');
  assert.equal(swapOldPair(file({ activate: 44, jump: 20 })), null, 'Jump moved by the player');
  assert.equal(swapOldPair(file({ activate: 18, jump: 8 })), null, 'Activate moved by the player');
  assert.equal(swapOldPair(file().replace(/<Control name="11"[\s\S]*?<\/Control>\n/, '')), null, 'no Jump control');
  assert.equal(swapOldPair(file().replace('<KeyBinder key="44" direction="INCREASE" />', '')), null, 'Activate on the mouse only');
  assert.equal(swapOldPair(''), null);
  assert.equal(swapOldPair('<Controller>\n    <Control name="9" stepSize="MAX">\n'), null, 'a cut file');
});

/** An Emscripten FS of a few files (analyzePath, readFile utf8, writeFile). */
function memFs(files = {}) {
  const m = new Map(Object.entries(files));
  return {
    files: m,
    analyzePath: (p) => ({ exists: m.has(p) }),
    readFile: (p, o) => { assert.equal(o?.encoding, 'utf8'); if (!m.has(p)) throw new Error('ENOENT'); return m.get(p); },
    writeFile: (p, d) => { m.set(p, String(d)); },
  };
}

test('once per player: swapped and recorded; recorded, never again — the old pair chosen later in Options stays', () => {
  const FS = memFs({ [INPUT_FILE]: file() });
  assert.equal(migrate(FS, () => 'T'), 'swapped');
  assert.equal(FS.files.get(INPUT_FILE), file({ activate: 8, jump: 44 }));
  assert.deepEqual(JSON.parse(FS.files.get(MARK_FILE)), { keys: 'activate-e-jump-space', result: 'swapped', at: 'T' });
  FS.files.set(INPUT_FILE, file());
  assert.equal(migrate(FS), 'done');
  assert.equal(FS.files.get(INPUT_FILE), file(), 'the player\'s choice after the swap');
});

test('a file of the player\'s own layout recorded as kept; no file: the engine\'s defaults, nothing recorded yet', () => {
  const own = memFs({ [INPUT_FILE]: file({ activate: 18, jump: 8 }) });
  assert.equal(migrate(own, () => 'T'), 'kept');
  assert.equal(own.files.get(INPUT_FILE), file({ activate: 18, jump: 8 }));
  assert.equal(JSON.parse(own.files.get(MARK_FILE)).result, 'kept');
  const fresh = memFs();
  assert.equal(migrate(fresh), 'none');
  assert.equal(fresh.files.size, 0, 'a file the engine writes later is looked at then');
  fresh.files.set(INPUT_FILE, file());
  assert.equal(migrate(fresh), 'swapped', 'an older engine\'s defaults saved meanwhile');
});

test('installed in the page: a failing file system never stops the game', () => {
  const win = {};
  install(win);
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(win.orthrosInputKeys({ analyzePath: () => { throw new Error('io'); } }), 'error');
  } finally { console.warn = warn; }
  assert.equal(win.orthrosInputKeys(memFs({ [INPUT_FILE]: file() })), 'swapped');
});

test('the engine page: the module before the engine, the swap once its user files are in place', () => {
  const html = `<html><head></head><body><script>
             FS.syncfs(true, function(err){
               FS.mkdirTree('/userdata/data');            // openmw.cfg data-local
               FS.mkdirTree('/userdata/config/openmw');   // XDG user config (persistent)
               window.__omwSyncfs();
             });
    document.body.appendChild(s);
  </script></body></html>`;
  const out = withInputKeys(withProgressiveView(html));
  assert.ok(out.includes(`<script>window.orthrosInputReady = import('/src/ports/openmw/input-keys.js')`));
  assert.ok(out.includes("FS.mkdirTree('/userdata/config/openmw');   // XDG user config (persistent)\n               if (window.orthrosInputKeys && window.orthrosInputKeys(FS) === 'swapped')"));
  assert.ok(out.includes('Promise.all([window.orthrosViewReady, window.orthrosTierReady, window.orthrosInputReady])'), 'the engine waits for it');
  for (const id of ['openmw-web-v1.5.3-orthros-r8', 'openmw-web-v1.5.3-orthros-r9']) {
    const release = path.join(DEFAULT_ENGINES_DIR, id, 'index.html');
    if (!fs.existsSync(release)) continue;
    const real = withInputKeys(withProgressiveView(fs.readFileSync(release, 'utf8')));
    for (const k of ['orthrosInputReady = import', 'window.orthrosInputKeys(FS)', 'window.orthrosInputReady]).then']) assert.equal(real.split(k).length - 1, 1, `${id}: ${k}`);
  }
});
