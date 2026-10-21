// The Windows games' playable mark (src/vfs/playable-watch.js; worker.js playableStep; server.js learnMark).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlayableWatch, ReadLog } from '../src/vfs/playable-watch.js';
import { BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { createServer } from '../src/host/server.js';

/** Feeds a watch a timeline: each step 250 ms, `fps` frames a second, `bps` bytes read a second; the first step it fires. */
function run(w, phases) {
  let now = 0, frames = 0, bytes = 1, videoBytes = 0, requests = 0, pacingMs = 0;
  for (const p of phases) {
    for (let t = 0; t < p.ms; t += 250) {
      now += 250; frames += (p.fps ?? 30) / 4; bytes += (p.bps ?? 0) / 4; videoBytes += (p.video ?? 0) / 4; requests += p.net ? 1 : 0; pacingMs += 250 * (1 - (p.busy ?? 0.3));
      if (w.step(now, { frames: Math.floor(frames), bytes: Math.floor(bytes), videoBytes: Math.floor(videoBytes), requests, pacingMs })) return now;
    }
  }
  return null;
}

/** `at` is within the stretch that begins at `from`: after it, at most `quiet` (+ a step) later */
const within = (at, from, quiet) => assert.ok(at !== null && at > from && at <= from + quiet + 250, `${at} for a stretch from ${from}`);

test('playable: the first quiet stretch drawn at a frame rate — not a loading, a movie, nor a wait on the network', () => {
  const W = () => new PlayableWatch({ quietMs: 5000, minFps: 10 });
  // a loading from this browser's copy (MB/s), then a menu
  within(run(W(), [{ ms: 10000, bps: 4e6, fps: 20 }, { ms: 20000 }]), 10000, 5000);
  // an intro movie (read at 200 KB/s, or by a movie file at any rate) first: the menu after it
  within(run(W(), [{ ms: 10000, bps: 200e3 }, { ms: 20000, bps: 20e3 }]), 10000, 5000);
  within(run(W(), [{ ms: 10000, video: 50e3 }, { ms: 20000 }]), 10000, 5000);
  // a loading over a thin link, a thread drawing its progress at 30 fps: every few seconds a read waits for the network
  assert.equal(run(W(), [{ ms: 30000, bps: 40e3, net: true }]), null);
  // a loading screen without frames (the game blocked on its reads): not before the frames come
  within(run(W(), [{ ms: 10000, fps: 1 }, { ms: 10000 }]), 10000, 5000);
  // a loading that computes, its splash screen drawn at 30 fps between steps of work, nothing read: not before its menu
  within(run(W(), [{ ms: 60000, busy: 1 }, { ms: 20000 }]), 60000, 5000);
  // menu music streamed from an archive (tens of KB a second): playable all the same
  within(run(W(), [{ ms: 10000, bps: 32e3 }]), 0, 5000);
  // once
  const w = W(); within(run(w, [{ ms: 10000 }]), 0, 5000); assert.equal(run(w, [{ ms: 10000 }]), null);
});

test('playable, by default: not a splash screen drawn between two loadings, its menu (a Windows strategy game\'s first start)', () => {
  const at = run(new PlayableWatch(), [
    { ms: 30000, bps: 3e6, fps: 1, busy: 1 }, // (loading: reads, few frames)
    { ms: 8000, fps: 10, busy: 0.5 }, { ms: 6000, fps: 23, busy: 0.45 }, // (a splash screen, then its fade)
    { ms: 120000, fps: 4, busy: 0.98 }, // (computing, the splash drawn now and then)
    { ms: 30000, fps: 30, busy: 0.25, bps: 20e3 }, // (the menu, its music streamed)
  ]);
  within(at, 164000, 10000);
});

test('ReadLog: by pieces, the first time each was read, per version, in ranges', () => {
  const l = new ReadLog();
  l.add('v', 'a.big', 10, 3 * CHUNK + 5, 1000); // (pieces 0-3 at t=0)
  l.add('v', 'a.big', 0, 100, 1500); // (again: nothing)
  l.add('dep', 'b.dat', BLOCK, BLOCK + 1, 2000);
  l.add('v', 'a.big', 10 * CHUNK, 10 * CHUNK + 1, 3000);
  const size = (p) => (p === 'a.big' ? 3 * CHUNK + 100 : 5 * BLOCK);
  assert.deepEqual(l.take('v', size), [['a.big', 0, 3 * CHUNK + 100, 0]], '(past the file: cut, or out)');
  assert.deepEqual(l.take('v', size), [], 'taken');
  l.add('v', 'a.big', 0, 10, 4000); l.add('v', 'a.big', CHUNK, CHUNK + 1, 4000);
  assert.deepEqual(l.take('v', size), [], 'read before: not again');
  assert.deepEqual(l.take('dep', size), [['b.dat', BLOCK, BLOCK + CHUNK, 1000]]);
  assert.deepEqual(l.names, ['v', 'dep']);
});

test('one session marks the version and the version it requires, each with its own reads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-pw-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), learn = path.join(root, 'learn'); fs.mkdirSync(learn);
  for (const [g, extra] of [['base', {}], ['mod', { requires: [{ game: 'base', version: 'base-1', mount: 'C:\\BASE' }] }]]) {
    fs.mkdirSync(path.join(games, g, 'base'), { recursive: true }); fs.mkdirSync(path.join(games, g, 'versions', '1'), { recursive: true });
    fs.writeFileSync(path.join(games, g, 'base', 'same.dat'), Buffer.alloc(2 * BLOCK, 3)); fs.writeFileSync(path.join(games, g, 'base', 'game.exe'), 'MZ');
    fs.writeFileSync(path.join(games, g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: g, name: g, defaultVersion: `${g}-1`, versions: [{ id: `${g}-1`, dir: '1', version: '1', exe: 'game.exe', ...extra }] }));
  }
  const server = createServer({ gamesDir: games, learnDir: learn, learnWriteMs: 10, lanLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (v, body) => fetch(`${base}/api/prefetch/${v}`, { method: 'POST', body: JSON.stringify(body) });
  // (an earlier session learned block 1 of the mod's file — the same path as the required version's)
  await post('mod-1', { session: 'old', reads: [['same.dat', BLOCK, BLOCK + 10, 9000]] });
  // this one read block 0 of each, and block 1 of the required version's only, then marked both
  assert.equal((await post('mod-1', { session: 'w', reads: [['same.dat', 0, 10, 5]], mark: { kind: 'playable' } })).status, 204);
  assert.equal((await post('base-1', { session: 'w', reads: [['same.dat', 0, 10, 5], ['same.dat', BLOCK, BLOCK + 10, 6]], mark: { kind: 'playable' } })).status, 204);
  const mod = await (await fetch(`${base}/api/prefetch/mod-1`)).json(), dep = await (await fetch(`${base}/api/prefetch/base-1`)).json();
  assert.deepEqual(mod.map((e) => [e[1], e[4]]), [[0, 1], [1, 0]], 'the mod\'s block 1: not before playable (read by the required version only)');
  assert.deepEqual(dep.map((e) => [e[1], e[4]]), [[0, 1], [1, 1]]);
});

test('ReadReports: in order (a mark after the reports before it); a final one at once, keepalive bodies under 64 KiB', async () => {
  const { ReadReports, KEEPALIVE_BYTES, FINAL_PIECE } = await import('../src/vfs/playable-watch.js');
  const calls = [], pending = [];
  const fetch = (url, init) => new Promise((resolve, reject) => { calls.push({ url, ...init, body: JSON.parse(init.body), bytes: init.body.length }); pending.push({ resolve, reject }); });
  const r = new ReadReports({ fetch });
  const reads = (n, from = 0) => Array.from({ length: n }, (_, i) => [`Data/file${from + i}.big`, 0, 65536, 1000 + i]);
  // (a large periodic report still uploading: the mark waits for it)
  const a = r.send('v', 's', reads(3000), null);
  const b = r.send('v', 's', reads(5, 3000), { kind: 'playable', t: 9 });
  await new Promise((s) => setTimeout(s, 10));
  assert.equal(calls.length, 1, 'the mark waits');
  assert.equal(calls[0].keepalive, false); assert.equal(calls[0].body.reads.length, 3000); assert.equal(calls[0].url, '/api/prefetch/v');
  pending[0].reject(new TypeError('network')); // (a failed report does not stop the chain)
  await a; await new Promise((s) => setTimeout(s, 0));
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].body.mark, { kind: 'playable', t: 9 });
  // (the final report: not behind the chain, split, keepalive while the bodies in flight stay under the limit)
  r.send('v', 's', reads(1), null);
  const before = calls.length;
  const fin = r.send('v', 's', reads(4500, 10000), null, true);
  const finals = calls.slice(before);
  assert.equal(finals.length, Math.ceil(4500 / FINAL_PIECE), 'at once, in pieces');
  assert.deepEqual(finals.flatMap((c) => c.body.reads).map((x) => x[0]), reads(4500, 10000).map((x) => x[0]), 'every read');
  assert.ok(finals.every((c) => c.bytes < KEEPALIVE_BYTES));
  const kept = finals.filter((c) => c.keepalive);
  assert.ok(kept.length >= 1 && kept.reduce((s, c) => s + c.bytes, 0) <= KEEPALIVE_BYTES, 'the keepalive ones within the budget');
  assert.ok(finals.some((c) => !c.keepalive), 'the rest as plain requests');
  for (const p of pending) p.resolve(new Response(null, { status: 204 }));
  await fin; await b;
  assert.equal(r.keepaliveBytes, 0, 'answered: the budget free again');
  // (an empty final report with a mark: one body)
  const n = calls.length; r.send('v', 's', [], { kind: 'playable', t: 1 }, true);
  assert.equal(calls.length, n + 1); assert.equal(calls[n].keepalive, true); assert.deepEqual(calls[n].body, { session: 's', reads: [], mark: { kind: 'playable', t: 1 } });
});
