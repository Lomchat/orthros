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
