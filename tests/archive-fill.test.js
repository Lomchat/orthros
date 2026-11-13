// The archive fill (docs/slow-network.md "Archive fill on medium links"): the files a session waited on in several
// minutes are noted in the store; the next session on a medium link wants them whole from the start — never on a thin
// link, nor past the store's budget —, its blocks into the store only; its requests go on an idle link only and are
// given up the moment the game waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, ARCHIVE_BUDGET } from '../src/vfs/http-backend.js';
import { NetLink } from '../src/vfs/net-link.js';

const MiB = 1 << 20;
function clock() {
  let now = 0; const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { now += ms; },
  };
}
const memStore = (notes = {}) => { const map = new Map(); return { map, notes, failed: false, put: (k, v) => { if (!map.has(k)) map.set(k, v.slice()); }, get: (k) => map.get(k)?.slice() ?? null, flush() {}, noteChanged() {} }; };
const tree = { dirs: {}, files: { 'Arc.big': { size: 8 * MiB, mtime: 1 }, 'once.big': { size: 4 * MiB, mtime: 1 }, 'music.big': { size: 4 * MiB, mtime: 1, media: true } } };
function session(store, bw, measured = true) {
  const c = clock(), net = new NetLink({ ...c, bw }), b = new HttpBackend('/game/w/', tree, { store, net });
  net.measured = measured;
  b.fillBackground = () => {}; // (what is queued, not its download)
  return { b, c };
}
const queued = (b) => [...b.later.values()].filter((w) => w.arch).map((w) => `${w.path}#${w.index}`);

test('archive fill: wait-minutes noted in the store, the next session on a medium link wants those files whole (not thin, not past the budget)', () => {
  globalThis.ORTHROS_ARCHIVE_FILL = 1;
  try {
    const store = memStore();
    // session 1: Arc.big waited on in 3 distinct minutes (twice in one), once.big in one, the media file never counted
    const { b, c } = session(store, 1.25e6);
    for (const m of [0, 0.5, 1.2, 2.7]) { c.advance(m * 60000 - c.now()); b.noteWait('Arc.big'); b.noteWait('music.big'); }
    b.noteWait('once.big');
    assert.deepEqual(store.notes.archive.files, { 'Arc.big': 3, 'once.big': 1 });
    // session 2 on a medium link: Arc.big wanted whole (every block not stored), once.big and the media file not
    store.map.set('Arc.big#8388608#1#3', new Uint8Array(MiB));
    const s2 = session(store, 1.25e6).b;
    s2.archiveStart();
    assert.deepEqual(queued(s2), [0, 1, 2, 4, 5, 6, 7].map((i) => `Arc.big#${i}`));
    // its earlier notes decay as this session's waits are added
    s2.noteWait('once.big');
    assert.deepEqual(store.notes.archive.files, { 'Arc.big': 1.5, 'once.big': 1.5 });
    // a block the fill brings goes to the store only, counted against the budget
    s2.archiveInstall = true; s2.installBlock('Arc.big', 0, new Uint8Array(MiB), 'Arc.big#8388608#1#0'); s2.archiveInstall = false;
    assert.ok(store.map.has('Arc.big#8388608#1#0') && !s2.cache.has('Arc.big#0'));
    assert.equal(store.notes.archive.bytes, MiB);
    // never on a thin link (85 KB/s), a fast one, nor once the budget is spent, nor when turned off
    for (const [bw, why] of [[85e3, 'thin link'], [8e6, 'fast link']]) { const s = session(store, bw).b; s.archiveStart(); assert.deepEqual(queued(s), [], why); }
    { const s = session(store, 1.25e6, false).b; s.archiveStart(); assert.deepEqual(queued(s), [], 'a rate kept from an earlier page, not measured yet'); }
    store.notes.archive.bytes = ARCHIVE_BUDGET;
    { const s = session(store, 1.25e6).b; s.archiveStart(); assert.deepEqual(queued(s), [], 'budget spent'); }
    store.notes.archive.bytes = 0; globalThis.ORTHROS_ARCHIVE_FILL = 0;
    { const s = session(store, 1.25e6).b; s.archiveStart(); assert.deepEqual(queued(s), [], 'off'); }
  } finally { delete globalThis.ORTHROS_ARCHIVE_FILL; }
});

test('archive fill: its turn only on an idle link, its request given up when the game waits (not one a parked read waits for)', () => {
  const c = clock(), n = new NetLink({ ...c, bw: 1.25e6 });
  const d = n.begin('demand', 65536);
  assert.equal(n.tryTurn(750, { idle: true }), false, 'a game read in flight');
  c.advance(100); n.end(d, 65536); c.advance(500);
  assert.equal(n.tryTurn(750, { idle: true }), false, 'the link quiet for less than its quiet time');
  assert.equal(n.tryTurn(750, {}), true, 'another background download goes beside the game (medium link)');
  c.advance(600); n.reserved.length = 0;
  assert.equal(n.tryTurn(750, { idle: true }), true);
  let aborted = 0, kept = 0;
  const a = n.begin('bg', 262144, () => { aborted++; }, null, 'archive'); Object.assign(a, { idle: true, keep: true, w: { idle: true } });
  const u = n.begin('bg', 262144, () => { kept++; }, null, 'archive'); Object.assign(u, { idle: true, keep: true, w: { idle: true, urgent: true } });
  const t = n.wait();
  assert.equal(aborted, 1, 'given up at once'); assert.equal(kept, 0, 'a parked read waits for it: kept');
  assert.equal(n.tryTurn(750, { idle: true }), false, 'not while the game waits');
  n.waitEnd(t);
});
