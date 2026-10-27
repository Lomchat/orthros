// tools/re3/lock.json: every build's patches are in tools/re3/patches/ (build.sh applies them to a copy of the pinned
// sources) and touch a submodule the lock pins; every build's engine files are pinned (build.sh refuses one that
// differs); build ids are unique. The r2 builds carry librw's sample count fix (docs/browser-ports.md, "The engine,
// built from source"); the r3 builds read sound bank 0 sample by sample (docs/slow-network.md, "Launch set after an
// engine change").
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
    // (a build added unpinned — `files: {}`, build.sh prints the files to pin at its first install — only as the latest
    // of its line: nothing after it built on it yet)
    const line = (x) => x.replace(/-r\d+$/, ''); // (a build's line: its id without its revision)
    if (!Object.keys(b.files ?? {}).length) assert.ok(!lock.builds.slice(ids.indexOf(b.id) + 1).some((x) => line(x.id) === line(b.id)), `${b.id}: unpinned, not the latest of its line`);
    else assert.deepEqual(Object.keys(b.files).sort(), ['engine/revc.mjs', 'engine/revc.wasm'], b.id);
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

test('re3 lock: the r3 builds add the lazy sound bank to r2\'s patches, each edition', () => {
  for (const [id, cmake] of [['revc-web-e312f97-r3', undefined], ['revc-web-e312f97-plus-r3', ['-DREVC_ORTHROS_EXTRAS=ON']]]) {
    const b = lock.builds.find((x) => x.id === id);
    assert.ok(b, id);
    assert.deepEqual(b.patches, [['vendor/librw', 'librw-webgl-samples.patch'], ['.', 'revc-lazy-sfx.patch']]);
    assert.deepEqual(b.cmake, cmake);
  }
  const patch = fs.readFileSync(path.join(dir, 'patches', 'revc-lazy-sfx.patch'), 'utf8');
  const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(files, ['src/audio/AudioLogic.cpp', 'src/audio/AudioManager.cpp', 'src/audio/sampman.h', 'src/audio/sampman_oal.cpp', 'src/skel/orthros_web.cpp', 'src/skel/orthros_web.h']);
  // (only under the browser's OpenAL build without Opus banks, one switch every audio file sees; the bank no longer read
  // whole; a sample read on its first play, exactly its range, when its bytes are here)
  assert.match(patch, /^\+#if defined\(__EMSCRIPTEN__\) && defined\(AUDIO_OAL\) && !defined\(OPUS_SFX\)\n\+[^]*?#define ORTHROS_LAZY_SFX$/m);
  assert.match(patch, /^\+\t\tgBankLoaded\[nBank\] = LOADING_STATUS_LOADED;\n\+\t\treturn TRUE;$/m);
  assert.match(patch, /^\+\tif \( !OrthrosFileReady\(fd, m_aSamples\[nSfx\]\.nOffset, size\) \)$/m);
  assert.match(patch, /^\+\tif \( pread\(fd, \(void \*\)addr, size, m_aSamples\[nSfx\]\.nOffset\) != \(ssize_t\)size \)$/m);
  // (a skipped play empties its channel — a caller that starts it all the same, the police radio, plays nothing rather
  // than the channel's last sample)
  assert.match(patch, /^\+\t\tif \( nBank == SFX_BANK_0 && !EnsureSample\(nSfx\) \)\n\+\t\t\{\n\+\t\t\tif \( GetChannelUsedFlag\(nChannel\) \)\n\+\t\t\t\tStopChannel\(nChannel\);\n\+\t\t\taChannel\[nChannel\]\.Reset\(\);\n\+\t\t\treturn FALSE;$/m);
  // (a skipped play frees its slot of the audio manager, so a loop — never checked against its channel — is asked for
  // again next frame and starts once its bytes are here)
  assert.match(patch, /^\+\t+else if \(m_asActiveSamples\[k\]\.m_nBankIndex == SFX_BANK_0\) \{\n(\+\t+\/\/.*\n)+\+\t+m_asActiveSamples\[k\]\.m_nSampleIndex = NO_SAMPLE;\n\+\t+m_asActiveSamples\[k\]\.m_nEntityIndex = AEHANDLE_NONE;\n\+\t+break;$/m);
  // (the player's gear change waits for its sample before moving the gear)
  assert.match(patch, /^\+\t+if \(!channelUsed && !SampleManager\.EnsureSample\(soundOffset \+ SFX_CAR_ACCEL_1\)\)\n\+\t+return;$/m);
  // (the page's count of the samples read and skipped, for tools/re3/check.mjs)
  assert.match(patch, /^\+EM_JS\(void, OrthrosSampleCount, \(int read, int frames\)/m);
});
