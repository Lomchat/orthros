// tools/re3/lock.json: every build's patches are in tools/re3/patches/ (build.sh applies them to a copy of the pinned
// sources) and touch a submodule the lock pins; every build's engine files are pinned (build.sh refuses one that
// differs); build ids are unique. The r2 builds carry librw's sample count fix (docs/browser-ports.md, "The engine,
// built from source").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'tools', 're3');
const lock = JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'));

test('re3 lock: unique builds, engine files pinned, patches present for pinned repositories', () => {
  const ids = lock.builds.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const b of lock.builds) {
    assert.deepEqual(Object.keys(b.files ?? {}).sort(), ['engine/revc.mjs', 'engine/revc.wasm'], b.id);
    for (const v of Object.values(b.files)) assert.match(v, /^[0-9a-f]{64}$/, b.id);
    for (const [repo, patch] of b.patches) {
      assert.ok(repo === '.' || lock.engine.submodules[repo], `${b.id}: ${repo} not a pinned submodule`);
      assert.ok(fs.statSync(path.join(dir, 'patches', patch)).isFile(), `${b.id}: ${patch} missing`);
    }
  }
});

test('re3 lock: the r2 builds ask WebGL for multisampling only above one sample', () => {
  for (const id of ['revc-web-e312f97-r2', 'revc-web-e312f97-plus-r2']) {
    const b = lock.builds.find((x) => x.id === id);
    assert.ok(b, id);
    assert.deepEqual(b.patches, [['vendor/librw', 'librw-webgl-samples.patch']]);
  }
  const patch = fs.readFileSync(path.join(dir, 'patches', 'librw-webgl-samples.patch'), 'utf8');
  assert.match(patch, /^\+\+\+ b\/src\/gl\/gl3device\.cpp$/m);
  assert.match(patch, /^\+\tSDL_GL_SetAttribute\(SDL_GL_MULTISAMPLESAMPLES, glGlobals\.numSamples > 1 \? glGlobals\.numSamples : 0\);$/m);
  assert.match(patch, /^\+\tSDL_GL_SetAttribute\(SDL_GL_MULTISAMPLEBUFFERS, glGlobals\.numSamples > 1 \? 1 : 0\);$/m);
});
