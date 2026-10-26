// Places learned from announcements (docs/slow-network.md "Places learned from announcements"): what an engine
// announced for a place's load (POST /api/places/<manifest>), listed for a page that fetches it before the click (GET).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/host/server.js';
import { BLOCK } from '../src/vfs/http-backend.js';

// (the br-cache's generation not paused by the machine's load nor its disk: a test on a busy machine)
const QUIET = { loadLimit: Infinity, diskLimit: 1, idleMs: 0, reseedMs: 3600e3 };

/**
 * A version 'g' (languages en, fr) of files meshes/a.nif (3000 B), meshes/b.nif (5000 B), textures/t.dds (BLOCK + 3000 B),
 * a server on it (`opts` its own, learnWriteMs 10 by default) restartable over the same learn directory.
 */
const placesServer = (t, opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-places-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const game = path.join(dir, 'game'), learn = path.join(dir, 'learn');
  fs.mkdirSync(path.join(game, 'meshes'), { recursive: true }); fs.mkdirSync(path.join(game, 'textures')); fs.mkdirSync(learn);
  const sizes = { 'meshes/a.nif': 3000, 'meshes/b.nif': 5000, 'textures/t.dds': BLOCK + 3000 };
  for (const [f, n] of Object.entries(sizes)) fs.writeFileSync(path.join(game, f), Buffer.alloc(n, f.length));
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: game, exe: 'x.exe', languages: ['en', 'fr'] }));
  const start = async (more = {}) => {
    const server = createServer({ manifests: path.join(dir, 'man'), learnDir: learn, learnWriteMs: 10, lanLog: () => {}, placeRuntimes: ['win32'], ...opts, ...more });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const close = () => new Promise((r) => { if (!server.listening) return r(); server.closeAllConnections?.(); server.close(r); });
    t.after(close);
    const origin = `http://127.0.0.1:${server.address().port}`, base = `${origin}/api/places/g`;
    const post = (body) => fetch(base, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    const get = async (q) => (await fetch(`${base}?${q}`)).json();
    return { server, origin, base, close, post, get };
  };
  return { dir, learn, sizes, start };
};

test('places: announced batches round trip — meshes, terrain, textures, each in its order; paths checked against the tree', async (t) => {
  const { start, sizes } = placesServer(t);
  const s = await start();
  const r1 = await s.post({ session: 's1', place: '-2,6', kind: 'textures', records: [['textures/t.dds', 0, -1], ['textures/nope.dds', 0, 10]] });
  assert.equal(r1.status, 200); assert.deepEqual(await r1.json(), { kept: 1 });
  // (out of the file, inverted, not integers, a path outside the tree, a light copy's — its file whole —, not a record)
  const r2 = await s.post({ session: 's1', place: '-2,6', kind: 'meshes', records: [['meshes/b.nif', 0, 5000], ['meshes/a.nif', 100, 200],
    ['meshes/a.nif', 0, 3001], ['meshes/a.nif', 50, 40], ['meshes/a.nif', 0.5, 10], ['../man/g.json', 0, 10], ['.light/meshes/a.nif', 7, 9], 'x', [1, 2, 3]] });
  assert.deepEqual(await r2.json(), { kept: 3 });
  assert.deepEqual(await (await s.post({ session: 's1', place: '-2,6', kind: 'terrain', records: [['meshes/a.nif', 0, 10]] })).json(), { kept: 1 });
  const got = await s.get('place=-2,6');
  assert.equal(got.place, '-2,6'); assert.equal(got.lang, null); assert.equal(got.sessions, 1);
  assert.deepEqual(got.list, [['meshes/b.nif', 0, 5000, 'meshes'], ['meshes/a.nif', 100, 200, 'meshes'], ['meshes/a.nif', 0, 3000, 'meshes'],
    ['meshes/a.nif', 0, 10, 'terrain'], ['textures/t.dds', 0, sizes['textures/t.dds'], 'textures']]);
  assert.equal(got.bytes, 5000 + 100 + 3000 + 10 + sizes['textures/t.dds']);
  // (a place nobody announced: an empty list; the places known)
  assert.deepEqual((await s.get('place=0,0')).list, []);
  assert.deepEqual((await s.get('')).map((e) => [e[0], e[1], e[2], e[4]]), [['-2,6', null, 1, 5]]);
  const n = await (await fetch(`${s.origin}/api/netstats`)).json();
  assert.deepEqual({ ...n.places }, { posts: 3, records: 5, dropped: 7, gets: 2, found: 1 });
});

test('places: malformed reports refused, unknown manifests 404, bodies bounded', async (t) => {
  const { start } = placesServer(t);
  const s = await start();
  const rec = [['meshes/a.nif', 0, 10]];
  assert.equal((await s.post('{')).status, 400);
  for (const bad of [{ place: '1,1', kind: 'meshes', records: rec }, { session: 'x'.repeat(41), place: '1,1', kind: 'meshes', records: rec },
    { session: 's', place: '', kind: 'meshes', records: rec }, { session: 's', place: 'a'.repeat(65), kind: 'meshes', records: rec },
    { session: 's', place: 'a\nb', kind: 'meshes', records: rec }, { session: 's', place: '1,1', kind: 'sounds', records: rec },
    { session: 's', place: '1,1', kind: 'meshes', records: 'x' }, null]) assert.equal((await s.post(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await s.post({ session: 's', place: '1,1', kind: 'meshes', records: [], pad: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
  // (nothing of the tree: no place made, no session counted)
  assert.deepEqual(await (await s.post({ session: 's', place: '1,1', kind: 'meshes', records: [['no.nif', 0, 1]] })).json(), { kept: 0 });
  assert.deepEqual(await s.get(''), []);
  assert.equal((await fetch(`${s.origin}/api/places/nope?place=1,1`)).status, 404);
  assert.equal((await fetch(`${s.origin}/api/places/nope`, { method: 'POST', body: JSON.stringify({ session: 's', place: '1,1', kind: 'meshes', records: rec }) })).status, 404);
});

test('places: a later session\'s list first, the earlier ones\' after it; a record no session of the last four announced out', async (t) => {
  const { start } = placesServer(t);
  const s = await start();
  const A = ['meshes/a.nif', 0, 3000], B = ['meshes/b.nif', 0, 5000], C = ['meshes/a.nif', 0, 100];
  await s.post({ session: 's1', place: 'balmora', kind: 'meshes', records: [A, B] });
  await s.post({ session: 's2', place: 'balmora', kind: 'meshes', records: [C, B] });
  assert.deepEqual((await s.get('place=balmora')).list.map((e) => e.slice(0, 3)), [C, B, A]);
  // (the same session's batches of one load: one session, the first rank of a record kept)
  await s.post({ session: 's2', place: 'balmora', kind: 'meshes', records: [A, C] });
  let got = await s.get('place=balmora');
  assert.equal(got.sessions, 2); assert.deepEqual(got.list.map((e) => e.slice(0, 3)), [C, B, A]);
  // (s2 announced A in its second batch: A is of s2's generation now; three sessions more without B: B out after the fourth)
  for (const sid of ['s3', 's4', 's5']) await s.post({ session: sid, place: 'balmora', kind: 'meshes', records: [A] });
  assert.deepEqual((await s.get('place=balmora')).list.map((e) => e.slice(0, 3)), [A, C, B], 'B last announced 3 sessions ago: kept');
  await s.post({ session: 's6', place: 'balmora', kind: 'meshes', records: [A] });
  got = await s.get('place=balmora');
  assert.equal(got.sessions, 6); assert.deepEqual(got.list.map((e) => e.slice(0, 3)), [A], 'B and C last announced by s2, four sessions ago: out');
});

test('places: bounded — places a version (least recently announced out), records a place (oldest out)', async (t) => {
  const { start } = placesServer(t, { placesMax: 3, placeRecords: 4 });
  const s = await start();
  for (const p of ['p1', 'p2', 'p3']) await s.post({ session: 's', place: p, kind: 'meshes', records: [['meshes/a.nif', 0, 1]] });
  await s.post({ session: 's', place: 'p1', kind: 'terrain', records: [['meshes/a.nif', 0, 2]] }); // (p1 the most recent now)
  await s.post({ session: 's', place: 'p4', kind: 'meshes', records: [['meshes/a.nif', 0, 1]] });
  assert.deepEqual((await s.get('')).map((e) => e[0]), ['p4', 'p1', 'p3']);
  assert.deepEqual((await s.get('place=p2')).list, []);
  const recs = (sid, from) => Array.from({ length: 3 }, (_, i) => ['meshes/b.nif', from + i, from + i + 1]);
  await s.post({ session: 'a', place: 'p4', kind: 'meshes', records: recs('a', 100) });
  await s.post({ session: 'b', place: 'p4', kind: 'meshes', records: recs('b', 200) });
  assert.deepEqual((await s.get('place=p4')).list.map((e) => e[1]), [200, 201, 202, 100], 'the latest session\'s first, the bound drops the oldest');
});

test('places: per game language (another one\'s when it has none), kept across a restart', async (t) => {
  const { start, learn } = placesServer(t);
  const s = await start();
  await s.post({ session: 'f', place: 'balmora, guilde des mages', kind: 'meshes', lang: 'FR', records: [['meshes/a.nif', 0, 10]] });
  await s.post({ session: 'e', place: '1,1', kind: 'meshes', lang: 'en', records: [['meshes/a.nif', 0, 20]] });
  await s.post({ session: 'f', place: '1,1', kind: 'meshes', lang: 'fr', records: [['meshes/a.nif', 0, 30]] });
  await s.post({ session: 'x', place: '1,1', kind: 'meshes', lang: 'xx', records: [['meshes/a.nif', 0, 40]] }); // (not the version's: none)
  assert.deepEqual((await s.get('place=1,1&lang=en')).list[0].slice(0, 3), ['meshes/a.nif', 0, 20]);
  assert.deepEqual((await s.get('place=1,1&lang=fr')).list[0].slice(0, 3), ['meshes/a.nif', 0, 30]);
  assert.deepEqual((await s.get('place=1,1')).list[0].slice(0, 3), ['meshes/a.nif', 0, 40]);
  const fr = await s.get(`place=${encodeURIComponent('balmora, guilde des mages')}&lang=en`);
  assert.equal(fr.lang, 'fr'); assert.equal(fr.list.length, 1);
  const before = await s.get('');
  await new Promise((r) => setTimeout(r, 100)); await s.close();
  assert.ok(fs.existsSync(path.join(learn, 'places-g.json')));
  const again = await start();
  assert.deepEqual(await again.get(''), before, 'kept on disk, in their order');
  assert.deepEqual((await again.get('place=1,1&lang=fr')).list[0].slice(0, 3), ['meshes/a.nif', 0, 30]);
  // (a session after the restart: a new generation, the records kept — the same reporter, counted once)
  await again.post({ session: 'f', place: '1,1', kind: 'meshes', lang: 'fr', records: [['meshes/b.nif', 0, 30]] });
  const got = await again.get('place=1,1&lang=fr');
  assert.equal(got.sessions, 1); assert.deepEqual(got.list.map((e) => e[0]), ['meshes/b.nif', 'meshes/a.nif']);
});

test('places: the most announced places\' units precompressed after the launch set, as an announcement asks them', async (t) => {
  const { start, sizes } = placesServer(t);
  const s = await start();
  // (a learned order, so that the version is a source of the units)
  await fetch(`${s.origin}/api/prefetch/g`, { method: 'POST', body: JSON.stringify({ session: 'r', reads: [['meshes/b.nif', 0, 10, 5]] }) });
  await s.post({ session: 's', place: '1,1', kind: 'textures', records: [['textures/t.dds', 0, -1], ['meshes/a.nif', 100, 200]] });
  await new Promise((r) => setTimeout(r, 100)); await s.close();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-places-br-')); t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const b = await start({ brCacheDir: cache, brCacheOptions: QUIET, brCacheLog: () => {} });
  t.after(() => b.server.brCache?.close?.());
  await b.server.brCache.drain();
  const unit = (rel, a, z) => new Promise((res, rej) => http.get(`${b.origin}/gamez/g/${rel}?r=${a}-${z}&w=1`, { headers: { 'accept-encoding': 'br' } }, (r) => { r.resume(); res(r.headers['x-orthros-unit']); }).on('error', rej));
  // (t.dds whole: its block 0 whole, then its tail block; a.nif's piece the range is in)
  assert.equal(await unit('textures/t.dds', 0, BLOCK), 'hit');
  assert.equal(await unit('textures/t.dds', BLOCK, sizes['textures/t.dds']), 'hit');
  assert.equal(await unit('meshes/a.nif', 0, 3000), 'hit', 'a file of one piece: its block');
  assert.equal(await unit('meshes/b.nif', 0, 5000), 'hit', 'the learned order after the places');
});

test('places: only a runtime that announces (openmw by default); one network\'s sessions are one reporter — they neither wipe nor outnumber others\'', async (t) => {
  const { start } = placesServer(t, { placeRuntimes: undefined });
  const off = await start();
  assert.equal((await off.post({ session: 's', place: '1,1', kind: 'meshes', records: [['meshes/a.nif', 0, 10]] })).status, 404, 'a win32 version: no places');
  await off.close();
  const s = await start({ placeRuntimes: ['win32'] });
  const from = (ip, body) => fetch(s.base, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  const A = ['meshes/a.nif', 0, 3000], B = ['meshes/b.nif', 0, 5000], C = ['meshes/b.nif', 0, 10];
  assert.equal((await from('10.0.0.1', { session: 'real', place: '-2,-9', kind: 'meshes', records: [A] })).status, 200);
  // (another network claims six sessions announcing something else: one reporter, A kept)
  for (let i = 0; i < 6; i++) await from('10.0.0.2', { session: `s${i}`, place: '-2,-9', kind: 'meshes', records: [B] });
  let got = await s.get('place=-2,-9');
  assert.equal(got.sessions, 2); assert.deepEqual(got.list.map((e) => e.slice(0, 3)), [B, A]);
  // (players of other networks: what the last four generations of two reporters did not announce goes)
  for (const ip of ['10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6']) await from(ip, { session: 'x', place: '-2,-9', kind: 'meshes', records: [C] });
  got = await s.get('place=-2,-9');
  assert.equal(got.sessions, 6); assert.deepEqual(got.list.map((e) => e.slice(0, 3)), [C]);
});

test('places: bounded in records a version (the fewest reporters out first), places a reporter makes an hour, bytes a list serves', async (t) => {
  const { start } = placesServer(t, { placesRecords: 4, placeNewPerHour: 4, placeServeMin: 1000 });
  const s = await start();
  const from = (ip, body) => fetch(s.base, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  const one = (i) => [['meshes/a.nif', i, i + 100]];
  await from('10.0.0.1', { session: 'a', place: 'town', kind: 'meshes', records: one(0) });
  await from('10.0.0.2', { session: 'b', place: 'town', kind: 'meshes', records: one(0) });
  // (a flood of places from one network: past 4 records the version lets go of its own kind, not the town two taught)
  for (let i = 0; i < 4; i++) assert.equal((await from('10.0.0.9', { session: 'f', place: `p${i}`, kind: 'meshes', records: one(i) })).status, 200);
  assert.equal((await from('10.0.0.9', { session: 'f', place: 'p4', kind: 'meshes', records: one(4) })).status, 429, 'a fifth place within the hour');
  const known = (await s.get('')).map((e) => e[0]);
  assert.ok(known.includes('town')); assert.equal(known.length, 4);
  // (a place swollen past four times the median place — 1000 B at least here —: its list cut)
  await from('10.0.0.1', { session: 'a', place: 'town', kind: 'textures', records: [['textures/t.dds', 0, -1]] });
  const got = await s.get('place=town');
  assert.ok(got.bytes <= 1000, `served ${got.bytes} B`); assert.deepEqual(got.list.map((e) => e[0]), ['meshes/a.nif']);
});
