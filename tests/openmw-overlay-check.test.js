// tools/openmw/overlay-check.mjs: an overlay of the engine's built-in scripts against the release's packed original,
// every overlay's installed file against its sha256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkOverlays } from '../tools/openmw/overlay-check.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('overlays of built-in scripts: refused when the release changed the original; installed files checked', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-overlay-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = (id, text) => {
    const e = path.join(dir, 'engines', id, 'e', 'abc'); fs.mkdirSync(e, { recursive: true });
    const pad = 'xxxx', data = pad + text + 'tail';
    fs.writeFileSync(path.join(e, 'openmw.data'), data);
    fs.writeFileSync(path.join(e, 'openmw.js'), `loadPackage({files:[{filename:"/resources/vfs/scripts/a.lua",start:${pad.length},end:${pad.length + text.length}},{filename:"/x",start:0,end:4}]})`);
  };
  release('r1', 'original'); release('r2', 'changed');
  const game = path.join(dir, 'game'), file = 'scripts/a.lua', over = 'overlay';
  fs.mkdirSync(path.join(game, 'versions', 'en', 'mods', 'p', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(game, 'versions', 'en', 'mods', 'p', file), over);
  const write = (o) => fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ versions: [{ id: 'v', dir: 'en', openmw: { engine: 'r1',
    mods: [{ id: 'm', installed: true, parts: [{ dir: 'mods/p' }], overlays: [{ of: 'openmw built-in', file, originalSha256: sha('original'), sha256: sha(over), ...o }] }] } }] }));
  const enginesDir = path.join(dir, 'engines'), man = path.join(game, 'manifest.json');
  write({});
  assert.deepEqual(checkOverlays(man, { enginesDir }), []);
  assert.match(checkOverlays(man, { enginesDir, engine: 'r2' })[0], /r2's built-in is .* regenerate or withdraw/, 'the next release changed the original');
  write({ file: 'scripts/b.lua' });
  assert.ok(checkOverlays(man, { enginesDir }).some((m) => /no longer has this built-in file/.test(m)));
  write({ sha256: sha('other') });
  assert.match(checkOverlays(man, { enginesDir })[0], /installed file differs/);
});
