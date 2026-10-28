// The home's module graph preloaded (src/host/module-graph.js, server.js sendHome): the page carries a
// <link rel="modulepreload"> for every module of its static graph below its first level, its validator its content's
// (a 304 while nothing changed), the page as it is with opts.homePreload false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { moduleGraph, withPreloads, staticImports } from '../src/host/module-graph.js';
import { createServer } from '../src/host/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(ROOT, 'src/host/web/index.html');
const get = (url, headers = {}) => new Promise((resolve, reject) => http.get(url, { headers }, (res) => {
  const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ res, body: Buffer.concat(parts) }));
}).on('error', reject));

test('module graph: levels from the page, deeper ones preloaded before the first module script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-graph-'));
  try {
    fs.mkdirSync(path.join(dir, 'w'));
    fs.writeFileSync(path.join(dir, 'w/index.html'), '<link rel="stylesheet" href="/w/s.css"><script type="module" src="/w/a.js"></script>');
    fs.writeFileSync(path.join(dir, 'w/s.css'), '');
    fs.writeFileSync(path.join(dir, 'w/a.js'), "import { b } from './b.js';\n// import './not.js';\nimport('./later.js');\n");
    fs.writeFileSync(path.join(dir, 'w/b.js'), "export * from './c.js';\nimport './a.js';\n");
    fs.writeFileSync(path.join(dir, 'w/c.js'), "import './gone.js';\n");
    const g = moduleGraph(dir, path.join(dir, 'w/index.html'));
    assert.deepEqual([...g.level].map(([f, d]) => [path.relative(dir, f), d]), [['w/a.js', 1], ['w/b.js', 2], ['w/c.js', 3]], 'a missing module out, a cycle once');
    assert.deepEqual([...g.dynamic].map((f) => path.relative(dir, f)), ['w/later.js']);
    assert.deepEqual(g.css.map((f) => path.relative(dir, f)), ['w/s.css']);
    assert.equal(withPreloads(dir, g.text, g.level),
      '<link rel="stylesheet" href="/w/s.css"><link rel="modulepreload" href="/w/b.js">\n<link rel="modulepreload" href="/w/c.js">\n<script type="module" src="/w/a.js"></script>');
    assert.deepEqual(staticImports("export const x = 1;\nimport y from '/z.js'"), ['/z.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: the home carries its graph\'s deeper levels, revalidated by its content; off: as it is', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-home-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'man'));
  const servers = [createServer({ manifests: path.join(dir, 'man') }), createServer({ manifests: path.join(dir, 'man'), homePreload: false })];
  for (const s of servers) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { s.closeAllConnections(); s.close(r); })); }
  const [on, off] = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
  const g = moduleGraph(ROOT, HOME), deep = [...g.level].filter(([, d]) => d >= 2).map(([f]) => '/' + path.relative(ROOT, f));
  assert.ok(deep.length > 0);
  const plain = await get(`${on}/`);
  assert.equal(plain.res.statusCode, 200);
  const text = plain.body.toString();
  const links = [...text.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(links.slice().sort(), deep.slice().sort(), 'every module of levels 2+, once');
  assert.ok(!links.includes('/src/host/web/main.js'), 'not the page\'s own scripts');
  assert.ok(text.indexOf('modulepreload') < text.indexOf('<script type="module"'));
  // (brotli for a browser that takes it, the same page)
  const br = await get(`${on}/`, { 'Accept-Encoding': 'br' });
  assert.equal(br.res.headers['content-encoding'], 'br');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), text);
  // (a returning browser: 304 by the page's content)
  const etag = plain.res.headers.etag;
  assert.equal((await get(`${on}/`, { 'If-None-Match': etag, 'Accept-Encoding': 'br' })).res.statusCode, 304);
  assert.equal((await get(`${on}/index.html`, { 'If-None-Match': 'W/"other"' })).res.statusCode, 200);
  // off: the file as it is
  assert.deepEqual((await get(`${off}/`)).body, fs.readFileSync(HOME));
});
