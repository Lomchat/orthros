// The browser's storage of the game data (src/host/web/storage-persist.js, docs/slow-network.md "Persistent storage"):
// persistent storage asked once, its state in every runtime's telemetry env, kept by the server's perf-record check;
// and the home's lines written from a store's probe (download.js Downloads.probed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageState, askPersist, pageStorage, withStorage } from '../src/host/web/storage-persist.js';
import { sanitizePerfRecord } from '../src/host/perf-record.js';
import { PerfSession, eventEnv } from '../src/host/web/perf-page.js';

const MiB = 1 << 20;
/** a navigator whose storage persists once asked (`grant`), counting the calls */
function fakeNav({ grant = true, persisted = false, usage = 300 * MiB + 1, quota = 120000 * MiB + 7, persist = true } = {}) {
  const calls = { persist: 0 };
  const storage = {
    persisted: async () => persisted,
    estimate: async () => ({ usage, quota }),
    ...(persist ? { persist: async () => { calls.persist++; if (grant) persisted = true; return grant; } } : {}),
  };
  return { nav: { storage }, calls };
}

test('storage: its state in whole MiB, persist() asked only when not persisted, once a page; a worker (no persist) or no StorageManager', async () => {
  const a = fakeNav();
  assert.deepEqual(await storageState(a.nav), { persisted: false, usageMB: 300, quotaMB: 120000 });
  assert.deepEqual(await askPersist(a.nav), { persisted: true, usageMB: 300, quotaMB: 120000, asked: true });
  assert.equal((await askPersist(a.nav)).asked, false, 'persisted already: not asked again');
  const refused = fakeNav({ grant: false });
  assert.deepEqual(await askPersist(refused.nav), { persisted: false, usageMB: 300, quotaMB: 120000, asked: true });
  const worker = fakeNav({ persist: false });
  assert.deepEqual(await askPersist(worker.nav), { persisted: false, usageMB: 300, quotaMB: 120000, asked: false });
  assert.equal(await askPersist({}), null); assert.equal(await storageState(undefined), null);
  const throws = { storage: { persisted: async () => { throw new Error('x'); }, estimate: async () => { throw new Error('y'); }, persist: async () => { throw new Error('z'); } } };
  assert.deepEqual(await askPersist(throws), { persisted: null, usageMB: null, quotaMB: null, asked: false }, 'never throws');
  const p = fakeNav(), s = pageStorage(p.nav);
  assert.equal(s.state, null);
  await Promise.all([s.ask(), s.ask()]); await s.ask();
  assert.equal(p.calls.persist, 1, 'once a page');
  assert.deepEqual(s.state, { persisted: true, usageMB: 300, quotaMB: 120000, asked: true });
  await s.read(); assert.equal(s.state.asked, true, 'read again: asked kept');
});

test('storage in the telemetry: the env builders of every runtime, the perf record\'s check keeps it (bounded), PerfSession reads it', async () => {
  const st = { persisted: true, usageMB: 300, quotaMB: 120000, asked: true };
  assert.deepEqual(withStorage({ cores: 8 }, st), { cores: 8, storage: st });
  assert.deepEqual(withStorage({ cores: 8 }, null), { cores: 8, storage: null });
  assert.deepEqual(eventEnv(st).storage, st); assert.ok('ua' in eventEnv() && 'screen' in eventEnv());
  const rec = { event: 'perf', v: 1, session: 'sess1234', runtime: 'goldsrc', seq: 0, mins: [], tot: {}, env: { cores: 8, storage: { ...st, extra: 'x' } } };
  const v = sanitizePerfRecord(rec);
  if (v.ok) {
    assert.deepEqual(v.rec.env.storage, st, 'kept, unknown fields dropped');
    assert.deepEqual(sanitizePerfRecord({ ...rec, env: { storage: { persisted: 'yes', usageMB: -1, quotaMB: null } } }).rec.env.storage, { quotaMB: null });
  } else assert.fail(v.error);
  // (a PerfSession: its env carries the page's storage)
  const sent = [], win = { document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} };
  const storage = pageStorage(fakeNav().nav); await storage.ask();
  const s = new PerfSession({ runtime: 'goldsrc', game: 'hl', session: 'sess5678', win, now: () => 1000, probe: false, send: (r) => sent.push(r), env: () => ({ gpu: 'x' }), storage, recordMs: 1 });
  s.send({}); s.end();
  assert.deepEqual(sent[0].env.storage, st);
});

test('the home\'s lines from a probe: the launch and the whole download kept as progress, a store gone clears them, a download of this visit untouched', async () => {
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  try {
    const { Downloads, launchStatus, downloadStatus } = await import('../src/host/web/download.js');
    const d = new Downloads(), seen = []; d.onChange((n) => seen.push(n));
    const launch = { bytes: 100 * MiB, lightBytes: 40 * MiB, wire: 50 * MiB, lightWire: 20 * MiB, engine: 8 * MiB, engineFiles: ['/engines/r/a.wasm'] };
    assert.equal(launchStatus(launch, { st: d.get('g', 'launch', 'en'), bw: 85000 }).state, 'none', 'before: "Playable after"');
    d.probed({ name: 'g', lang: 'en', launch: { bytes: 48 * MiB, total: 48 * MiB, engine: 8 * MiB, engineFiles: launch.engineFiles, done: true }, whole: { bytes: 60 * MiB, total: 400 * MiB, done: false } });
    assert.deepEqual(seen, ['g']);
    const ln = launchStatus(launch, { st: d.get('g', 'launch', 'en'), bw: 85000 });
    assert.equal(ln.state, 'done'); assert.match(ln.text, /^Ready/);
    const wh = downloadStatus(d.get('g'), 400 * MiB);
    assert.equal(wh.state, 'paused'); assert.equal(wh.pct, 15); assert.match(wh.text, /^15% downloaded/);
    assert.ok(kept.has('orthros.launch.g.en') && kept.has('orthros.download.g'), 'kept for the next visit');
    // (a store found holding less: the line says what is left)
    d.probed({ name: 'g', lang: 'en', launch: { bytes: 18 * MiB, total: 48 * MiB, engine: 8 * MiB, engineFiles: launch.engineFiles, done: false }, whole: { bytes: 0, total: 400 * MiB, done: false } });
    assert.match(launchStatus(launch, { st: d.get('g', 'launch', 'en'), bw: 85000 }).text, /^Playable after 30/);
    assert.equal(downloadStatus(d.get('g'), 400 * MiB).state, 'none', 'no whole block here: no download progress');
    // (evicted or cleared: back to the full size)
    d.probed({ name: 'g', lang: 'en', missing: true });
    assert.equal(d.get('g', 'launch', 'en'), null); assert.equal(kept.has('orthros.launch.g.en'), false);
    // (a download of this visit running: its own count stays)
    d.live.set('orthros.download.h', { bytes: 5, total: 10, running: true });
    d.probed({ name: 'h', lang: null, launch: null, whole: { bytes: 1, total: 10, done: false } });
    assert.equal(d.get('h').bytes, 5);
  } finally { delete globalThis.localStorage; }
});
