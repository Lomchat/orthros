// "Prepare" (src/host/web/download-worker.js): a browser port's engine files come side by side (a release of 17 small
// files was a round trip each), each once, their wire bytes counted once whatever their order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemBlockStore } from '../src/vfs/opfs-store.js';
import { storeLocks } from '../src/vfs/game-data.js';
import { Downloads } from '../src/host/web/download.js';

test('prepare: the engine files side by side (at most 4), each once, the bytes counted once', async () => {
  const real = globalThis.fetch, realSelf = globalThis.self;
  const posts = []; globalThis.self = { postMessage: (m) => posts.push(m) };
  let now = 0, most = 0; const asked = [];
  const urls = Array.from({ length: 9 }, (_, i) => `/engines/r/e${i}.wasm`);
  globalThis.fetch = async (url, o = {}) => {
    if (o.cache === 'only-if-cached') throw new TypeError('not cached');
    const json = (v) => ({ ok: true, status: 200, json: async () => v, headers: new Headers() });
    if (url.startsWith('/api/manifest/')) return json({});
    if (url.startsWith('/api/tree/')) return json({ dirs: {}, files: {} });
    if (url.startsWith('/api/prefetch/')) return json([]);
    asked.push(url); now++; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 10));
    now--;
    const body = new Uint8Array(1000 + asked.length);
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(body.length) }), body: new Response(body).body };
  };
  try {
    const { download } = await import('../src/host/web/download-worker.js');
    await download('g', undefined, 'launch', null, { files: urls, bytes: 9 * 1005 }, { openStore: async () => new MemBlockStore() });
    assert.deepEqual([...asked].sort(), [...urls].sort(), 'each once');
    assert.ok(most > 1 && most <= 4, `side by side: ${most}`);
    const done = posts.filter((m) => m.type === 'progress').at(-1);
    assert.equal(done.done, true, JSON.stringify(done));
  } finally { globalThis.fetch = real; globalThis.self = realSelf; }
});

test('prepare: the owner\'s store held by another tab\'s game — the shared files kept in the version\'s own store, not a failed Prepare', async () => {
  const real = globalThis.fetch, realSelf = globalThis.self;
  const posts = []; globalThis.self = { postMessage: (m) => posts.push(m) };
  globalThis.fetch = async (url) => {
    const json = (v) => ({ ok: true, status: 200, json: async () => v, headers: new Headers() });
    if (url.startsWith('/api/manifest/')) return json({});
    if (url.startsWith('/api/tree/')) return json({ dirs: {}, files: { 'a.dat': { size: 10, mtime: 1, owner: 'base' }, 'b.dat': { size: 10, mtime: 1 } } });
    if (url.startsWith('/api/prefetch/')) return json([]);
    throw new Error('unexpected ' + url);
  };
  const own = new MemBlockStore(), opened = [];
  try {
    const { download } = await import('../src/host/web/download-worker.js');
    await download('ed', undefined, 'launch', null, null, { openStore: async (n) => { opened.push(n); return n === 'ed' ? own : null; } });
    const last = posts.filter((m) => m.type === 'progress').at(-1);
    assert.deepEqual(opened, ['ed', 'base']);
    assert.equal(last.error, undefined, JSON.stringify(last)); assert.equal(last.done, true);
  } finally { globalThis.fetch = real; globalThis.self = realSelf; }
});

// The home's probe (download-worker.js `probe`, docs/slow-network.md "The card from the store"): what a store holds of
// the launch set and of the whole game, a store filled on another link counted (light copies or files), a store that
// does not exist neither opened nor created.
const MiB = 1 << 20, CHUNK = 1 << 16;
const probeTree = () => ({ dirs: {}, files: { 'data.bsa': { size: 2 * MiB, mtime: 1 }, 'tex.dds': { size: 2 * MiB, mtime: 1, light: 100000 } } });
const probeOrder = [['data.bsa', 0, 0, 0, 1], ['tex.dds', 0, 0, 10, 1], ['tex.dds', 1, 0, 20, 1], ['data.bsa', 1, 0, 9000, 0]];
async function runProbe(items, bw, { stores = {}, exists = (n) => n in stores, engineCached = false, tree = probeTree, manifest = {} } = {}) {
  const real = globalThis.fetch, realSelf = globalThis.self;
  const posts = [], opened = []; globalThis.self = { postMessage: (m) => posts.push(m) };
  globalThis.fetch = async (url, o = {}) => {
    const json = (v) => ({ ok: true, status: 200, json: async () => v, headers: new Headers() });
    if (o.cache === 'only-if-cached') { if (engineCached) return { ok: true, body: null }; throw new TypeError('not cached'); }
    if (url.startsWith('/api/manifest/')) return json(manifest);
    if (url.startsWith('/api/tree/')) return json(tree(decodeURIComponent(url.slice(10))));
    if (url.startsWith('/api/prefetch/')) return json(probeOrder);
    throw new Error('unexpected ' + url);
  };
  try {
    const { probe } = await import('../src/host/web/download-worker.js');
    await probe(items, bw, { exists: async (n) => exists(n), openStore: async (n) => { opened.push(n); return stores[n] ?? null; } });
  } finally { globalThis.fetch = real; globalThis.self = realSelf; }
  return { probed: posts.filter((m) => m.type === 'probed'), stopped: posts.filter((m) => m.type === 'stopped').length, opened };
}
const FAST = 8 * MiB, THIN = 85000;
const putBlock = (s, path, size, b) => s.put(`${path}#${size}#1#${b}`, new Uint8Array(Math.min(MiB, size - b * MiB)));
const putPieces = (s, path, size, n) => { for (let c = 0; c < n; c++) s.put(`${path}#${size}#1#c${c}`, new Uint8Array(Math.min(CHUNK, size - c * CHUNK))); };

test('probe: a store filled on a thin link (light copies) is ready on a thin one, not on a fast one (its startup fetches the files), files stored are ready on both; the whole game counted by its whole blocks', async () => {
  const thinFilled = new MemBlockStore(); putBlock(thinFilled, 'data.bsa', 2 * MiB, 0); putPieces(thinFilled, '.light/tex.dds', 100000, 2);
  for (const bw of [FAST, THIN]) {
    const { probed, stopped } = await runProbe([{ name: 'g', lang: 'en' }], bw, { stores: { g: thinFilled } });
    assert.equal(probed.length, 1); assert.equal(stopped, 1);
    const [m] = probed;
    assert.equal(m.launch.done, bw === THIN, `light copies here, ${bw} B/s: ${JSON.stringify(m.launch)}`);
    if (bw === THIN) assert.equal(m.launch.bytes, m.launch.total);
    else assert.ok(m.launch.bytes > 0 && m.launch.bytes < m.launch.total, `fast: data.bsa here, tex.dds's pieces not: ${JSON.stringify(m.launch)}`);
    assert.deepEqual(m.whole, { bytes: MiB, total: 4 * MiB, done: false }, 'the whole game: the blocks here whole');
  }
  const fastFilled = new MemBlockStore(); putBlock(fastFilled, 'data.bsa', 2 * MiB, 0); putBlock(fastFilled, 'tex.dds', 2 * MiB, 0); putBlock(fastFilled, 'tex.dds', 2 * MiB, 1);
  const thin = (await runProbe([{ name: 'g' }], THIN, { stores: { g: fastFilled } })).probed[0];
  assert.equal(thin.launch.done, true, `the files here, a thin link: ${JSON.stringify(thin.launch)}`);
  const part = new MemBlockStore(); putBlock(part, 'data.bsa', 2 * MiB, 0);
  const p = (await runProbe([{ name: 'g' }], FAST, { stores: { g: part } })).probed[0];
  assert.equal(p.launch.done, false); assert.ok(p.launch.bytes > 0 && p.launch.bytes < p.launch.total, JSON.stringify(p.launch));
});

test('probe: a store that does not exist is neither opened nor created (missing), one another tab holds says nothing, the engine counted only if cached', async () => {
  const s = new MemBlockStore(); putBlock(s, 'data.bsa', 2 * MiB, 0); putBlock(s, 'tex.dds', 2 * MiB, 0); putBlock(s, 'tex.dds', 2 * MiB, 1);
  const engine = { files: ['/engines/r/a.wasm', '/engines/r/b.js', 'http://elsewhere/x'], bytes: 1000 };
  const r = await runProbe([{ name: 'gone', lang: 'fr' }, { name: 'busy' }, { name: 'g', engine }], FAST, { stores: { g: s }, exists: (n) => n !== 'gone' });
  assert.deepEqual(r.opened, ['busy', 'g'], 'the missing store not opened');
  assert.deepEqual(r.probed.map((m) => m.name), ['gone', 'g'], 'the busy one: unknown, nothing said');
  assert.deepEqual({ missing: r.probed[0].missing, lang: r.probed[0].lang }, { missing: true, lang: 'fr' });
  const g = r.probed[1].launch;
  assert.equal(g.engine, 1000); assert.deepEqual(g.engineFiles, ['/engines/r/a.wasm', '/engines/r/b.js']);
  assert.equal(g.done, false, 'the engine not cached: not ready'); assert.equal(g.total - g.bytes, 1000);
  const c = (await runProbe([{ name: 'g', engine }], FAST, { stores: { g: s }, engineCached: true })).probed[0].launch;
  assert.equal(c.done, true); assert.equal(c.bytes, c.total);
});

test('probe: under the stores\' Web Locks — a store whose lock another context holds is not opened (unknown), a game\'s open waits out the count', async () => {
  const s = new MemBlockStore(); putBlock(s, 'data.bsa', 2 * MiB, 0);
  // (a game opening the store now: the probe does not wait, says nothing of it)
  let release; const held = new Promise((r) => { release = r; });
  const holding = storeLocks(['g'], () => held);
  const busy = await runProbe([{ name: 'g' }], FAST, { stores: { g: s } });
  assert.deepEqual({ opened: busy.opened, probed: busy.probed.length, stopped: busy.stopped }, { opened: [], probed: 0, stopped: 1 });
  release(); await holding;
  // (the probe counting: a game's open — game-data.js openStore, under the same lock — waits until the store is closed)
  const order = []; let game = null;
  const counted = Object.assign(Object.create(Object.getPrototypeOf(s)), s, { close: () => order.push('probe closed') });
  const real = globalThis.fetch, realSelf = globalThis.self;
  globalThis.self = { postMessage: () => {} };
  globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: new Headers(), json: async () => (url.startsWith('/api/tree/') ? probeTree() : url.startsWith('/api/prefetch/') ? probeOrder : {}) });
  try {
    const { probe } = await import('../src/host/web/download-worker.js');
    await probe([{ name: 'g' }], FAST, { exists: async () => true, openStore: async () => { game = storeLocks(['g'], () => order.push('game opened')); return counted; } });
  } finally { globalThis.fetch = real; globalThis.self = realSelf; }
  await game;
  assert.deepEqual(order, ['probe closed', 'game opened']);
});

test('probe: a file a version takes from one it requires counts from that version\'s store (one copy for both); the stores\' locks in one order', async () => {
  // (the edition's tree: data.bsa is the owner's file — the server's mark —, tex.dds its own)
  const tree = () => { const t = probeTree(); t.files['data.bsa'].owner = 'base'; return t; };
  const own = new MemBlockStore(); putBlock(own, 'tex.dds', 2 * MiB, 0); putBlock(own, 'tex.dds', 2 * MiB, 1);
  const owner = new MemBlockStore(); putBlock(owner, 'data.bsa', 2 * MiB, 0); putBlock(owner, 'data.bsa', 2 * MiB, 1);
  const both = await runProbe([{ name: 'ed' }], FAST, { stores: { ed: own, base: owner }, tree });
  assert.deepEqual(both.opened, ['ed', 'base']);
  assert.deepEqual(both.probed[0].whole, { bytes: 4 * MiB, total: 4 * MiB, done: true }, 'the owner\'s blocks counted');
  assert.equal(both.probed[0].launch.done, true);
  // (the owner's store not here, or held by another tab's game: what the edition's own kept of the owner's files
  // before the owners counts — the game reads it there, UnderStore)
  const alone = new MemBlockStore(); for (const s of [own]) for (const [k, v] of s.map) alone.put(k, v); putBlock(alone, 'data.bsa', 2 * MiB, 0);
  const one = await runProbe([{ name: 'ed' }], FAST, { stores: { ed: alone }, tree });
  assert.deepEqual(one.opened, ['ed']);
  assert.deepEqual(one.probed[0].whole, { bytes: 3 * MiB, total: 4 * MiB, done: false });
  const busy = await runProbe([{ name: 'ed' }], FAST, { stores: { ed: alone }, exists: (n) => n === 'ed' || n === 'base', tree });
  assert.deepEqual(busy.opened, ['ed', 'base']);
  assert.deepEqual(busy.probed[0].whole, { bytes: 3 * MiB, total: 4 * MiB, done: false }, 'the owner\'s busy: the edition\'s share counted, not unknown');
  // (the edition never played, its owner's store here: not missing — the shared files counted)
  const fresh = await runProbe([{ name: 'ed' }], FAST, { stores: { base: owner }, tree, manifest: { owners: ['base'] } });
  assert.deepEqual(fresh.opened, ['base']);
  assert.deepEqual(fresh.probed[0].whole, { bytes: 2 * MiB, total: 4 * MiB, done: false });
  assert.equal((await runProbe([{ name: 'ed' }], FAST, { stores: {}, tree, manifest: { owners: ['base'] } })).probed[0].missing, true, 'no store of either: missing');
  // (the locks: by name whatever the order asked — a page taking the edition's and the owner's, a probe the other way)
  const real = globalThis.navigator, taken = [];
  const locks = { request: async (name, o, fn) => { taken.push(name); return fn({ name }); } };
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  try { await storeLocks(['vice-city-revc', 'vice-city-1.1', 'vice-city-revc'], () => {}); } finally { Object.defineProperty(globalThis, 'navigator', { value: real, configurable: true }); }
  assert.deepEqual(taken, ['orthros-store-vice-city-1.1', 'orthros-store-vice-city-revc']);
});

test('Play: no probe starts once a game is chosen (forGame) — a probe timer firing after the click starts no worker', async () => {
  const realW = globalThis.Worker; let made = 0;
  globalThis.Worker = class { constructor() { made++; } postMessage() {} terminate() {} };
  try {
    const d = new Downloads();
    await d.forGame();
    d.probe([{ name: 'g' }]);
    assert.equal(made, 0, 'no worker after Play');
    const e = new Downloads(); e.probe([{ name: 'g' }]);
    assert.equal(made, 1, 'the probe of a home visit');
  } finally { globalThis.Worker = realW; }
});

test('probe: an engine that reloads in place — its light set on every link: a store filled light on a thin link is ready on a fast one', async () => {
  const thinFilled = new MemBlockStore(); putBlock(thinFilled, 'data.bsa', 2 * MiB, 0); putPieces(thinFilled, '.light/tex.dds', 100000, 2);
  const [m] = (await runProbe([{ name: 'g', lang: 'en', reloads: true }], FAST, { stores: { g: thinFilled } })).probed;
  assert.equal(m.launch.done, true, JSON.stringify(m.launch)); assert.equal(m.launch.bytes, m.launch.total);
  const fastFilled = new MemBlockStore(); putBlock(fastFilled, 'data.bsa', 2 * MiB, 0); putBlock(fastFilled, 'tex.dds', 2 * MiB, 0); putBlock(fastFilled, 'tex.dds', 2 * MiB, 1);
  assert.equal((await runProbe([{ name: 'g', reloads: true }], FAST, { stores: { g: fastFilled } })).probed[0].launch.done, true, 'the files here whole: ready too');
});

test('prepare: an engine that reloads in place, on a fast link — the light set first ("Ready"), then the files themselves as a second stage', async () => {
  const run = async (reloads) => {
    const real = globalThis.fetch, realSelf = globalThis.self;
    const posts = [], asked = []; globalThis.self = { postMessage: (m) => posts.push({ ...m, asked: asked.length }) };
    globalThis.fetch = async (url) => {
      const json = (v) => ({ ok: true, status: 200, json: async () => v, headers: new Headers() });
      if (url.startsWith('/api/manifest/')) return json({});
      if (url.startsWith('/api/tree/')) return json(probeTree());
      if (url.startsWith('/api/prefetch/')) return json(probeOrder);
      const u = new URL(url, 'http://x'), r = u.searchParams.get('r');
      const [a, b] = r ? r.split('-').map(Number) : [0, 0];
      const file = decodeURIComponent(u.pathname.split('/').slice(3).join('/'));
      asked.push(file);
      // (the file itself slow: the half-second reports of the second stage come meanwhile)
      if (file === 'tex.dds') await new Promise((r) => setTimeout(r, 700));
      return new Response(new Uint8Array(b - a), { status: 200, headers: { 'content-length': String(b - a) } });
    };
    try {
      const { download } = await import('../src/host/web/download-worker.js');
      await download('g', FAST, 'launch', null, null, { openStore: async () => new MemBlockStore() }, reloads);
    } finally { globalThis.fetch = real; globalThis.self = realSelf; }
    return { progress: posts.filter((m) => m.type === 'progress'), asked };
  };
  const two = await run(true);
  const ready = two.progress.find((m) => m.done);
  assert.ok(ready && ready.bytes === ready.total, `'Ready' once the light set is here: ${JSON.stringify(ready)}`);
  const before = two.asked.slice(0, ready.asked), after = two.asked.slice(ready.asked);
  assert.ok(before.includes('.light/tex.dds') && !before.includes('tex.dds'), `first stage: the light copy, not the file: ${before}`);
  assert.ok(after.includes('tex.dds'), `second stage: the file itself: ${after}`);
  const last = two.progress.at(-1);
  assert.equal(last.done, true); assert.equal(last.running, false);
  assert.ok(last.upgrade && last.upgrade.bytes === last.upgrade.total && last.upgrade.total > 0, JSON.stringify(last.upgrade));
  assert.ok(two.progress.filter((m) => m.upgrade && m.running).length >= 2, 'the half-second reports while the second stage runs');
  assert.ok(two.progress.filter((m) => m.upgrade).every((m) => m.done), 'ready all along the second stage');
  // (an engine that does not reload in place: the files themselves on a fast link, one stage)
  const one = await run(false);
  assert.ok(!one.asked.some((p) => p.startsWith('.light/')) && one.asked.includes('tex.dds'), one.asked.join(' '));
  assert.ok(!one.progress.some((m) => m.upgrade));
});
