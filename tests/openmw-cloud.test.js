import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../src/ports/openmw/cloud.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 10));
function browser(remote = null, state = null, { dates = true } = {}) {
  const files = new Map(), storage = new Map(), messages = [], writes = [], events = {}, reads = [], times = new Map();
  let clock = 1000;
  if (state) storage.set('orthros.openmw.cloud.user.game', JSON.stringify(state));
  let cloud = remote ? gzipSync(JSON.stringify({ format: 'orthros-profile', version: 1, game: 'game', files: remote })) : null;
  let head = cloud ? 'remote-head' : 'none', fail = false, failStatus = 409;
  const FS = {
    syncfs(_populate, cb) { cb(null); },
    readdir(root) { const prefix = root + '/'; return ['.', '..', ...new Set([...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]))]; },
    // (as MEMFS: a file's size and date — the date of its last write, a Date —; `dates` false: a file system without)
    stat(p) { return files.has(p) ? { mode: 1, size: files.get(p).length, mtime: dates ? new Date(times.get(p) ?? 0) : undefined } : { mode: 2 }; },
    isDir: (m) => m === 2, isFile: (m) => m === 1,
    readFile: (p) => { reads.push(p); return files.get(p); }, writeFile: (p, b) => { files.set(p, new Uint8Array(b)); times.set(p, clock++); },
    mkdirTree() {}, unlink: (p) => files.delete(p), rmdir() {},
  };
  const window = { parent: { postMessage: (m) => messages.push(m) }, addEventListener: (n, cb) => events[n] = cb };
  runInNewContext(source, { window, document: { createElement: () => ({ setAttribute() {} }), body: { prepend() {} } },
    crypto: webcrypto, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, Uint8Array,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('binary'), location: { origin: 'https://orthros.test' },
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    fetch: async (_url, options) => {
      assert.equal(options.headers['X-Orthros-Player-Scope'], 'user');
      if (options.method === 'PUT') {
        writes.push(options);
        if (fail) return new Response('{}', { status: failStatus });
        assert.equal(options.headers['X-Orthros-Parent-Hash'], head);
        cloud = Buffer.from(options.body); head = 'head-' + writes.length;
        return new Response(JSON.stringify({ hash: head }));
      }
      return cloud ? new Response(cloud, { headers: { 'X-Orthros-Backup-Hash': head } }) : new Response('{}', { status: 404 });
    },
  });
  window.orthrosCloudInstall(FS, 'game', 'user');
  // (`put`: a write by the engine, its date the next millisecond)
  return { FS, files, storage, messages, writes, events, window, reads, fail: (status = 409) => { fail = true; failStatus = status; }, recover: () => { fail = false; }, put: (p, b) => FS.writeFile(p, b),
    cloud: () => JSON.parse(gunzipSync(cloud)), sync: () => new Promise((r) => FS.syncfs(false, r)),
    ready: () => new Promise((r) => FS.syncfs(true, r)) };
}
async function uploaded(b, count) {
  for (let n = 0; n < 100 && (b.writes.length < count || b.messages.at(-1)?.state !== 'saved'); n++) await tick();
  assert.equal(b.writes.length, count); assert.equal(b.messages.at(-1).state, 'saved');
}

test('OpenMW restores full account files before boot and uploads binary saves with optimistic hashes', async () => {
  const b = browser([{ path: 'saves/old.omwsave', data: 'AP9h' }]);
  b.files.set('/userdata/stale', new Uint8Array([4]));
  await b.ready();
  assert.equal(b.files.has('/userdata/stale'), false);
  assert.deepEqual([...b.files.get('/userdata/saves/old.omwsave')], [0, 255, 97]);
  b.files.set('/userdata/saves/new.omwsave', new Uint8Array([0, 1, 254]));
  await b.sync(); await uploaded(b, 1);
  assert.equal(b.cloud().files.find((f) => f.path === 'saves/new.omwsave').data, 'AAH+');
  b.files.set('/userdata/config/openmw/openmw.log', new Uint8Array([99]));
  await b.sync(); await tick();
  assert.equal(b.writes.length, 1, 'unchanged files do not grow backup history');
  assert.equal(JSON.parse([...b.storage.values()][0]).dirty, false);
  b.files.set('/userdata/saves/new.omwsave', new Uint8Array([5]));
  await b.sync(); await uploaded(b, 2);
  assert.equal(b.writes[1].headers['X-Orthros-Parent-Hash'], 'head-1');
});

test('OpenMW cloud conflicts preserve local saves, suspend uploads and warn before closing', async () => {
  const b = browser(); await b.ready();
  b.files.set('/userdata/save', new Uint8Array([9])); b.fail(); await b.sync();
  for (let n = 0; n < 100 && !b.messages.at(-1)?.error; n++) await tick();
  assert.match(b.messages.at(-1).message, /Conflit/); assert.equal(b.messages.at(-1).state, 'conflict');
  assert.deepEqual([...b.files.get('/userdata/save')], [9]);
  assert.equal(JSON.parse([...b.storage.values()][0]).dirty, true);
  let warned = false; b.events.beforeunload({ preventDefault() { warned = true; } }); assert.ok(warned);
  await b.sync(); await tick(); assert.equal(b.writes.length, 1);
});

test('OpenMW refuses boot when an unsent local copy conflicts with another device', async () => {
  const b = browser([{ path: 'save', data: 'AA==' }], { dirty: true, parent: 'older-head' });
  b.files.set('/userdata/save', new Uint8Array([9]));
  let booted = false; b.FS.syncfs(true, () => { booted = true; });
  for (let n = 0; n < 100 && !b.messages.at(-1)?.error; n++) await tick();
  assert.equal(booted, false); assert.match(b.messages.at(-1).message, /Conflit/);
  assert.deepEqual([...b.files.get('/userdata/save')], [9]); assert.equal(b.writes.length, 0);
});

test('OpenMW answers the Orthros page\'s flush once the account has the saves', async () => {
  const b = browser(); await b.ready();
  b.files.set('/userdata/saves/a.omwsave', new Uint8Array([1, 2]));
  b.events.message({ origin: 'https://orthros.test', source: {}, data: { type: 'orthros-flush' } }); // (not the page around it: ignored)
  await tick(); assert.equal(b.messages.filter((m) => m.type === 'orthros-flushed').length, 0);
  b.events.message({ origin: 'https://orthros.test', source: b.window.parent, data: { type: 'orthros-flush' } });
  for (let n = 0; n < 100 && !b.messages.some((m) => m.type === 'orthros-flushed'); n++) await tick();
  assert.equal(b.messages.find((m) => m.type === 'orthros-flushed').ok, true);
  assert.equal(b.writes.length, 1);
  assert.equal(b.cloud().files[0].path, 'saves/a.omwsave');
});

test('OpenMW syncs that changed nothing read, encode and send nothing; a file written again unchanged is not sent', async () => {
  for (const dates of [true, false]) {
    const b = browser(null, null, { dates }); await b.ready();
    b.put('/userdata/saves/a.omwsave', new Uint8Array(300000).fill(7)); b.put('/userdata/config/settings.cfg', new TextEncoder().encode('[Video]\n'));
    await b.sync(); await uploaded(b, 1);
    b.reads.length = 0;
    await b.sync(); await tick();
    assert.equal(b.writes.length, 1);
    if (dates) assert.deepEqual(b.reads, [], 'nothing read when no file changed');
    // (the engine writes its settings again every 15 s, the same bytes: read, found the same, not sent)
    b.reads.length = 0; b.put('/userdata/config/settings.cfg', new TextEncoder().encode('[Video]\n'));
    await b.sync(); await tick();
    assert.equal(b.writes.length, 1, 'the same bytes: nothing sent');
    if (dates) assert.deepEqual(b.reads, ['/userdata/config/settings.cfg'], 'only the file written again');
    assert.equal(JSON.parse([...b.storage.values()][0]).dirty, false);
    // (a save changed, one removed, one added: sent)
    b.put('/userdata/saves/a.omwsave', new Uint8Array(300000).fill(8)); await b.sync(); await uploaded(b, 2);
    assert.equal(b.cloud().files.find((f) => f.path === 'saves/a.omwsave').data, Buffer.alloc(300000, 8).toString('base64'));
    b.files.delete('/userdata/saves/a.omwsave'); await b.sync(); await uploaded(b, 3);
    assert.deepEqual(b.cloud().files.map((f) => f.path), ['config/settings.cfg']);
    b.put('/userdata/saves/b.omwsave', new Uint8Array([1])); await b.sync(); await uploaded(b, 4);
    assert.deepEqual(b.cloud().files.map((f) => f.path).sort(), ['config/settings.cfg', 'saves/b.omwsave']);
  }
});

test('OpenMW sends again after a failed upload, even when nothing changed since', async () => {
  const b = browser(); await b.ready();
  b.put('/userdata/save', new Uint8Array([1])); await b.sync(); await uploaded(b, 1);
  b.put('/userdata/save', new Uint8Array([2])); b.fail(503); await b.sync();
  for (let n = 0; n < 100 && b.messages.at(-1)?.state !== 'error'; n++) await tick();
  assert.equal(b.writes.length, 2); assert.equal(JSON.parse([...b.storage.values()][0]).dirty, true, 'not on the account yet');
  b.recover(); await b.sync(); await uploaded(b, 3);
  assert.equal(b.cloud().files[0].data, 'Ag==', 'the change the failed upload had');
});
