// tools/openmw/place-load.mjs's pieces without a browser: the scratch games folder whose version runs another engine
// release (real folders of links the server's catalog discovers, the required game resolved, the live folder untouched,
// removed without following a link), a load's times from the page's frame gaps, and stage 3's pieces: the options, a dev
// engine release's brotli siblings, the learned places' summary, the menu-time prefetch from a proxy log; the in-play
// scenarios' pieces: the glide's line, its crossings, the learned places' ranges and a stretch's reads against them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scratchGames, clearScratchGames, loadTimes, parseArgs, engineBrotli, placesSummary, prefetchReport, glideSpec, glideLine, crossings, learnedSets, readCoverage, glideReport } from '../tools/openmw/place-load.mjs';
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
    assert.deepEqual(made, { out, game: 'mw-plus', previous: 'eng-r8', changed: { 'mw-plus-en': { game: 'mw-plus', previous: 'eng-r8' } } });
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

test('place-load: the options, resolved and checked', () => {
  const o = parseArgs(['mw-en', '--tree', '/x/tree', '--mode', 'save', '--profile', 'new', '--teach', '2', '--to', '-3,7', '--engine', 'eng-r10', '--engine-br', '--rate', '900k', '--dry']);
  assert.equal(o.id, 'mw-en'); assert.equal(o.tree, '/x/tree'); assert.equal(o.mode, 'save'); assert.equal(o.profile, 'new');
  assert.equal(o.teach, 2); assert.equal(o.runs, 2); assert.equal(o.rate, 900000); assert.equal(o.engineBr, true); assert.equal(o.dry, true);
  assert.equal(o.place, '-3,7'); assert.equal(o.target, '-3 7'); assert.equal(o.toX, -3);
  assert.equal(o.saveFile, '/tmp/orthros-scratch/mw-load/saves/-3_7.omwsave');
  // (defaults: a returning player, nothing taught, scenario C)
  const d = parseArgs(['mw-en', '--tree', 't']);
  assert.equal(d.profile, 'warm'); assert.equal(d.teach, 0); assert.equal(d.mode, 'coe'); assert.equal(d.engineBr, false); assert.equal(d.rate, 1.8e6);
  for (const [argv, why] of [
    [['--tree', 't'], /manifest id/], [['mw-en'], /--tree/], [['mw-en', '--tree', 't', '--profile', 'old'], /warm or new/],
    [['mw-en', '--tree', 't', '--teach', '1.5'], /integer/], [['mw-en', '--tree', 't', '--teach', '-1'], /integer/],
    [['mw-en', '--tree', 't', '--engine-br'], /--engine/], [['mw-en', '--tree', 't', '--to', 'balmora'], /x,y/],
    [['mw-en', '--tree', 't', '--rate', 'fast'], /rate/], [['mw-en', '--tree', 't', '--techa', '1'], /unknown/],
    [['mw-en', '--tree', 't', '--teach'], /value expected/], [['mw-en', '--tree', 't', '--scratch', '/var/lib/orthros2'], /live state/],
  ]) assert.throws(() => parseArgs(argv), why, argv.join(' '));
});

test('place-load: --input-trace and its cadence, block check; only with a load', () => {
  const d = parseArgs(['mw-en', '--tree', 't', '--mode', 'save']);
  assert.equal(d.inputTrace, false); assert.equal(d.inputEvery, 50); assert.equal(d.inputKeys, 1000); assert.equal(d.inputBlock, 0);
  const o = parseArgs(['mw-en', '--tree', 't', '--mode', 'save', '--input-trace', '--input-every', '25', '--input-keys', '0', '--input-block', '2000']);
  assert.equal(o.inputTrace, true); assert.equal(o.inputEvery, 25); assert.equal(o.inputKeys, 0); assert.equal(o.inputBlock, 2000);
  for (const [argv, why] of [
    [['--input-block', '2000'], /with --input-trace only/], [['--input-trace', '--input-every', '5'], />= 10/],
    [['--input-trace', '--input-keys', '50'], /every 200 ms/], [['--input-trace', '--mode', 'glide'], /not a glide/],
  ]) assert.throws(() => parseArgs(['mw-en', '--tree', 't', ...argv]), why, argv.join(' '));
});

test('place-load: a dev engine release\'s brotli siblings, made once, only under the scratch root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-load-br-'));
  try {
    const rel = path.join(tmp, 'eng-r10dev'), e = path.join(rel, 'e', 'abc');
    fs.mkdirSync(e, { recursive: true });
    fs.writeFileSync(path.join(rel, 'release.json'), '{}');
    for (const n of ['openmw.js', 'openmw.wasm', 'openmw.data']) fs.writeFileSync(path.join(e, n), n.repeat(500));
    fs.writeFileSync(path.join(e, 'streamfs.js'), 'x');
    assert.deepEqual(engineBrotli(rel, { root: tmp, make: false }).map((r) => r.made), [false, false, false]);
    assert.equal(fs.existsSync(path.join(e, 'openmw.js.br')), false);
    const made = engineBrotli(rel, { root: tmp });
    assert.deepEqual(made.map((r) => [path.basename(r.file), r.made]), [['openmw.js', true], ['openmw.wasm', true], ['openmw.data', true]]);
    assert.equal(zlib.brotliDecompressSync(fs.readFileSync(path.join(e, 'openmw.data.br'))).toString(), 'openmw.data'.repeat(500));
    assert.equal(fs.existsSync(path.join(e, 'streamfs.js.br')), false);
    // (fresh: kept; a file newer than its sibling: made again)
    assert.deepEqual(engineBrotli(rel, { root: tmp }).map((r) => r.made), [false, false, false]);
    const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(e, 'openmw.wasm'), later, later);
    assert.deepEqual(engineBrotli(rel, { root: tmp }).map((r) => r.made), [false, true, false]);
    // (a release elsewhere — a link out of the root included — refused)
    assert.throws(() => engineBrotli(rel, { root: path.join(tmp, 'other') }), /only for a release under/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'place-load-out-'));
    try { fs.symlinkSync(outside, path.join(tmp, 'link')); assert.throws(() => engineBrotli(path.join(tmp, 'link'), { root: tmp }), /only for a release under/); } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('place-load: the learned places\' summary, as the server stores them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-load-pl-'));
  try {
    assert.equal(placesSummary(tmp, 'mw-en', '-2,6'), null);
    const f = path.join(tmp, 'places-mw-en.json');
    // (server.js placesWrite: [lang, place, at, sessions, gen, [[kind, path, start, end, gen, rank]]]; the newest entry of the place)
    fs.writeFileSync(f, JSON.stringify([['', '-2,6', 5, 1, 1, [[0, 'Meshes/a.nif', 0, 1e6, 1, 1]]], ['fr', '-2,6', 9, 2, 2, [[0, 'Meshes/a.nif', 0, 2e6, 2, 1], [2, 'Textures/b.dds', 0, 5e5, 2, 2]]], ['', 'ald-ruhn, guild', 3, 1, 1, []]]));
    const r = placesSummary(tmp, 'mw-en', '-2,6');
    assert.deepEqual((({ places, target, targetMB, sessions }) => ({ places, target, targetMB, sessions }))(r), { places: 3, target: 2, targetMB: 2.5, sessions: 2 });
    assert.deepEqual([...r.paths], ['Meshes/a.nif', 'Textures/b.dds']);
    assert.equal(JSON.stringify(r).includes('paths'), false, 'the paths stay out of the row');
    assert.equal(placesSummary(tmp, 'mw-en', '0,0').target, null);
    fs.writeFileSync(f, '{cut');
    assert.match(placesSummary(tmp, 'mw-en', '-2,6').error, /JSON/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('place-load: the menu-time prefetch from a proxy log', () => {
  const g = (t, ms, q, wire = 1000, file = 'Meshes/a.nif') => ({ t, ms, url: `/gamez/mw-en/${file}?r=0-2000${q}`, wire, method: 'GET', status: 200 });
  const recs = [
    { t: 100, ms: 5, url: '/ports/openmw/mw-en/app/index.html' },
    { t: 2000, ms: 90, url: '/api/places/mw-en?place=-2%2C6', method: 'GET', status: 200 },
    g(3000, 500, '&p=1'), g(4000, 200, '&p=1', 1000, 'Meshes/other.nif'), g(9000, 300, '&p=1'), g(11900, 400, '&p=1', 1000, '.light/Meshes/a.nif'), g(11950, 10, '&w=1'),
    g(12500, 100, '&p=1'), g(12600, 100, '&s=1'),
    { mark: 'place-1' },
  ];
  const r = prefetchReport(recs, { docT: 100, menuT: 8000, keyT: 12000, placePaths: new Set(['Meshes/a.nif']) });
  // (the place's files in the background before the key — a light copy as its file —, not another file's, not after the key)
  assert.deepEqual(r.place, { count: 3, wireMB: 0, decodedMB: 0.01, firstS: 2.9, lastEndS: 12.2, lastEndToKeyS: 0.3, inFlightAtKey: 1 });
  assert.equal(r.want.count, 1);
  assert.equal(r.beforeMenu.count, 1); assert.equal(r.inMenu.count, 2);
  assert.deepEqual(r.places.map((p) => [p.atS, p.keyS, p.status]), [[1.9, -10, 200]]);
  // (no key: nothing counted before it; no menu time: no split; no place known: none of the background is the place's)
  assert.equal(prefetchReport(recs, { keyT: null }).place.count, 0);
  assert.equal(prefetchReport(recs, { keyT: 12000 }).inMenu, null);
  assert.equal(prefetchReport(recs, { keyT: 12000 }).place.count, 0);
});

test('place-load: scratchGames gives an re3 version of each of two games its own engine release', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-load-'));
  try {
    const live = path.join(tmp, 'live'), out = path.join(tmp, 'games-r3');
    const game = (g, v) => {
      fs.mkdirSync(path.join(live, g, 'versions', v.dir), { recursive: true }); fs.mkdirSync(path.join(live, g, 'base'), { recursive: true });
      fs.writeFileSync(path.join(live, g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: g, name: g, defaultVersion: v.id, defaults: { runtime: 're3' }, versions: [v] }));
    };
    game('vc', { id: 'vc-revc', dir: 'revc', version: '1', re3: { engine: 'revc-r2' } });
    game('vc-plus', { id: 'vc-plus', dir: 'plus', version: '1', re3: { engine: 'revc-plus-r2', modes: ['story'] } });
    game('other', { id: 'other-en', dir: 'en', version: '1', re3: { engine: 'revc-r2' } });
    const made = scratchGames({ live, out, engines: { 'vc-revc': 'revc-r3', 'vc-plus': 'revc-plus-r3' } });
    assert.deepEqual(made.changed, { 'vc-revc': { game: 'vc', previous: 'revc-r2' }, 'vc-plus': { game: 'vc-plus', previous: 'revc-plus-r2' } });
    const read = (g) => JSON.parse(fs.readFileSync(path.join(out, g, 'manifest.json'), 'utf8')).versions[0].re3;
    assert.deepEqual(read('vc'), { engine: 'revc-r3' });
    assert.deepEqual(read('vc-plus'), { engine: 'revc-plus-r3', modes: ['story'] });
    assert.ok(fs.lstatSync(path.join(out, 'other', 'manifest.json')).isSymbolicLink()); // (an unchanged game: its own)
    assert.throws(() => scratchGames({ live, out, engines: { 'vc-revc': 'x', nope: 'y' } }), /nope: no version/);
    clearScratchGames(out);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('place-load: glide and door options', () => {
  const g = parseArgs(['mw-en', '--tree', 't', '--mode', 'glide', '--glide', '1,0,600', '--seconds', '90']);
  assert.deepEqual(g.glide, { dx: 1, dy: 0, speed: 600, z: 3000 }); assert.equal(g.seconds, 90); assert.equal(g.start, '-2,-9');
  assert.equal(g.warmDir, '/tmp/orthros-scratch/mw-load/profile-warm');
  const d = parseArgs(['mw-en', '--tree', 't', '--mode', 'door', '--interior', 'Balmora, Council Club', '--lead', '5']);
  // (Balmora by default, its own warm profile; the id lowercased as the engine's label has it: ASCII only)
  assert.equal(d.start, '-3,-2'); assert.equal(d.warmDir, '/tmp/orthros-scratch/mw-load/profile-warm--3,-2');
  assert.equal(d.interior, 'balmora, council club'); assert.equal(d.leadS, 5);
  assert.equal(parseArgs(['mw-en', '--tree', 't', '--mode', 'door']).interior, 'balmora, south wall cornerclub');
  assert.equal(parseArgs(['mw-en', '--tree', 't', '--mode', 'door', '--interior', 'Échoppe de Île']).interior, 'Échoppe de Île'.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  assert.equal(parseArgs(['mw-en', '--tree', 't', '--mode', 'door', '--interior', 'ÉCHOPPE']).interior, 'Échoppe');
  assert.equal(parseArgs(['mw-en', '--tree', 't', '--query', 'lead=0']).query, 'lead=0');
  const t = parseArgs(['mw-en', '--tree', 't', '--teach', '1', '--teach-query', 'lead=1']);
  assert.deepEqual([t.query, t.teachQuery], ['', 'lead=1']);
  for (const [argv, why] of [
    [['--mode', 'walk'], /coe or save or glide or door/], [['--glide', '0,0'], /direction/], [['--glide', '1'], /direction/], [['--glide', '0,1,-3'], /speed/],
    [['--seconds', '2'], />= 5/], [['--interior', 'a"b'], /no quote/], [['--lead', '-1'], />= 0/], [['--query', 'a b'], /name=value/], [['--teach-query', 'a'], /--teach-query a: name=value/],
  ]) assert.throws(() => parseArgs(['mw-en', '--tree', 't', ...argv]), why, argv.join(' '));
  assert.deepEqual(glideSpec('0,1'), { dx: 0, dy: 1, speed: 300, z: 3000 });
  // (perf.mjs's line: from the start cell's centre, the direction normalised)
  assert.deepEqual(glideLine('-2,-9', { dx: 0, dy: 2, speed: 300, z: 100 }), { x0: -12288, y0: -69632, vx: 0, vy: 300, z: 100 });
});

test('place-load: a glide\'s crossings from the probe', () => {
  const cells = [['-2 -9', 1000], ['-2 -8', 5000], ['-2 -7', 12000], ['-2 -6', 40000]];
  const gaps = [[4900, 5400], [5600, 5700], [12100, 15100], [13000, 13050]];
  const samples = [[1000, 0, 0, 0, 0, 0], [4500, 10, 1, 0, 0, 0], [11000, 300, 3, 1, 200, 40], [16000, 3300, 4, 2, 3000, 90]];
  const r = crossings({ cells, gaps, samples, from: 1000, to: 20000 });
  // (the cell glided from is not a crossing; one beyond the glide's end neither; the last one runs to the end)
  assert.deepEqual(r.map((c) => [c.cell, c.atS, c.ms]), [['-2 -8', 4, 7000], ['-2 -7', 11, 8000]]);
  assert.deepEqual(r[0], { cell: '-2 -8', atS: 4, ms: 7000, longestGapMs: 500, gapsOver250: 1, gapsOver250Ms: 500, stallMs: 290, syncFetches: 2, wantWaits: 1, wantWaitMs: 200, wants: 40 });
  assert.deepEqual([r[1].longestGapMs, r[1].gapsOver250, r[1].stallMs, r[1].wantWaitMs], [3000, 1, 3000, 2800]);
  assert.deepEqual(crossings({ cells, gaps, samples: [], from: 1000, to: 20000 })[0].stallMs, null);
});

test('place-load: the learned places\' ranges and a stretch\'s reads against them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-load-cov-'));
  try {
    assert.equal(learnedSets(tmp, 'mw-en').size, 0);
    fs.writeFileSync(path.join(tmp, 'places-mw-en.json'), JSON.stringify([
      ['', '-2,-8', 5, 1, 1, [[0, 'Morrowind.bsa', 0, 1000, 1, 1], [0, 'Morrowind.bsa', 500, 2000, 1, 2]]],
      ['fr', '-2,-8', 9, 1, 2, [[0, 'Morrowind.bsa', 0, 600, 2, 1]]],
      ['', 'balmora, guild', 3, 1, 1, [[2, 'Textures/a.dds', 0, 4000, 1, 1]]],
    ]));
    const sets = learnedSets(tmp, 'mw-en');
    // (each place's newest entry)
    assert.deepEqual([...sets.keys()], ['-2,-8', 'balmora, guild']);
    assert.deepEqual(sets.get('-2,-8').get('Morrowind.bsa'), [[0, 600]]);
    const g = (t, url) => ({ t, ms: 50, wire: 100, url });
    const recs = [
      g(100, '/gamez/mw-en/Morrowind.bsa?r=400-1400&s=x'), g(200, '/gamez/mw-en/Textures/a.dds?r=0-2000&w=1'), g(300, '/gamez/mw-en/.light/Textures/a.dds?r=1000-5000'),
      g(400, '/gamez/mw-en/Meshes/b.nif?r=0-3000&p=1'), g(500, '/api/places/mw-en'), { mark: 'x' }, g(5000, '/gamez/mw-en/Morrowind.bsa?r=0-100'),
    ];
    const r = readCoverage(recs, 0, 1000, sets, '-2,-8');
    // (the background not counted; the light copy as its file; only the bytes inside a range)
    assert.equal(r.reads, 3); assert.equal(r.MB, 0.01); assert.equal(r.placeKnown, true);
    assert.deepEqual(r.files.map((f) => f.path), ['Textures/a.dds', 'Morrowind.bsa']);
    // (a read touching a learned record of its file counts whole — the fetch units are larger than the records —; a
    // light copy's read whole when its file is in the set; the cell's set and any place's)
    const big = [g(100, '/gamez/mw-en/Morrowind.bsa?r=400000-1400000'), g(200, '/gamez/mw-en/Textures/a.dds?r=0-2000000&w=1'),
      g(300, '/gamez/mw-en/Morrowind.bsa?r=3000000-4000000'), g(400, '/gamez/mw-en/.light/Textures/a.dds?r=5000000-6000000')];
    const sets2 = new Map([['-2,-8', new Map([['Morrowind.bsa', [[0, 600000], [500000, 900000]]]])], ['x', new Map([['Textures/a.dds', [[0, 1000000]]]])]]);
    const c = readCoverage(big, 0, 1000, sets2, '-2,-8');
    assert.deepEqual([c.MB, c.inPlaceMB, c.inAnyMB], [5, 1, 4]);
    assert.deepEqual(c.files, [{ path: 'Textures/a.dds', MB: 3, unknownMB: 0 }, { path: 'Morrowind.bsa', MB: 2, unknownMB: 1 }]);
    assert.equal(readCoverage(big, 0, 1000, sets2, 'nowhere').placeKnown, false);
    // (several places: a read named by any of them)
    assert.deepEqual([readCoverage(big, 0, 1000, sets2, ['-2,-8', 'x']).inPlaceMB, readCoverage(big, 0, 1000, sets2, ['nowhere', 'x']).placeKnown], [4, true]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('place-load: a glide run\'s report', () => {
  const P = { from: 1000, cells: [['-2 -9', 1000], ['-2 -8', 5000], ['', 6000]], gaps: [[5000, 5600]], samples: [[1000, 0, 0, 0, 0, 0], [9000, 600, 2, 1, 500, 10]] };
  const recs = [{ t: 105500, ms: 10, wire: 10, url: '/gamez/mw-en/Morrowind.bsa?r=0-1000000' }];
  const sets = new Map([['-2,-8', new Map([['Morrowind.bsa', [[0, 1000000]]]])]]);
  const r = glideReport({ P, glideEnd: 9000, recs, proxyOf: (t) => t + 100000, sets });
  assert.deepEqual(r.crossings.map((c) => [c.cell, c.ms, c.net.MB, c.net.inPlaceMB]), [['-2 -8', 4000, 1, 1]]);
  assert.deepEqual(r.total, { seconds: 8, crossings: 1, longestGapMs: 600, gapsOver250: 1, gapsOver250Ms: 600, stallMs: 600, syncFetches: 2, wantWaitMs: 500, netMB: 1, learnedMB: 1 });
  assert.deepEqual(glideReport({ P, glideEnd: null, recs, proxyOf: () => null, sets }).crossings, []);
  // (a crossing's window against the next cell's set too: the engine's preload fetched that row before it announced it)
  const P2 = { from: 1000, cells: [['-2 -9', 1000], ['-2 -8', 5000], ['-2 -7', 9000]], gaps: [], samples: [] };
  const sets2 = new Map([['-2,-7', new Map([['Morrowind.bsa', [[0, 1000000]]]])], ['-2,-6', new Map([['Morrowind.bsa', [[2000000, 3000000]]]])]]);
  const recs2 = [{ t: 105500, ms: 10, wire: 10, url: '/gamez/mw-en/Morrowind.bsa?r=0-1000000' }, { t: 110500, ms: 10, wire: 10, url: '/gamez/mw-en/Morrowind.bsa?r=2000000-3000000' }];
  const r2 = glideReport({ P: P2, glideEnd: 12000, recs: recs2, proxyOf: (t) => t + 100000, sets: sets2 });
  // (-2 -8's window: -2,-7's set, the next crossing; -2 -7's, the last: -2,-6 the same way)
  assert.deepEqual(r2.crossings.map((c) => [c.cell, c.net.MB, c.net.inPlaceMB]), [['-2 -8', 1, 1], ['-2 -7', 1, 1]]);
  assert.equal(r2.total.learnedMB, 2);
});
