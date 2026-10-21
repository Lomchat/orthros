// The launch set (docs/slow-network.md "Playable after"): a page marks its game playable (GameData.mark), the server
// flags the learned entries the marking sessions had read by then, the data worker's startup set and the home's
// "Prepare" take those, and the home card says "playable after X MB, about Y min at your link".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/host/server.js';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';
import { forLink, startupHead, launchSet, setBytes, launchSummary, PRE_PLAYABLE, WIRE_RATIO } from '../src/vfs/launch-set.js';
import { createDataWorker } from '../src/vfs/data-worker.js';
import { launchStatus } from '../src/host/web/download.js';

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
  assert.match(slow.text, /^Playable after 80 MB, about 10 min at your link \(100 KB\/s\)$/);
  assert.match(launchStatus(launch, { bw: 4 * MiB }, 'en').text, /^Playable after 200 MB, about 40 s/, 'a fast link: the files themselves');
  assert.equal(launchStatus(launch, { bw: null }, 'en').text, 'Playable after 80 MB', 'no rate measured: the size only');
  assert.equal(launchStatus({ ...launch, engine: 40 * MiB }, { bw: null }, 'fr').text, 'Jouable après 80 Mo (+ 40 Mo de moteur au premier lancement)', 'the engine at a first launch, said beside');
  assert.match(launchStatus(launch, { bw: 100 * 1024 }, 'fr').text, /^Jouable après 80 Mo, environ 10 min à ta connexion/);
  const half = launchStatus(launch, { bw: 100 * 1024, st: { bytes: 40 * MiB, total: 80 * MiB } }, 'en');
  assert.equal(half.state, 'paused'); assert.equal(half.pct, 50); assert.match(half.text, /^Playable after 40 MB more \(50% ready\), about 5 min/);
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
