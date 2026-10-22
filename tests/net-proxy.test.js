// The player's-link proxy (tools/net-proxy.mjs, docs/slow-network.md "Measuring"): an answer crosses a round trip and
// the link's rate, a text answer sent as it is goes gzip on the way (Cloudflare), a data report's mark is seen and
// listed, one JSON line per request with its wire bytes and unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { startProxy } from '../tools/net-proxy.mjs';

test('net-proxy: round trip and rate, edge gzip of text, marks, JSON log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-net-proxy-'));
  const BIN = Buffer.alloc(100_000, 7), TEXT = 'orthros '.repeat(4000);
  const posted = [];
  const origin = http.createServer((req, res) => {
    const body = []; req.on('data', (c) => body.push(c));
    req.on('end', () => {
      if (req.method === 'POST') { posted.push(Buffer.concat(body).toString()); res.writeHead(204); res.end(); return; }
      if (req.url.startsWith('/bin')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIN.length, 'x-orthros-unit': 'hit' }); res.end(BIN); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(TEXT) }); res.end(TEXT);
    });
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const log = path.join(dir, 'log.jsonl');
  const proxy = await startProxy({ upstream: `127.0.0.1:${origin.address().port}`, listen: 0, rate: 500e3, rtt: 80, log, http1: true });
  const base = `http://127.0.0.1:${proxy.port}`;
  try {
    // (100 KB at 500 KB/s after a round trip of 80 ms: 280 ms at least)
    const t = performance.now();
    const r = await fetch(`${base}/bin?r=0-100000&p=1`);
    const got = Buffer.from(await r.arrayBuffer()), ms = performance.now() - t;
    assert.ok(got.equals(BIN), 'the answer as sent');
    assert.ok(ms >= 260 && ms < 2000, `round trip and rate: ${ms.toFixed(0)} ms`);
    // (a text answer: gzip on the way, the client gets it decoded)
    const raw = await new Promise((resolve, reject) => http.get(`${base}/api/x`, { headers: { 'accept-encoding': 'gzip, br' } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ enc: res.headers['content-encoding'], body: Buffer.concat(parts) }));
    }).on('error', reject));
    assert.equal(raw.enc, 'gzip');
    assert.equal(zlib.gunzipSync(raw.body).toString(), TEXT);
    // (a data report's mark: forwarded, seen, listed — not forwarded itself)
    await fetch(`${base}/api/prefetch/game`, { method: 'POST', body: JSON.stringify({ mark: { kind: 'playable' } }) });
    assert.deepEqual(posted.map((p) => JSON.parse(p).mark.kind), ['playable'], 'the report reached the origin');
    const marks = await (await fetch(`${base}/__proxy/marks`)).json();
    assert.equal(marks.length, 1); assert.equal(marks[0].mark.kind, 'playable'); assert.equal(marks[0].url, '/api/prefetch/game');
  } finally { await proxy.close(); origin.close(); }
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bin = lines.find((l) => l.url?.startsWith('/bin'));
  assert.equal(bin.kind, 'bg'); assert.equal(bin.unit, 'hit'); assert.equal(bin.wire, BIN.length + 200); assert.ok(bin.ms >= 260);
  const text = lines.find((l) => l.url === '/api/x');
  assert.equal(text.enc, 'gzip'); assert.ok(text.wire < 2000, `the gzip bytes on the wire: ${text.wire}`);
  assert.ok(lines.some((l) => l.mark?.kind === 'playable'), 'the mark in the log');
  fs.rmSync(dir, { recursive: true, force: true });
});
