// Image codecs (GDI+ image loading): PNG, baseline/progressive JPEG, DEFLATE, against references
// produced by an independent decoder (PIL). JPEG tolerance covers IDCT rounding differences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodePng } from '../src/gfx/codecs/png.js';
import { decodeJpeg } from '../src/gfx/codecs/jpeg.js';
import { inflate } from '../src/gfx/codecs/inflate.js';

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
