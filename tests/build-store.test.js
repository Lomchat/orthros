// Frozen builds (src/server/build-store.js, docs/builds.md): a page's code comes from one immutable build — a deploy
// during its session (the live tree changed, the server restarted) never hands it a module of another version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server/server.js';
import { BuildStore } from '../src/server/build-store.js';

const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('frozen builds: a session keeps its build across a deploy and a restart; the stable pin; nothing of another version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-builds-')), tree = path.join(dir, 'tree'), store = path.join(dir, 'builds');
  write(tree, 'src/web/index.html', '<html><head><link rel="stylesheet" href="/src/web/a.css"></head><body><script type="module" src="/src/web/main.js"></script></body></html>');
  write(tree, 'src/web/main.js', "import './a.js';\n");
  write(tree, 'src/web/a.js', "export const a = 'A1';\n");
  write(tree, 'src/web/a.css', 'body {}');
  write(tree, 'src/web/worker.js', "import '../core/vm.js';\n");
  write(tree, 'src/core/vm.js', 'export const machine = 1;\n');
  write(tree, 'src/server/x.js', 'one');
  fs.mkdirSync(path.join(dir, 'man'));
  const start = async () => {
    const server = createServer({ manifests: path.join(dir, 'man'), buildsDir: store, buildRoot: tree, buildsLog: () => {}, buildsOptions: { settleMs: 0, checkMs: 0 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, get: (p, h = {}) => fetch(base + p, { headers: h, redirect: 'manual' }), stop: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
  };
  const homeBuild = async (s, h) => { const html = await (await s.get('/', h)).text(); return /\/b\/([0-9a-f]{16})\/src\/web\/main\.js/.exec(html)?.[1]; };
  fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(path.join(store, 'channel.json'), JSON.stringify({ mode: 'auto' })); // (the default is restart)
  let s = await start();
  try {
    const home = await (await s.get('/')).text(), A = await homeBuild(s);
    assert.ok(A, 'the home names its build');
    assert.ok(home.includes(`href="/b/${A}/src/web/a.css"`) && home.includes(`<link rel="modulepreload" href="/b/${A}/src/web/a.js">`), 'every address of the page in the build');
    let r = await s.get(`/b/${A}/src/web/a.js`);
    assert.equal(await r.text(), "export const a = 'A1';\n");
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await s.get(`/b/${A}/src/web/a.js`, { 'If-None-Match': r.headers.get('etag') })).status, 304);
    assert.equal((await s.get(`/b/${A}/src/server/x.js`)).status, 404, "the server's code is no build's");
    // (a server-only change: the same build — players download nothing again)
    write(tree, 'src/server/x.js', 'two');
    assert.equal(await homeBuild(s), A);
    // a deploy: the next page gets a new build, the page of before still gets its own bytes
    write(tree, 'src/web/a.js', "export const a = 'A2';\n");
    const B = await homeBuild(s);
    assert.ok(B && B !== A);
    assert.equal(await (await s.get(`/b/${A}/src/web/a.js`)).text(), "export const a = 'A1';\n");
    assert.equal(await (await s.get(`/b/${B}/src/web/a.js`)).text(), "export const a = 'A2';\n");
    // (an absolute /src/ address asked by a build's module: from that build)
    r = await s.get('/src/web/a.js', { Referer: `http://x/b/${A}/src/web/main.js` });
    assert.equal(r.status, 307); assert.equal(r.headers.get('location'), `/b/${A}/src/web/a.js`);
    // (the snapshot key's sources are the page's build's; a build not kept: none, and no other version's file)
    assert.deepEqual(await (await s.get(`/api/snapshot-sources?build=${A}`)).json(), await (await s.get('/api/snapshot-sources')).json(), 'vm.js unchanged: the same key');
    assert.equal((await s.get('/api/snapshot-sources?build=0123456789abcdef')).status, 410);
    assert.equal((await s.get('/b/0123456789abcdef/src/web/a.js')).status, 410);
  } finally { await s.stop(); }
  // a restart: the builds of before still served; the stable pin, and ?channel=main for the live tree's
  s = await start();
  try {
    const ids = fs.readdirSync(store).filter((n) => /^[0-9a-f]{16}$/.test(n)), B = await homeBuild(s), old = ids.find((i) => i !== B);
    assert.equal(ids.length, 2);
    assert.equal(await (await s.get(`/b/${old}/src/web/a.js`)).text(), "export const a = 'A1';\n");
    // (the restart channel: the build of the server's start — a merge reaches players at the next restart)
    fs.writeFileSync(path.join(store, 'channel.json'), JSON.stringify({ mode: 'restart' }));
    write(tree, 'src/web/a.js', "export const a = 'A3';\n");
    assert.equal(await homeBuild(s), B);
    assert.notEqual(await homeBuild(s, { Cookie: 'orthros_channel=main' }), B);
    write(tree, 'src/web/a.js', "export const a = 'A2';\n");
    fs.writeFileSync(path.join(store, 'channel.json'), JSON.stringify({ stable: old }));
    assert.equal(await homeBuild(s), old, 'pinned: players get the stable build');
    const main = await s.get('/?channel=main');
    assert.match(main.headers.get('set-cookie'), /orthros_channel=main/);
    assert.equal(await homeBuild(s, { Cookie: 'orthros_channel=main' }), B);
    // (kept while pinned; unpinned and unused past keepMs: removed, its own bytes too, the live build's kept)
    const st = new BuildStore({ root: tree, dir: store, keepMs: 3600e3 });
    st.prune(Date.now() + 2 * 3600e3);
    assert.ok(st.get(old));
    fs.writeFileSync(path.join(store, 'channel.json'), JSON.stringify({ stable: null }));
    st.readPin(); st.prune(Date.now() + 2 * 3600e3);
    assert.equal(st.get(old), null);
    assert.equal(fs.readdirSync(path.join(store, 'blobs')).length, 6, 'the live build\'s files (main, a, a.css, worker, vm, index) left');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no page code names the live tree by an absolute /src/ address (it would load another version than its build)', () => {
  const root = new URL('../src/', import.meta.url).pathname, bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (f !== path.join(root, 'server')) walk(f); continue; }
      if (!/\.m?js$/.test(e.name)) continue;
      // (comments aside: the prose names files by their tree path)
      const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
      if (/['"`]\/src\//.test(code)) bad.push(path.relative(root, f));
    }
  };
  walk(root);
  assert.deepEqual(bad, [], 'a module, worker or worklet named from import.meta.url (a classic script: document.currentScript)');
});
