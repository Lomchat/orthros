// A GoldSrc map's load announced (src/ports/goldsrc/bsp-reads.js, docs/browser-ports.md "Map loads announced"): a
// synthetic BSP v30 and WAD3 archives — the lumps, the entities, the textures found in the WADs as the engine finds them,
// the sky, the entities' files, the files beside the map; a map's own textures from a WAD only with r_wadtextures, its
// node graph only when the page runs its server — and the page's hook: a listing's read announces nothing (its .res
// neither), a load's announces its reads once (the WAD lumps as the light copy the archive is read as, from the
// directory parsed when the engine read it), its .res fetched announced and its entries a second list, never reported
// as the engine's reads; the shared WAD3 reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bspLumps, bspTextures, parseEntities, looksLikeEntities, mapReads, resReads, announceMapLoads, configSetting, BSP_HEADER, BSP_LUMPS } from '../src/ports/goldsrc/bsp-reads.js';
import { wadEntries, wadHeader, WAD_MIPTEX } from '../src/vfs/wad3.js';
import { GameData } from '../src/vfs/data-client.js';

const enc = (s) => new TextEncoder().encode(s);
const cat = (parts) => { const n = parts.reduce((a, b) => a + b.length, 0), out = new Uint8Array(n); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

/** A WAD3: lumps [name, type, bytes] in order, then the directory. Returns { bytes, at: name → { pos, disk } }. */
function wad3(lumps) {
  const parts = [new Uint8Array(12)], dir = new Uint8Array(lumps.length * 32), dv = new DataView(dir.buffer), at = {};
  let pos = 12;
  lumps.forEach(([name, type, b], i) => {
    dv.setInt32(i * 32, pos, true); dv.setInt32(i * 32 + 4, b.length, true); dv.setInt32(i * 32 + 8, b.length, true); dir[i * 32 + 12] = type;
    dir.set(enc(name).subarray(0, 15), i * 32 + 16);
    at[name.toLowerCase()] = { pos, disk: b.length };
    parts.push(b); pos += b.length;
  });
  const head = parts[0], hv = new DataView(head.buffer);
  head.set(enc('WAD3')); hv.setInt32(4, lumps.length, true); hv.setInt32(8, pos, true);
  return { bytes: cat([...parts, dir]), at };
}
/** A miptex: its 40-byte head (name, size, level offsets: 0 when its pixels are elsewhere), then `pixels` bytes. */
function miptex(name, pixels = 0) {
  const b = new Uint8Array(40 + pixels), v = new DataView(b.buffer);
  b.set(enc(name).subarray(0, 15)); v.setUint32(16, 16, true); v.setUint32(20, 16, true);
  if (pixels) v.setUint32(24, 40, true);
  return b;
}
/** A v30 BSP: lump 0 the entities' text (lump 1 with `swap`), lump 2 the textures (names; '+name' embedded; null: -1). */
function bsp(entities, textures, { swap = false, filler = 4096 } = {}) {
  const ents = enc(entities + '\0');
  const heads = textures.map((t) => (t === null ? null : t.startsWith('+') ? miptex(t.slice(1), 256) : miptex(t)));
  const offs = [], body = []; let o = 4 + textures.length * 4;
  for (const h of heads) { offs.push(h ? o : -1); if (h) { body.push(h); o += h.length; } }
  const tl = new Uint8Array(4 + textures.length * 4), tv = new DataView(tl.buffer);
  tv.setInt32(0, textures.length, true); offs.forEach((x, i) => tv.setInt32(4 + i * 4, x, true));
  const texLump = cat([tl, ...body]), planes = new Uint8Array(filler).fill(3);
  const lumps = Array.from({ length: BSP_LUMPS }, () => new Uint8Array(0));
  lumps[swap ? 1 : 0] = ents; lumps[swap ? 0 : 1] = planes; lumps[2] = texLump; lumps[3] = new Uint8Array(filler).fill(9);
  const head = new Uint8Array(BSP_HEADER), hv = new DataView(head.buffer); hv.setInt32(0, 30, true);
  let at = BSP_HEADER;
  lumps.forEach((l, i) => { hv.setInt32(4 + i * 8, at, true); hv.setInt32(8 + i * 8, l.length, true); at += l.length; });
  return cat([head, ...lumps]);
}

const ENTITIES = `{
"classname" "worldspawn"
"wad" "\\quiver\\valve\\halflife.wad;c:\\maps\\Other.WAD;\\gone\\nothere.wad"
"skyname" "night"
}
// a comment
{ "classname" "env_sprite" "model" "sprites/glow.spr" }
{ "classname" "func_door" "model" "*3" }
{ "classname" "cycler" "model" "models\\Thing.mdl" }
{ "classname" "ambient_generic" "message" "ambience/wind.wav" }
{ "classname" "ambient_generic" "message" "!SENTENCE_1" }
{ "classname" "trigger_once" "message" "not/a/sound.wav" }
{ "classname" "info_target" "model" "models/missing.mdl" }`;

test('a v30 BSP\'s lumps, entities (either of the first two lumps) and textures, read as the engine reads them', () => {
  const b = bsp(ENTITIES, ['Wall1', '+emb1', null, 'wall1', 'gone']);
  const lumps = bspLumps(b, b.length);
  assert.equal(lumps.length, BSP_LUMPS);
  assert.equal(bspLumps(b, lumps[3].off + lumps[3].len - 1), null, 'a lump past the file\'s end');
  const v = b.slice(); v[0] = 29; assert.equal(bspLumps(v, v.length), null, 'not v30');
  const ents = parseEntities(new TextDecoder('latin1').decode(b.subarray(lumps[0].off, lumps[0].off + lumps[0].len)));
  assert.equal(ents.length, 8);
  assert.equal(ents[0].wad.split(';').length, 3); assert.equal(ents[0].skyname, 'night'); assert.equal(ents[3].model, 'models\\Thing.mdl');
  assert.deepEqual(bspTextures(b.subarray(lumps[2].off, lumps[2].off + lumps[2].len)), [{ name: 'wall1', external: true }, { name: 'emb1', external: false }, { name: 'gone', external: true }]);
  const s = bsp(ENTITIES, ['wall1'], { swap: true }), sl = bspLumps(s, s.length);
  assert.ok(!looksLikeEntities(s.subarray(sl[0].off, sl[0].off + sl[0].len)) && looksLikeEntities(s.subarray(sl[1].off, sl[1].off + sl[1].len)), 'the entities in lump 1');
  assert.deepEqual(parseEntities('{ "a" "1" } { "b" "2"'), [{ a: '1' }], 'a truncated entity dropped');
});

test('the shared WAD3 reader: header and directory entries, names without case, entries past the file left out', () => {
  const w = wad3([['WALL1', WAD_MIPTEX, miptex('WALL1', 64)], ['pic', 0x42, new Uint8Array(20)]]);
  const hd = wadHeader(w.bytes, w.bytes.length);
  assert.deepEqual(hd, { n: 2, dir: w.bytes.length - 64 });
  assert.equal(wadHeader(w.bytes, w.bytes.length - 1), null, 'a directory past the end');
  const e = wadEntries(w.bytes.subarray(hd.dir), hd.n, w.bytes.length);
  assert.deepEqual(e.map((x) => [x.name, x.pos, x.disk, x.type]), [['wall1', 12, 104, WAD_MIPTEX], ['pic', 116, 20, 0x42]]);
  assert.equal(wadEntries(w.bytes.subarray(hd.dir), hd.n, 100).length, 0);
  const bad = w.bytes.slice(); bad[3] = 0x32; assert.equal(wadHeader(bad, bad.length), null, 'WAD2');
});

test('what a map\'s load reads: each texture from the last WAD of the map\'s list that has it, the sky, the entities\' files, the files beside the map', () => {
  const files = new Map(), h = (p) => { const k = p.toLowerCase(); if (!files.has(k)) files.set(k, { name: 'v', path: p, size: 100 }); return files.get(k); };
  const have = new Set(['cstrike/gfx/env/nightrt.tga', 'cstrike/gfx/env/nightbk.tga', 'cstrike/gfx/env/nightlf.tga', 'cstrike/gfx/env/nightft.tga', 'cstrike/gfx/env/nightup.tga',
    'valve/gfx/env/nightdn.bmp', 'valve/sprites/glow.spr', 'cstrike/models/thing.mdl', 'valve/sound/ambience/wind.wav', 'cstrike/maps/graphs/m1.nod', 'cstrike/overviews/m1.txt',
    'cstrike/overviews/m1.bmp', 'cstrike/models/fromres.mdl', 'cstrike/sound/res/a.wav']);
  const find = (rel) => { for (const d of ['cstrike', 'valve']) if (have.has(`${d}/${rel.toLowerCase()}`)) return h(`${d}/${rel.toLowerCase()}`); return null; };
  const hl = h('valve/halflife.wad'), other = h('cstrike/other.wad');
  const wads = { halflife: { h: hl, dir: new Map([['wall1', { pos: 100, disk: 50 }], ['emb1', { pos: 200, disk: 60 }], ['solo', { pos: 300, disk: 70 }]]) },
    other: { h: other, dir: new Map([['wall1', { pos: 1000, disk: 80 }]]) } };
  const textures = [{ name: 'wall1', external: true }, { name: 'emb1', external: false }, { name: 'solo', external: true }, { name: 'gone', external: true }, { name: 'mapown', external: false }];
  const res = '// list\r\nmodels/fromres.mdl\r\nother.wad\r\nmaps/m1.bsp\r\nsound/res/a.wav\r\nsound/res/missing.wav\r\n';
  const r = mapReads({ map: 'M1', entities: parseEntities(ENTITIES), textures, find, wad: (n) => wads[n] ?? null, res, wadTextures: true, server: true });
  const got = r.entries.map((e) => (e.off === undefined ? e.h.path : `${e.h.path}@${e.off}+${e.len}`));
  assert.deepEqual(got, ['cstrike/other.wad@1000+80', 'valve/halflife.wad@200+60', 'valve/halflife.wad@300+70',
    'cstrike/gfx/env/nightrt.tga', 'cstrike/gfx/env/nightbk.tga', 'cstrike/gfx/env/nightlf.tga', 'cstrike/gfx/env/nightft.tga', 'cstrike/gfx/env/nightup.tga', 'valve/gfx/env/nightdn.bmp',
    'valve/sprites/glow.spr', 'cstrike/models/thing.mdl', 'valve/sound/ambience/wind.wav', 'cstrike/maps/graphs/m1.nod', 'cstrike/overviews/m1.txt', 'cstrike/overviews/m1.bmp',
    'cstrike/models/fromres.mdl', 'cstrike/sound/res/a.wav']);
  assert.equal(r.textures, 3); assert.equal(r.missing, 1, 'the external texture no WAD has; the map\'s own embedded one is read from the map');
  // (r_wadtextures 0 — the engine's default —: a texture the map holds is read from the map, not from a WAD that has it;
  // a client of another's server: no node graph)
  const own = mapReads({ map: 'M1', entities: parseEntities(ENTITIES), textures, find, wad: (n) => wads[n] ?? null, res });
  const ownGot = own.entries.map((e) => (e.off === undefined ? e.h.path : `${e.h.path}@${e.off}+${e.len}`));
  assert.deepEqual(ownGot, got.filter((x) => x !== 'valve/halflife.wad@200+60' && x !== 'cstrike/maps/graphs/m1.nod'));
  assert.equal(own.textures, 2); assert.equal(own.missing, 1);
  assert.deepEqual(resReads(res, find).map((e) => e.h.path), ['cstrike/models/fromres.mdl', 'cstrike/sound/res/a.wav']);
  // (no wad key, no sky, nothing beside it: nothing but the entities' files)
  const bare = mapReads({ map: 'm2', entities: [{ classname: 'worldspawn' }], textures: [{ name: 'wall1', external: true }], find: () => null, wad: () => null });
  assert.deepEqual(bare, { entries: [], textures: 0, missing: 1 });
});

/** A GameData of a fake worker (its messages kept) over a tree of `files` (path → bytes; `lights`: same-size light copies). */
function pageData(files, lights = []) {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  const tree = { dirs: {}, files: {} };
  for (const [p, b] of Object.entries(files)) {
    const parts = p.split('/'); let node = tree;
    for (const d of parts.slice(0, -1)) node = node.dirs[d] ??= { dirs: {}, files: {} };
    node.files[parts.at(-1)] = { size: b.length, mtime: 1, ...(lights.includes(p) ? { light: b.length } : {}) };
  }
  data.trees = { v: tree };
  return { data, told };
}

test('the page\'s hook: a listing\'s read of a map announces nothing; its load announces its reads once, at once, the WAD lumps as the copy the archive is read as; its .res a second list, not the engine\'s reads', async () => {
  // (the textures far from the header and the directory: the pieces the engine read at the mount are not theirs)
  const w = wad3([['pad1', 0x42, new Uint8Array(140000)], ['wall1', WAD_MIPTEX, miptex('wall1', 1024)], ['emb1', WAD_MIPTEX, miptex('emb1', 2048)], ['pad2', 0x42, new Uint8Array(140000)]]);
  const map = bsp(ENTITIES.replace('Other.WAD', 'none.wad'), ['wall1', '+emb1', 'gone'], { filler: 70000 });
  const files = { 'valve/maps/m1.bsp': map, 'valve/halflife.wad': w.bytes, 'valve/sprites/glow.spr': new Uint8Array(500), 'valve/models/thing.mdl': new Uint8Array(900),
    'valve_fr/sound/ambience/wind.wav': new Uint8Array(700), 'valve/maps/m1.res': enc('models/thing.mdl\nsprites/glow.spr\n') };
  const { data, told } = pageData(files, ['valve/halflife.wad']);
  try {
    // (the archive mounted at the engine's start, read light — the link not measured —: its directory in the page as the light copy's)
    const hw = data.file('v', 'valve/halflife.wad');
    assert.notEqual(data.pick(hw, 0), hw, 'read light');
    const lw = data.fileAs('v', '.light/valve/halflife.wad', hw.size), last = Math.floor((w.bytes.length - 64) / 65536);
    data.keep(lw, 0, w.bytes.subarray(0, 65536)); data.keep(lw, last, w.bytes.subarray(last * 65536));
    data.keep(data.file('v', 'valve/maps/m1.bsp'), 0, files['valve/maps/m1.bsp']); // (m1.res: not in the page)
    // (a language's folder over the game's: the engine's path is where it goes)
    const shown = Object.keys(files).map((p) => (p.startsWith('valve_fr/') ? { path: p, at: 'valve/' + p.slice(9) } : { path: p }));
    const hb = data.file('v', 'valve/maps/m1.bsp');
    const node = { path: '/rodir/valve/maps/m1.bsp', usedBytes: map.length, stream_ops: { read: (s, buf, off, len, pos) => data.read(hb, buf, off, len, pos) } };
    const wadNode = { path: '/rodir/valve/halflife.wad', usedBytes: w.bytes.length, stream_ops: { read: (s, buf, off, len, pos) => data.read(hw, buf, off, len, pos) } };
    const FS = { getPath: (n) => n.path }, logs = [], told2 = [];
    const opts = { name: 'v', files: shown, root: '/rodir', gameDir: 'valve', log: (t) => logs.push(t), wadTextures: () => true, announced: (m) => told2.push(m) };
    assert.equal(announceMapLoads(FS, [node, wadNode, { path: '/rodir/valve/sprites/glow.spr', stream_ops: {} }], data, opts), 1);
    // (the engine mounts the archive: its header, then its directory — parsed then; later, those pieces leave the page)
    const wb = new Uint8Array(w.bytes.length);
    wadNode.stream_ops.read({}, wb, 0, 12, 0); wadNode.stream_ops.read({}, wb, 0, 64, w.bytes.length - 64);
    data.cache.clear(); data.held = 0;
    data.keep(hb, 0, map); data.used.length = 0;
    const buf = new Uint8Array(map.length);
    // (a listing: the header and the entities — not half the file)
    const listing = {};
    node.stream_ops.read(listing, buf, 0, BSP_HEADER, 0);
    node.stream_ops.read(listing, buf, 0, 600, BSP_HEADER);
    assert.equal(told.filter((m) => m.want || m.read).length, 0, 'nothing announced, its .res neither');
    // (a load: the whole file, in two reads — announced after the read that reaches half, once)
    const load = {};
    node.stream_ops.read(load, buf, 0, BSP_HEADER, 0);
    assert.equal(told.filter((m) => m.want).length, 0);
    node.stream_ops.read(load, buf, BSP_HEADER, map.length - BSP_HEADER, BSP_HEADER);
    const wants = told.filter((m) => m.want);
    assert.equal(wants.length, 2, 'posted at once, the page\'s thread never yielding: its .res, then its reads');
    assert.deepEqual(wants[0].want.list, [['v', 'valve/maps/m1.res', 0, files['valve/maps/m1.res'].length]]);
    assert.equal(wants[0].want.label, 'res:m1'); assert.equal(wants[0].want.wait, false);
    const ask = told.find((m) => m.read);
    assert.ok(ask && ask.read.path === 'valve/maps/m1.res' && told.indexOf(ask) > told.indexOf(wants[0]), 'its .res fetched in the background, after its announce (the request joined)');
    const { want } = wants[1];
    assert.equal(want.seq, 0); assert.equal(want.wait, false); assert.equal(want.label, 'textures:m1');
    assert.deepEqual(want.list, [['v', '.light/valve/halflife.wad', w.at.wall1.pos, w.at.wall1.disk], ['v', '.light/valve/halflife.wad', w.at.emb1.pos, w.at.emb1.disk],
      ['v', 'valve/sprites/glow.spr', 0, 500], ['v', 'valve/models/thing.mdl', 0, 900], ['v', 'valve_fr/sound/ambience/wind.wav', 0, 700]]);
    assert.ok(hw.pin && !hw.pin.real, 'the archive\'s next open reads the light copy announced');
    assert.equal(data.wantSeq, 0, 'no batch: wantWait never waits for it');
    assert.match(logs.at(-1), /^Map m1: 5 of 5 reads announced \(2 textures from WADs, 1 not found, r_wadtextures\)$/);
    node.stream_ops.read(load, buf, 0, map.length, 0);
    assert.equal(told.filter((m) => m.want).length, 2, 'once an open');
    // (its .res here: its entries a second list — those the page has not —; its bytes never reported as the engine's)
    data.worker.onmessage({ data: { id: ask.read.id, bytes: files['valve/maps/m1.res'].slice() } });
    await new Promise((r) => setTimeout(r, 5));
    const third = told.filter((m) => m.want)[2];
    assert.ok(third, 'the .res\'s list');
    assert.equal(third.want.label, 'res:m1');
    assert.deepEqual(third.want.list, [['v', 'valve/models/thing.mdl', 0, 900], ['v', 'valve/sprites/glow.spr', 0, 500]]);
    assert.ok(![...data.used, ...told.flatMap((m) => m.used ?? [])].some(([, p]) => /\.res$/.test(p)), 'not reported as used');
    assert.deepEqual(told2, ['m1'], 'told after the announce, outside the read');
  } finally { data.close(); }
});

test('GameData.peek: the page\'s bytes without a fetch — the file\'s, or its same-layout light copy\'s —, null when some are missing', () => {
  const { data } = pageData({ 'a.wad': new Uint8Array(200000), 'b.bin': new Uint8Array(100) }, ['a.wad']);
  try {
    const a = data.file('v', 'a.wad'), light = data.fileAs('v', '.light/a.wad', a.size), b = data.file('v', 'b.bin');
    const bytes = Uint8Array.from({ length: 200000 }, (_, i) => (i * 7) & 255);
    assert.equal(data.peek(a, 0, 10), null);
    data.keep(light, 1, bytes.subarray(65536, 131072));
    assert.deepEqual(data.peek(a, 70000, 100), bytes.subarray(70000, 70100), 'from the light copy');
    assert.equal(data.peek(a, 60000, 10000), null, 'a piece missing');
    data.keep(a, 0, bytes.subarray(0, 65536)); data.keep(a, 1, bytes.subarray(65536, 131072));
    assert.deepEqual(data.peek(a, 60000, 10000), bytes.subarray(60000, 70000), 'across two pieces of the file');
    assert.equal(data.peek(b, 0, 10), null);
    assert.equal(data.sameLayout(a, light), true);
  } finally { data.close(); }
});

test('a console variable as the engine\'s configuration sets it: the last statement wins, quotes, `;`, comments, case', () => {
  const cfg = '// r_wadtextures "9"\nbind "w" "+forward"\nR_WadTextures "1"\nsv_cheats 0; r_wadtextures 0 ; echo "a;r_wadtextures 5"\nr_wadtexturesx 7\n';
  assert.equal(configSetting(cfg, 'r_wadtextures'), '0');
  assert.equal(configSetting('r_wadtextures "1"\r\n', 'r_wadtextures'), '1');
  assert.equal(configSetting('\nr_wadtextures 1\n', 'r_wadtextures'), '1', 'a command line\'s +r_wadtextures 1');
  assert.equal(configSetting('gl_vbo 1', 'r_wadtextures'), null);
});
