// Warm jobs (src/server/warm-jobs.js): one job at a time, a publish before a learn, the players' languages first, a queue that keeps kinds apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Warmer, defaultLanguage, warmLanguages, learnArgs, learnScenario, learnScenarios, LearnedScenarios, LEARN_TRIES } from '../src/server/warm-jobs.js';
import { SnapshotQueue } from '../src/server/snapshot-store.js';

test('warmer queues one job at a time: publish first, learn once the snapshot is there, nothing when both are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));
  try {
    const jobs = new SnapshotQueue(path.join(dir, 'queue.json'));
    const snaps = new Set(), learned = new Set(), played = new Set(['b']);
    const w = new Warmer({
      versions: () => [{ name: 'a', man: { languages: ['fr', 'en'] } }, { name: 'b', man: { languages: ['De'] } }],
      fetchVersion: async (n) => ({ manifest: { name: n }, tree: { files: {} } }),
      sources: () => ({ hash: 'h' }),
      snapshotReady: (n) => snaps.has(n), hasLearned: (n) => learned.has(n), scenariosLearned: (n) => played.has(n), jobs,
    });
    const j1 = await w.tick();
    assert.deepEqual([j1.kind, j1.name, j1.lang], ['publish', 'a', 'en']);
    assert.match(j1.key, /^[0-9a-f]{32}$/);
    assert.equal(await w.tick(), null, 'the first one is not done: nothing more queued');
    snaps.add('a');
    const j2 = await w.tick();
    assert.deepEqual([j2.kind, j2.name], ['learn', 'a']);
    learned.add('a');
    assert.equal(await w.tick(), null, 'the lists are there, its learn scenarios not played yet: the job is not done');
    played.add('a');
    const j3 = await w.tick();
    assert.deepEqual([j3.kind, j3.name, j3.lang], ['publish', 'b', 'de']);
    snaps.add('b'); learned.add('b');
    assert.equal(await w.tick(), null);
    assert.equal(jobs.jobs.length, 3);
    assert.equal(jobs.job(jobs.jobs[1].token, 'a', 'en', j2.key), null, 'a learn job is no publishing token');
    assert.ok(jobs.job(jobs.jobs[0].token, 'a', 'en', j1.key));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('default language as the page picks it; a learn scenario only for a version a bench lists', () => {
  assert.equal(defaultLanguage({ languages: ['fr', 'en'] }), 'en');
  assert.equal(defaultLanguage({ languages: ['fr'] }), 'fr');
  assert.equal(defaultLanguage({}), null);
  const root = new URL('..', import.meta.url).pathname;
  assert.ok(learnScenario(root, 'bfme1-108').file.endsWith('.txt'));
  assert.equal(learnScenario(root, 'no-such-game'), null);
  // (a version with learn scenarios: those, each required; a bench scenario is only the fallback)
  const aotr = learnScenarios(root, 'aotr-10');
  assert.ok(aotr.length >= 2 && aotr.every((s) => s.required && /^[\w.-]+:[0-9a-f]{12}$/.test(s.id)));
});

test('learn scenarios: one played is done, one that never reaches its end is given up after a few tries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));
  try {
    const l = new LearnedScenarios(path.join(dir, 'learned.json'));
    l.add('a', ['menu:000000000000'], ['map:111111111111']);
    assert.ok(l.done('a', 'menu:000000000000'));
    assert.ok(!l.done('a', 'map:111111111111'), 'one failure: tried again');
    for (let i = 1; i < LEARN_TRIES; i++) l.add('a', [], ['map:111111111111']);
    assert.deepEqual(l.doneIds('a').sort(), ['map:111111111111', 'menu:000000000000']);
    l.add('a', [], ['menu:000000000000']);
    assert.ok(l.done('a', 'menu:000000000000'), 'a played one stays played');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('players\' languages: every version\'s first one (its snapshot, then its learn job in it) before any second one', async () => {
  assert.deepEqual(warmLanguages({ languages: ['en', 'fr'] }, { fr: 5 }), ['fr', 'en']);
  assert.deepEqual(warmLanguages({ languages: ['en', 'fr', 'de'] }, { en: 7, fr: 2, it: 9 }), ['en', 'fr'], 'undeclared and unused languages left out');
  assert.deepEqual(warmLanguages({ languages: ['en', 'fr'] }, { en: 7 }, ['fr']), ['fr', 'en'], '--warm-langs first');
  assert.deepEqual(warmLanguages({}), [null]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));
  try {
    const jobs = new SnapshotQueue(path.join(dir, 'queue.json')), snaps = new Set(), learned = new Set();
    const w = new Warmer({
      versions: () => [{ name: 'a', man: { languages: ['en', 'fr'] } }, { name: 'b', man: { languages: ['en', 'fr'] } }],
      fetchVersion: async (n) => ({ manifest: { name: n }, tree: { files: {} } }), sources: () => ({ hash: 'h' }),
      snapshotReady: (n, l) => snaps.has(`${n}/${l}`), hasLearned: (n) => learned.has(n), langUse: (n) => (n === 'a' ? { fr: 5 } : {}), jobs,
    });
    const order = [];
    for (let j; (j = await w.tick());) { order.push(`${j.kind} ${j.name} ${j.lang}`); (j.kind === 'publish' ? snaps : learned).add(j.kind === 'publish' ? `${j.name}/${j.lang}` : j.name); }
    assert.deepEqual(order, ['publish a fr', 'learn a fr', 'publish b en', 'learn b en', 'publish a en']);
    assert.deepEqual(learnArgs('/r', 'a', 1, '/o', null, { lang: 'fr' }).slice(-2), ['--game-lang', 'fr']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a full queue of finished jobs from earlier deploys still takes a new key (a player\'s 404 is not refused for hours)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-q-'));
  try {
    const q = new SnapshotQueue(path.join(dir, 'queue.json'), { max: 4 });
    const now = Date.now();
    // (four jobs past their ttl but within retryMs: the old code kept them all and refused anything new)
    q.jobs = ['a', 'b', 'c', 'd'].map((n, i) => ({ name: n, lang: 'en', key: 'old', kind: 'publish', token: 't' + i, at: now - 3 * 3600e3 + i }));
    assert.equal(q.want('a', 'en', 'old'), false, 'the same key is not queued again within retryMs');
    assert.equal(q.want('a', 'en', 'new'), true, 'a new key replaces its version\'s stale job');
    assert.ok(!q.jobs.some((j) => j.name === 'a' && j.key === 'old'));
    assert.equal(q.want('e', 'en', 'new'), true, 'full: the oldest job past its ttl goes');
    assert.equal(q.jobs.length, 4);
    q.jobs.forEach((j) => { j.at = now; }); // (all running: none may go)
    assert.equal(q.want('f', 'en', 'new'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
