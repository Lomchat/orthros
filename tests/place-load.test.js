// tools/openmw/place-load.mjs's pieces without a browser: the scratch games folder whose version runs another engine
// release (real folders of links the server's catalog discovers, the required game resolved, the live folder untouched,
// removed without following a link) and a load's times from the page's frame gaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scratchGames, clearScratchGames, loadTimes } from '../tools/openmw/place-load.mjs';
import { loadGameCatalog } from '../src/host/game-catalog.js';

const openmw = (engine, extra = {}) => ({ engine, files: ['Morrowind.esm'], ...extra });
function liveGames(root) {
  const game = (g, versions) => {
    for (const v of versions) fs.mkdirSync(path.join(root, g, 'versions', v.dir), { recursive: true });
    fs.mkdirSync(path.join(root, g, 'base'), { recursive: true });
    fs.writeFileSync(path.join(root, g, 'base', 'Morrowind.esm'), 'esm');
    fs.writeFileSync(path.join(root, g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: g, name: g, defaultVersion: versions[0].id, defaults: { runtime: 'openmw' }, versions }));
  };
  game('mw', [{ id: 'mw-en', dir: 'en', version: '1', openmw: openmw('eng-r8') }]);
  game('mw-plus', [
    { id: 'mw-plus-en', dir: 'plus-en', version: '1', requires: [{ game: 'mw', version: 'mw-en' }], openmw: openmw('eng-r8', { startCell: '-2,-9' }) },
    { id: 'mw-plus-fr', dir: 'plus-fr', version: '1', openmw: openmw('eng-r8') },
  ]);
}
const links = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isSymbolicLink()) out.push(f); else if (e.isDirectory()) walk(f); } }; walk(dir); return out; };

test('place-load: a scratch games folder whose version runs another engine, the live one untouched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-load-'));
  try {
    const live = path.join(tmp, 'live'), out = path.join(tmp, 'games-eng-r9');
    liveGames(live);
    const manifestBefore = fs.readFileSync(path.join(live, 'mw-plus', 'manifest.json'), 'utf8');
    const made = scratchGames({ live, out, version: 'mw-plus-en', engine: 'eng-r9' });
    assert.deepEqual(made, { out, game: 'mw-plus', previous: 'eng-r8' });
    // (real folders of links; the measured game's manifest a file of its own; nothing new in the live folder)
    for (const g of ['mw', 'mw-plus']) assert.ok(fs.lstatSync(path.join(out, g)).isDirectory());
    assert.ok(fs.lstatSync(path.join(out, 'mw', 'manifest.json')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(out, 'mw-plus', 'base')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(out, 'mw-plus', 'manifest.json')).isFile());
    assert.deepEqual(links(live), []);
    assert.equal(fs.readFileSync(path.join(live, 'mw-plus', 'manifest.json'), 'utf8'), manifestBefore);
    // (the server's catalog: both games discovered, the version on the new engine, the others on their own, the
    // required game's files beneath it)
    const cat = loadGameCatalog(out, null, { enginesDir: path.join(tmp, 'engines') });
    assert.equal(cat.get('mw-plus-en').openmw.engine, 'eng-r9');
    assert.equal(cat.get('mw-plus-en').openmw.startCell, '-2,-9');
    assert.equal(cat.get('mw-plus-fr').openmw.engine, 'eng-r8');
    assert.equal(cat.get('mw-en').openmw.engine, 'eng-r8');
    // (made again: the previous one replaced; removed: links unlinked, never followed)
    scratchGames({ live, out, version: 'mw-plus-en', engine: 'eng-r10' });
    assert.equal(loadGameCatalog(out, null, { enginesDir: path.join(tmp, 'engines') }).get('mw-plus-en').openmw.engine, 'eng-r10');
    clearScratchGames(out);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.readFileSync(path.join(live, 'mw', 'base', 'Morrowind.esm'), 'utf8'), 'esm');
    assert.throws(() => scratchGames({ live, out, version: 'nope', engine: 'eng-r9' }), /no version/);
    // (a folder it did not make is refused: a real file below a game's folder)
    fs.mkdirSync(path.join(out, 'x', 'y'), { recursive: true });
    assert.throws(() => clearScratchGames(out), /not made by scratchGames/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('place-load: a load\'s times from the frame gaps', () => {
  const gaps = [[50, 300], [1000, 1200], [1300, 9300], [9400, 9800], [12500, 13100], [30000, 30400]];
  const t = loadTimes({ gaps, from: 1000, cellAt: 10000 });
  assert.deepEqual(t.longest, [1300, 9300]);
  assert.equal(t.frozenMs, 8000); assert.equal(t.frozenStartMs, 300);
  // (stalls over 250 ms after the trigger: 8000 + 400 + 600 + 400; frames back: the last such gap within 2 s of the cell)
  assert.equal(t.stallsOver250Ms, 9400);
  assert.equal(t.steadyAt, 9800);
  assert.equal(loadTimes({ gaps, from: 1000 }).steadyAt, 30400);
  assert.deepEqual(loadTimes({ gaps: [], from: 0 }), { longest: null, steadyAt: null, frozenMs: null, frozenStartMs: null, stallsOver250Ms: 0 });
});
