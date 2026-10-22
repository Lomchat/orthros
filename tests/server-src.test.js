// The page's own files (src/): revalidated at each load, 304 when unchanged, brotli 11 once made (server.js sendSource).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createServer } from '../src/host/server.js';

const get = (port, p, h = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: h }, (res) => {
    const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject);
});

async function start(t) {
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-src-'));
  t.after(() => fs.rmSync(games, { recursive: true, force: true }));
  const server = createServer({ gamesDir: games, lanLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return server.address().port;
}

test('src: ETag and Last-Modified, 304 on either validator, COOP/COEP kept', async (t) => {
  const port = await start(t), p = '/src/vfs/http-backend.js';
  const a = await get(port, p);
  assert.equal(a.status, 200);
  assert.ok(a.headers.etag?.startsWith('W/"'));
  assert.equal(a.headers['cache-control'], 'no-cache');
  assert.equal(a.body.length, fs.statSync(new URL('../src/vfs/http-backend.js', import.meta.url)).size);
  const b = await get(port, p, { 'If-None-Match': a.headers.etag });
  assert.equal(b.status, 304); assert.equal(b.body.length, 0);
  assert.equal(b.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(b.headers.etag, a.headers.etag);
  const c = await get(port, p, { 'If-Modified-Since': a.headers['last-modified'] });
  assert.equal(c.status, 304);
  const d = await get(port, p, { 'If-None-Match': 'W/"other"' });
  assert.equal(d.status, 200); // (If-None-Match decides over If-Modified-Since)
  const e = await get(port, p, { 'If-Modified-Since': new Date(Date.parse(a.headers['last-modified']) - 5000).toUTCString() });
  assert.equal(e.status, 200);
  const pg = await get(port, '/');
  assert.equal((await get(port, '/', { 'If-None-Match': pg.headers.etag })).status, 304);
});

test('src: brotli 11 once made, same bytes decoded, 304 for it too', async (t) => {
  const port = await start(t), p = '/src/host/server.js', file = new URL('../src/host/server.js', import.meta.url);
  const br = { 'Accept-Encoding': 'gzip, br' };
  const first = await get(port, p, br);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-encoding'], undefined); // (being made: sent as it is)
  assert.match(first.headers.vary, /Accept-Encoding/);
  let r = null;
  for (let i = 0; i < 200; i++) { r = await get(port, p, br); if (r.headers['content-encoding'] === 'br') break; await new Promise((s) => setTimeout(s, 25)); }
  assert.equal(r.headers['content-encoding'], 'br');
  const raw = fs.readFileSync(file);
  assert.deepEqual(zlib.brotliDecompressSync(r.body), raw);
  assert.ok(r.body.length < raw.length * 0.3, `${r.body.length} of ${raw.length}`);
  assert.equal(r.headers.etag, first.headers.etag);
  assert.equal((await get(port, p, { ...br, 'If-None-Match': r.headers.etag })).status, 304);
  // (no brotli asked: the file)
  const plain = await get(port, p);
  assert.equal(plain.headers['content-encoding'], undefined); assert.deepEqual(plain.body, raw);
  // (a range: the file's bytes)
  const part = await get(port, p, { ...br, Range: 'bytes=0-9' });
  assert.equal(part.status, 206); assert.deepEqual(part.body, raw.subarray(0, 10));
});

test('paths: no way out of a served directory — decoded "..", "." or backslash refused, malformed escapes too', async (t) => {
  const port = await start(t);
  const raw = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal((await get(port, '/src/vfs/http-backend.js')).status, 200);
  for (const p of ['/src/..%2fpackage.json', '/src/..%2FMakefile', '/src/%2e%2e%2fpackage.json', '/tools/..%2f..%2fetc/passwd',
    '/tests/..%2f.git/config', '/src/..%5cpackage.json', '/src/vfs%5c..%5c..%5cpackage.json', '/src/.%2fvfs/http-backend.js', '/src/%00x.js', '/src/%zz.js',
    '/game/g/..%2f..%2fmanifest.json', '/gamez/g/..%2fx', '/engines/..%2f..%2fpackage.json/x', '/api/cover/..%2f..', '/ports/goldsrc/..%2f/']) {
    const r = await get(port, p);
    assert.equal(r.status, 400, p);
    assert.ok(!r.body.toString().includes('"name"'), p);
  }
  assert.equal((await get(port, '/src/%2e%2e/package.json')).status, 404, "(the URL parser folds an encoded '..' segment: /package.json, not served)");
  assert.equal(await raw('//'), 400, 'an address URL cannot parse');
  assert.equal((await get(port, '/src/no-such-file.js')).status, 404);
});

test('paths: isUnder wants the directory and a separator (a sibling with the same prefix is not under it)', async () => {
  const { isUnder, requestPath } = await import('../src/host/server.js');
  assert.equal(isUnder('/srv/orthros/src', '/srv/orthros/src/a.js'), true);
  assert.equal(isUnder('/srv/orthros/src', '/srv/orthros/src'), false);
  assert.equal(isUnder('/srv/orthros', '/srv/orthros2/x'), false);
  assert.equal(isUnder('/srv/orthros/src', '/srv/orthros/src/../package.json'), false);
  assert.equal(requestPath('/src/a%20b.js'), '/src/a b.js');
  assert.equal(requestPath('/game/g/Data/x..y.big'), '/game/g/Data/x..y.big', 'dots inside a name are fine');
  for (const p of ['/src/..%2fx', '/a/%2e%2e', '/a%5cb', '/%E0%A4%A', '/a/./b']) assert.equal(requestPath(p), null, p);
});

test('src: the brotli copies made two at a time, the rest queued (libuv\'s pool left to the game data)', async (t) => {
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-src-'));
  t.after(() => fs.rmSync(games, { recursive: true, force: true }));
  const server = createServer({ gamesDir: games, lanLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const port = server.address().port, br = { 'Accept-Encoding': 'br' };
  const files = fs.readdirSync(new URL('../src/win32/', import.meta.url)).filter((f) => f.endsWith('.js') && fs.statSync(new URL(`../src/win32/${f}`, import.meta.url)).size > 4096).slice(0, 12);
  assert.ok(files.length >= 6);
  await Promise.all(files.map((f) => get(port, `/src/win32/${f}`, br)));
  const s0 = server.srcBrJobs();
  assert.ok(s0.running <= 2 && s0.running + s0.queued <= files.length, JSON.stringify(s0));
  for (let i = 0; i < 400 && (server.srcBrJobs().running || server.srcBrJobs().queued); i++) await new Promise((r) => setTimeout(r, 25));
  const s1 = server.srcBrJobs();
  assert.deepEqual([s1.running, s1.queued], [0, 0]);
  assert.equal(s1.peak, 2, 'never more than two at once');
  for (const f of files) assert.equal((await get(port, `/src/win32/${f}`, br)).headers['content-encoding'], 'br', f);
});

test('src: prewarmSrc makes every text module brotli at start — the first visit after a restart gets them so', async (t) => {
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-src-'));
  t.after(() => fs.rmSync(games, { recursive: true, force: true }));
  const server = createServer({ gamesDir: games, lanLog: () => {}, prewarmSrc: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const port = server.address().port;
  for (let i = 0; i < 1200; i++) { const q = server.srcBrJobs(); if (i > 2 && q.queued === 0 && q.running === 0) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(server.srcBrJobs().peak <= 2, 'two at a time');
  // (never asked before: brotli at its first request)
  for (const p of ['/src/host/web/main.js', '/src/cpu/decoder.js', '/src/vfs/http-backend.js']) {
    const r = await get(port, p, { 'Accept-Encoding': 'gzip, br' });
    assert.equal(r.headers['content-encoding'], 'br', p);
    assert.deepEqual(zlib.brotliDecompressSync(r.body), fs.readFileSync(new URL('..' + p, import.meta.url)));
  }
});
