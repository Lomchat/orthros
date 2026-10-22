// The launch set (docs/slow-network.md "Playable after"): a page marks its game playable (GameData.mark), the server
// flags the learned entries the marking sessions had read by then, the data worker's startup set and the home's
// "Prepare" take those, and the home card says "playable after X MB, about Y min at your link".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/host/server.js';
import { DirListings } from '../src/host/game-files.js';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';
import { NetLink } from '../src/vfs/net-link.js';
import { forLink, startupHead, launchSet, launchFirst, setBytes, launchSummary, PRE_PLAYABLE, WIRE_RATIO } from '../src/vfs/launch-set.js';
import { createDataWorker } from '../src/vfs/data-worker.js';
import { launchFor, launchStatus } from '../src/host/web/download.js';
import { engineSizes, wireOf } from '../src/host/web/download-worker.js';

const MiB = 1 << 20;
const tree = () => ({
  dirs: { Video: { dirs: {}, files: { 'intro.bik': { size: 3 * MiB, mtime: 1, media: true } } } },
  files: { 'data.bsa': { size: 3 * MiB, mtime: 1 }, 'tex.dds': { size: 2 * MiB, mtime: 1, light: 100000 }, 'late.esp': { size: 200000, mtime: 1 } },
});

test('the startup set: the entries flagged read before playable when the order has flags, else up to its first pause', () => {
  const files = new HttpBackend('/game/m/', tree());
  const plain = [['data.bsa', 0, 1, 0], ['data.bsa', 1, 1, 100], ['late.esp', 0, 1, 9000]];
  assert.deepEqual(startupHead(files, plain, true).map((e) => e[0] + '#' + e[1]), ['data.bsa#0', 'data.bsa#1'], 'no flags: cut at the 2 s pause');
  // (flags: what was read before playable, pauses or not; media left out on a link that is not fast)
  const marked = [['data.bsa', 0, 1, 0, 1], ['Video/intro.bik', 0, 0, 50, 1], ['tex.dds', 0, 0xffff, 100, 1], ['data.bsa', 1, 1, 9000, 1], ['late.esp', 0, 1, 20000, 0]];
  assert.deepEqual(launchSet(files, marked, true).map((e) => e[0] + '#' + e[1]), ['data.bsa#0', 'Video/intro.bik#0', 'tex.dds#0', 'data.bsa#1']);
  assert.deepEqual(launchSet(files, marked, false).map((e) => e[0] + '#' + e[1]), ['data.bsa#0', '.light/tex.dds#0', 'data.bsa#1'], 'light copy in place of the texture, keeping its flag');
  // (a light copy earlier sessions read: on a fast link the file itself, every block, with the entry's flag)
  const lightRead = [['.light/tex.dds', 0, 3, 10, 1]];
  assert.deepEqual(forLink(files, lightRead, true), [['tex.dds', 0, 0, 10, 1], ['tex.dds', 1, 0, 10, 1]]);
});

test('the learned order fetched ahead puts its launch set first (a player in the menu: a new game\'s load before later reads), media last', () => {
  const files = new HttpBackend('/game/m/', tree());
  const order = [['data.bsa', 0, 1, 0, 1], ['late.esp', 0, 1, 50, 0], ['Video/intro.bik', 0, 0, 60, 1], ['tex.dds', 0, 0xffff, 100, 1], ['data.bsa', 2, 1, 9000, 0], ['data.bsa', 1, 1, 3000, 1]];
  const key = (l) => l.map((e) => e[0] + '#' + e[1]);
  assert.deepEqual(key(launchFirst(files, order, true)), ['data.bsa#0', 'Video/intro.bik#0', 'tex.dds#0', 'data.bsa#1', 'late.esp#0', 'data.bsa#2']);
  assert.deepEqual(key(launchFirst(files, order, false)), ['data.bsa#0', '.light/tex.dds#0', 'data.bsa#1', 'late.esp#0', 'data.bsa#2', 'Video/intro.bik#0'], 'not fast: light copies, the movie last');
  const plain = order.map((e) => e.slice(0, 4));
  assert.deepEqual(launchFirst(files, plain, true), forLink(files, plain, true), 'no flags: the order as it is');
  // (the game's step after the launch set's end: the order starting again is not part of it)
  const store = new MemBlockStore(64 * MiB), b = new HttpBackend('/game/m/', tree(), { store });
  b.learned = { entries: launchFirst(b, order, true).map(([p, i, mask, t]) => ({ path: p, size: tree().files[p]?.size ?? 3 * MiB, mtime: 1, index: i, mask, t })), pos: 2 };
  assert.equal(b.stepEstimate().bytes, CHUNK, 'data.bsa#1 only, not late.esp read earlier in the timeline');
});

test('a media file the game streams (a menu\'s music) does not move the background pass to the order\'s media tail', async () => {
  const tr = { dirs: { Music: { dirs: {}, files: { 'title.mp3': { size: BLOCK, mtime: 1, media: true } } } }, files: { 'data.bsa': { size: 3 * BLOCK, mtime: 1 } } };
  const store = new MemBlockStore(64 * MiB), b = new HttpBackend('/game/m/', tr, { store, net: new NetLink({ bw: 85000 }) });
  assert.equal(b.net.fast(), false);
  const order = [['data.bsa', 0, 1, 0, 1], ['Music/title.mp3', 0, 1, 50, 1], ['data.bsa', 1, 1, 100, 1], ['data.bsa', 2, 1, 9000, 0]];
  const list = launchFirst(b, order, false);
  assert.deepEqual(list.map((e) => e[0] + '#' + e[1]), ['data.bsa#0', 'data.bsa#1', 'data.bsa#2', 'Music/title.mp3#0']);
  await b.prefetch(list, {}, () => true); // (the entries only: stopped at once)
  b.noteBlock('data.bsa', 0);
  assert.equal(b.learned.pos, 0);
  b.noteBlock('Music/title.mp3', 0);
  assert.equal(b.learned.pos, 0, 'the game is still where it was in the order: data.bsa#1 comes next, not the media after the music');
  b.noteBlock('data.bsa', 1);
  assert.equal(b.learned.pos, 1);
});

test('a read past the launch set (a loading picture) does not send the background pass through the rest before the launch set\'s missing entries', async (t) => {
  const tr = { dirs: {}, files: { 'a.dat': { size: BLOCK, mtime: 1 }, 'c.dat': { size: BLOCK, mtime: 1 }, 'b.dat': { size: 3 * BLOCK, mtime: 1 } } };
  // (pieces not known: whole blocks, nothing fetched ahead of the game's position — the background pass's order only)
  const order = [['a.dat', 0, 0, 0, PRE_PLAYABLE], ['b.dat', 0, 0, 10, 0], ['c.dat', 0, 0, 20, PRE_PLAYABLE], ['b.dat', 1, 0, 9000, 0], ['b.dat', 2, 0, 9100, 0]];
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  for (const bw of [100 * MiB, MiB]) {
    const asked = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url, 'http://x'), [a, b] = u.searchParams.get('r').split('-').map(Number);
      asked.push(`${u.pathname.replace(/^\/gamez\/m\//, '')}@${Math.floor(a / BLOCK)}`);
      return new Response(new Uint8Array(b - a), { status: 200, headers: { 'content-length': String(b - a) } });
    };
    const store = new MemBlockStore(64 * MiB), b = new HttpBackend('/game/m/', tr, { store, net: new NetLink({ bw }), encoded: true });
    const list = launchFirst(b, order, true);
    assert.deepEqual(list.map((e) => e[0] + '#' + e[1]), ['a.dat#0', 'c.dat#0', 'b.dat#0', 'b.dat#1', 'b.dat#2']);
    assert.equal(list.first, 2, 'the launch set\'s length');
    // (the game busy reading while the pass starts: it reads an entry of the rest, the launch set not here yet)
    let busy = true; b.gameBusy = () => busy;
    const job = b.prefetch(list, {}, () => false, { first: list.first });
    b.noteBlock('b.dat', 0);
    assert.equal(b.learned.pos, 2);
    busy = false; await job;
    assert.deepEqual(asked.slice(0, 2), ['a.dat@0', 'c.dat@0'], `${bw}: the launch set's missing entries first, then the rest (${asked.join(' ')})`);
    assert.ok(asked.includes('b.dat@1'));
  }
});

test('a set\'s bytes, those here, and a launch\'s cost with and without light copies, its wire bytes from the units known', () => {
  const store = new MemBlockStore(64 * MiB), files = new HttpBackend('/game/m/', tree(), { store });
  const list = [['data.bsa', 0, 0b101, 0, PRE_PLAYABLE], ['tex.dds', 1, 0, 10, PRE_PLAYABLE], ['late.esp', 0, 0, 30000, 0]];
  assert.deepEqual(setBytes(files, list), { bytes: 2 * CHUNK + BLOCK + 200000, here: 0 });
  store.put(files.pieceKey('data.bsa', 3 * MiB, 1, 2), new Uint8Array(CHUNK));
  assert.equal(setBytes(files, list).here, CHUNK, 'a piece kept counts as here');
  const s = launchSummary(files, list);
  assert.equal(s.bytes, 2 * CHUNK + BLOCK, 'fast: the learned pieces, the texture\'s block');
  assert.equal(s.lightBytes, 2 * CHUNK + 100000, 'not fast: the texture\'s light copy, whole');
  assert.equal(s.wire, Math.round(s.bytes * WIRE_RATIO));
  // (the units the server made: their own sizes — a piece unit for a partial block, a block unit for a whole one)
  const seen = [];
  const w = launchSummary(files, list, (p, unit, raw) => { seen.push(`${p}:${unit.kind}${unit.index}`); return unit.kind === 'b' && p === 'tex.dds' ? 1000 : null; });
  assert.ok(seen.includes('data.bsa:p0') && seen.includes('data.bsa:p2') && seen.includes('tex.dds:b1') && seen.some((u) => u.startsWith('.light/tex.dds:p')), seen.join(' '));
  assert.equal(w.wire, Math.round(2 * CHUNK * WIRE_RATIO + 1000));
  assert.equal(launchSummary(files, list.map((e) => e.slice(0, 4))), null, 'no session marked it: unknown');
});

test('the home card\'s line: playable after X at the link\'s rate, preparing, prepared, ready', () => {
  const launch = { bytes: 200 * MiB, lightBytes: 80 * MiB, wire: 150 * MiB, lightWire: 60 * MiB };
  const slow = launchStatus(launch, { bw: 100 * 1024 }, 'en');
  assert.equal(slow.state, 'none');
  // (the card's short line; the whole of it — the rate — in its tooltip, `detail`)
  assert.equal(slow.text, 'Playable after 80 MB · ~10 min');
  assert.match(slow.detail, /^Playable after 80 MB, about 10 min at your link \(100 KB\/s\)$/);
  assert.match(launchStatus(launch, { bw: 4 * MiB }, 'en').detail, /^Playable after 200 MB, about 40 s/, 'a fast link: the files themselves');
  assert.equal(launchStatus(launch, { bw: null }, 'en').text, 'Playable after 80 MB', 'no rate measured: the size only');
  const first = launchStatus({ ...launch, engine: 40 * MiB }, { bw: null }, 'fr');
  assert.equal(first.text, 'Jouable après 80 Mo (+ 40 Mo de moteur)', 'the engine at a first launch, said beside');
  assert.equal(first.detail, 'Jouable après 80 Mo (+ 40 Mo de moteur au premier lancement)');
  assert.equal(launchStatus(launch, { bw: 100 * 1024 }, 'fr').text, 'Jouable après 80 Mo · ~10 min');
  assert.match(launchStatus(launch, { bw: 100 * 1024 }, 'fr').detail, /^Jouable après 80 Mo, environ 10 min à ta connexion/);
  const half = launchStatus(launch, { bw: 100 * 1024, st: { bytes: 40 * MiB, total: 80 * MiB } }, 'en');
  assert.equal(half.state, 'paused'); assert.equal(half.pct, 50); assert.equal(half.text, 'Playable after 40 MB more · ~5 min');
  assert.match(half.detail, /^Playable after 40 MB more \(50% ready\), about 5 min/);
  assert.equal(launchStatus(launch, { bw: 100 * 1024, st: { bytes: 40 * MiB, total: 80 * MiB, running: true } }, 'en').state, 'running');
  assert.equal(launchStatus(launch, { st: { done: true } }, 'en').state, 'done');
  assert.equal(launchStatus(launch, { whole: { state: 'done', done: true } }, 'en').state, 'done');
  assert.equal(launchStatus(null, {}, 'en'), null);
});

test('the server learns the launch set from the sessions\' marks: flags in the learned order, a launch per version, kept', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-launch-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), gs = path.join(games, 'gs'), learn = path.join(root, 'learn');
  fs.mkdirSync(path.join(gs, 'base', 'valve'), { recursive: true }); fs.mkdirSync(path.join(gs, 'versions', 'orig'), { recursive: true }); fs.mkdirSync(learn);
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'a.pak'), Buffer.alloc(2 * BLOCK, 1));
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'late.pak'), Buffer.alloc(100000, 2));
  fs.writeFileSync(path.join(gs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-orig', defaults: { runtime: 'goldsrc' },
    versions: [{ id: 'gs-orig', dir: 'orig', version: 'O', goldsrc: { engine: 'e-1', gameDir: 'valve', modules: { client: 'c.wasm', server: 's.wasm' }, solo: { map: 'start' } } }] }));
  const start = async () => {
    const server = createServer({ gamesDir: games, learnDir: learn, learnWriteMs: 10, lanLog: () => {} });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  };
  let s = await start();
  const post = (body) => fetch(`${s.base}/api/prefetch/gs-orig`, { method: 'POST', body: JSON.stringify(body) });
  const launchOf = async () => (await (await fetch(`${s.base}/api/manifests`)).json()).find((m) => m.name === 'gs-orig').launch;
  await post({ session: 's1', reads: [['valve/a.pak', 0, 1000, 10]] });
  assert.deepEqual(await (await fetch(`${s.base}/api/prefetch/gs-orig`)).json(), [['valve/a.pak', 0, 1, 10]], 'no mark yet: no flags');
  assert.equal(await launchOf(), null);
  // (s1 marks playable with its next reads; s2 reads the late file only after its mark; s3 never marks)
  await post({ session: 's1', reads: [['valve/a.pak', BLOCK, BLOCK + 10, 500]], mark: { kind: 'playable', t: 600 } });
  await post({ session: 's1', reads: [['valve/late.pak', 0, 10, 9000]] });
  await post({ session: 's2', reads: [['valve/a.pak', 0, 10, 5]], mark: { kind: 'playable' } });
  await post({ session: 's2', reads: [['valve/late.pak', 0, 10, 8000]], mark: { kind: 'playable' } }); // (once a session)
  await post({ session: 's3', reads: [['valve/late.pak', 0, 10, 20]] });
  const list = await (await fetch(`${s.base}/api/prefetch/gs-orig`)).json();
  assert.deepEqual(list, [['valve/a.pak', 0, 1, 5, 1], ['valve/late.pak', 0, 1, 20, 0], ['valve/a.pak', 1, 1, 500, 1]], 'flag: before playable in at least half the marks');
  const launch = await launchOf();
  assert.equal(launch.bytes, 2 * CHUNK); assert.equal(launch.lightBytes, 2 * CHUNK); assert.equal(launch.wire, Math.round(2 * CHUNK * WIRE_RATIO));
  await new Promise((r) => setTimeout(r, 100)); // (written)
  await s.close();
  s = await start(); t.after(() => s.close());
  assert.deepEqual(await (await fetch(`${s.base}/api/prefetch/gs-orig`)).json(), list, 'kept: the marks and each entry\'s count');
});

test('a session\'s read leaves the launch summary served until it is stale (LAUNCH_STALE_MS); a mark makes it again at once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-launch-stale-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), gs = path.join(games, 'gs');
  fs.mkdirSync(path.join(gs, 'base', 'valve'), { recursive: true }); fs.mkdirSync(path.join(gs, 'versions', 'orig'), { recursive: true });
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'a.pak'), Buffer.alloc(2 * BLOCK, 1));
  fs.writeFileSync(path.join(gs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-orig', defaults: { runtime: 'goldsrc' },
    versions: [{ id: 'gs-orig', dir: 'orig', version: 'O', goldsrc: { engine: 'e-1', gameDir: 'valve', modules: { client: 'c.wasm', server: 's.wasm' }, solo: { map: 'start' } } }] }));
  const recent = DirListings.RECENT_MS; t.after(() => { DirListings.RECENT_MS = recent; });
  DirListings.RECENT_MS = 0; // (the folders as if old: the game's tree listed once — game-files.js dirsStamp)
  const server = createServer({ gamesDir: games, launchStaleMs: 300, lanLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/prefetch/gs-orig`, { method: 'POST', body: JSON.stringify(body) });
  const launchOf = async () => (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === 'gs-orig').launch;
  await post({ session: 's1', reads: [['valve/a.pak', 0, 10, 5]], mark: { kind: 'playable' } });
  assert.equal((await launchOf()).bytes, CHUNK);
  // (a read widens the launch block's mask: the summary made before it is served on — not made again at every read)
  await post({ session: 's2', reads: [['valve/a.pak', CHUNK, CHUNK + 10, 7]] });
  assert.equal((await launchOf()).bytes, CHUNK, 'the summary kept while not stale');
  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await launchOf()).bytes, 2 * CHUNK, 'made again once stale');
  await post({ session: 's2', reads: [['valve/a.pak', 3 * CHUNK, 3 * CHUNK + 10, 9]], mark: { kind: 'playable' } });
  assert.equal((await launchOf()).bytes, 3 * CHUNK, 'a mark: at once');
});

test('a version\'s launch counts the launch sets of the versions it requires (extraMounts), each its own', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-launch-req-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), learn = path.join(root, 'learn'); fs.mkdirSync(learn);
  for (const [g, file, extra] of [['base', 'big.dat', {}], ['mod', 'mod.dat', { requires: [{ game: 'base', version: 'base-1', mount: 'C:\\BASE' }] }]]) {
    fs.mkdirSync(path.join(games, g, 'base'), { recursive: true }); fs.mkdirSync(path.join(games, g, 'versions', '1'), { recursive: true });
    fs.writeFileSync(path.join(games, g, 'base', file), Buffer.alloc(2 * BLOCK, 3)); fs.writeFileSync(path.join(games, g, 'base', 'game.exe'), 'MZ');
    fs.writeFileSync(path.join(games, g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: g, name: g, defaultVersion: `${g}-1`,
      versions: [{ id: `${g}-1`, dir: '1', version: '1', exe: 'game.exe', ...extra }] }));
  }
  const server = createServer({ gamesDir: games, learnDir: learn, learnWriteMs: 10, lanLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (v, body) => fetch(`${base}/api/prefetch/${v}`, { method: 'POST', body: JSON.stringify(body) });
  const launchOf = async (v) => (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === v).launch;
  await post('mod-1', { session: 'm1', reads: [['mod.dat', 0, 10, 5]], mark: { kind: 'playable' } });
  assert.equal((await launchOf('mod-1')).bytes, CHUNK, 'the required version not marked yet: the mod\'s own');
  await post('base-1', { session: 'b1', reads: [['big.dat', 0, 10, 5], ['big.dat', BLOCK, BLOCK + 10, 6]], mark: { kind: 'playable' } });
  await new Promise((r) => setTimeout(r, 50));
  // (its summary made again after a minute: a fresh server's view of the same learned lists)
  const again = createServer({ gamesDir: games, learnDir: learn, learnWriteMs: 10, lanLog: () => {} });
  await new Promise((r) => again.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { again.closeAllConnections?.(); again.close(r); }));
  const m = (await (await fetch(`http://127.0.0.1:${again.address().port}/api/manifests`)).json()).find((x) => x.name === 'mod-1');
  assert.equal(m.launch.bytes, 3 * CHUNK, 'the mod\'s and the required version\'s');
});

test('the data worker sends a page\'s mark once, with every read before it, and its startup set follows the flags', async (t) => {
  const posts = [], asked = [];
  const tr = { dirs: {}, files: { 'a.dat': { size: 2 * BLOCK, mtime: 5 }, 'b.dat': { size: BLOCK, mtime: 5 } } };
  const learned = [['a.dat', 0, 1, 0, 1], ['b.dat', 0, 1, 100, 0], ['a.dat', 1, 1, 5000, 1]];
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/manifest/v') return Response.json({ name: 'v' });
    if (u.pathname === '/api/tree/v') return Response.json(tr);
    if (u.pathname === '/api/prefetch/v') { if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); } return Response.json(learned); }
    const m = /^\/gamez\/v\/(.+)$/.exec(u.pathname);
    if (m) { const [a, b] = u.searchParams.get('r').split('-').map(Number); asked.push([m[1], a, b]); const body = new Uint8Array(b - a); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); }
    return new Response('no', { status: 404 });
  };
  const out = [], handle = createDataWorker((m) => out.push(m));
  const ctrl = new Int32Array(new SharedArrayBuffer(64)), data = new Uint8Array(new SharedArrayBuffer(1 << 20));
  handle({ init: { name: 'v', session: 'sess1', prefetch: 'none', ctrl: ctrl.buffer, data: data.buffer } });
  const until = async (ok, what) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(ok(), what); };
  await until(() => out.some((m) => m.ready), 'ready');
  t.after(() => handle({ close: true }));
  handle({ startup: true });
  await until(() => out.some((m) => m.startup?.done), 'startup');
  assert.equal(out.findLast((m) => m.startup).startup.total, 2 * CHUNK, 'the two flagged entries, past the pause');
  assert.ok(asked.some(([p, a]) => p === 'a.dat' && a === BLOCK) && !asked.some(([p]) => p === 'b.dat'), JSON.stringify(asked));
  handle({ start: true });
  handle({ used: [['v', 'a.dat', 0]], mark: { kind: 'playable' } });
  handle({ mark: { kind: 'playable' } });
  await until(() => posts.length, 'reported');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.length, 1, 'once');
  assert.equal(posts[0].mark.kind, 'playable'); assert.ok(posts[0].mark.t >= 0);
  assert.deepEqual(posts[0].reads.map((r) => r.slice(0, 3)), [['a.dat', 0, CHUNK]]);
});

test('a page of a game language: its startup set is that language\'s, its mark tells it', async (t) => {
  const posts = [], orders = [];
  const tr = { dirs: {}, files: { 'a.dat': { size: BLOCK, mtime: 5 } } };
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/manifest/v') return Response.json({ name: 'v' });
    if (u.pathname === '/api/tree/v') return Response.json(tr);
    if (u.pathname === '/api/prefetch/v') { if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); } orders.push(u.search); return Response.json([['a.dat', 0, 1, 0, 1]]); }
    const m = /^\/gamez\/v\/(.+)$/.exec(u.pathname);
    if (m) { const [a, b] = u.searchParams.get('r').split('-').map(Number); const body = new Uint8Array(b - a); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); }
    return new Response('no', { status: 404 });
  };
  const out = [], handle = createDataWorker((m) => out.push(m));
  const ctrl = new Int32Array(new SharedArrayBuffer(64)), data = new Uint8Array(new SharedArrayBuffer(1 << 20));
  handle({ init: { name: 'v', session: 'sess2', lang: 'fr', prefetch: 'none', ctrl: ctrl.buffer, data: data.buffer } });
  const until = async (ok, what) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(ok(), what); };
  await until(() => out.some((m) => m.ready), 'ready');
  t.after(() => handle({ close: true }));
  handle({ startup: true });
  await until(() => out.some((m) => m.startup?.done), 'startup');
  assert.deepEqual(orders, ['?lang=fr']);
  handle({ start: true });
  handle({ used: [['v', 'a.dat', 0]], mark: { kind: 'playable' } });
  await until(() => posts.length, 'reported');
  assert.equal(posts[0].mark.lang, 'fr');
});

test('a game language\'s own launch set (its sessions\' marks: its translated files), and a port\'s engine release said and listed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-launch-lang-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), gs = path.join(games, 'gs'), learn = path.join(root, 'learn'), engines = path.join(root, 'engines');
  fs.mkdirSync(path.join(gs, 'base', 'valve'), { recursive: true }); fs.mkdirSync(path.join(gs, 'base', 'valve_french'), { recursive: true });
  fs.mkdirSync(path.join(gs, 'versions', 'orig'), { recursive: true }); fs.mkdirSync(learn);
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'a.pak'), Buffer.alloc(BLOCK, 1));
  fs.writeFileSync(path.join(gs, 'base', 'valve_french', 'titles.txt'), Buffer.alloc(1000, 2));
  fs.writeFileSync(path.join(gs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-orig', defaults: { runtime: 'goldsrc' },
    versions: [{ id: 'gs-orig', dir: 'orig', version: 'O', languages: ['en', 'fr'], goldsrc: { engine: 'e-1', gameDir: 'valve', modules: { client: 'cl/c.wasm', server: 'dl/s.wasm' }, solo: { map: 'start' } } }] }));
  // (the engine release: its module graph, WebAssembly and modules — one served brotli)
  const e1 = path.join(engines, 'e-1');
  for (const [f, n] of [['release.json', 2], ['engine/index.js', 10], ['engine/xash.wasm', 5000], ['cl/c.wasm', 300], ['dl/s.wasm', 200], ['engine/valve/extras.pk3', 40]]) {
    fs.mkdirSync(path.dirname(path.join(e1, f)), { recursive: true }); fs.writeFileSync(path.join(e1, f), Buffer.alloc(n, 7));
  }
  fs.writeFileSync(path.join(e1, 'engine/xash.wasm.br'), Buffer.alloc(1200, 7));
  const start = async () => {
    const server = createServer({ gamesDir: games, learnDir: learn, enginesDir: engines, learnWriteMs: 10, lanLog: () => {} });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  };
  let s = await start();
  const post = (body) => fetch(`${s.base}/api/prefetch/gs-orig`, { method: 'POST', body: JSON.stringify(body) });
  const order = async (q = '') => (await (await fetch(`${s.base}/api/prefetch/gs-orig${q}`)).json()).map((e) => `${e[0]}:${e[4]}`).sort();
  // (two English sessions and a French one, which reads its texts before playable too)
  await post({ session: 'e1', reads: [['valve/a.pak', 0, 10, 5]], mark: { kind: 'playable', lang: 'en' } });
  await post({ session: 'f1', reads: [['valve/a.pak', 0, 10, 5], ['valve_french/titles.txt', 0, 1000, 50]], mark: { kind: 'playable', lang: 'fr' } });
  await post({ session: 'e2', reads: [['valve/a.pak', 0, 10, 5]], mark: { kind: 'playable', lang: 'en' } });
  assert.deepEqual(await order(), ['valve/a.pak:1', 'valve_french/titles.txt:0'], 'all the sessions: a minority language\'s files left out');
  assert.deepEqual(await order('?lang=fr'), ['valve/a.pak:1', 'valve_french/titles.txt:1'], 'the French sessions\' own');
  assert.deepEqual(await order('?lang=en'), ['valve/a.pak:1', 'valve_french/titles.txt:0']);
  assert.deepEqual(await order('?lang=de'), await order(), 'a language no session told: all the sessions');
  const launch = (await (await fetch(`${s.base}/api/manifests`)).json()).find((m) => m.name === 'gs-orig').launch;
  assert.equal(launch.bytes, CHUNK); assert.equal(launch.langs.fr.bytes, CHUNK + 1000); assert.equal(launch.langs.en.bytes, CHUNK);
  assert.equal(launch.engine, 10 + 1200 + 300 + 200 + 40, 'the engine release at a first launch: brotli when served so');
  assert.deepEqual(launch.engineFiles, ['/engines/e-1/engine/index.js', '/engines/e-1/engine/xash.wasm', '/engines/e-1/cl/c.wasm', '/engines/e-1/dl/s.wasm', '/engines/e-1/engine/valve/extras.pk3']);
  assert.equal(launch.langs.fr.engine, launch.engine);
  assert.equal(launchFor(launch, 'fr'), launch.langs.fr); assert.equal(launchFor(launch, 'de'), launch); assert.equal(launchFor(null, 'fr'), null);
  // (a language the version does not declare: counted in all the sessions' marks, not as a language of its own)
  await post({ session: 'x1', reads: [['valve/a.pak', 0, 10, 5]], mark: { kind: 'playable', lang: 'qqqqqqqqqqqqqqqq' } });
  assert.deepEqual(Object.keys((await (await fetch(`${s.base}/api/manifests`)).json()).find((m) => m.name === 'gs-orig').launch.langs), ['en', 'fr']);
  // (the tree every start and Prepare fetch: compressed when the browser takes it)
  for (const enc of ['br', 'gzip']) {
    const r = await fetch(`${s.base}/api/tree/gs-orig`, { headers: { 'accept-encoding': enc } });
    assert.equal(r.headers.get('content-encoding'), enc); assert.ok((await r.json()).dirs.valve_french);
  }
  // (kept: the languages' marks and counts)
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(learn, 'playable-gs-orig.json'), 'utf8')), { marks: 4, by: { en: 2, fr: 1 } });
  const fr = await order('?lang=fr');
  await s.close();
  s = await start(); t.after(() => s.close());
  assert.deepEqual(await order('?lang=fr'), fr);
});

test('the card\'s line once "Prepare" fetched the engine too: its bytes counted in the progress and the time left', () => {
  const launch = { bytes: 10 * MiB, lightBytes: 10 * MiB, wire: 5 * MiB, lightWire: 5 * MiB, engine: 5 * MiB };
  const paused = launchStatus(launch, { bw: 1 * MiB, st: { bytes: 5 * MiB, total: 15 * MiB, engine: 5 * MiB } }, 'en');
  assert.equal(paused.state, 'paused'); assert.equal(paused.pct, 33);
  assert.match(paused.detail, /^Playable after 10 MB more \(33% ready\)/, paused.detail); assert.ok(Math.abs(paused.eta - 20 / 3) < 0.01, String(paused.eta));
  // (prepared with the engine files the launch still names: ready; with others — an OpenMW game's lean package made
  // since —: its engine to fetch again, the launch set here)
  const files = ['/engines/e/e/1/openmw.js', '/engines/e/lean1/1/openmw.data'];
  const prepared = { bytes: 15 * MiB, total: 15 * MiB, engine: 5 * MiB, done: true };
  assert.equal(launchStatus({ ...launch, engineFiles: files }, { bw: 1 * MiB, st: { ...prepared, engineFiles: files } }, 'en').state, 'done');
  assert.equal(launchStatus({ ...launch, engineFiles: files }, { bw: 1 * MiB, st: prepared }, 'en').state, 'done', 'a progress kept before: as it says');
  const stale = launchStatus({ ...launch, engineFiles: files }, { bw: 1 * MiB, st: { ...prepared, engineFiles: files.slice(0, 1) } }, 'en');
  assert.equal(stale.state, 'paused'); assert.match(stale.text, /^Playable after 5 MB more/, stale.text);
});

test('"Prepare" counts an engine file\'s progress in wire bytes, the unit of its total, its body coming decoded', () => {
  const h = (o) => new Headers(o);
  // (a brotli answer: its sizes said by the server — a 33 MB package of 204 MB; one with a Content-Length of the brotli)
  assert.deepEqual(engineSizes(h({ 'content-encoding': 'br', 'x-orthros-wire-length': '33', 'x-orthros-decoded-length': '204' })), { wire: 33, decoded: 204 });
  assert.deepEqual(engineSizes(h({ 'content-encoding': 'br', 'content-length': '33' })), { wire: 33, decoded: 0 });
  assert.deepEqual(engineSizes(h({ 'content-length': '50' })), { wire: 50, decoded: 50 });
  assert.deepEqual(engineSizes(h({})), { wire: 0, decoded: 0 });
  assert.equal(wireOf(102, 33, 204), 17, 'half the decoded bytes: half the wire');
  assert.equal(wireOf(204, 33, 204), 33);
  assert.equal(wireOf(300, 33, 0), 33, 'decoded size unknown: at most the wire');
  assert.equal(wireOf(300, 0, 0), 300, 'nothing said: as it came');
});

test('a page that waits for the startup set (prefetch: \'startup\') gets the rest of the learned order in the background once its engine runs', async (t) => {
  const asked = [];
  const tr = { dirs: {}, files: { 'a.dat': { size: 2 * BLOCK, mtime: 5 }, 'b.dat': { size: BLOCK, mtime: 5 } } };
  const learned = [['a.dat', 0, 1, 0, 1], ['b.dat', 0, 1, 100, 0], ['a.dat', 1, 1, 5000, 0]];
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/manifest/v') return Response.json({ name: 'v' });
    if (u.pathname === '/api/tree/v') return Response.json(tr);
    if (u.pathname === '/api/prefetch/v') return init.method === 'POST' ? new Response(null, { status: 204 }) : Response.json(learned);
    const m = /^\/gamez\/v\/(.+)$/.exec(u.pathname);
    if (m) { const [a, b] = u.searchParams.get('r').split('-').map(Number); asked.push([m[1], a, b]); const body = new Uint8Array(b - a); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); }
    return new Response('no', { status: 404 });
  };
  const out = [], handle = createDataWorker((m) => out.push(m));
  const ctrl = new Int32Array(new SharedArrayBuffer(64)), data = new Uint8Array(new SharedArrayBuffer(1 << 20));
  handle({ init: { name: 'v', session: 'sess1', prefetch: 'startup', ctrl: ctrl.buffer, data: data.buffer } });
  const until = async (ok, what) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(ok(), what); };
  await until(() => out.some((m) => m.ready), 'ready');
  t.after(() => handle({ close: true }));
  handle({ startup: true });
  await until(() => out.some((m) => m.startup?.done), 'startup');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(asked.map(([p, a]) => `${p}@${a}`), ['a.dat@0'], 'the startup set only, before the engine');
  handle({ start: true });
  await until(() => asked.some(([p]) => p === 'b.dat') && asked.some(([p, a]) => p === 'a.dat' && a === BLOCK), 'the rest of the learned order');
  await until(() => out.some((m) => m.ahead?.finished), 'the learned order loaded');
});

test('the data worker loads the launch set first and tells the way to playable: its bytes, those here, the time left', async (t) => {
  const asked = [];
  const tr = { dirs: {}, files: { 'a.dat': { size: 2 * BLOCK, mtime: 5 }, 'b.dat': { size: BLOCK, mtime: 5 } } };
  const learned = [['a.dat', 0, 1, 0, 1], ['b.dat', 0, 1, 100, 0], ['a.dat', 1, 1, 5000, 1]];
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/manifest/v') return Response.json({ name: 'v' });
    if (u.pathname === '/api/tree/v') return Response.json(tr);
    if (u.pathname === '/api/prefetch/v') return init.method === 'POST' ? new Response(null, { status: 204 }) : Response.json(learned);
    const m = /^\/gamez\/v\/(.+)$/.exec(u.pathname);
    if (m) { const [a, b] = u.searchParams.get('r').split('-').map(Number); asked.push([m[1], a]); await new Promise((r) => setTimeout(r, 30)); const body = new Uint8Array(b - a); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); }
    return new Response('no', { status: 404 });
  };
  const out = [], handle = createDataWorker((m) => out.push(m));
  const ctrl = new Int32Array(new SharedArrayBuffer(64)), data = new Uint8Array(new SharedArrayBuffer(1 << 20));
  handle({ init: { name: 'v', session: 's2', prefetch: 'start', bw: 85000, ctrl: ctrl.buffer, data: data.buffer } });
  const until = async (ok, what) => { for (let i = 0; i < 3000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(ok(), what); };
  await until(() => out.some((m) => m.ready), 'ready');
  t.after(() => handle({ close: true }));
  handle({ start: true });
  await until(() => out.some((m) => m.launch), 'told');
  const first = out.find((m) => m.launch).launch;
  assert.equal(first.bytes, 2 * CHUNK, 'the flagged entries\' learned pieces');
  assert.ok(first.here < first.bytes && !first.done && first.wireLeft > 0, JSON.stringify(first));
  await until(() => out.some((m) => m.launch?.done), 'all of it here');
  assert.equal(out.findLast((m) => m.launch).launch.here, 2 * CHUNK);
  const a1 = asked.findIndex(([p, a]) => p === 'a.dat' && a === BLOCK), b0 = asked.findIndex(([p]) => p === 'b.dat');
  assert.ok(a1 >= 0 && (b0 < 0 || a1 < b0), `the launch set before the rest: ${JSON.stringify(asked)}`);
});

test('the startup progress on a fast link counts the blocks it fetches whole, never past its total', async (t) => {
  const tr = { dirs: {}, files: { 'a.dat': { size: 2 * BLOCK, mtime: 5 } } };
  const learned = [['a.dat', 0, 1, 0, 1], ['a.dat', 1, 1, 100, 1]];
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/manifest/v') return Response.json({ name: 'v' });
    if (u.pathname === '/api/tree/v') return Response.json(tr);
    if (u.pathname === '/api/prefetch/v') return init.method === 'POST' ? new Response(null, { status: 204 }) : Response.json(learned);
    const m = /^\/gamez\/v\/(.+)$/.exec(u.pathname);
    if (m) { const [a, b] = u.searchParams.get('r').split('-').map(Number); const body = new Uint8Array(b - a); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); }
    return new Response('no', { status: 404 });
  };
  const out = [], handle = createDataWorker((m) => out.push(m));
  const ctrl = new Int32Array(new SharedArrayBuffer(64)), data = new Uint8Array(new SharedArrayBuffer(1 << 20));
  handle({ init: { name: 'v', session: 's', prefetch: 'none', bw: 50 << 20, ctrl: ctrl.buffer, data: data.buffer } });
  const until = async (ok, what) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(ok(), what); };
  await until(() => out.some((m) => m.ready), 'ready');
  t.after(() => handle({ close: true }));
  handle({ startup: true });
  await until(() => out.some((m) => m.startup?.done), 'startup');
  const all = out.filter((m) => m.startup).map((m) => m.startup);
  assert.equal(all.at(-1).total, 2 * BLOCK, 'its two blocks, whole');
  assert.ok(all.every((p) => p.bytes <= p.total), JSON.stringify(all));
});

test('a light copy of the file\'s own size (a WAD\'s, redrawn in place) stands for the same pieces, not for all of it', async () => {
  const { HttpBackend, BLOCK } = await import('../src/vfs/http-backend.js');
  const { forLink } = await import('../src/vfs/launch-set.js');
  const tree = { dirs: { maps: { dirs: {}, files: { 'a.wad': { size: 8 * BLOCK, mtime: 1, light: 8 * BLOCK } } } }, files: {} };
  const files = new HttpBackend('/game/g/', tree);
  const list = [['maps/a.wad', 3, 0b1010, 10, 1], ['.light/maps/a.wad', 5, 0b1, 20, 0]];
  assert.deepEqual(forLink(files, list, false), [['.light/maps/a.wad', 3, 0b1010, 10, 1], ['.light/maps/a.wad', 5, 0b1, 20, 0]]);
  assert.deepEqual(forLink(files, list, true), [['maps/a.wad', 3, 0b1010, 10, 1], ['maps/a.wad', 5, 0b1, 20, 0]], 'a fast link: the file, the same pieces');
});
