// Where an OpenMW saved game loads (src/ports/openmw/save-place.js, docs/openmw.md "Anticipated places"): a save made
// here byte for byte as the engine writes one (components/esm3: TES3 with FORM, SAVE, the world's records, PLAY with the
// player's cell just before LKEP), its place read as the engine's announced reads name it; the save the player most
// likely loads chosen (the remembered place, the newest, the most played after a restore from the account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSave, listSaves, chooseSave, labelPlace, placeHint, engineLower, SAVES_DIRS } from '../src/ports/openmw/save-place.js';

const enc = (s) => new TextEncoder().encode(s);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const i32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b; };
const f64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, true); return b; };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const sub = (name, data) => cat(enc(name), u32(data.length), data);
const rec = (name, ...subs) => { const body = cat(...subs); return cat(enc(name), u32(body.length), u32(0), u32(0), body); };
/** a RefId as writeHNRefId writes it (format > 23): an exterior cell, or an unsized string */
const exterior = (x, y) => cat(Uint8Array.of(6), i32(x), i32(y));
const stringId = (s) => cat(Uint8Array.of(2), enc(s));

/** A save of format `format` whose player stands in `cell` (a PLAY NAME RefId; up to 26: [SPAC, CIDX?]). */
function save({ format = 38, cell, time = 12.5, player = 'Nérévarine', cellName = "Ald'ruhn" }) {
  const play = format > 26
    ? [sub('NAME', stringId('player')), sub('DATA', new Uint8Array(24)), sub('NAME', cell), sub('LKEP', new Uint8Array(8)), sub('CURD', i32(0))]
    : [sub('NAME', enc('player')), sub('DATA', new Uint8Array(24)), ...cell, sub('LKEP', new Uint8Array(8))];
  return cat(
    rec('TES3', ...(format ? [sub('FORM', u32(format))] : []), sub('HEDR', new Uint8Array(300))),
    rec('SAVE', sub('PLNA', enc(player)), sub('PLLE', i32(7)), sub('PLCL', stringId('warrior')), sub('PLCE', enc(cellName)),
      sub('TSTM', new Uint8Array(12)), sub('TIME', f64(time)), sub('DESC', enc('Quicksave')), sub('DEPE', enc('Morrowind.esm')),
      sub('DEPE', enc('Tribunal.esm')), sub('SCRN', new Uint8Array(5000)), sub('CDAY', i32(3)), sub('CHLT', new Uint8Array(4)), sub('MHLT', new Uint8Array(4))),
    rec('GAME', sub('GMDT', new Uint8Array(40))),
    rec('JOUR', sub('JEDA', enc('x'.repeat(3000)))),
    // (a record named PLAY's neighbours: a cell's own NAME subrecords are no player's cell)
    rec('CELL', sub('NAME', stringId('Balmora')), sub('DATA', new Uint8Array(12))),
    rec('PLAY', ...play),
    rec('CSTA', sub('NAME', exterior(9, 9))),
  );
}

test('the place of a save: an exterior cell \'x,y\', an interior\'s id lowercased (ASCII, as the engine), the header\'s fields', () => {
  const ext = parseSave(save({ cell: exterior(-2, 6) }));
  assert.equal(ext.place, '-2,6');
  assert.equal(ext.format, 38);
  assert.equal(ext.player, 'Nérévarine');
  assert.equal(ext.level, 7);
  assert.equal(ext.cellName, "Ald'ruhn", 'the display name (not the key)');
  assert.equal(ext.timePlayed, 12.5);
  assert.equal(ext.desc, 'Quicksave');
  assert.deepEqual(ext.contentFiles, ['Morrowind.esm', 'Tribunal.esm']);
  assert.equal(parseSave(save({ cell: exterior(-12345, 0) })).place, '-12345,0');
  assert.equal(parseSave(save({ cell: stringId("Ald'ruhn, Maison des Guildes ÉCLAT") })).place, "ald'ruhn, maison des guildes Éclat", 'ASCII letters only, as Misc::StringUtils::lowerCase');
  assert.equal(parseSave(save({ cell: cat(Uint8Array.of(1), u32(5), enc('Vivec'), enc('junk')) })).place, 'vivec', 'a sized string id');
  assert.equal(parseSave(save({ cell: Uint8Array.of(0) })).place, null, 'an empty id: no place');
  assert.equal(engineLower('ABC é Z'), 'abc é z');
});

test('an older save (format 26 and below): the old CellId (SPAC, CIDX for an exterior)', () => {
  assert.equal(parseSave(save({ format: 21, cell: [sub('SPAC', enc('sys::default')), sub('CIDX', cat(i32(3), i32(-7)))] })).place, '3,-7');
  assert.equal(parseSave(save({ format: 0, cell: [sub('SPAC', enc('Seyda Neen, Census and Excise Office'))] })).place, 'seyda neen, census and excise office');
});

test('not a save: another file, a header alone, cut short', () => {
  assert.equal(parseSave(enc('not a save at all, not at all, not at all')), null);
  assert.equal(parseSave(new Uint8Array(4)), null);
  const full = save({ cell: exterior(1, 2) });
  assert.equal(parseSave(full.subarray(0, 40)), null, 'TES3 alone: no SAVE');
  const cut = parseSave(full.subarray(0, full.length - 80));
  assert.ok(cut && cut.player === 'Nérévarine' && cut.place === null, 'PLAY cut short: the header, no place');
  // (a record whose size runs past the file: the walk stops)
  const bad = full.slice(), jour = Buffer.from(bad).indexOf('JOUR');
  new DataView(bad.buffer).setUint32(jour + 4, 0x7fffffff, true);
  assert.equal(parseSave(bad).place, null);
});

/** Emscripten's FS, as far as listSaves reads it: { '/dir/char/file': { bytes, mtime } } */
function fakeFS(files) {
  const dirs = new Map();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/') || '/';
      if (!dirs.has(d)) dirs.set(d, new Set());
      dirs.get(d).add(parts[i]);
    }
  }
  return {
    reads: 0,
    readdir(d) { const s = dirs.get(d); if (!s) throw new Error('ENOENT'); return ['.', '..', ...s]; },
    stat(p) { const f = files[p]; if (!f) return { mtime: new Date(0) }; return { mtime: new Date(f.mtime) }; },
    readFile(p) { this.reads++; return files[p].bytes; },
  };
}

test('the saves of every character in both folders, each parsed; those written after a date only', () => {
  const [a, b] = SAVES_DIRS;
  const fs = fakeFS({
    [`${a}/player/Quicksave.omwsave`]: { bytes: save({ cell: exterior(-2, 6), time: 10 }), mtime: 1000 },
    [`${a}/player/notes.txt`]: { bytes: enc('x'), mtime: 5000 },
    [`${b}/Nerevar/Autosave.omwsave`]: { bytes: save({ cell: stringId('Vivec, Arena') }), mtime: 3000 },
    [`${b}/Nerevar/broken.omwsave`]: { bytes: enc('nothing'), mtime: 4000 },
  });
  const all = listSaves(fs);
  assert.deepEqual(all.map((s) => [s.character, s.mtime, s.info.place]).sort(), [['Nerevar', 3000, 'vivec, arena'], ['player', 1000, '-2,6']]);
  fs.reads = 0;
  assert.deepEqual(listSaves(fs, SAVES_DIRS, 2000).map((s) => s.path), [`${b}/Nerevar/Autosave.omwsave`]);
  assert.equal(fs.reads, 2, 'the older one not read (the broken one is, and left out)');
  assert.deepEqual(listSaves(fakeFS({})), [], 'no saves folder');
});

test('a save read by its records\' headers through FS.read — the screenshot and the world\'s records before PLAY not read', () => {
  const bytes = save({ cell: exterior(-2, 6) }), path = `${SAVES_DIRS[0]}/player/Quicksave.omwsave`;
  const fs = fakeFS({ [path]: { bytes, mtime: 1000 } });
  let read = 0, open = 0, closed = 0;
  Object.assign(fs, {
    stat: (p) => ({ mtime: new Date(1000), size: p === path ? bytes.length : 0 }),
    open: () => { open++; return { fd: 3 }; },
    read: (stream, buf, off, len, pos) => { const b = bytes.subarray(pos, pos + len); buf.set(b, off); read += b.length; return b.length; },
    close: () => { closed++; },
    readFile: () => { throw new Error('not the whole save'); },
  });
  const [s] = listSaves(fs);
  assert.equal(s.info.place, '-2,6'); assert.equal(s.info.timePlayed, 12.5);
  assert.equal(open, 1); assert.equal(closed, 1);
  assert.ok(read < bytes.length - 8000, `${read} of ${bytes.length} bytes read`);
});

test('the save chosen: the remembered place when a save is there, else the newest, else (a profile restored) the most played', () => {
  const s = (place, mtime, timePlayed) => ({ path: place, mtime, info: { place, timePlayed } });
  const saves = [s('-2,6', 1000, 50), s('vivec, arena', 3000, 20), s(null, 9000, 99)];
  assert.deepEqual(chooseSave(saves, { hint: { place: '-2,6', at: 3000 } }), { save: saves[0], place: '-2,6', why: 'hint' });
  assert.equal(chooseSave(saves, { hint: { place: '-2,6', at: 900 } }).place, 'vivec, arena', 'a save newer than the hint: the newest');
  assert.equal(chooseSave(saves, { hint: { place: '-2,6', at: 1000 }, restored: true }).why, 'hint', 'dates of a restore: the hint');
  assert.equal(chooseSave(saves, { hint: '-2,6' }).why, 'newest', 'a bare place of an earlier page: no date, any save newer');
  assert.equal(chooseSave(saves, { hint: { place: '0,0', at: 9000 } }).place, 'vivec, arena', 'a hint with no save there: the newest');
  const two = [s('-2,6', 1000, 50), s('-2,6', 2000, 10)];
  assert.equal(chooseSave(two, { hint: { place: '-2,6', at: 5000 } }).save, two[1], 'the newest save of the hinted place');
  assert.deepEqual(chooseSave(saves), { save: saves[1], place: 'vivec, arena', why: 'newest' });
  assert.deepEqual(chooseSave(saves, { restored: true }), { save: saves[0], place: '-2,6', why: 'time' }, 'dates rewritten by the restore: the most played');
  assert.equal(chooseSave([s('a', 5, 1), s('b', 5, 2)]).place, 'b', 'same date: the most played');
  assert.equal(chooseSave([s(null, 1, 1)]), null);
  assert.equal(chooseSave([]), null);
});

test('an announced batch\'s label names its place; the hint is the browser\'s storage, per installation', () => {
  assert.deepEqual(labelPlace('meshes:-2,6'), { kind: 'meshes', place: '-2,6' });
  assert.deepEqual(labelPlace("textures:ald'ruhn, temple"), { kind: 'textures', place: "ald'ruhn, temple" });
  assert.deepEqual(labelPlace('terrain:3,4'), { kind: 'terrain', place: '3,4' });
  assert.equal(labelPlace('place:3,4'), null);
  assert.equal(labelPlace('meshes:'), null);
  assert.equal(labelPlace(null), null);
  const m = new Map(), storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(placeHint.get('mw-fr', storage), null);
  placeHint.set('mw-fr', '-2,6', storage, 1234);
  assert.deepEqual(placeHint.get('mw-fr', storage), { place: '-2,6', at: 1234 });
  assert.equal(placeHint.get('mw-en', storage), null);
  m.set('orthros.place.mw-old', 'balmora'); assert.deepEqual(placeHint.get('mw-old', storage), { place: 'balmora', at: 0 }, 'a bare place of an earlier page');
  m.delete('orthros.place.mw-old');
  assert.deepEqual([...m.keys()], ['orthros.place.mw-fr']);
  assert.equal(placeHint.get('mw-fr', null), null, 'no storage');
  assert.doesNotThrow(() => placeHint.set('mw-fr', 'x', { getItem() { throw new Error('denied'); } }));
});
