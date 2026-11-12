// Learned code shared by content (src/server/code-share.js): what one version's sessions learned about a module's code
// pages is served to another version whose module holds the same page bytes — at the page's own offset there, the
// version's own entries first; a page of one repeated byte lends nothing; `?share=0` serves the version's own only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server/server.js';

/** a minimal PE32 DLL whose image pages (from RVA 0x1000) are `pages` (4 KiB each), in one section */
function pe(pages) {
  const hdr = 0x400, raw = Buffer.concat(pages), b = Buffer.alloc(hdr + raw.length);
  b.write('MZ', 0); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80);
  const fh = 0x84; b.writeUInt16LE(0x14c, fh); b.writeUInt16LE(1, fh + 2); b.writeUInt16LE(224, fh + 16); b.writeUInt16LE(0x2102, fh + 18);
  const oh = fh + 20; b.writeUInt16LE(0x10b, oh); b.writeUInt32LE(0x10000000, oh + 28); b.writeUInt32LE(0x1000, oh + 32); b.writeUInt32LE(0x200, oh + 36);
  b.writeUInt32LE(0x1000 + raw.length, oh + 56); b.writeUInt32LE(hdr, oh + 60); b.writeUInt32LE(16, oh + 92);
  const sh = oh + 224; b.write('.text', sh); b.writeUInt32LE(raw.length, sh + 8); b.writeUInt32LE(0x1000, sh + 12); b.writeUInt32LE(raw.length, sh + 16); b.writeUInt32LE(hdr, sh + 20); b.writeUInt32LE(0x60000020, sh + 36);
  raw.copy(b, hdr);
  return b;
}
const page = (seed) => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * seed + (i >> 7)) & 0xff));

test('code share: a version is served what another learned of the same code pages, at their offsets there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-codeshare-'));
  const man = path.join(dir, 'man'), learnDir = path.join(dir, 'learn');
  fs.mkdirSync(man); fs.mkdirSync(learnDir);
  const pad = Buffer.alloc(4096, 0xcc);
  // (A's lib.dll: pages P1, P2, padding; B's: another page first, then P1, P2, the padding — the same code one page on)
  for (const [v, pages] of [['a', [page(3), page(5), pad]], ['b', [page(7), page(3), page(5), pad]]]) {
    fs.mkdirSync(path.join(dir, v)); fs.writeFileSync(path.join(dir, v, 'lib.dll'), pe(pages));
    fs.writeFileSync(path.join(man, `${v}.json`), JSON.stringify({ name: v, folder: path.join(dir, v), exe: 'x.exe' }));
  }
  const server = createServer({ manifests: man, learnDir, codeShareWarmMs: 1e9 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (k, v, q = '') => `http://127.0.0.1:${server.address().port}/api/${k}/${v}${q}`;
  const post = (k, v, body) => fetch(url(k, v), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // A learned: heat in P1 running into P2, heat in the padding page; region entries in P2 and in the padding
    await post('heat', 'a', { heat: [['LIB.dll', 0x1ff0, 0x20], ['lib.dll', 0x3010, 8]] });
    await post('regions', 'a', { regions: [['lib.dll', 0x2100, 0x27f, 50], ['lib.dll', 0x3000, null, 10]] });
    // B learned one entry of its own (a later first use than A's)
    await post('regions', 'b', { regions: [['lib.dll', 0x1000, null, 900]] });
    assert.deepEqual(await (await fetch(url('heat', 'b'))).json(), { 'lib.dll': [0x2ff0, 0x20] });
    assert.deepEqual(await (await fetch(url('regions', 'b'))).json(), [['lib.dll', 0x1000, null], ['lib.dll', 0x3100, 0x27f]]);
    assert.deepEqual(await (await fetch(url('heat', 'b', '?share=0'))).json(), {});
    assert.deepEqual(await (await fetch(url('regions', 'b', '?share=0'))).json(), [['lib.dll', 0x1000, null]]);
    // (A's own answers: its own data, B's entry in P0 — not in A's code — lends nothing)
    assert.deepEqual(await (await fetch(url('regions', 'a'))).json(), [['lib.dll', 0x3000, null], ['lib.dll', 0x2100, 0x27f]]);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
