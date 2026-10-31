// HTTP game file backend on a thin link (docs/slow-network.md): the game's reads fetch what they need (pieces, plus a
// little measured past a stream), the pieces are kept in the persistent store (a second launch reads them locally) and
// become whole blocks once all are here, no speculative whole blocks go in the background, the learned pieces come in
// the learned order, and the offline copy follows the learned order first and resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { NetLink } from '../src/vfs/net-link.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';

const MiB = 1 << 20;
const P = BLOCK / CHUNK;
const SIZE = 6 * MiB + 4321;
const byteAt = (i) => (i * 11 + (i >> 10)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
const tree = () => ({ dirs: {}, files: { 'f.big': { size: SIZE, mtime: 3 }, 'g.big': { size: 2 * MiB, mtime: 3 } } });
const thin = () => new NetLink({ bw: 85000, fixed: true });

const syncReqs = [];
globalThis.XMLHttpRequest = class {
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  getResponseHeader() { return null; }
  send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); syncReqs.push([+a, +b + 1]); this.status = 206; this.response = bytes(+a, +b + 1).buffer; }
};
/** fetch stand-in answering at once (a microtask later) */
function withFetch(body) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '') ?? /[?&]r=(\d+)-(\d+)/.exec(url);
    const a = +m[1], e = init.headers?.Range ? +m[2] + 1 : +m[2];
    calls.push({ url, start: a, end: e });
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(a, e).buffer };
  };
  return Promise.resolve(body(calls)).finally(() => { globalThis.fetch = real; });
}
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1)); };

test('thin link: a random read fetches its pieces only, keeps them in the store; a second launch reads them locally', () => withFetch(async (calls) => {
  const store = new MemBlockStore();
  const b = new HttpBackend('/game/s/', tree(), { store, net: thin() });
  const f = b.open('f.big'), n0 = syncReqs.length;
  assert.deepEqual(f.read(2 * MiB + 1000, 300), bytes(2 * MiB + 1000, 2 * MiB + 1300));
  assert.deepEqual(syncReqs.slice(n0), [[2 * MiB, 2 * MiB + CHUNK]], 'one piece');
  await settle();
  assert.equal(calls.length, 0, 'no whole block in the background (16 times the bytes on a thin link)');
  assert.equal(b.want.size, 0);
  assert.ok(store.map.has(`f.big#${SIZE}#3#c${(2 * MiB) / CHUNK}`), 'the piece is kept');
  // a later session (same store): no request
  const b2 = new HttpBackend('/game/s/', tree(), { store, net: thin() }), n1 = syncReqs.length;
  assert.deepEqual(b2.open('f.big').read(2 * MiB + 1000, 300), bytes(2 * MiB + 1000, 2 * MiB + 1300));
  assert.equal(syncReqs.length, n1, 'read from the stored piece');
  // all of a block's pieces here: the block itself is stored, its pieces dropped
  const g = b2.open('g.big');
  for (let c = 0; c < BLOCK / CHUNK; c++) g.read(c * CHUNK + 5, 10);
  assert.ok(store.map.has(`g.big#${2 * MiB}#3#0`), 'block 0 assembled and stored');
  assert.ok(![...store.map.keys()].some((k) => k.startsWith(`g.big#${2 * MiB}#3#c`) && Number(k.split('#c')[1]) < 16), 'its pieces dropped');
  assert.deepEqual(g.read(BLOCK - 100, 200), bytes(BLOCK - 100, BLOCK + 100));
}));

test('thin link: a file read in sequence is fetched a little past each read, never 4 MiB at once; the rest comes ahead in small requests, whole blocks once it is read whole', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/q/', tree(), { net: thin() });
  const f = b.open('f.big'), n0 = syncReqs.length;
  for (let pos = 0; pos < 2 * MiB; pos += 32 << 10) { assert.deepEqual(f.read(pos, 32 << 10), bytes(pos, pos + (32 << 10))); await settle(2); }
  const sync = syncReqs.slice(n0);
  assert.ok(sync.length > 0);
  assert.ok(sync.every(([a, z]) => z - a <= 2 * CHUNK), `sync requests small (${sync.map(([a, z]) => (z - a) / 1024)} KiB)`);
  assert.ok(calls.length > 0, 'pieces fetched ahead of the reader');
  // (its first MiB: requests of the link's size; past STREAM_BYTES — the file read whole —: whole blocks, the server's
  // units, two at most past the reader)
  const isBlock = (c) => c.start % BLOCK === 0 && c.end === Math.min(SIZE, c.start + BLOCK);
  assert.ok(calls.every((c) => c.end - c.start <= b.net.backgroundBytes() || isBlock(c)), `background requests of the link's size or whole blocks: ${calls.map((c) => `${c.start >> 10}+${(c.end - c.start) >> 10}`)} KiB`);
  assert.ok(calls.filter((c) => c.start < MiB).every((c) => c.end - c.start <= b.net.backgroundBytes()), 'not read whole yet: pieces');
  assert.ok(calls.some(isBlock), 'read whole: whole blocks');
  assert.ok(b.stats.wholeAheads > 0);
  assert.ok(calls.every((c) => c.start < 5 * MiB), 'not far past the reader: its block and two past it at most');
}));

test('thin link: a file read whole keeps two whole blocks on their way past its reader (one during a load), its own block by pieces; a block with a piece here by its pieces; a media file never', () => withFetch(async (calls) => {
  const tr = { dirs: { Music: { dirs: {}, files: { 'track.mp3': { size: 6 * MiB, mtime: 3, media: true } } } }, files: tree().files };
  const b = new HttpBackend('/game/wa/', tr, { net: thin() });
  b.net.mayStart = () => true; // (the turns at once: the cut of the requests is what is checked)
  const mid = MiB + 5 * CHUNK + 100;
  // (the reader stays at `mid` while its read-ahead's answers come: the rest of its block first, three requests at most
  // on their way, then the two blocks past it)
  for (let i = 0; i < 12; i++) { b.readAheadParts('f.big', SIZE, 3, mid, 0, 40, mid); await settle(); }
  const got = calls.map((c) => [c.start, c.end]);
  assert.ok(got.filter(([a]) => a < 2 * MiB).every(([a, e]) => e - a <= b.net.backgroundBytes() && e <= 2 * MiB), `the reader's block by pieces: ${JSON.stringify(got)}`);
  assert.equal(got.filter(([a]) => a < 2 * MiB).length, P - 5, 'all of its rest');
  assert.deepEqual(got.filter(([a]) => a >= 2 * MiB), [[2 * MiB, 3 * MiB], [3 * MiB, 4 * MiB]], 'then two whole blocks, nothing past them');
  // (at a block's start: that block and the next whole; a block with a piece here: its missing pieces)
  calls.length = 0;
  const c = new HttpBackend('/game/wb/', tr, { net: thin() }); c.net.mayStart = () => true;
  c.addPieces('f.big', 3 * P + 4, 3 * P + 4, bytes(3 * MiB + 4 * CHUNK, 3 * MiB + 5 * CHUNK), { size: SIZE, mtime: 3 });
  c.readAheadParts('f.big', SIZE, 3, 2 * MiB, 0, 40, 2 * MiB); await settle();
  const got2 = calls.map((x) => [x.start, x.end]);
  assert.deepEqual(got2[0], [2 * MiB, 3 * MiB], JSON.stringify(got2));
  assert.ok(got2.slice(1).every(([a, e]) => a >= 3 * MiB && e - a <= c.net.backgroundBytes() && !(a <= 3 * MiB + 4 * CHUNK && e > 3 * MiB + 4 * CHUNK)), `block 3 by its missing pieces: ${JSON.stringify(got2)}`);
  // (during a load: one whole block past the reader)
  calls.length = 0;
  const d = new HttpBackend('/game/wc/', tr, { net: thin() });
  const w = d.net.wait(); assert.ok(d.net.silenced()); d.net.mayStart = () => true;
  d.readAheadParts('f.big', SIZE, 3, 2 * MiB, 0, 40, 2 * MiB); await settle();
  assert.deepEqual(calls.map((x) => [x.start, x.end]), [[2 * MiB, 3 * MiB], [3 * MiB, 4 * MiB]], 'during a load: the reader\'s next block (it ends on a block boundary) and one past it');
  d.net.waitEnd(w);
  // (a reader of few reads, or a short run: as before, no whole block; a media stream: its own seconds, no block)
  for (const [p, size, reads, run] of [['f.big', SIZE, 4, 2 * MiB], ['f.big', SIZE, 40, 512 << 10], ['Music/track.mp3', 6 * MiB, 400, 3 * MiB]]) {
    calls.length = 0;
    const e = new HttpBackend('/game/wd/', tr, { net: thin() }); e.net.mayStart = () => true;
    e.readAheadParts(p, size, 3, 2 * MiB, 20000, reads, run); await settle();
    assert.ok(calls.every((x) => x.end - x.start <= e.net.backgroundBytes()), `${p} ${reads} ${run}: ${JSON.stringify(calls.map((x) => [x.start, x.end]))}`);
    assert.equal(e.stats.wholeAheads ?? 0, 0);
  }
}));

test('thin link: whole blocks only for a file read from its start or a long run; never again a block on its way whole; one waiting for its turn at a time, dropped once its reader moved away', () => withFetch(async (calls) => {
  const mk = (name) => { const b = new HttpBackend(`/game/${name}/`, tree(), { net: thin() }); b.net.mayStart = () => true; return b; };
  // (a 2 MiB run that did not start at the file's start — an archive's adjacent entries —: pieces; 4 MiB and more: blocks)
  const a = mk('wr');
  a.readAheadParts('f.big', SIZE, 3, 3 * MiB, 0, 40, 2 * MiB); await settle();
  assert.ok(calls.length > 0 && calls.every((x) => x.end - x.start <= a.net.backgroundBytes()), JSON.stringify(calls.map((x) => [x.start, x.end])));
  assert.equal(a.stats.wholeAheads ?? 0, 0);
  calls.length = 0;
  const a2 = mk('wr2');
  for (let i = 0; i < 12; i++) { a2.readAheadParts('f.big', SIZE, 3, 4 * MiB + 100, 0, 40, 4 * MiB); await settle(); }
  assert.ok(a2.stats.wholeAheads > 0 && calls.some((x) => x.start === 5 * MiB && x.end === 6 * MiB), JSON.stringify(calls.map((x) => [x.start, x.end])));
  // (blocks 2 and 3 on their way whole — the read-ahead of a link that was fast a moment ago —: not asked again)
  calls.length = 0;
  const c = mk('wf'), never = new Promise(() => {});
  c.blockFlights.set('f.big#2', never); c.blockFlights.set('f.big#3', never);
  c.readAheadParts('f.big', SIZE, 3, 2 * MiB, 0, 40, 2 * MiB); await settle();
  assert.deepEqual(calls.map((x) => [x.start, x.end]), [[4 * MiB, 5 * MiB]], 'the block past them only');
  // (the link busy: the first whole block waits for its turn, no second one behind it; the reader reads elsewhere: dropped)
  calls.length = 0;
  for (const moved of [true, false]) {
    const d = new HttpBackend(`/game/wq${moved}/`, tree(), { net: thin() });
    d.net.mayStart = () => false;
    d.open('f.big').read(MiB, MiB); // (the reader: its run ends at 2 MiB)
    await settle(); calls.length = 0;
    d.readAheadParts('f.big', SIZE, 3, 2 * MiB, 0, 40, 2 * MiB);
    assert.equal(d.net.waiters.length, 1, 'one whole block waiting');
    if (moved) d.open('g.big').read(0, 100);
    await settle(); calls.length = 0;
    d.net.mayStart = () => true; d.net.kick(); await settle();
    const got = calls.map((x) => [x.start, x.end]);
    if (moved) assert.ok(!got.some(([s0, e0]) => s0 === 2 * MiB && e0 === 3 * MiB), `dropped: ${JSON.stringify(got)}`);
    else assert.deepEqual(got[0], [2 * MiB, 3 * MiB], 'fetched once its turn came');
  }
}));

test('thin link: a read-ahead of pieces waiting for its turn is dropped once its reader moved away, unless a read waits for it', () => withFetch(async (calls) => {
  // (a 1 MiB run read from the middle of the file — an archive's entries —: pieces ahead, not a whole block)
  for (const how of ['moved', 'stayed', 'parked']) {
    const d = new HttpBackend(`/game/pq${how}/`, tree(), { net: thin() });
    d.net.mayStart = () => false;
    d.open('f.big').read(2 * MiB, MiB);
    await settle(); calls.length = 0;
    d.readAheadParts('f.big', SIZE, 3, 3 * MiB, 0, 40, MiB);
    assert.ok(d.net.waiters.length >= 1 && (d.stats.wholeAheads ?? 0) === 0, 'pieces waiting for their turn');
    const first = d.net.waiters[0];
    if (how === 'parked') first.urgent = true; // (a read of its bytes waits for it — HttpBackend's parked read)
    if (how !== 'stayed') d.open('g.big').read(0, 100);
    await settle(); calls.length = 0;
    d.net.mayStart = () => true; d.net.kick(); await settle();
    const got = calls.filter((x) => x.url.includes('f.big')).map((x) => [x.start, x.end]);
    if (how === 'moved') { assert.equal(got.length, 0, `dropped: ${JSON.stringify(got)}`); assert.ok(d.stats.aheadsDropped >= 1); }
    else assert.ok(got.some(([s0]) => s0 === 3 * MiB), `fetched once its turn came (${how}): ${JSON.stringify(got)}`);
  }
}));

test('thin link: the learned prefetch fetches the learned pieces in order from the game\'s position, nothing else', () => withFetch(async (calls) => {
  const store = new MemBlockStore();
  const b = new HttpBackend('/game/p/', tree(), { store, encoded: true, net: thin() });
  b.gameBusy = () => false;
  const progress = {};
  // block 4 of f.big: pieces 1 and 2; block 0 of g.big: piece 0; block 1 of f.big: mask unknown (0)
  await b.prefetch([['f.big', 4, 0b110, 0], ['g.big', 0, 0b1, 100], ['f.big', 1, 0, 200]], progress);
  // (one 64 KiB piece per request: what 85 KB/s carries in BG_SECONDS, rounded up to a piece)
  assert.deepEqual(calls.map((c) => [c.url.split('?')[0].split('/').pop(), c.start, c.end]), [['f.big', 4 * MiB + CHUNK, 4 * MiB + 2 * CHUNK], ['f.big', 4 * MiB + 2 * CHUNK, 4 * MiB + 3 * CHUNK], ['g.big', 0, CHUNK]]);
  assert.ok(calls.every((c) => c.url.includes('&p=1')), 'asked as background downloads');
  assert.ok(progress.done);
  assert.ok(store.map.has(`f.big#${SIZE}#3#c${4 * 16 + 1}`) && store.map.has(`g.big#${2 * MiB}#3#c0`));
  // the step estimate: what the learned entries past the position still need
  const b2 = new HttpBackend('/game/p/', tree(), { store: new MemBlockStore(), encoded: true, net: thin() });
  b2.learned = { entries: [{ path: 'f.big', size: SIZE, mtime: 3, index: 4, mask: 0b110, t: 0 }, { path: 'g.big', size: 2 * MiB, mtime: 3, index: 0, mask: 1, t: 100 }, { path: 'f.big', size: SIZE, mtime: 3, index: 1, mask: 0, t: 60000 }], pos: -1, rankOf: new Map() };
  assert.equal(b2.stepEstimate().bytes, 3 * CHUNK, 'up to the pause: two pieces and one piece');
}));

test('offline copy: the learned blocks first, then the rest; a second start resumes (stored blocks skipped)', () => withFetch(async (calls) => {
  const store = new MemBlockStore();
  const b = new HttpBackend('/game/o/', tree(), { store, encoded: true, net: thin() });
  let n = 0;
  const p1 = {};
  await b.downloadAll(p1, () => ++n > 3, { alone: true, order: [['g.big', 1], ['f.big', 5]] });
  assert.deepEqual(calls.slice(0, 2).map((c) => [c.url.split('?')[0].split('/').pop(), c.start]), [['g.big', MiB], ['f.big', 5 * MiB]], 'the learned blocks first');
  assert.ok(calls.every((c) => c.url.includes('&p=1')), 'not learned as the game\'s own reads');
  assert.ok(!p1.done);
  const p2 = {};
  await b.downloadAll(p2, () => false, { alone: true, order: [['g.big', 1], ['f.big', 5]] });
  assert.ok(p2.done); assert.ok(p2.stored > 0, 'resumed: bytes already here');
  assert.equal(p2.bytes, p2.total);
  for (let i = 0; i * BLOCK < SIZE; i++) assert.ok(store.map.has(`f.big#${SIZE}#3#${i}`));
  const asked = new Map(); for (const c of calls) { const k = `${c.url.split('?')[0]}#${c.start}`; asked.set(k, (asked.get(k) ?? 0) + 1); }
  assert.ok([...asked.values()].every((v) => v === 1), 'no range asked twice');
}));

test('thin link: a parked read of pieces whose background request waits for its turn makes it go at once (no wait behind the game\'s other reads)', () => withFetch(async (calls) => {
  const net = thin(), b = new HttpBackend('/game/u/', tree(), { net });
  const f = b.open('f.big');
  const busy = net.begin('demand', CHUNK); // (another thread's read on its way: background turns wait on a thin link)
  const part = b.fetchPartBg('f.big', SIZE, 3, 32, 33, [5, 300]);
  await settle();
  assert.equal(calls.length, 0, 'waits for its turn');
  const p = f.prepare(32 * CHUNK + 10, 100);
  assert.ok(p, 'the read parks');
  await settle();
  assert.equal(calls.length, 1, 'promoted: started although a game read is in flight');
  assert.equal(await part, true);
  await p;
  const n0 = syncReqs.length;
  assert.deepEqual(f.read(32 * CHUNK + 10, 100), bytes(32 * CHUNK + 10, 32 * CHUNK + 110));
  assert.equal(syncReqs.length, n0, 'the read finds the pieces here');
  net.end(busy, CHUNK);
}));

test('thin link: a synchronous read aborts a background request for the same bytes; the read is exact and the aborted pieces are not kept half', async () => {
  const real = globalThis.fetch, pending = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? ''), a = +m[1], e = +m[2] + 1;
    const p = { a, e, resolve: () => resolve({ status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(a, e).buffer }) };
    init.signal?.addEventListener('abort', () => { p.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    pending.push(p);
  });
  try {
    const store = new MemBlockStore(), net = thin(), b = new HttpBackend('/game/v/', tree(), { store, net });
    const f = b.open('f.big');
    const part = b.fetchPartBg('f.big', SIZE, 3, 48, 48, [5, 0]);
    await settle();
    assert.equal(pending.length, 1);
    assert.deepEqual(f.read(48 * CHUNK + 7, 1000), bytes(48 * CHUNK + 7, 48 * CHUNK + 1007));
    assert.ok(pending[0].aborted, 'the background request for the same bytes went away');
    assert.equal(await part, false);
    assert.ok(store.map.has(`f.big#${SIZE}#3#c48`), 'the piece kept from the read');
    assert.deepEqual(store.get(`f.big#${SIZE}#3#c48`), bytes(48 * CHUNK, 49 * CHUNK));
    assert.equal(net.inflight.bg, 0); assert.equal(net.bgFlights.size, 0);
  } finally { globalThis.fetch = real; }
});

test('download first on a thin link: one block per request (a 4 MiB request would take 50 s), four on a fast one', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/w/', tree(), { store: new MemBlockStore(), encoded: true, net: thin() });
  const p = {};
  await b.downloadAll(p, () => false, { alone: true });
  assert.ok(p.done);
  assert.ok(calls.every((c) => c.end - c.start <= BLOCK), `request sizes ${calls.map((c) => (c.end - c.start) >> 10)} KiB`);
  calls.length = 0;
  // (unitRequests off: the 4 MiB download as planned, not cut at its blocks for the server's precompressed units)
  const f = new HttpBackend('/game/w2/', tree(), { store: new MemBlockStore(), encoded: true, unitRequests: false, net: new NetLink({ bw: 20 << 20, fixed: true }) });
  await f.downloadAll({}, () => false, { alone: true });
  assert.ok(calls.some((c) => c.end - c.start === 4 * BLOCK));
}));

test('a link between thin and fast: a learned block wanted whole goes as the block (the server\'s unit), not as pieces; a slower one by pieces', () => withFetch(async (calls) => {
  // 1 MB/s: backgroundBytes() is 320 KiB, a block crosses the link in about 1 s (within WHOLE_BLOCK_SECONDS)
  const b = new HttpBackend('/game/u/', tree(), { store: new MemBlockStore(), encoded: true, net: new NetLink({ bw: 1e6, fixed: true }) });
  b.gameBusy = () => false;
  assert.ok(b.net.backgroundBytes() < BLOCK && b.wholeBlockFits());
  // block 2 of f.big: every piece learned; block 4: pieces 1 and 2 (no whole block for those)
  await b.prefetch([['f.big', 2, 0xffff, 0], ['f.big', 4, 0b110, 10]], {}, () => false, { learnedOnly: true });
  const got = calls.map((c) => [c.start, c.end]);
  assert.deepEqual(got[0], [2 * MiB, 3 * MiB], `the whole block in one request: ${JSON.stringify(got)}`);
  assert.deepEqual(got.slice(1), [[4 * MiB + CHUNK, 4 * MiB + 2 * CHUNK], [4 * MiB + 2 * CHUNK, 4 * MiB + 3 * CHUNK]], 'the learned pieces of the other one');
  assert.ok(b.peekBlockHere('f.big', SIZE, 3, 2), 'the block kept whole');
  // 300 KB/s: a block would take ~3.5 s — while the game runs, by pieces, backgroundBytes() at a time
  calls.length = 0;
  const s = new HttpBackend('/game/u2/', tree(), { store: new MemBlockStore(), encoded: true, net: new NetLink({ bw: 400e3, fixed: true }) });
  s.gameBusy = () => false;
  assert.equal(s.wholeBlockFits(), false);
  await s.prefetch([['f.big', 2, 0xffff, 0]], {}, () => false);
  assert.ok(calls.length > 1 && calls.every((c) => c.end - c.start <= s.net.backgroundBytes()), `by pieces: ${calls.map((c) => (c.end - c.start) >> 10)} KiB`);
  // before the game starts (learnedOnly: a startup set, Prepare), nothing of the game's on the link: the block whole on
  // a thin link too (its unit: ~16 % fewer bytes than pieces brotli makes on the fly, 1 request instead of 16); a light
  // copy's pieces as they are made (by pieces)
  for (const bw of [400e3, 85e3]) {
    calls.length = 0;
    const t = new HttpBackend('/game/u3/', tree(), { store: new MemBlockStore(), encoded: true, net: new NetLink({ bw, fixed: true }) });
    t.gameBusy = () => false;
    await t.prefetch([['f.big', 2, 0xffff, 0], ['f.big', 4, 0b110, 10]], {}, () => false, { learnedOnly: true });
    const got2 = calls.map((c) => [c.start, c.end]);
    assert.deepEqual(got2[0], [2 * MiB, 3 * MiB], `${bw}: the whole block in one request: ${JSON.stringify(got2)}`);
    assert.ok(got2.slice(1).every(([a, e]) => a >= 4 * MiB && e <= 4 * MiB + 3 * CHUNK), `${bw}: the other one's learned pieces: ${JSON.stringify(got2)}`);
    assert.ok(t.peekBlockHere('f.big', SIZE, 3, 2), 'the block kept whole');
  }
}));

test('a fast link before the game starts (learnedOnly): the learned pieces only, several requests at once, none again of those here; while the game runs, whole blocks one at a time', async () => {
  const real = globalThis.fetch;
  let now = 0, most = 0, asked = [];
  globalThis.fetch = async (url) => {
    const [, a, e] = /[?&]r=(\d+)-(\d+)/.exec(url); asked.push([+a, +e]);
    now++; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 5)); now--;
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(+a, +e).buffer };
  };
  try {
    const files = {}; for (let i = 0; i < 12; i++) files[`s${i}.txt`] = { size: 5000 + i, mtime: 3 };
    files['f.big'] = { size: SIZE, mtime: 3 };
    const list = Object.keys(files).filter((p) => p !== 'f.big').map((p, i) => [p, 0, 1, i]);
    const run = async (opts) => {
      const store = new MemBlockStore(), b = new HttpBackend('/game/q/', { dirs: {}, files }, { store, encoded: true, net: new NetLink({ bw: 20e6, fixed: true }) });
      b.gameBusy = () => false; most = 0; asked = [];
      // (block 1 of f.big: its learned pieces 0 and 3 here already — fetched by pieces before the link was measured)
      store.put(b.pieceKey('f.big', SIZE, 3, 16), bytes(MiB, MiB + CHUNK)); store.put(b.pieceKey('f.big', SIZE, 3, 19), bytes(MiB + 3 * CHUNK, MiB + 4 * CHUNK));
      const p = {}; await b.prefetch([...list, ['f.big', 1, 0b1001, 20], ['f.big', 2, 0b0110, 30]], p, () => false, opts);
      assert.ok(p.done);
      for (const [path, f] of Object.entries(files)) if (path !== 'f.big') assert.ok(b.peekBlockHere(path, f.size, 3, 0) || b.pieceHere(path, f.size, 3, 0), `${path} stored`);
      // (kept in the store, not only in memory: a fast link keeps whole blocks only otherwise — the pass fetched the same
      // pieces again and again once the memory's pieces were trimmed: Morrowind Vanilla+'s launch set, 56 000 requests)
      if (opts.learnedOnly) for (const c of [33, 34]) assert.ok(store.map.has(b.pieceKey('f.big', SIZE, 3, c)), `piece ${c} in the store`);
      return { most, asked: [...asked] };
    };
    const before = await run({ learnedOnly: true });
    assert.ok(before.most >= 4 && before.most <= 8, `requests at once: ${before.most}`);
    assert.ok(!before.asked.some(([a, e]) => a < 2 * MiB && e > MiB), `nothing of the block whose learned pieces are here: ${JSON.stringify(before.asked)}`);
    assert.deepEqual(before.asked.filter(([a]) => a >= 2 * MiB), [[2 * MiB + CHUNK, 2 * MiB + 2 * CHUNK], [2 * MiB + 2 * CHUNK, 2 * MiB + 3 * CHUNK]], 'the other block\'s learned pieces, not the block (its units)');
    const playing = await run({});
    assert.ok(playing.most <= 2, `one request at a time while the game runs (two blocks of one cut at their units): ${playing.most}`);
    assert.ok(playing.asked.some(([a]) => a === MiB), 'the whole block, the game running (the rest of it comes too)');
  } finally { globalThis.fetch = real; }
});

test('a block completed by the pieces of one request is stored once, as the block (its pieces not put and dropped: the store appends)', () => withFetch(async () => {
  for (const net of [new NetLink({ bw: 20e6, fixed: true }), thin()]) {
    const store = new MemBlockStore(), puts = [], put = store.put.bind(store);
    store.put = (k, v) => { puts.push(k); return put(k, v); };
    const b = new HttpBackend('/game/once/', tree(), { store, encoded: true, net });
    b.gameBusy = () => false;
    // (block 2: every piece learned — whole; block 4: two pieces — kept as pieces)
    await b.prefetch([['f.big', 2, 0xffff, 0], ['f.big', 4, 0b110, 10]], {}, () => false, { learnedOnly: true });
    assert.ok(b.peekBlockHere('f.big', SIZE, 3, 2), 'block 2 kept whole');
    const own = (lo, hi) => puts.filter((k) => { const c = /#c(\d+)$/.exec(k); return c && +c[1] >= lo && +c[1] < hi; });
    assert.deepEqual(own(32, 48), [], `no piece of block 2 put: ${puts}`);
    assert.equal(puts.filter((k) => k.endsWith('#2')).length, 1, 'the block once');
    assert.deepEqual(own(64, 80).sort(), [b.pieceKey('f.big', SIZE, 3, 65), b.pieceKey('f.big', SIZE, 3, 66)].sort(), 'block 4\'s pieces kept');
  }
}));

test('learnedOnly with a full store: an entry the store did not keep is asked once (not again each time the memory evicts it)', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const [, a, e] = /[?&]r=(\d+)-(\d+)/.exec(url); asked.push([+a, +e]);
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(+a, +e).buffer };
  };
  try {
    const files = { 'f.big': { size: SIZE, mtime: 3 } };
    // (a store that keeps nothing, a memory cache of one block: every block evicted by the next)
    const b = new HttpBackend('/game/full/', { dirs: {}, files }, { store: new MemBlockStore(0), encoded: true, net: new NetLink({ bw: 20e6, fixed: true }) });
    b.gameBusy = () => false;
    b.maxBlocks = 1;
    const list = [0, 1, 2, 3].map((i) => ['f.big', i, 0xffff, i]);
    // (stopped after 40 requests: the pass would otherwise go on for good)
    const p = {}; await b.prefetch(list, p, () => asked.length > 40, { learnedOnly: true });
    assert.ok(p.done, `the pass ended by itself after ${asked.length} requests`);
    const per = new Map(); for (const [a] of asked) { const k = Math.floor(a / MiB); per.set(k, (per.get(k) ?? 0) + 1); }
    assert.deepEqual([...per.values()], [1, 1, 1, 1], `each block asked once: ${JSON.stringify(asked)}`);
  } finally { globalThis.fetch = real; }
});

/** fetch stand-in answering after `ms`, each call with its time (performance.now) */
function withSlowFetch(ms, body) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const m = /[?&]r=(\d+)-(\d+)/.exec(url), a = +m[1], e = +m[2];
    calls.push({ url, start: a, end: e, at: performance.now(), bg: url.includes('p=1') });
    await new Promise((r) => setTimeout(r, ms));
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(a, e).buffer };
  };
  return Promise.resolve(body(calls)).finally(() => { globalThis.fetch = real; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('between thin and fast: during a run of parked reads (a load) the block fill and the upgrades wait for its end, then go', () => withSlowFetch(30, async (calls) => {
  const tr = { dirs: { Splash: { dirs: {}, files: { 'pic.tga': { size: 3 * MiB, mtime: 3, light: 197000 } } } }, files: { 'level.dat': { size: 48 * MiB, mtime: 3 }, 'tex.dds': { size: 300000, mtime: 3, light: 40000 } } };
  const b = new HttpBackend('/game/l/', tr, { encoded: true, net: new NetLink({ bw: 1.5e6, fixed: true }) });
  const f = b.open('level.dat');
  // (a picture's light copy read on a link that is not fast: its file is never fetched after it)
  b.upgrade('Splash/pic.tga', { soon: true });
  assert.equal(b.upgrades.size, 0, 'a picture is not upgraded'); assert.equal(b.stats.pictureKept, 1);
  // (the load: reads far apart, each parked — the game waits —, the engine's work between them; a texture read light
  // early in it, its file wanted soon)
  let runEnd = 0, dense = 0;
  for (let i = 0; i < 10; i++) {
    if (i === 2) dense = performance.now(); // (from its third wait on, a load: the first two may be play's)
    // (4 blocks apart: past the blocks near a missed one, which the fill may bring before the load is dense)
    const at = i * 4 * MiB + 12345, p = f.prepare(at, 4096, true);
    assert.ok(p, `read ${i} needs the network`);
    await p; assert.deepEqual(f.read(at, 4096), bytes(at, at + 4096));
    if (i === 1) b.upgrade('tex.dds', { soon: true });
    runEnd = performance.now();
    if (i < 9) await sleep(200); // (> the fill's 150 ms: it used to go in each of these gaps)
  }
  assert.ok(b.want.size > 0, 'the blocks the load touched are wanted');
  const during = calls.filter((c) => c.bg && c.at >= dense && c.at < runEnd);
  assert.deepEqual(during.map((c) => c.url), [], 'nothing of the background during the load');
  b.near.clear(); // (the blocks near the missed ones: not what this test looks at — the fill goes on with the rest sooner)
  for (let k = 0; k < 400 && !b.net.bgBy.upgrade; k++) await sleep(25);
  const after = calls.filter((c) => c.bg);
  assert.ok(after.some((c) => c.at >= runEnd + 400) && after.every((c) => c.at < dense || c.at >= runEnd + 400), 'after the gap that ends the load');
  assert.ok(after.some((c) => c.url.includes('tex.dds')), 'the upgrade too, once the game is quiet');
  assert.ok(!calls.some((c) => c.url.includes('pic.tga')));
  const by = b.net.snapshot().bgBy;
  assert.ok(by.want?.requests > 0 && by.upgrade?.requests > 0, JSON.stringify(by));
  // (on a fast link a picture is upgraded as any light copy)
  const fast = new HttpBackend('/game/l/', tr, { encoded: true, net: new NetLink({ bw: 200e6, fixed: true }) });
  fast.fillBackground = () => {}; fast.upgrade('Splash/pic.tga'); assert.equal(fast.upgrades.size, 3);
  for (const q of [b.want, b.near, b.later, b.upgrades]) q.clear(); // (the fill stops: the next test's fetch is its own)
  while (b.filling) await sleep(20);
}));

test('between thin and fast: a media stream gets a few seconds of its own rate ahead, not seconds of the link', () => withFetch(async (calls) => {
  const tr = { dirs: { Music: { dirs: {}, files: { 'track.mp3': { size: 6 * MiB, mtime: 3, media: true } } } }, files: { 'f.big': { size: SIZE, mtime: 3 } } };
  const b = new HttpBackend('/game/m/', tr, { net: new NetLink({ bw: 1.5e6, fixed: true }) });
  b.readAheadParts('Music/track.mp3', 6 * MiB, 3, 64 << 10, 20000); // (a 160 kbit/s track)
  await settle();
  const music = calls.reduce((n, c) => n + c.end - c.start, 0);
  assert.ok(music > 0 && music <= 256 << 10, `${music >> 10} KiB ahead of the track`);
  calls.length = 0;
  b.readAheadParts('f.big', SIZE, 3, 64 << 10, 20000);
  await settle();
  assert.ok(calls.reduce((n, c) => n + c.end - c.start, 0) > 256 << 10, 'a file loaded in sequence: the link\'s seconds');
}));

test('between thin and fast: a media stream\'s parked reads are no load (its own read-ahead is not silenced by them); a file\'s are', () => withFetch(async (calls) => {
  const tr = { dirs: { Video: { dirs: {}, files: { 'intro.bik': { size: 6 * MiB, mtime: 3, media: true } } } }, files: { 'f.big': { size: SIZE, mtime: 3 } } };
  const b = new HttpBackend('/game/m/', tr, { net: new NetLink({ bw: 1.5e6, fixed: true }) });
  const v = b.open('Video/intro.bik');
  for (let i = 0; i < 4; i++) { const p = v.prepare(i * 300000, 4096, true); assert.ok(p); await p; }
  assert.equal(b.net.totals.waits, 0); assert.equal(b.net.loading(), false);
  // (the movie's reader gets its seconds ahead now — not held for a load)
  calls.length = 0; b.readAheadParts('Video/intro.bik', 6 * MiB, 3, 1200000 + 4096, 600000); await settle();
  assert.ok(calls.length > 0, 'its read-ahead goes');
  const f = b.open('f.big'); const p = f.prepare(5 * MiB, 4096, true); assert.ok(p); await p;
  assert.equal(b.net.totals.waits, 1, 'a file\'s parked read is a wait');
}));

test('between thin and fast: during a load an archive\'s entry read in a few pieces gets one request ahead of it, a long sequential reader two', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/m/', tree(), { net: new NetLink({ bw: 1.5e6, fixed: true }) });
  const w = b.net.wait(); assert.ok(b.net.silenced());
  b.readAheadParts('f.big', SIZE, 3, 128 << 10, 0, 2); await settle();
  assert.equal(calls.length, 1, 'one request past the entry (the bytes past it: other entries the load may not read)');
  b.readAheadParts('g.big', 2 * MiB, 3, 128 << 10, 0, 16); await settle();
  assert.equal(calls.length, 3, 'a reader of many reads in sequence: two');
  b.net.waitEnd(w);
}));
