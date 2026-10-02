// Shared first-launch profile (src/host/profile-seed.js, server /api/profile-seed): selection limits, set identity,
// the worker's snapshot rules, the server's quorum, bounds, opt-out and persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEED_LIMITS, seedPathOk, seedSelect, seedKey, SeedWatch, toBase64, fromBase64 } from '../src/host/profile-seed.js';
import { createServer } from '../src/host/server.js';

const bytes = (s) => new TextEncoder().encode(s);
const file = (p, s) => ({ path: p, data: typeof s === 'string' ? bytes(s) : s });

test('profile seed: eligible paths', () => {
  for (const p of ['AppData/Roaming/My Game Files/Options.ini', 'Documents/a.cfg', 'top.ini']) assert.ok(seedPathOk(p), p);
  for (const p of ['', 'Temp/x.tmp', 'temp/a/b', 'a/../b', './a', 'a//b', 'a\\b', 'C:/a', 'a/b:c', 'a/ b', 'x'.repeat(300), null, 3]) assert.ok(!seedPathOk(p), String(p));
});

test('profile seed: selection skips large files and Temp, keeps within the set limits, sorted by path', () => {
  const big = new Uint8Array(SEED_LIMITS.fileMax + 1);
  const sel = seedSelect([file('b/Options.ini', 'x=1'), file('Temp/{guid}/lrf1.tmp', 'tmp'), file('a/Save/game.sav', big), file('A/z.ini', 'z'), file('b/OPTIONS.INI', 'dup')]);
  assert.deepEqual(sel.map((f) => f.path), ['A/z.ini', 'b/Options.ini']);
  // over the set's total: the smallest files first
  const many = [];
  for (let i = 0; i < 5; i++) many.push(file(`d/f${i}.bin`, new Uint8Array(40 * 1024 + i)));
  const s2 = seedSelect(many);
  assert.deepEqual(s2.map((f) => f.path), ['d/f0.bin', 'd/f1.bin', 'd/f2.bin']);
  assert.ok(s2.reduce((n, f) => n + f.data.length, 0) <= SEED_LIMITS.setMax);
  const s3 = seedSelect(Array.from({ length: 50 }, (_, i) => file(`c/${String(i).padStart(2, '0')}.ini`, 'v')));
  assert.equal(s3.length, SEED_LIMITS.files);
});

test('profile seed: set identity depends on paths (not their case) and bytes', () => {
  const a = [file('x/Options.ini', 'a=1'), file('y.ini', '')];
  assert.equal(seedKey(a), seedKey([file('X/options.INI', 'a=1'), file('y.ini', '')]));
  assert.notEqual(seedKey(a), seedKey([file('x/Options.ini', 'a=2'), file('y.ini', '')]));
  assert.notEqual(seedKey(a), seedKey([file('x/Options.ini', 'a=1')]));
  assert.notEqual(seedKey([file('ab', 'c')]), seedKey([file('a', 'bc')]));
  const d = new Uint8Array(70000); for (let i = 0; i < d.length; i++) d[i] = (i * 7) & 255;
  assert.deepEqual(fromBase64(toBase64(d)), d);
  assert.equal(fromBase64('***'), null);
});

test('profile seed: the snapshot waits for files at a click, never includes what follows typing, reports after play', () => {
  const prof = new Map();
  const w = new SeedWatch({ files: () => [...prof].map(([p, s]) => file(p, s)), frames: 100, ms: 1000 });
  w.input(0, 0, false); // (a click during the first-launch work: nothing written yet)
  assert.equal(w.snap, null);
  prof.set('AppData/Game/Options.ini', 'Resolution = 800 600');
  prof.set('Temp/x.tmp', 'scratch');
  w.input(500, 10, false); // (the first click on the menu)
  prof.set('AppData/Game/Options.ini', 'changed after the click');
  w.input(600, 12, true); // (typing: the snapshot is already taken)
  prof.set('AppData/Game/Player.ini', 'Name = Typed');
  assert.equal(w.step(1200, 50), null); // (not enough frames yet)
  assert.equal(w.step(900, 200), null); // (not long enough yet)
  const out = w.step(1600, 200);
  assert.deepEqual(out.map((f) => [f.path, new TextDecoder().decode(f.data)]), [['AppData/Game/Options.ini', 'Resolution = 800 600']]);
  assert.equal(w.step(5000, 1000), null); // (once)
  // typing first, with nothing written yet: no snapshot ever
  const w2 = new SeedWatch({ files: () => [...prof].map(([p, s]) => file(p, s)), frames: 1, ms: 1 });
  prof.clear(); w2.input(0, 0, true); prof.set('a/b.ini', 'x'); w2.input(10, 0, false);
  assert.ok(w2.done); assert.equal(w2.step(1e6, 1e6), null);
});

async function withServer(fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-seed-'));
  fs.mkdirSync(path.join(dir, 'man'));
  fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  fs.writeFileSync(path.join(dir, 'man', 'off.json'), JSON.stringify({ name: 'off', folder: dir, exe: 'x.exe', profileSeed: false }));
  const learn = path.join(dir, 'learn');
  fs.mkdirSync(learn);
  const servers = [];
  const start = async () => { const s = createServer({ manifests: path.join(dir, 'man'), learnDir: learn, learnWriteMs: 10, ...opts }); servers.push(s); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; };
  try { await fn(start, learn); } finally { for (const s of servers) s.close(); fs.rmSync(dir, { recursive: true, force: true }); } // (a failed assertion leaves no server running)
}
const url = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;
const report = (s, name, session, files, lang = 'en') => fetch(url(s, `/api/profile-seed/${name}`), { method: 'POST', body: JSON.stringify({ lang, session, files: files.map(([p, t]) => ({ path: p, data: toBase64(bytes(t)) })) }) });
const seedOf = async (s, name, lang = 'en') => (await (await fetch(url(s, `/api/profile-seed/${name}?lang=${lang}`))).json()).files.map((f) => [f.path, new TextDecoder().decode(fromBase64(f.data))]);

test('profile seed server: offered once enough distinct sessions reported identical files, per language', async () => {
  await withServer(async (start, learn) => {
    let s = await start();
    const opts = [['AppData/G/Options.ini', 'Detail = High']];
    assert.equal((await fetch(url(s, '/api/config')).then((r) => r.json())).profileSeed, true);
    assert.equal((await report(s, 'g', 's1', opts)).status, 204);
    assert.deepEqual(await seedOf(s, 'g'), []); // (one session: not yet)
    assert.equal((await report(s, 'g', 's1', opts)).status, 204);
    assert.deepEqual(await seedOf(s, 'g'), []); // (the same session twice counts once)
    await report(s, 'g', 's2', [['AppData/G/Options.ini', 'Detail = Low']]); // (another content: its own set)
    await report(s, 'g', 's3', opts);
    assert.deepEqual(await seedOf(s, 'g'), opts);
    assert.deepEqual(await seedOf(s, 'g', 'fr'), []); // (per game language)
    // the most reported set wins
    await report(s, 'g', 's4', [['AppData/G/Options.ini', 'Detail = Low']]);
    await report(s, 'g', 's5', [['AppData/G/Options.ini', 'Detail = Low']]);
    assert.deepEqual(await seedOf(s, 'g'), [['AppData/G/Options.ini', 'Detail = Low']]);
    // refused: Temp, bad paths, oversized, bad session or language
    assert.equal((await report(s, 'g', 's6', [['Temp/a.tmp', 'x']])).status, 400);
    assert.equal((await report(s, 'g', 's6', [['../x', 'x']])).status, 400);
    assert.equal((await report(s, 'g', 's6', [['a/big.bin', 'x'.repeat(SEED_LIMITS.fileMax + 1)]])).status, 400);
    assert.equal((await report(s, 'g', '', opts)).status, 400);
    assert.equal((await report(s, 'g', 's7', opts, 'e n')).status, 400);
    // a game whose manifest opts out: nothing offered or kept
    await report(s, 'off', 's1', opts); await report(s, 'off', 's2', opts);
    assert.deepEqual(await seedOf(s, 'off'), []);
    await new Promise((r) => setTimeout(r, 100));
    s.close();
    assert.ok(!fs.existsSync(path.join(learn, 'profileseed-off.json')));
    // kept across a restart
    s = await start();
    assert.deepEqual(await seedOf(s, 'g'), [['AppData/G/Options.ini', 'Detail = Low']]);
    s.close();
    // a damaged file: started empty
    fs.writeFileSync(path.join(learn, 'profileseed-g.json'), '{oops');
    s = await start();
    assert.deepEqual(await seedOf(s, 'g'), []);
    s.close();
  });
});

test('profile seed server: bounded set count, quorum option', async () => {
  await withServer(async (start, learn) => {
    const s = await start();
    for (let i = 0; i < 40; i++) await report(s, 'g', 'a' + i, [['c/o.ini', 'v' + i]]);
    await report(s, 'g', 'b', [['c/o.ini', 'v39']]);
    assert.deepEqual(await seedOf(s, 'g'), [['c/o.ini', 'v39']]); // (the only set two sessions reported)
    await new Promise((r) => setTimeout(r, 100));
    s.close();
    const j = JSON.parse(fs.readFileSync(path.join(learn, 'profileseed-g.json'), 'utf8'));
    assert.ok(j.sets.length <= 16);
    assert.ok(j.sets.some((x) => x.sessions.length === 2));
  });
  await withServer(async (start) => {
    const s = await start();
    await report(s, 'g', 'only', [['c/o.ini', 'v']]);
    assert.deepEqual(await seedOf(s, 'g'), [['c/o.ini', 'v']]);
    s.close();
  }, { profileSeedQuorum: 1 });
});
