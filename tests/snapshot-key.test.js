// The key a snapshot is kept under (src/host/web/snapshot-key.js, docs/snapshot.md): the debug flags that only measure
// the host (gpu-probe.js HOST_ONLY_DBG) are left out — a ?bench page and a plain page share their snapshots, and a
// shared-snapshot job a bench queued can be published by tools/snapshot-publish.mjs (a plain page).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { snapshotKey, machineDbg } from '../src/host/web/snapshot-key.js';
import { HOST_ONLY_DBG } from '../src/gfx/gpu-probe.js';

const base = { gameLanguage: 'fr', timeScale: 1, interp: false, interpRange: '', jitOpts: '', noF32: false, f32Off: '' };
const key = (opts) => snapshotKey('sources-hash', 'bfme1-108', { name: 'bfme1-108', exe: 'game.exe' }, { files: { 'game.exe': { size: 2, mtime: 1 } } }, { ...base, ...opts });

test('a ?bench page and a plain page get the same snapshot key', async () => {
  // (main.js: dbg is [?dbg=, the bench's flags].join(','))
  const main = fs.readFileSync(new URL('../src/host/web/main.js', import.meta.url), 'utf8');
  const benchFlags = [...main.matchAll(/state\.bench \? '([^']*)'/g)].flatMap((m) => m[1].split(',')).map((kv) => kv.split('=')[0]);
  assert.ok(benchFlags.length, 'main.js adds its bench flags to dbg');
  for (const f of benchFlags) assert.ok(HOST_ONLY_DBG.includes(f), `${f}: a bench's flag that is not host-only would give benches a key of their own`);
  const plain = await key({ dbg: '' });
  assert.match(plain, /^[0-9a-f]{32}$/);
  assert.equal(await key({ dbg: 'ORTHROS_GL_COUNT=1' }), plain, 'a bench page');
  assert.equal(await key({ dbg: 'ORTHROS_GL_TIME=300@6000,ORTHROS_GL_PROBES=0,ORTHROS_GL_COUNT=1' }), plain, 'every host-only flag');
  assert.equal(await key({ dbg: undefined }), plain);
});

test('the flags that change the machine still change the key, in their order', async () => {
  const plain = await key({ dbg: '' }), jit = await key({ dbg: 'ORTHROS_API_FAST_OFF=1' });
  assert.notEqual(jit, plain);
  assert.equal(await key({ dbg: 'ORTHROS_API_FAST_OFF=1,ORTHROS_GL_COUNT=1' }), jit);
  assert.equal(await key({ dbg: 'ORTHROS_GL_COUNT=1,ORTHROS_API_FAST_OFF=1' }), jit);
  assert.equal(machineDbg('ORTHROS_GL_COUNT=1,ORTHROS_SLICE_INSNS=5,ORTHROS_GL_TIME=3,ORTHROS_NO_DEFER=1'), 'ORTHROS_SLICE_INSNS=5,ORTHROS_NO_DEFER=1');
  assert.notEqual(await key({ dbg: '', gameLanguage: 'en' }), plain, 'the language');
  assert.notEqual(await key({ dbg: '', timeScale: 2 }), plain, 'the options that change the machine');
});
