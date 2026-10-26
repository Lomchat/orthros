// The proxy log's readers (tools/net-proxy.mjs): a request's kind from its URL (an `a=1` read carries the session too),
// a game data read's path and decoded size, its file category (a light copy's full file read later: an upgrade), and a
// stretch of the log — the game's own reads, their spacing and waits, the background's bytes by kind and category.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { urlKind, dataRead, fileCategory, loadWindow, readLog, summarize } from '../tools/net-proxy.mjs';

const M = '/gamez/mw';
const rec = (t, url, wire, ms, first = 45) => ({ t, url, kind: 'x', status: 200, wire, first, ms });

test('net-proxy log: kinds, reads and categories', () => {
  assert.equal(urlKind(`${M}/Data/a.nif?r=0-10&s=abc`), 'demand');
  assert.equal(urlKind(`${M}/Data/a.nif?r=0-10&s=abc&a=1`), 'ahead');
  assert.equal(urlKind(`${M}/Data/a.nif?r=0-10&p=1`), 'bg');
  assert.equal(urlKind(`${M}/Data/a.nif?r=0-10&w=1`), 'want');
  assert.equal(urlKind('/src/vfs/net-link.js'), 'other');
  assert.deepEqual(dataRead(`${M}/.light/Textures/tx%20a.dds?r=100-1100&s=x`), { manifest: 'mw', path: 'Textures/tx a.dds', light: true, decoded: 1000 });
  assert.equal(dataRead(`${M}/Morrowind.bsa?r=0-5&p=1`).decoded, 5);
  assert.equal(dataRead('/api/tree/mw'), null);
  const cat = (p, o) => fileCategory(dataRead(`${M}/${p}?r=0-1`), o);
  assert.equal(cat('.light/Textures/a.dds'), 'light');
  assert.equal(cat('Textures/a.dds', { lightSeen: new Set(['Textures/a.dds']) }), 'upgrade');
  assert.equal(cat('Textures/a.dds'), 'texture');
  assert.equal(cat('Splash/Splash_x.tga'), 'Splash');
  assert.equal(cat('mods/hd/video/intro.bik'), 'Video');
  assert.equal(cat('Music/Explore/a.mp3'), 'Music');
  assert.equal(cat('Meshes/x/a.nif'), 'mesh');
  assert.equal(cat('Tribunal.bsa'), 'archive');
  assert.equal(cat('Morrowind.esm'), 'content');
  assert.equal(cat('_engine/a.omwaddon'), '_engine');
  assert.equal(cat('a.txt'), 'other');
});

test('net-proxy log: a stretch — demand spacing and waits, background by kind and category, upgrades', () => {
  const recs = [
    rec(0, `${M}/.light/Textures/a.dds?r=0-1000&s=x`, 700, 100),            // before: the light copy read
    rec(1000, `${M}/Meshes/a.nif?r=0-2000&s=x`, 1200, 100),                 // the stretch's reads: 1000, 1200, 1500
    rec(1050, `${M}/Textures/a.dds?r=0-1000000&p=1`, 600_000, 400),         // its upgrade, inside
    rec(1200, `${M}/.light/Textures/b.dds?r=0-500&s=x`, 400, 100),
    rec(1300, `${M}/Video/intro.bik?r=0-500000&s=x&a=1`, 300_000, 200),     // ahead, a movie
    rec(1500, `${M}/Morrowind.bsa?r=0-4000&s=x`, 3000, 200, 90),
    rec(1900, `${M}/Music/a.mp3?r=0-400000&p=1`, 400_000, 200),             // half inside the stretch
    { t: 1950, mark: { kind: 'playable' }, url: '/api/prefetch/mw' },
    rec(1960, '/__qa/mark?x', 300, 5),
    rec(3000, `${M}/Meshes/b.nif?r=0-10&s=x`, 210, 50),                     // after
  ];
  const w = loadWindow(recs, 1000, 2000);
  assert.equal(w.ms, 1000);
  assert.equal(w.demand.count, 3);
  assert.equal(w.demand.light.count, 1);
  assert.equal(w.demand.decodedMB, 0.01); // 2000 + 500 + 4000 bytes
  assert.deepEqual(w.demand.spacing, { p10: 200, p50: 300, p90: 300 });
  assert.equal(w.demand.waitMs, 100 + 100 + 200);
  assert.deepEqual(w.demand.idle, { p10: 100, p50: 200, p90: 200 });
  assert.equal(w.demand.ttfb.p90, 90);
  assert.equal(w.backgroundByCategory.upgrade, 0.6);
  assert.equal(w.backgroundByCategory.Video, 0.3);
  assert.equal(w.backgroundByCategory.Music, 0.2);
  assert.deepEqual(w.backgroundByKind.ahead, { Video: 0.3 });
  assert.equal(w.backgroundMB, 1.1);
  assert.equal(w.wireMB.other, 0); // (the marker: 300 bytes)
  // (the whole log's summary skips the mark line)
  assert.equal(summarize(recs).requests, 9);
});

test('net-proxy log: readLog sorts by start, reads gzip, skips a cut line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-proxy-log-'));
  try {
    const text = [JSON.stringify(rec(50, '/b', 1, 1)), JSON.stringify(rec(10, '/a', 1, 1)), '{"t":5,"url'].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'p.jsonl.gz'), zlib.gzipSync(text));
    assert.deepEqual(readLog(path.join(dir, 'p.jsonl.gz')).map((r) => r.url), ['/a', '/b']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('net-proxy log: announced ranges (w=1) are the load\'s own — counted apart, not background', () => {
  const recs = [
    rec(1000, `${M}/Meshes/a.nif?r=0-65536&w=1`, 30_000, 120),
    rec(1001, `${M}/.light/Textures/a.dds?r=0-40000&w=1`, 20_000, 110),
    rec(1010, `${M}/Textures/b.dds?r=0-100000&p=1`, 50_000, 100),
    rec(1500, `${M}/Meshes/a.nif?r=0-100&s=x`, 100, 90),
  ];
  const w = loadWindow(recs, 1000, 2000);
  assert.deepEqual(w.want, { count: 2, decodedMB: 0.11, wireMB: 0.05 });
  assert.equal(w.backgroundMB, 0.05, 'the p=1 download only');
  assert.equal(w.wireMB.want, 0.05);
  const s = summarize(recs);
  assert.deepEqual(s.byKind.want, { requests: 2, MB: 0.05 });
  assert.equal(s.dataRequests, 4);
});
