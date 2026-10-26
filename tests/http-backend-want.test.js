// Announced reads (docs/slow-network.md "Announced reads", HttpBackend.wantList): the ranges an engine says its next
// reads take are fetched in parallel as transport units (a window of requests in flight, in the list's order, `w=1`),
// not asked again when here or on their way, joined by a parked read of the same bytes (which makes a queued one go
// first), allowed during a load's silence, retried on a network failure and settled false when they fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { NetLink } from '../src/vfs/net-link.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';

const MiB = 1 << 20;
const byteAt = (i) => (i * 13 + (i >> 9)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
/** 60 small files (one piece each: a mesh, a light texture) and a 2.5 MiB archive */
const tree = () => {
  const files = { 'arc.bsa': { size: 2.5 * MiB, mtime: 7 } };
  for (let i = 0; i < 60; i++) files[`m${i}.nif`] = { size: 20000 + i, mtime: 7 };
  return { dirs: {}, files };
};
/** a link neither thin nor fast (1.5 MB/s), as the slow-network measures */
const mid = () => new NetLink({ bw: 1.5e6, fixed: true });

/**
 * fetch stand-in: answers held until release() (or at once with `auto`); `fail(url)` → 'status' (404), 'throw' (network
 * down) or null. Returns { calls, inFlight, maxInFlight, release }.
 */
function heldFetch({ auto = false, fail = () => null } = {}) {
  const real = globalThis.fetch, waiting = [];
  const s = { calls: [], inFlight: 0, maxInFlight: 0, release() { for (const f of waiting.splice(0)) f(); } };
  globalThis.fetch = (url, init = {}) => {
    const m = /[?&]r=(\d+)-(\d+)/.exec(url) ?? /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '');
    const a = +m[1], e = /[?&]r=/.test(url) ? +m[2] : +m[2] + 1;
    s.calls.push({ url, start: a, end: e, file: url.split('?')[0].split('/').pop() });
    s.inFlight++; s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
    const how = fail(url);
    return new Promise((resolve, reject) => {
      const go = () => {
        s.inFlight--;
        if (how === 'throw') return reject(new TypeError('network down'));
        if (how === 'status') return resolve({ status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
        resolve({ status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(a, e).buffer });
      };
      if (auto) queueMicrotask(go); else waiting.push(go);
    });
  };
  s.restore = () => { globalThis.fetch = real; };
  return s;
}
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1)); };

test('announced files are fetched in parallel (a window of unit requests, w=1, in order), kept; announced again: nothing asked', async () => {
  const F = heldFetch(), store = new MemBlockStore();
  try {
    const b = new HttpBackend('/game/v/', tree(), { store, encoded: true, session: 'sess', net: mid() });
    const list = Array.from({ length: 40 }, (_, i) => [`m${i}.nif`, 0, -1]);
    const done = b.wantList(list, { label: 'meshes:-2,6' });
    await settle(5);
    assert.equal(F.calls.length, 32, 'the window: 32 requests at once, before any answer');
    assert.deepEqual(F.calls.map((c) => c.file), list.slice(0, 32).map(([p]) => p), 'in the list\'s order');
    assert.ok(F.calls.every((c) => /[?&]w=1/.test(c.url) && !/[?&]p=1/.test(c.url) && !/[?&]s=/.test(c.url)), 'announced: w=1, no session (not learned)');
    assert.ok(F.calls.every((c) => c.start === 0 && c.end === 20000 + Number(c.file.slice(1, -4))), 'each one unit: the file, its only block');
    assert.equal(b.net.loading(), true, 'the game waits for them: a load (the rest of the background keeps quiet)');
    F.release(); await settle(5); F.release(); await settle(5);
    assert.deepEqual(await Promise.all(done), list.map(() => true));
    assert.equal(F.calls.length, 40);
    assert.equal(b.stats.wantLabel, 'meshes:-2,6');
    assert.ok(store.map.has(`m39.nif#20039#7#0`), 'kept in the store as its block');
    assert.deepEqual(b.open('m7.nif').read(100, 50), bytes(100, 150), 'read from here');
    const again = b.wantList(list);
    assert.deepEqual(await Promise.all(again), list.map(() => true));
    await settle(2);
    assert.equal(F.calls.length, 40, 'here already: nothing asked');
    assert.equal(b.net.snapshot().bgBy.announced.requests, 40, 'counted as the announced reads\' in the link\'s producers');
  } finally { F.restore(); }
});

test('an archive range: its whole blocks as block units, a partial block as its pieces; size -1 to the end', async () => {
  const F = heldFetch({ auto: true });
  try {
    const b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net: mid() });
    // [0.5 MiB - 10, end): piece-aligned tail of block 0, all of block 1, block 2 (the file's tail, 0.5 MiB) whole
    const r = await Promise.all(b.wantList([['arc.bsa', MiB / 2 - 10, -1]]));
    assert.deepEqual(r, [true]);
    const got = F.calls.map((c) => [c.start, c.end]).sort((x, y) => x[0] - y[0]);
    const want = [];
    for (let c = (MiB / 2 - CHUNK) / CHUNK; c < MiB / CHUNK; c++) want.push([c * CHUNK, (c + 1) * CHUNK]);
    want.push([MiB, 2 * MiB], [2 * MiB, 2.5 * MiB]);
    assert.deepEqual(got, want);
    assert.ok(b.peekBlockHere('arc.bsa', 2.5 * MiB, 7, 1) && b.peekBlockHere('arc.bsa', 2.5 * MiB, 7, 2), 'whole blocks installed');
  } finally { F.restore(); }
});

test('what is on its way is joined, not asked again; a parked read of a queued unit joins it and makes it go first', async () => {
  const F = heldFetch();
  try {
    const b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net: mid() });
    // (a learned piece already on its way: fetchPartBg registers it as a flight)
    const own = b.fetchPartBg('m0.nif', 20000, 7, 0, 0, [2, 0]);
    await settle(2);
    assert.equal(F.calls.length, 1);
    const list = Array.from({ length: 40 }, (_, i) => [`m${i}.nif`, 0, -1]);
    const done = b.wantList(list);
    await settle(2);
    assert.equal(F.calls.filter((c) => c.file === 'm0.nif').length, 1, 'm0 joined the flight on its way');
    assert.equal(F.calls.length, 1 + 32, 'the window full');
    // (m38: queued behind the window — a parked read of it waits for that unit, promoted past the window)
    const f = b.open('m38.nif');
    const parked = f.prepare(0, 100, true);
    assert.ok(parked, 'the read is not here: parked');
    await settle(2);
    assert.equal(F.calls.length, 1 + 33, 'the queued unit went at once');
    assert.equal(F.calls.at(-1).file, 'm38.nif');
    assert.ok(/[?&]w=1/.test(F.calls.at(-1).url), 'as the announced request (no demand request of the same bytes)');
    for (let i = 0; i < 4; i++) { F.release(); await settle(3); }
    await parked; await own;
    assert.deepEqual(await Promise.all(done), list.map(() => true));
    assert.equal(F.calls.filter((c) => c.file === 'm38.nif').length, 1, 'm38 asked once');
    assert.equal(F.calls.length, 1 + 40 - 1, 'every file once (m0 by its flight)');
    assert.deepEqual(f.read(0, 100), bytes(0, 100));
  } finally { F.restore(); }
});

test('during a load\'s silence the announced units go; the other background waits', async () => {
  const F = heldFetch();
  try {
    const net = mid(), b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net });
    // (a load: a dense run of reads the game waits for — NetLink.wait)
    const toks = [net.wait(), net.wait(), net.wait()];
    assert.equal(net.silenced(), true);
    const bg = b.fetchPartBg('m50.nif', 20050, 7, 0, 0, [5, 0]);
    await settle(2);
    assert.equal(F.calls.length, 0, 'a background download waits for the load to end');
    const done = b.wantList([['m1.nif', 0, -1], ['m2.nif', 0, -1]]);
    await settle(2);
    assert.deepEqual(F.calls.map((c) => c.file).sort(), ['m1.nif', 'm2.nif'], 'the announced ones go (forLoad, urgent)');
    F.release(); await settle(3);
    assert.deepEqual(await Promise.all(done), [true, true]);
    for (const t of toks) net.waitEnd(t);
    // (the load over: the background goes)
    for (let i = 0; i < 200 && !F.calls.some((c) => c.file === 'm50.nif'); i++) await new Promise((r) => setTimeout(r, 10));
    F.release(); await bg;
    assert.ok(F.calls.some((c) => c.file === 'm50.nif'));
  } finally { F.restore(); }
});

test('a queued background flight it joins goes first: the list\'s own silence does not hold it (no wait for the engine\'s timeout)', async () => {
  const F = heldFetch({ auto: true });
  try {
    const net = mid(), b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net });
    // (a background piece (prefetch, fill, a learned piece no longer followed: not forLoad) queued behind a load's silence)
    const toks = [net.wait(), net.wait(), net.wait()];
    const bg = b.fetchPartBg('m50.nif', 20050, 7, 0, 0, [5, 0]);
    await settle(2);
    assert.equal(F.calls.length, 0, 'held by the silence');
    for (const t of toks) net.waitEnd(t);
    // (the announced list's own wait keeps the link silenced; the joined flight must go all the same)
    const done = b.wantList([['m50.nif', 0, -1], ['m1.nif', 0, -1]]);
    assert.equal(net.silenced(), true, 'the list\'s wait: a load');
    let settled = false; const all = Promise.all(done).then((r) => { settled = true; return r; });
    for (let i = 0; i < 100 && !settled; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(settled, true, 'the list settled (the joined flight was promoted)');
    assert.deepEqual(await all, [true, true]);
    assert.equal(F.calls.filter((c) => c.file === 'm50.nif').length, 1, 'joined, not asked again');
    assert.equal(await bg, true);
  } finally { F.restore(); }
});

test('failures: an answer refused fails at once, a network failure after its retries; the wait ends with them', async () => {
  const F = heldFetch({ auto: true, fail: (url) => (/m3\.nif/.test(url) ? 'status' : /m4\.nif/.test(url) ? 'throw' : null) });
  try {
    const b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net: mid(), retryWaits: [1, 1, 1] });
    const r = await Promise.all(b.wantList([['m3.nif', 0, -1], ['m4.nif', 0, -1], ['m5.nif', 0, -1], ['nope.nif', 0, -1]]));
    assert.deepEqual(r, [false, false, true, false]);
    assert.equal(F.calls.filter((c) => c.file === 'm3.nif').length, 1, 'refused: not asked again');
    assert.equal(F.calls.filter((c) => c.file === 'm4.nif').length, 3, 'network down: asked again twice');
    assert.equal(b.stats.wantFailed, 2);
    assert.equal(b.flights.size, 0, 'no flight left behind');
    await settle(2);
    assert.equal(b.net.waitsNow.size, 0, 'the link\'s wait over');
  } finally { F.restore(); }
});

test('a whole block already read ahead (blockFlights) is joined', async () => {
  const F = heldFetch();
  try {
    const b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net: mid() });
    let release; const flight = new Promise((r) => { release = r; });
    b.blockFlights.set('arc.bsa#1', flight);
    const done = b.wantList([['arc.bsa', MiB + 100, 1000]]);
    await settle(2);
    assert.equal(F.calls.length, 0, 'waits for the block on its way');
    b.installBlock('arc.bsa', 1, bytes(MiB, 2 * MiB), `arc.bsa#${2.5 * MiB}#7#1`); b.blockFlights.delete('arc.bsa#1'); release();
    assert.deepEqual(await Promise.all(done), [true]);
    assert.equal(F.calls.length, 0);
    assert.equal(BLOCK, MiB);
  } finally { F.restore(); }
});

test('while an announced list is missing nothing is fetched ahead from the learned order (even announced far ahead); once here, it is', async () => {
  const F = heldFetch();
  let stopped = false;
  try {
    const files = { 'f.big': { size: 8 * MiB, mtime: 1 }, 'm0.nif': { size: 20000, mtime: 1 } };
    const b = new HttpBackend('/game/w/', { dirs: {}, files }, { store: new MemBlockStore(), net: mid() });
    b.fillBackground = () => {}; b.noteMiss = () => {}; b.lastSyncFetchAt = performance.now() + 1e9; // (the learned pieces alone)
    const pass = b.prefetch([['f.big', 0, 0b1], ['f.big', 1, 0b100], ['f.big', 2, 0b1]], {}, () => stopped);
    await settle(2);
    // (wait false: the link not held — only the announced list keeps the learned pieces back)
    const done = b.wantList([['m0.nif', 0, -1]], { label: 'meshes:0,0', wait: false });
    await settle(2);
    assert.deepEqual(F.calls.map((c) => c.file), ['m0.nif']);
    b.chunks.set('f.big#0', bytes(0, CHUNK)); b.chunkBytes += CHUNK;
    assert.deepEqual(b.open('f.big').read(100, 50), bytes(100, 150)); // the game reaches the learned list's entry 0
    await settle(2);
    assert.deepEqual(F.calls.map((c) => c.file), ['m0.nif'], 'nothing ahead while the announced file is missing');
    F.release();
    assert.deepEqual(await Promise.all(done), [true]);
    await settle(5);
    assert.deepEqual(F.calls.slice(1).map((c) => [c.file, c.start]), [['f.big', MiB + 2 * CHUNK], ['f.big', 2 * MiB]], 'the learned pieces ahead once it is here');
    stopped = true; F.release(); await pass;
  } finally { stopped = true; F.release(); F.restore(); }
});

// A predicted place (wantList `prio: 'place'`, docs/openmw.md "Anticipated places"): the set of the place a saved game
// will load, fetched while the link is idle before the player clicks — background turns below the game's reads, a
// load's and the launch set, not learned, no wait of the link's, joined (and promoted) by what the game then needs.
test('a predicted place: background requests (p=1, not learned), a small window, held by a load\'s silence, no wait of the link\'s', async () => {
  const F = heldFetch();
  try {
    const net = mid(), b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, session: 'sess', net });
    const toks = [net.wait(), net.wait(), net.wait()];
    const list = Array.from({ length: 10 }, (_, i) => [`m${i}.nif`, 0, -1]);
    const done = b.wantList(list, { prio: 'place', label: 'place:-2,6' });
    await settle(3);
    assert.equal(F.calls.length, 0, 'not forLoad nor urgent: a load holds it');
    assert.equal(net.waitsNow.size, 3, 'no wait of its own (the engine waits for nothing)');
    assert.equal(b.wantLists, 0, 'the learned read-ahead is not paused for it');
    assert.equal(b.stats.placeLabel, 'place:-2,6');
    assert.equal(b.stats.wantLabel, undefined, 'not an announced load\'s label');
    for (const t of toks) net.waitEnd(t);
    for (let i = 0; i < 200 && !F.calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(F.calls.length > 0 && F.calls.length <= 8, `its window (${F.calls.length} requests)`);
    assert.ok(F.calls.every((c) => /[?&]p=1/.test(c.url) && !/[?&]w=1/.test(c.url) && !/[?&]s=/.test(c.url)), 'background, not learned');
    for (let i = 0; i < 40 && F.calls.length < 10; i++) { F.release(); await settle(3); await new Promise((r) => setTimeout(r, 5)); }
    F.release();
    assert.deepEqual(await Promise.all(done), list.map(() => true));
    assert.equal(F.calls.length, 10);
    assert.equal(b.stats.placeUnits, 10);
    assert.equal(b.stats.wantUnits, undefined);
    assert.equal(net.snapshot().bgBy.place.requests, 10, 'counted as the place\'s');
    assert.deepEqual(await Promise.all(b.wantList(list, { prio: 'place' })), list.map(() => true), 'asked again: here already');
    assert.equal(F.calls.length, 10);
  } finally { F.restore(); }
});

test('a predicted place\'s queued unit that an announced list (or a parked read) needs goes at once, asked once; announced units first', async () => {
  const F = heldFetch();
  try {
    const net = mid(), b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net });
    const toks = [net.wait(), net.wait(), net.wait()];
    const place = b.wantList(Array.from({ length: 10 }, (_, i) => [`m${i}.nif`, 0, -1]), { prio: 'place' });
    await settle(3);
    assert.equal(F.calls.length, 0);
    // (the player loaded that place: the engine announces some of the same files — joined, promoted past the silence)
    const done = b.wantList([['m7.nif', 0, -1], ['m1.nif', 0, -1], ['m20.nif', 0, -1]]);
    await settle(3);
    assert.deepEqual(F.calls.map((c) => c.file).sort(), ['m1.nif', 'm20.nif', 'm7.nif']);
    // (a parked read of another of the place's units: it goes too)
    const parked = b.open('m9.nif').prepare(0, 100, true);
    await settle(3);
    assert.ok(F.calls.some((c) => c.file === 'm9.nif'));
    F.release(); await settle(3);
    assert.deepEqual(await Promise.all(done), [true, true, true]);
    await parked;
    for (const t of toks) net.waitEnd(t);
    for (let i = 0; i < 60 && F.calls.length < 11; i++) { F.release(); await new Promise((r) => setTimeout(r, 10)); }
    F.release();
    assert.deepEqual(await Promise.all(place), Array(10).fill(true));
    for (const f of ['m1.nif', 'm7.nif', 'm9.nif']) assert.equal(F.calls.filter((c) => c.file === f).length, 1, `${f} asked once`);
    // (announced units waiting for their requests (the window full): a place's wait for them)
    const a2 = b.wantList(Array.from({ length: 40 }, (_, i) => [`m${10 + i}.nif`, 0, -1]).filter(([p]) => p !== 'm20.nif'));
    const p2 = b.wantList(Array.from({ length: 5 }, (_, i) => [`m${50 + i}.nif`, 0, -1]), { prio: 'place' });
    await settle(3);
    const n0 = F.calls.length;
    assert.equal(b.placeQ.length, 5, 'queued behind the announced ones');
    assert.ok(!F.calls.some((c) => /m5[0-4]\./.test(c.file)));
    let over = false; const all2 = Promise.all([...a2, ...p2]).then((r) => { over = true; return r; });
    for (let i = 0; i < 300 && !over; i++) { F.release(); await new Promise((r) => setTimeout(r, 5)); }
    assert.ok((await all2).every(Boolean));
    const order = F.calls.slice(n0 - 32).map((c) => c.file);
    assert.ok(order.findIndex((f) => /m5[0-4]\./.test(f)) > order.indexOf('m49.nif'), 'the place\'s after every announced unit');
  } finally { F.restore(); }
});

test('a predicted place\'s queued units an announced list names go under the announced window, in its order — not all at once', async () => {
  const F = heldFetch();
  try {
    const net = mid(), b = new HttpBackend('/game/v/', tree(), { store: new MemBlockStore(), encoded: true, net });
    const tok = net.wait(); // (a load's silence: the place's units stay queued)
    const files = Array.from({ length: 60 }, (_, i) => [`m${i}.nif`, 0, -1]);
    const place = b.wantList(files, { prio: 'place' });
    await settle(3);
    assert.equal(F.calls.length, 0);
    // (the player loads that place: the engine announces the same files, the other way round)
    const announced = [...files].reverse(), done = b.wantList(announced);
    await settle(3);
    // (the place's first PLACE_REQUESTS_THIN… — 8 — had their requests already, waiting for their turn: a load's own now,
    // by the link's rules; the 52 still queued joined the announced queue, the window's 32 of them at once)
    const ann = F.calls.filter((c) => /[?&]w=1/.test(c.url)), early = F.calls.filter((c) => !/[?&]w=1/.test(c.url));
    assert.equal(ann.length, 32, 'the window, not the 52 promoted at once');
    assert.ok(early.length <= 8, `the place's own requests only (${early.length})`);
    assert.deepEqual(ann.map((c) => c.file), announced.filter(([p]) => !early.some((c) => c.file === p)).slice(0, 32).map(([p]) => p), 'in the announcement\'s order');
    for (let i = 0; i < 60 && F.calls.length < 60; i++) { F.release(); await settle(2); }
    F.release();
    assert.deepEqual(await Promise.all(done), Array(60).fill(true));
    assert.deepEqual(await Promise.all(place), Array(60).fill(true));
    assert.equal(F.calls.length, 60, 'each asked once');
    assert.ok(F.maxInFlight <= 40, `at most the window and the place's own in flight (${F.maxInFlight})`);
    assert.equal(b.stats.placeAdopted, 60 - early.length);
    net.waitEnd(tok);
  } finally { F.restore(); }
});

test('the learned order\'s launch set goes before a predicted place, the rest of the order after it', async () => {
  const files = { 'a.bin': { size: 2 * MiB, mtime: 1 }, 'b.bin': { size: 2 * MiB, mtime: 1 } };
  const b = new HttpBackend('/game/w/', { dirs: {}, files }, { store: new MemBlockStore(), net: mid() });
  b.fillBackground = () => {}; b.noteMiss = () => {};
  const prios = [];
  // (each learned piece as if fetched: here at once)
  b.fetchPartBg = (path, size, mtime, c0, c1, prio) => { prios.push([path, prio[0]]); b.chunks.set(`${path}#${c0}`, new Uint8Array(CHUNK)); return Promise.resolve(true); };
  const real = globalThis.fetch; globalThis.fetch = () => Promise.reject(new Error('none'));
  try {
    const list = [['a.bin', 0, 0b1], ['b.bin', 0, 0b1]]; list.first = 1;
    await b.prefetch(list, {}, () => false, { first: 1 });
    let placePrio = null;
    b.fetchBackground = (path, s, e, onStart, abortable, learn, turn) => { placePrio = turn.prio[0]; return Promise.resolve(undefined); };
    await Promise.all(b.wantList([['a.bin', MiB, MiB + 100]], { prio: 'place' }));
    assert.deepEqual([...new Set(prios.map(([p]) => p))], ['a.bin', 'b.bin']);
    prios.splice(1, prios.findIndex(([p]) => p === 'b.bin') - 1);
    assert.ok(prios[0][1] < placePrio && placePrio < prios[1][1], `launch set ${prios[0][1]} < place ${placePrio} < the rest ${prios[1][1]}`);
  } finally { globalThis.fetch = real; }
});
