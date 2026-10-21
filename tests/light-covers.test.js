// The home's light covers (src/host/light-covers.js, server.js /api/cover).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { lightCovers, COVER_WIDTH } from '../src/host/light-covers.js';
import { createServer } from '../src/host/server.js';

const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const haveWebp = ffmpeg.status === 0 && /libwebp/.test(ffmpeg.stdout);
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) })); }).on('error', reject);
});
/** a 1920 × 1080 noisy JPEG made by ffmpeg (a cover of a game's size) */
const makeJpeg = (file) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1,noise=alls=60:allf=t', '-frames:v', '1', '-q:v', '2', file]).status === 0;

test('light covers: no ffmpeg — none, and asked once', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-cov-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'c.jpg'); fs.writeFileSync(f, Buffer.alloc(4096, 1));
  const c = lightCovers({ dir: path.join(d, 'out'), ffmpeg: path.join(d, 'no-such-ffmpeg') });
  assert.equal(await c.make(f), null);
  assert.equal(c.file(f), null);
  assert.equal(c.file(path.join(d, 'cover.svg')), null);
});

test('light covers: a 960 px WebP made in the background, then served by /api/cover (?full: the image)', { skip: !haveWebp && 'no ffmpeg with libwebp' }, async (t) => {
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-covg-')); t.after(() => fs.rmSync(games, { recursive: true, force: true }));
  const g = path.join(games, 'demo');
  fs.mkdirSync(path.join(g, 'base'), { recursive: true }); fs.mkdirSync(path.join(g, 'versions', '1.0'), { recursive: true });
  fs.writeFileSync(path.join(g, 'base', 'demo.exe'), 'MZ');
  assert.ok(makeJpeg(path.join(g, 'cover.jpg')));
  fs.writeFileSync(path.join(g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'demo', defaultVersion: 'demo-10', versions: [{ id: 'demo-10', dir: '1.0', version: '1.0', exe: 'demo.exe', coverFile: 'cover.jpg' }] }));
  const coverDir = path.join(games, '..', path.basename(games) + '-covers'); t.after(() => fs.rmSync(coverDir, { recursive: true, force: true }));
  const server = createServer({ gamesDir: games, coverDir, lanLog: () => {}, brCacheLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const port = server.address().port, full = fs.statSync(path.join(g, 'cover.jpg')).size;
  const first = await get(port, '/api/cover/demo-10');
  assert.equal(first.status, 200); assert.equal(first.headers['content-type'], 'image/jpeg'); assert.equal(first.body.length, full);
  let r = null;
  for (let i = 0; i < 200; i++) { r = await get(port, '/api/cover/demo-10'); if (r.headers['content-type'] === 'image/webp') break; await new Promise((s) => setTimeout(s, 50)); }
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.ok(r.body.length < full / 2, `${r.body.length} of ${full}`);
  assert.equal(r.body.subarray(0, 4).toString(), 'RIFF');
  // (its width: VP8 bitstream's, or VP8X's canvas)
  const kind = r.body.subarray(12, 16).toString();
  const width = kind === 'VP8X' ? 1 + r.body.readUIntLE(24, 3) : kind === 'VP8 ' ? r.body.readUInt16LE(26) & 0x3fff : null;
  assert.equal(width, COVER_WIDTH);
  assert.equal((await get(port, '/api/cover/demo-10?full=1')).body.length, full);
});

test('light covers: a cover ffmpeg cannot convert is marked, not tried again at each request — again once it changes', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-cov-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  // (a stand-in ffmpeg: counts its starts, fails as on an image it cannot read)
  const count = path.join(d, 'count'), fake = path.join(d, 'ffmpeg');
  fs.writeFileSync(fake, `#!/bin/sh\necho x >> '${count}'\necho 'Invalid data found when processing input' >&2\nexit 1\n`); fs.chmodSync(fake, 0o755);
  const starts = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0);
  const logs = [];
  const f = path.join(d, 'c.webp'); fs.writeFileSync(f, Buffer.alloc(4096, 1));
  const c = lightCovers({ dir: path.join(d, 'out'), ffmpeg: fake, log: (m) => logs.push(m) });
  assert.equal(c.pending(f), true);
  assert.equal(await c.make(f), null);
  assert.equal(starts(), 1); assert.equal(logs.length, 1);
  assert.equal(c.pending(f), false, 'marked: the full image is the cover');
  for (let i = 0; i < 5; i++) assert.equal(c.file(f), null);
  assert.equal(await c.make(f), null);
  assert.equal(starts(), 1, 'not spawned again'); assert.equal(logs.length, 1);
  // (the cover changed: tried again)
  fs.writeFileSync(f, Buffer.alloc(5000, 2));
  assert.equal(c.pending(f), true);
  assert.equal(await c.make(f), null);
  assert.equal(starts(), 2);
  assert.equal(c.pending(path.join(d, 'cover.svg')), false, 'an SVG: none to wait for');
});

test('/api/cover: the full image not cached for a day while its light copy is pending; covers made from the start', { skip: !haveWebp && 'no ffmpeg with libwebp' }, async (t) => {
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-covg-')); t.after(() => fs.rmSync(games, { recursive: true, force: true }));
  const g = path.join(games, 'demo');
  fs.mkdirSync(path.join(g, 'base'), { recursive: true }); fs.mkdirSync(path.join(g, 'versions', '1.0'), { recursive: true });
  fs.writeFileSync(path.join(g, 'base', 'demo.exe'), 'MZ');
  assert.ok(makeJpeg(path.join(g, 'cover.jpg')));
  fs.writeFileSync(path.join(g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'demo', defaultVersion: 'demo-10', versions: [{ id: 'demo-10', dir: '1.0', version: '1.0', exe: 'demo.exe', coverFile: 'cover.jpg' }] }));
  const coverDir = path.join(games, '..', path.basename(games) + '-covers'); t.after(() => fs.rmSync(coverDir, { recursive: true, force: true }));
  const server = createServer({ gamesDir: games, coverDir, lanLog: () => {}, brCacheLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const port = server.address().port;
  const made = () => (fs.existsSync(coverDir) ? fs.readdirSync(coverDir).filter((n) => n.endsWith('.webp')).length : 0);
  // (made with no request for it: the server started it)
  for (let i = 0; i < 200 && !made(); i++) await new Promise((s) => setTimeout(s, 50));
  assert.equal(made(), 1);
  const light = await get(port, '/api/cover/demo-10');
  assert.equal(light.headers['content-type'], 'image/webp'); assert.equal(light.headers['cache-control'], 'public, max-age=86400');
  assert.equal((await get(port, '/api/cover/demo-10?full=1')).headers['cache-control'], 'public, max-age=86400', '?full: the image, for a day');
  // (the cover changed: its light copy pending, the full image sent meanwhile is not kept)
  await new Promise((s) => setTimeout(s, 20));
  fs.appendFileSync(path.join(g, 'cover.jpg'), Buffer.alloc(16));
  const pending = await get(port, '/api/cover/demo-10');
  assert.equal(pending.headers['content-type'], 'image/jpeg'); assert.equal(pending.headers['cache-control'], 'no-cache');
  for (let i = 0; i < 200 && made() < 2; i++) await new Promise((s) => setTimeout(s, 50));
  assert.equal((await get(port, '/api/cover/demo-10')).headers['content-type'], 'image/webp');
});
