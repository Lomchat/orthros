// Shared first-launch profile (src/host/profile-seed.js, server /api/profile-seed): selection limits, set identity,
// the worker's snapshot rules, the server's quorum, bounds, opt-out and persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SEED_LIMITS, seedPathOk, seedSelect, seedKey, SeedWatch, toBase64, fromBase64, seedCanonFile, canonSets } from '../src/host/profile-seed.js';
import { createServer } from '../src/host/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

test('profile seed server: behind a proxy, sessions from one client address count once toward the quorum', async () => {
  await withServer(async (start) => {
    const s = await start();
    const opts = [['AppData/G/Options.ini', 'Detail = High']];
    const from = (ip, sid) => fetch(url(s, '/api/profile-seed/g'), { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: JSON.stringify({ lang: 'en', session: sid, files: opts.map(([p, t]) => ({ path: p, data: toBase64(bytes(t)) })) }) });
    assert.equal((await from('203.0.113.7', 'x1')).status, 204);
    assert.equal((await from('203.0.113.7, 10.0.0.1', 'x2')).status, 204); // (made-up session ids, one client)
    assert.deepEqual(await seedOf(s, 'g'), []);
    await from('198.51.100.9', 'y1'); // (a second client)
    assert.deepEqual(await seedOf(s, 'g'), opts);
    s.close();
  });
});

test('profile seed server: IPv6 addresses of one /64 are one client', async () => {
  await withServer(async (start) => {
    const s = await start();
    const opts = [['AppData/G/Options.ini', 'Detail = Low']];
    const from = (ip, sid) => fetch(url(s, '/api/profile-seed/g'), { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: JSON.stringify({ lang: 'en', session: sid, files: opts.map(([p, t]) => ({ path: p, data: toBase64(bytes(t)) })) }) });
    assert.equal((await from('2001:db8:1:2::1', 'x1')).status, 204);
    await from('2001:0db8:0001:0002:abcd:ef01:2345:6789', 'x2');
    await from('2001:db8:1:2:ffff::', 'x3');
    assert.deepEqual(await seedOf(s, 'g'), [], 'one /64: one client');
    await from('2001:db8:1:3::1', 'y1'); // (another /64)
    assert.deepEqual(await seedOf(s, 'g'), opts);
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

test('profile seed: canonical file sets validated, one per language', () => {
  const ok = [['AppData/G/Options.ini', toBase64(bytes('Detail = Medium'))]];
  const sets = canonSets({ v: 1, sets: [{ lang: 'fr', files: ok, note: 'n' }, { lang: 'fr', files: [['other.ini', toBase64(bytes('x'))]] }, { lang: 'en', files: [['Temp/a.tmp', toBase64(bytes('x'))]] }, { lang: 'de', files: [] }, { lang: 'E N', files: ok }, null] });
  assert.deepEqual(sets.map((s) => [s.lang, s.files, s.note]), [['fr', ok, 'n']]);
  assert.equal(sets[0].key, seedKey([file('AppData/G/Options.ini', 'Detail = Medium')]));
  assert.deepEqual(canonSets(null), []);
  assert.equal(seedCanonFile('a b/c'), 'seedcanon-a_b_c.json');
});

test('profile seed server: a canonical set is offered with no reporter and stays ahead of the learned sets', async () => {
  await withServer(async (start, learn) => {
    const s = await start();
    const learned = [['AppData/G/Options.ini', 'Detail = High']];
    await report(s, 'g', 's1', learned); await report(s, 'g', 's2', learned);
    assert.deepEqual(await seedOf(s, 'g'), learned);
    await new Promise((r) => setTimeout(r, 50)); // (the learned file written)
    // the operator's tool writes the canonical set while the server runs: offered from the next request on
    const prof = path.join(learn, '..', 'prof');
    fs.mkdirSync(path.join(prof, 'AppData', 'G'), { recursive: true });
    fs.writeFileSync(path.join(prof, 'AppData', 'G', 'Options.ini'), 'Detail = Medium');
    fs.mkdirSync(path.join(prof, 'Temp'), { recursive: true });
    fs.writeFileSync(path.join(prof, 'Temp', 'scratch.tmp'), 'x');
    const tool = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'profile-seed-make.mjs'), ...a, '--learn', learn], { encoding: 'utf8' });
    const put = tool('put', 'g', 'en', prof);
    assert.equal(put.status, 0, put.stderr);
    assert.match(put.stdout, /Detail = Medium/);
    assert.deepEqual(await seedOf(s, 'g'), [['AppData/G/Options.ini', 'Detail = Medium']]);
    assert.deepEqual(await seedOf(s, 'g', 'fr'), []); // (per language)
    // more sessions reporting other content do not displace it
    for (let i = 0; i < 5; i++) await report(s, 'g', 'r' + i, learned);
    assert.deepEqual(await seedOf(s, 'g'), [['AppData/G/Options.ini', 'Detail = Medium']]);
    // a learned set promoted to canonical for another language (one reporter: below the quorum, offered once promoted)
    await report(s, 'g', 'f1', learned, 'fr');
    assert.deepEqual(await seedOf(s, 'g', 'fr'), []);
    await new Promise((r) => setTimeout(r, 50)); // (the learned file written)
    const promote = tool('promote', 'g', 'fr');
    assert.equal(promote.status, 0, promote.stderr);
    assert.deepEqual(await seedOf(s, 'g', 'fr'), learned);
    assert.deepEqual(await seedOf(s, 'g'), [['AppData/G/Options.ini', 'Detail = Medium']]); // (the other language's kept)
    // removed: the learned quorum again
    assert.equal(tool('remove', 'g', 'en').status, 0);
    assert.deepEqual(await seedOf(s, 'g'), learned);
    assert.deepEqual(await seedOf(s, 'g', 'fr'), learned);
    // a damaged file: no canonical set (the fr learned set has one reporter: nothing)
    fs.writeFileSync(path.join(learn, seedCanonFile('g')), '{oops');
    assert.deepEqual(await seedOf(s, 'g', 'fr'), []);
    s.close();
  });
});
