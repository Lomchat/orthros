// The OpenMW page's guesses of the player's next place in play (src/ports/openmw/place-lead.js): the next exterior row
// after a crossing (no door guess), a guess's entries (meshes and terrain only, bounded) and the session's bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAD, parseCell, nextRow, leadEntries, createLead } from '../src/ports/openmw/place-lead.js';

test('place-lead: the next row, the same way as the last crossing', () => {
  assert.deepEqual(parseCell('-2 -9'), [-2, -9]); assert.equal(parseCell(''), null); assert.equal(parseCell('-2,-9'), null);
  assert.equal(nextRow('-2 -9', '-2 -8'), '-2,-7');
  assert.equal(nextRow('0 0', '-1 -1'), '-2,-2', 'diagonal');
  assert.equal(nextRow('3 1', '4 1'), '5,1');
  // (no neighbour's step: a teleport, a door out, the first report)
  for (const [a, b] of [['-2 -9', '-2 -7'], ['', '-3 -2'], [null, '-3 -2'], ['-2 -9', '-2 -9'], ['-2 -9', '']]) assert.equal(nextRow(a, b), null, `${a} -> ${b}`);
});

test('place-lead: a guess takes its set\'s meshes and terrain, within its bytes, the tree\'s files only', () => {
  const sizes = { 'Morrowind.bsa': 1e9, 'Meshes/a.nif': 5000, 'Textures/t.dds': 4e6 };
  const size = (p) => sizes[p] ?? null;
  const doc = { list: [['Morrowind.bsa', 1000, 3000, 'meshes'], ['Textures/t.dds', 0, -1, 'textures'], ['Meshes/a.nif', 0, -1, 'meshes'], ['gone.nif', 0, 10, 'meshes'], ['Morrowind.bsa', 9000, 9500, 'terrain']] };
  assert.deepEqual(leadEntries(doc, { size }), { entries: [{ path: 'Morrowind.bsa', off: 1000, len: 2000 }, { path: 'Meshes/a.nif', off: 0, len: -1 }, { path: 'Morrowind.bsa', off: 9000, len: 500 }], bytes: 7500 });
  // (cut once the next would pass the bound, the order kept; a bare list as well)
  assert.deepEqual(leadEntries(doc.list, { size, bytes: 6000 }).entries.map((e) => e.path), ['Morrowind.bsa']);
  assert.deepEqual(leadEntries(null, { size }), { entries: [], bytes: 0 });
  assert.deepEqual(LEAD.kinds, ['meshes', 'terrain'], 'never textures');
});

test('place-lead: each place guessed once, the session bounded', () => {
  const L = createLead();
  const at = (cell, door = '') => L.look({ 'orthros.cell': cell, 'orthros.door': door });
  assert.deepEqual(at('-2 -9'), [], 'the first report: no direction yet');
  assert.deepEqual(at('-2 -8'), ['-2,-7']);
  assert.deepEqual(at('-2 -8'), [], 'the same cell: nothing new');
  // (no door guess: under a second of warning, and every door passed would spend the bounds)
  assert.deepEqual(at('-2 -8', 'seyda neen, arrille\'s tradehouse'), []);
  assert.deepEqual(at(''), [], 'inside: no row');
  assert.deepEqual(at('-2 -8'), [], 'out again: a door is no neighbour\'s step');
  assert.deepEqual(at('-2 -7'), ['-2,-6']);
  assert.deepEqual(at('-2 -8'), ['-2,-9']);
  assert.deepEqual(at('-2 -7'), [], 'that row asked once');
  L.spent(1e6);
  assert.deepEqual(L.snapshot(), { guessed: 3, bytes: 1e6, last: ['-2,-7', '-2,-6', '-2,-9'] });
  const tight = createLead({ ...LEAD, places: 1 });
  tight.look({ 'orthros.cell': '0 0' }); assert.deepEqual(tight.look({ 'orthros.cell': '0 1' }), ['0,2']);
  assert.deepEqual(tight.look({ 'orthros.cell': '0 2' }), [], 'past the places bound');
  const spent = createLead({ ...LEAD, sessionBytes: 10 });
  spent.spent(10); spent.look({ 'orthros.cell': '0 0' });
  assert.deepEqual(spent.look({ 'orthros.cell': '0 1' }), [], 'past the session\'s bytes');
});
