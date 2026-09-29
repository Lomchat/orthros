// Image codecs (GDI+ image loading): PNG, baseline/progressive JPEG, DEFLATE, against references
// produced by an independent decoder (PIL). JPEG tolerance covers IDCT rounding differences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodePng } from '../src/gfx/codecs/png.js';
import { decodeJpeg } from '../src/gfx/codecs/jpeg.js';
import { inflate } from '../src/gfx/codecs/inflate.js';
import { parseImage, parseImageInfo } from '../src/win32/d3dx9-image.js';
import { FMT } from '../src/win32/d3d8.js';

const DIR = new URL('./fixtures/codec/', import.meta.url).pathname;
const read = (n) => fs.readFileSync(DIR + n);
const ref = (n) => inflate(read(n + '.rgba.z'));

function compare(got, want, tol, what) {
  assert.equal(got.length, want.length, `${what}: size`);
  let max = 0, sum = 0;
  for (let i = 0; i < want.length; i++) { const d = Math.abs(got[i] - want[i]); if (d > max) max = d; sum += d; }
  assert.ok(max <= tol, `${what}: max diff ${max} > ${tol} (mean ${(sum / want.length).toFixed(3)})`);
}

test('inflate: zlib streams (dynamic and stored blocks)', () => {
  const want = inflate(read('z.bin.z'));
  assert.equal(want.length, 50000);
  compare(inflate(read('z.z')), want, 0, 'z');
  compare(inflate(read('z0.z')), want, 0, 'z0 (stored)');
});

test('png: RGB, gray, palette, RGBA, 1-bit', () => {
  for (const [n, r] of [['rgb', 'rgb'], ['gray', 'gray'], ['pal', 'pal'], ['rgba', 'rgba'], ['bw', 'bw']]) {
    const img = decodePng(read(n + '.png'));
    assert.equal(img.width, 97); assert.equal(img.height, 61);
    compare(img.data, ref(r), 0, n);
  }
});

test('jpeg: baseline 4:2:0, progressive, 4:4:4, grayscale', () => {
  for (const [n, r] of [['base', 'base'], ['prog', 'prog'], ['sub444', 'sub444'], ['gray', 'grayjpg']]) {
    const img = decodeJpeg(read(n + '.jpg'));
    assert.equal(img.width, 97); assert.equal(img.height, 61);
    compare(img.data, ref(r), 3, n);
  }
});

test('jpeg: 4:2:2, restart intervals, q100, optimized tables, progressive 4:2:0, odd size, CMYK (tools/gen/codec_fixtures.py)', () => {
  for (const [n, w, h] of [['x-422', 97, 61], ['x-rst', 97, 61], ['x-rstrows', 97, 61], ['x-q100', 97, 61], ['x-opt', 97, 61], ['x-prog420', 97, 61], ['x-odd', 33, 17], ['x-cmyk', 40, 24]]) {
    const img = decodeJpeg(read(n + '.jpg'));
    assert.equal(img.width, w); assert.equal(img.height, h);
    compare(img.data, ref(n), 3, n);
  }
});

test('d3dx: JPEG/PNG files as X8R8G8B8 / A8R8G8B8 pixels (BGRA bytes), and their info from the headers alone', () => {
  for (const [n, alpha] of [['base.jpg', false], ['gray.jpg', false], ['x-cmyk.jpg', false], ['x-prog420.jpg', false], ['rgba.png', true], ['pal.png', true], ['bw.png', true]]) {
    const bytes = new Uint8Array(read(n));
    const im = parseImage(bytes), d = (n.endsWith('.jpg') ? decodeJpeg : decodePng)(bytes);
    assert.equal(im.fmt, alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8, n);
    const px = im.images[0][0];
    for (let i = 0; i < d.width * d.height; i++) {
      const want = [d.data[4 * i + 2], d.data[4 * i + 1], d.data[4 * i], alpha ? d.data[4 * i + 3] : 255];
      if (px[4 * i] !== want[0] || px[4 * i + 1] !== want[1] || px[4 * i + 2] !== want[2] || px[4 * i + 3] !== want[3]) assert.fail(`${n}: pixel ${i}`);
    }
    const info = parseImageInfo(bytes);
    for (const k of ['width', 'height', 'depth', 'mips', 'fmt', 'infoFmt', 'fileFormat', 'kind']) assert.equal(info[k], im[k], `${n}: ${k}`);
  }
  // (headers it does not read: the full parse decides)
  assert.throws(() => parseImageInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xc3, 0, 11, 8, 0, 4, 0, 4, 1, 1, 0x11, 0, 0xff, 0xd9])), /no frame/);
});
