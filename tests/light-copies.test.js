// Light copies (src/host/light-copies.js, docs/slow-network.md "Light copies"): a DDS texture without its finest mip
// levels — the format's cases —, marked in a browser port's tree and served under .light/ (its ranges, its read reports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lightDds, LIGHT_SIDE } from '../src/host/light-copies.js';
import { listGameTree } from '../src/host/game-files.js';
import { createServer } from '../src/host/server.js';

/** A DDS texture: its header (DX10's too when `dxgi`), then its levels' bytes (each level's bytes its own value). */
export function dds({ w, h, mips, four = 'DXT1', bits = 0, rgb = false, dxgi = 0, caps2 = 0, pitch = false, cut = 0 }) {
  const head = Buffer.alloc(dxgi ? 148 : 128);
  head.write('DDS ', 0, 'latin1'); head.writeUInt32LE(124, 4);
  head.writeUInt32LE(0x1007 | 0x20000 | (pitch ? 0x8 : 0x80000), 8); head.writeUInt32LE(h, 12); head.writeUInt32LE(w, 16); head.writeUInt32LE(mips, 28);
  head.writeUInt32LE(32, 76); head.writeUInt32LE(rgb ? 0x41 : 0x4, 80);
  if (!rgb) head.write(dxgi ? 'DX10' : four, 84, 'latin1'); else head.writeUInt32LE(bits, 88);
  head.writeUInt32LE(caps2, 112);
  if (dxgi) { head.writeUInt32LE(dxgi, 128); head.writeUInt32LE(3, 132); head.writeUInt32LE(1, 140); }
  const unit = rgb ? bits / 8 : dxgi ? 16 : four === 'DXT1' ? 8 : 16, levels = [];
  for (let i = 0; i < mips; i++) {
    const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i);
    levels.push(Buffer.alloc(rgb ? lw * lh * unit : Math.ceil(lw / 4) * Math.ceil(lh / 4) * unit, i + 1));
  }
  const all = Buffer.concat([head, ...levels]);
  return { bytes: all.subarray(0, all.length - cut), levels, head };
}

test('a large DDS texture\'s light copy leaves its finest levels out: the same format, the header telling the smaller size', () => {
  assert.equal(LIGHT_SIDE, 256);
  const t = dds({ w: 1024, h: 1024, mips: 11 }), c = lightDds(t.bytes.subarray(0, 148), t.bytes.length), cut = t.levels[0].length + t.levels[1].length;
  assert.equal(c.from, 128 + cut); assert.equal(c.size, t.bytes.length - cut);
  assert.equal(c.head.readUInt32LE(16), 256); assert.equal(c.head.readUInt32LE(12), 256); assert.equal(c.head.readUInt32LE(28), 9);
  assert.equal(c.head.readUInt32LE(20), t.levels[2].length, 'the linear size of its first level');
  // (a long texture: its longest side down to LIGHT_SIDE, its levels as they are)
  const long = dds({ w: 2048, h: 8192, mips: 14, four: 'DXT5' }), cl = lightDds(long.bytes, long.bytes.length);
  assert.deepEqual([cl.head.readUInt32LE(16), cl.head.readUInt32LE(12), cl.head.readUInt32LE(28)], [64, 256, 9]);
  assert.deepEqual(long.bytes.subarray(cl.from, cl.from + 16), Buffer.alloc(16, 6), 'from its sixth level on');
  // (uncompressed, its pitch; DX10 with a block-compressed format)
  const rgba = dds({ w: 1024, h: 512, mips: 3, rgb: true, bits: 32, pitch: true }), cr = lightDds(rgba.bytes, rgba.bytes.length);
  assert.deepEqual([cr.head.readUInt32LE(16), cr.head.readUInt32LE(12), cr.head.readUInt32LE(20), cr.head.readUInt32LE(28)], [256, 128, 1024, 1]);
  const bc7 = dds({ w: 2048, h: 2048, mips: 12, dxgi: 98 }), c7 = lightDds(bc7.bytes, bc7.bytes.length);
  assert.equal(c7.head.length, 148); assert.equal(c7.from, 148 + bc7.levels.slice(0, 3).reduce((n, l) => n + l.length, 0));
  // (nothing to gain, or not as its header says: none)
  for (const [what, x] of [['small', dds({ w: 256, h: 256, mips: 9 })], ['no levels below', dds({ w: 2048, h: 2048, mips: 1 })],
    ['a cube', dds({ w: 1024, h: 1024, mips: 11, caps2: 0x200 })], ['cut short', dds({ w: 1024, h: 1024, mips: 11, cut: 9 })]]) assert.equal(lightDds(x.bytes, x.bytes.length), null, what);
  assert.equal(lightDds(Buffer.from('not a texture at all, not at all, no'), 36), null);
});

test('a browser port\'s tree tells its textures\' light size, served under .light/ and learned from read reports; a Windows game\'s does not', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-light-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), game = path.join(games, 'mw');
  fs.mkdirSync(path.join(game, 'base/Textures'), { recursive: true }); fs.mkdirSync(path.join(game, 'versions/1'), { recursive: true });
  const big = dds({ w: 1024, h: 1024, mips: 11 });
  fs.writeFileSync(path.join(game, 'base/Textures/big.dds'), big.bytes); fs.writeFileSync(path.join(game, 'base/Textures/small.dds'), dds({ w: 256, h: 256, mips: 9 }).bytes);
  fs.writeFileSync(path.join(game, 'base/Game.esm'), 'esm');
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'mw', name: 'MW', defaultVersion: 'mw-1', defaults: { runtime: 'openmw' },
    versions: [{ id: 'mw-1', dir: '1', version: '1', openmw: { engine: 'e1', files: ['Game.esm'] } }] }));
  fs.mkdirSync(path.join(engines, 'e1/moddata'), { recursive: true });
  const server = createServer({ gamesDir: games, enginesDir: engines });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cut = big.levels[0].length + big.levels[1].length, tree = await (await fetch(base + '/api/tree/mw-1')).json(), light = big.bytes.length - cut;
  assert.equal(tree.dirs.Textures.files['big.dds'].light, light); assert.equal(tree.dirs.Textures.files['small.dds'].light, undefined);
  const got = Buffer.from(await (await fetch(`${base}/gamez/mw-1/.light/Textures/big.dds?r=100-${light}`)).arrayBuffer());
  const want = Buffer.concat([lightDds(big.bytes, big.bytes.length).head, big.bytes.subarray(128 + cut)]);
  assert.deepEqual(got, want.subarray(100));
  assert.equal((await fetch(`${base}/gamez/mw-1/.light/Textures/small.dds?r=0-10`)).status, 404);
  assert.equal((await fetch(`${base}/gamez/mw-1/.light/Game.esm?r=0-3`)).status, 404);
  const prefetch = `${base}/api/prefetch/mw-1`;
  await fetch(prefetch, { method: 'POST', body: JSON.stringify({ session: 's', reads: [['.light/Textures/big.dds', 0, light, 5], ['.light/Textures/big.dds', 0, light + 1, 6]] }) });
  assert.deepEqual(await (await fetch(prefetch)).json(), [['.light/Textures/big.dds', 0, (1 << Math.ceil(light / 65536)) - 1, 5]], 'its pieces; a read past its end left out');
  // (a Windows game reads its files as they are)
  assert.equal(listGameTree({ folder: path.join(game, 'versions/1'), baseFolder: path.join(game, 'base'), lightCopies: false }).dirs.Textures.files['big.dds'].light, undefined);
});
