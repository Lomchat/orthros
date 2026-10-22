// The server under many players (tools/server-load.mjs measures it): the folders' listings kept and checked by a stat
// (DirListings), the same range encoded once for the players asking it at once, the on-the-fly encodings bounded (the
// game's reads first), the learned sessions bounded, and its state in /api/netstats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createServer } from '../src/host/server.js';
import { DirListings, resolveGameFile } from '../src/host/game-files.js';

const get = (base, p, enc = 'gzip') => new Promise((resolve, reject) => {
  http.get(base + p, { headers: { 'accept-encoding': enc } }, (res) => {
    const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject);
});
const plain = (r) => (r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.body);

async function start(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-load-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const game = path.join(dir, 'game'); fs.mkdirSync(path.join(game, 'Data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: game, exe: 'x.exe' }));
  const server = createServer({ manifests: path.join(dir, 'man'), lanLog: () => {}, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { base: `http://127.0.0.1:${server.address().port}`, game, server };
}

test('DirListings: a folder listed once, used again while unchanged; a file added, removed or renamed there is seen', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-listings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'Data')); fs.writeFileSync(path.join(dir, 'Data', 'A.big'), 'a');
  const man = { folder: dir }, memo = new DirListings();
  const readdir = fs.readdirSync; let lists = 0;
  fs.readdirSync = (...a) => { lists++; return readdir(...a); };
  const recent = DirListings.RECENT_MS;
  const realStat = fs.statSync;
  t.after(() => { fs.readdirSync = readdir; fs.statSync = realStat; DirListings.RECENT_MS = recent; });
  // (folders changed a moment ago — a file system's clock ticks in ms: two changes may share an mtime — listed each time)
  // (the folder's clock frozen: a change in the same tick as the listing)
  const stat = fs.statSync, frozen = Date.now() - 50;
  fs.statSync = (p, ...a) => { const st = stat(p, ...a); if (p === path.join(dir, 'Data')) { st.mtimeMs = st.ctimeMs = frozen; } return st; };
  assert.equal(resolveGameFile(man, 'data/a.big', memo), path.join(dir, 'Data', 'A.big'));
  fs.writeFileSync(path.join(dir, 'Data', 'z.big'), 'z');
  assert.equal(resolveGameFile(man, 'data/z.big', memo), path.join(dir, 'Data', 'z.big'), 'a file added in the same tick: found');
  fs.statSync = stat;
  DirListings.RECENT_MS = 0; // (the folders as if old: kept)
  assert.equal(resolveGameFile(man, 'data/a.big', memo), path.join(dir, 'Data', 'A.big'));
  const first = lists;
  assert.equal(resolveGameFile(man, 'DATA/A.BIG', memo), path.join(dir, 'Data', 'A.big'));
  assert.equal(lists, first, 'unchanged folders: not listed again');
  await new Promise((r) => setTimeout(r, 20)); // (another tick of the file system's clock)
  fs.writeFileSync(path.join(dir, 'Data', 'b.big'), 'b');
  assert.equal(resolveGameFile(man, 'data/B.big', memo), path.join(dir, 'Data', 'b.big'), 'a file added: found');
  await new Promise((r) => setTimeout(r, 20));
  fs.renameSync(path.join(dir, 'Data', 'A.big'), path.join(dir, 'Data', 'c.big'));
  assert.equal(resolveGameFile(man, 'data/a.big', memo), null, 'renamed: gone');
  assert.equal(resolveGameFile(man, 'data/c.big', memo), path.join(dir, 'Data', 'c.big'));
  // bounded by names: the least recently used folders out
  const small = new DirListings(3);
  resolveGameFile(man, 'data/c.big', small);
  assert.ok(small.names <= 3 + 3 && small.size <= 2);
});

test('/gamez: the same range asked by many players at once is encoded once, every answer exact; the server\'s state told', async (t) => {
  const { base, game } = await start(t, { encodeJobs: 1 });
  const text = Buffer.from('the same line again and again, a block of a game file\n'.repeat(60000));
  fs.writeFileSync(path.join(game, 'Data', 'big.dat'), text);
  const before = JSON.parse((await get(base, '/api/netstats', '')).body);
  const answers = await Promise.all(Array.from({ length: 8 }, () => get(base, '/gamez/g/Data/big.dat?r=0-1048576&s=a')));
  for (const r of answers) { assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], 'gzip'); assert.deepEqual(plain(r), text.subarray(0, 1048576)); }
  const after = JSON.parse((await get(base, '/api/netstats', '')).body);
  assert.equal(after.requests - before.requests, 8);
  assert.equal(after.joined - before.joined, 7, 'seven joined the first one\'s encoding');
  assert.ok(after.encodeMs >= before.encodeMs);
  assert.equal(after.server.encodeQueue.running, 0);
  assert.ok(after.server.encodedCache.bytes > 0 && after.server.encodedCache.entries === 1, 'one entry, counted once');
  assert.ok(after.server.rss > 0 && after.server.sessions === 1);
  // brotli in a window the range's size: the same bytes
  const br = await get(base, '/gamez/g/Data/big.dat?r=100-65636&p=1', 'br');
  assert.equal(br.headers['content-encoding'], 'br'); assert.deepEqual(plain(br), text.subarray(100, 65636));
});

test('/gamez: encodings at most encodeJobs at once, the game\'s reads before the background downloads', async (t) => {
  const { base, game } = await start(t, { encodeJobs: 1 });
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(game, 'Data', `f${i}.dat`), Buffer.from(`file ${i} of a game `.repeat(600000)));
  const done = [];
  const ask = (i, kind) => get(base, `/gamez/g/Data/f${i}.dat?r=0-${8 << 20}&${kind === 'bg' ? 'p=1' : 's=x'}`).then((r) => { assert.equal(r.status, 200); done.push(`${kind}${i}`); });
  const queue = async () => JSON.parse((await get(base, '/api/netstats', '')).body).server.encodeQueue;
  const until = async (f) => { for (let k = 0; k < 400 && !f(await queue()); k++) await new Promise((r) => setTimeout(r, 2)); };
  // three background downloads: one runs, two wait; then two of the game's reads arrive
  const all = [ask(1, 'bg'), ask(2, 'bg'), ask(3, 'bg')];
  await until((q) => q.bg === 2);
  all.push(ask(4, 'demand'), ask(5, 'demand'));
  await until((q) => q.demand === 2);
  const q = await queue();
  assert.ok(q.running <= 1, `at most one at once (${q.running})`);
  await Promise.all(all);
  // (the queue's turns: a background download every third, the game's reads otherwise)
  assert.deepEqual(done, ['bg1', 'demand4', 'bg2', 'demand5', 'bg3']);
});

test('learned sessions bounded: the least recently active out', async (t) => {
  const { base, game } = await start(t, { sessionsMax: 3 });
  fs.writeFileSync(path.join(game, 'Data', 'a.dat'), Buffer.alloc(100000, 1));
  for (let i = 0; i < 6; i++) await get(base, `/gamez/g/Data/a.dat?r=0-1000&s=s${i}`);
  const st = JSON.parse((await get(base, '/api/netstats', '')).body).server;
  assert.ok(st.sessions <= 3, `${st.sessions} sessions kept`);
});
