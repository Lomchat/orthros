// tools/engine-br.mjs: an engine release's brotli siblings (what sendEngineFile sends and engineOf counts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { precompress } from '../tools/engine-br.mjs';

test('engine-br: compressible files get a sibling that decodes to them; archives, gamefiles/ and kept ones left', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-ebr-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const text = Buffer.from('export const x = 1;\n'.repeat(4000));
  fs.mkdirSync(path.join(d, 'engine'), { recursive: true }); fs.mkdirSync(path.join(d, 'gamefiles'));
  fs.writeFileSync(path.join(d, 'release.json'), '{}');
  fs.writeFileSync(path.join(d, 'engine', 'index.js'), text);
  fs.writeFileSync(path.join(d, 'engine', 'x.wasm'), Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), text]));
  fs.writeFileSync(path.join(d, 'engine', 'noise.wasm'), crypto.randomBytes(8192));
  fs.writeFileSync(path.join(d, 'engine', 'extras.pk3'), text);
  fs.writeFileSync(path.join(d, 'gamefiles', 'db.txt'), text);
  const r = precompress(d);
  const by = Object.fromEntries(r.map((x) => [x.rel, x]));
  assert.ok(by['engine/index.js'].br < text.length / 10);
  assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(d, 'engine', 'index.js.br'))), text);
  assert.ok(fs.statSync(path.join(d, 'engine', 'index.js.br')).mtimeMs >= fs.statSync(path.join(d, 'engine', 'index.js')).mtimeMs);
  assert.ok(fs.existsSync(path.join(d, 'engine', 'x.wasm.br')));
  assert.equal(by['engine/noise.wasm'].br, null); assert.ok(!fs.existsSync(path.join(d, 'engine', 'noise.wasm.br'))); // (not worth it)
  assert.ok(!fs.existsSync(path.join(d, 'engine', 'extras.pk3.br')));
  assert.ok(!fs.existsSync(path.join(d, 'gamefiles', 'db.txt.br')));
  assert.ok(!fs.readdirSync(path.join(d, 'engine')).some((n) => n.includes('.tmp')));
  // (again: kept)
  assert.ok(precompress(d).find((x) => x.rel === 'engine/index.js').kept);
});
