// PNG encoding on the CPU (cursors): the image decodes back to the same RGBA (the project's decoder and zlib's
// checks: chunk CRCs, adler-32), including images larger than one 64 KiB stored deflate block; the browser display
// defines an image cursor from such PNGs at once, without any canvas (a 2D canvas waits on the GPU process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodePng, decodePng } from '../src/gfx/codecs/png.js';
import { BrowserDisplay } from '../src/host/browser-host.js';

const image = (w, h) => { const px = new Uint8Array(w * h * 4); for (let i = 0; i < px.length; i++) px[i] = (i * 37 + 11) & 255; return px; };

test('encodePng: decodes back to the same pixels; chunk CRCs and the zlib stream are valid', () => {
  for (const [w, h] of [[1, 1], [32, 32], [3, 7], [200, 120]]) {
    const px = image(w, h), png = encodePng(px, w, h);
    const d = decodePng(png);
    assert.equal(d.width, w); assert.equal(d.height, h);
    assert.deepEqual(Buffer.from(d.data), Buffer.from(px));
    const dv = new DataView(png.buffer); let p = 8; const idat = [];
    while (p < png.length) {
      const n = dv.getUint32(p), type = Buffer.from(png.subarray(p + 4, p + 8)).toString('latin1');
      assert.equal(zlib.crc32(png.subarray(p + 4, p + 8 + n)), dv.getUint32(p + 8 + n), `${type} CRC`);
      if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + n));
      p += 12 + n;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat)); // (throws on a bad adler-32)
    assert.equal(raw.length, (w * 4 + 1) * h);
  }
});

test('an image cursor is defined from CPU-encoded PNGs at once (no canvas), then selected', () => {
  const posts = [];
  const host = { post: (m, t) => posts.push([m, t]) };
  const display = Object.create(BrowserDisplay.prototype); display.host = host; // (no canvases: none may be used)
  const frames = [{ w: 2, h: 2, rgba: image(2, 2), hotX: 1, hotY: 0 }, { w: 2, h: 2, rgba: image(2, 2).reverse(), hotX: 1, hotY: 0 }];
  display.setCursor(0x1234, { frames, steps: [[0, 10], [1, 10]] }, 0);
  assert.equal(posts.length, 2);
  const [def, transfer] = posts[0];
  assert.equal(def.type, 'cursor-def'); assert.equal(def.id, 0x1234); assert.equal(def.frames.length, 2);
  assert.deepEqual(Buffer.from(decodePng(new Uint8Array(def.frames[1].png)).data), Buffer.from(frames[1].rgba));
  assert.equal(transfer.length, 2, 'the PNG buffers are transferred');
  assert.deepEqual(posts[1][0], { type: 'cursor-set', id: 0x1234 });
  display.setCursor(0x1234, { frames, steps: [] }, 0);
  assert.equal(posts.length, 2, 'the same cursor again: nothing posted');
});
