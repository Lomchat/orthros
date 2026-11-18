// A player's display report (src/shared/display-report.js): what it must tell apart — a picture that alternates where
// nothing moved (A-B-A, and A-B-B-A on a screen twice as fast as the game) from a scroll, and a screen that showed what
// no back buffer had or went back to an older one —, and the server taking it within its limits (its own size, one a
// minute per session) while the other telemetry keeps its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAnalysis, alignStrips, REPORT_POST_MAX_BYTES, DISPLAY_REPORT_VERSION } from '../src/shared/display-report.js';
import { CAPTURE_POST_MAX_BYTES } from '../src/shared/flicker-record.js';
import { createServer } from '../src/server/server.js';

const W = 64, H = 36;
/** a luminance picture: a textured background shifted by `dx`, with a square of value `sq` (null: none) */
const pic = (dx, sq) => { const l = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) l[y * W + x] = ((((x + dx) >> 2) + (y >> 2)) & 1) * 120 + 60; if (sq !== null) for (let y = 10; y < 18; y++) for (let x = 20; x < 28; x++) l[y * W + x] = sq; return l; };

test('a strip: alternation where nothing moved is counted, a scroll is not; the screen aligned with the back buffers', () => {
  // (back buffers: A B A B — a square drawn every other frame over a still background)
  const A = pic(0, 250), B = pic(0, null), still = stripAnalysis([A, B], [0, 1, 0, 1, 0], W, H);
  assert.ok(still.still[2] > 20000 && still.summary.exact === 3, `A-B-A counted (${still.still[2]} ppm, exact ${still.summary.exact})`);
  // (a scroll: the background moves every frame, no square)
  const scroll = stripAnalysis([0, 1, 2, 3, 4].map((d) => pic(d * 3, null)), [0, 1, 2, 3, 4], W, H);
  assert.ok(scroll.summary.stillMax < 2000, `a scroll is not flicker (${scroll.summary.stillMax} ppm)`);
  // (a 30 fps alternation on a 60 Hz screen: A A B B A A)
  const held = stripAnalysis([A, B], [0, 0, 1, 1, 0, 0], W, H);
  assert.ok(held.abba[4] > 20000 && held.still[4] === 0, 'A-B-B-A counted');
  // alignment: back buffers A (t 0), B (16), C (33); the screen shows A, B, then A again (an older one), then a picture none had
  const C = pic(0, 120), X = pic(0, 0);
  const bb = { frames: [{ at: 0, img: 0, f: 10 }, { at: 16, img: 1, f: 11 }, { at: 33, img: 2, f: 12 }], lums: [A, B, C] };
  const screen = { frames: [{ at: 5, img: 0 }, { at: 21, img: 1 }, { at: 38, img: 0 }, { at: 55, img: 2 }], lums: [A, B, X] };
  const al = alignStrips(bb, screen, W, H, { match: 5000 });
  assert.deepEqual(al.rows.map((r) => [r.j, r.back, r.unmatched]), [[0, false, false], [1, false, false], [0, true, false], [2, false, true]]);
  assert.equal(al.summary.back, 1); assert.equal(al.summary.unmatched, 1);
  // (the render worker names each bitmap's device frame: the canvas handed frame 12 still holding frame 10's picture)
  const named = alignStrips(bb, { frames: [{ at: 5, img: 0, df: 10 }, { at: 21, img: 1, df: 11 }, { at: 38, img: 0, df: 12 }], lums: [A, B] }, W, H, { match: 50000 });
  assert.deepEqual(named.rows.map((r) => [r.by, r.j, r.other, r.back]), [['frame', 0, undefined, false], ['frame', 1, undefined, false], ['frame', 2, 0, true]]);
});

test('the server takes a display report within its own limits, one a minute per session; other telemetry keeps its own', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tel = path.join(root, 'tel'); fs.mkdirSync(tel); fs.mkdirSync(path.join(root, 'games'));
  const server = createServer({ gamesDir: path.join(root, 'games'), enginesDir: path.join(root, 'engines'), telemetryDir: tel, lanLog: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
  const strip = (n) => ({ t0: 1, frames: [{ t: 0, img: 0 }], images: Array.from({ length: Math.ceil(n / 100000) }, (_, i) => 'A'.repeat(Math.min(100000, n - i * 100000))), analysis: {} });
  const report = (session, pad) => ({ event: 'display-report', v: DISPLAY_REPORT_VERSION, id: 1, session, bb: strip(4), screen: strip(pad), extra: 'dropped' });
  // (larger than a flicker capture may be, under its own limit: taken; past its limit: refused)
  assert.equal(await post(report('sessA111', CAPTURE_POST_MAX_BYTES)), 204);
  assert.equal(await post(report('sessA111', 8)), 429, 'one a minute per session');
  assert.equal(await post(report('sessB222', REPORT_POST_MAX_BYTES)), 413);
  assert.equal(await post({ ...report('sessC333', 8), screen: { frames: [], images: ['not base64!'] } }), 400, 'pictures checked');
  assert.equal(await post({ event: 'flicker-capture', v: 1, session: 'sessD444', frames: [], images: [], pad: 'x'.repeat(CAPTURE_POST_MAX_BYTES) }), 413, 'a capture keeps its limit');
  assert.equal(await post({ session: 'sessD444', samples: [{ pad: 'x'.repeat(300 * 1024) }] }), 413, 'a batch keeps its 256 KB');
  await new Promise((r) => setTimeout(r, 100));
  const lines = fs.readdirSync(tel).flatMap((f) => fs.readFileSync(path.join(tel, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1); assert.equal(lines[0].event, 'display-report'); assert.equal(lines[0].extra, undefined, 'rebuilt from its known fields');
});
