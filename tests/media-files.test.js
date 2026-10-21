// Media files after the rest (docs/slow-network.md "Media files after the rest"): the server marks movies, music and
// long sounds in the tree by format; on a link that is not fast the learned order puts them after every other entry
// and the startup set leaves them out; the offline copy downloads them last; no guessed blocks for a media file the
// game is not streaming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMediaFile, MEDIA_WAV_BYTES, treeFiles } from '../src/vfs/game-tree.js';
import { listGameTree } from '../src/host/game-files.js';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { NetLink } from '../src/vfs/net-link.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';
import { forLink, startupHead } from '../src/vfs/data-worker.js';

const MiB = 1 << 20;
const byteAt = (i) => (i * 7 + (i >> 9)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
const tree = () => ({
  dirs: { Video: { dirs: {}, files: { 'intro.bik': { size: 3 * MiB, mtime: 1, media: true } } } },
  files: { 'data.bsa': { size: 3 * MiB, mtime: 1 }, 'title.mp3': { size: 2 * MiB, mtime: 1, media: true } },
});
const mid = () => new NetLink({ bw: 1 << 20, fixed: true }); // (neither thin nor fast)

test('media files by format: movies, music, a long .wav; not a short sound nor a game archive', () => {
  for (const n of ['a.bik', 'B.BK2', 'm.mp3', 'm.ogg', 'v.avi', 'v.mpg', 'v.wmv', 'v.smk', 'v.webm']) assert.ok(isMediaFile(n, 10), n);
  assert.ok(isMediaFile('speech.wav', MEDIA_WAV_BYTES));
  assert.ok(!isMediaFile('click.wav', MEDIA_WAV_BYTES - 1));
  for (const n of ['data.bsa', 'tex.dds', 'game.big', 'bik']) assert.ok(!isMediaFile(n, 1 << 30), n);
});

test('the server\'s tree marks media files (media: true), and the tree\'s file list keeps the mark', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-media-'));
  try {
    fs.mkdirSync(path.join(root, 'Video'));
    fs.writeFileSync(path.join(root, 'Video', 'logo.bik'), 'x');
    fs.writeFileSync(path.join(root, 'click.wav'), 'x');
    fs.writeFileSync(path.join(root, 'speech.wav'), Buffer.alloc(MEDIA_WAV_BYTES));
    fs.writeFileSync(path.join(root, 'data.bsa'), 'x');
    const t = listGameTree({ folder: root });
    assert.equal(t.dirs.Video.files['logo.bik'].media, true);
    assert.equal(t.files['speech.wav'].media, true);
    assert.equal(t.files['click.wav'].media, undefined);
    assert.equal(t.files['data.bsa'].media, undefined);
    const list = Object.fromEntries(treeFiles(t).map((f) => [f.path, !!f.media]));
    assert.deepEqual(list, { 'Video/logo.bik': true, 'click.wav': false, 'speech.wav': true, 'data.bsa': false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('learned order on a link that is not fast: media entries after all the others, in their order; the startup set without them', () => {
  const part = { files: new HttpBackend('/game/m/', tree()) };
  const list = [['Video/intro.bik', 0, 0xffff, 0], ['data.bsa', 0, 1, 100], ['title.mp3', 0, 0xffff, 200], ['data.bsa', 1, 1, 300], ['Video/intro.bik', 1, 0xffff, 400]];
  assert.deepEqual(forLink(part, list, false).map(([p, b]) => `${p}#${b}`), ['data.bsa#0', 'data.bsa#1', 'Video/intro.bik#0', 'title.mp3#0', 'Video/intro.bik#1']);
  assert.deepEqual(forLink(part, list, true), list, 'a fast link: the order as learned');
  assert.deepEqual(startupHead(part, forLink(part, list, false), false).map(([p, b]) => `${p}#${b}`), ['data.bsa#0', 'data.bsa#1']);
  // (the pause before the media: a gap of the startup set measured between the entries left)
  const paused = [['data.bsa', 0, 1, 0], ['title.mp3', 0, 1, 1000], ['data.bsa', 1, 1, 1900], ['data.bsa', 2, 1, 9000]];
  assert.deepEqual(startupHead(part, forLink(part, paused, false), false).map(([p, b]) => `${p}#${b}`), ['data.bsa#0', 'data.bsa#1']);
  assert.deepEqual(startupHead(part, forLink(part, paused, true), true).map(([p, b]) => `${p}#${b}`), ['data.bsa#0', 'title.mp3#0', 'data.bsa#1']);
});

test('offline copy: the media files\' blocks after every other block, learned ones first among them', async () => {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url) => {
    const [, a, e] = /[?&]r=(\d+)-(\d+)/.exec(url).map(Number);
    calls.push(`${decodeURIComponent(url.split('?')[0].split('/').slice(3).join('/'))}#${a / BLOCK}`);
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(a, e).buffer };
  };
  try {
    const store = new MemBlockStore();
    const b = new HttpBackend('/game/o/', tree(), { store, encoded: true, net: new NetLink({ bw: 64 << 20, fixed: true }) });
    const p = {};
    await b.downloadAll(p, () => false, { alone: true, order: [['title.mp3', 1], ['data.bsa', 2], ['Video/intro.bik', 0]] });
    assert.ok(p.done);
    const firstMedia = calls.findIndex((c) => /\.(mp3|bik)#/.test(c));
    assert.ok(calls.slice(0, firstMedia).every((c) => c.startsWith('data.bsa#')) && calls.slice(firstMedia).every((c) => !c.startsWith('data.bsa#')), calls.join(' '));
    assert.equal(calls[0], 'data.bsa#2', 'the learned block first');
    assert.deepEqual(calls.slice(firstMedia, firstMedia + 2), ['title.mp3#1', 'Video/intro.bik#0'], 'the learned media blocks first among the media');
  } finally { globalThis.fetch = real; }
});

test('no guessed blocks for a media file the game is not streaming: neither near a miss nor the next ones; a stream keeps them', () => {
  const real = globalThis.fetch, realXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = async () => { throw new Error('no background fetch in this test'); };
  globalThis.XMLHttpRequest = class {
    open(m, url) { this.url = url; }
    setRequestHeader(k, v) { this.range = v; }
    getResponseHeader() { return null; }
    send() { const [, a, z] = /bytes=(\d+)-(\d+)/.exec(this.range); this.status = 206; this.response = bytes(+a, +z + 1).buffer; }
  };
  try {
    const b = new HttpBackend('/game/g/', tree(), { net: mid() });
    b.fillBackground = () => {};
    assert.ok(b.isMedia('title.mp3') && b.isMedia('Video/intro.bik') && !b.isMedia('data.bsa'));
    const out = new Uint8Array(100);
    // a game archive: the block, the next ones and those near it are guessed
    b.readPieces('data.bsa', 3 * MiB, 1, 1, MiB, MiB + 100, out, 0, 2);
    assert.deepEqual(out, bytes(MiB, MiB + 100));
    assert.ok(b.want.has('data.bsa#2') && b.near.has('data.bsa#0'));
    // a media file not streamed: its own block only
    b.readPieces('title.mp3', 2 * MiB, 1, 0, 0, 100, out, 0, 2);
    assert.deepEqual(out, bytes(0, 100));
    assert.ok(b.want.has('title.mp3#0'));
    assert.ok(!b.want.has('title.mp3#1') && !b.near.has('title.mp3#1'), 'no next nor near block');
    // being streamed: as any file
    b.streams.add('Video/intro.bik');
    b.readPieces('Video/intro.bik', 3 * MiB, 1, 0, CHUNK, CHUNK + 100, out, 0, 2);
    assert.ok(b.want.has('Video/intro.bik#1') && b.near.has('Video/intro.bik#1'));
  } finally { globalThis.fetch = real; globalThis.XMLHttpRequest = realXhr; }
});

test('the link as last measured: fast from FAST_BPS, not fast below it nor when never measured (a page skips its intro videos)', async () => {
  const { linkRate } = await import('../src/vfs/data-client.js');
  const { FAST_BPS } = await import('../src/vfs/net-link.js');
  const real = globalThis.localStorage, items = new Map();
  globalThis.localStorage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
  try {
    assert.equal(linkRate.fast(), false, 'never measured');
    linkRate.set(FAST_BPS - 1); assert.equal(linkRate.fast(), false);
    linkRate.set(FAST_BPS); assert.equal(linkRate.fast(), true);
  } finally { if (real === undefined) delete globalThis.localStorage; else globalThis.localStorage = real; }
});
