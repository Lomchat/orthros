// Orthros' own OpenMW engine releases (tools/openmw/lock.json "builds", tools/openmw/build.sh): each build's patches
// exist and extend the previous build's, in order; r3's page (when installed here) keeps the cooperative WorkQueue's
// switches and preloads the exterior grid unless the old inline mode is asked for; r4 fixes r3's global map (a resized
// save's map copied back, the CPU copy's layout checked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';

const here = path.dirname(fileURLToPath(import.meta.url)), tools = path.join(here, '../tools/openmw');
const lock = JSON.parse(fs.readFileSync(path.join(tools, 'lock.json'), 'utf8'));

test('every engine build: its patches present, each build the previous one plus its own', () => {
  let previous = [];
  for (const b of lock.builds) {
    for (const p of b.patches) assert.ok(fs.existsSync(path.join(tools, 'patches', p)), `${b.id}: ${p}`);
    assert.deepEqual(b.patches.slice(0, previous.length), previous, `${b.id} extends the previous build`);
    previous = b.patches;
  }
  const r3 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r3');
  assert.ok(r3, 'r3 is a build');
  assert.deepEqual(r3.patches, ['orthros-r1.patch', 'orthros-r2.patch', 'orthros-r3.patch']);
  const r4 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r4');
  assert.ok(r4, 'r4 is a build');
  assert.deepEqual(r4.patches, [...r3.patches, 'orthros-r4.patch']);
  assert.deepEqual(r4.exports, r3.exports, 'r4 keeps r3\'s exports');
});

test('r3 patch: the cooperative WorkQueue, its per-frame pump, the sliced preloads, the global map copied back only for saves', () => {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r3.patch'), 'utf8');
  for (const k of ['+++ b/openmw/components/sceneutil/workqueue.cpp', 'void WorkQueue::runCooperative(double budgetMs)',
    'self->mWorkQueue->runCooperative(budgetMs);', 'bool doWorkSlice(std::chrono::steady_clock::time_point deadline) override',
    'bool QuadTreeWorld::preloadSlice(', 'mTerrainPreloadItem->waitTillDone();', 'void GlobalMap::syncCpuCopy()', 'mCpuCopyStale = true;',
    "ENV.OPENMW_WORKQUEUE_INLINE='1'", 'preload exterior grid = true'])
    assert.ok(patch.includes(k), k);
});

test('r4 patch: no CPU copy pending on a camera whose mask is zeroed, the save\'s map resized without one, the copy\'s layout checked', () => {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r4.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const k of ['if (!mParent->hasPendingCopy(node))', 'bool GlobalMap::hasPendingCopy(osg::Camera* camera) const',
    'bool GlobalMap::isCpuCopyLayout(const osg::Image& image) const', 'image.getPixelFormat() == GL_RGBA', 'image.getDataType() == GL_UNSIGNED_BYTE',
    'if (!isCpuCopyLayout(*mOverlayImage))', '&& isCpuCopyLayout(*image))', "'[Map]\\nglobal map cell size = '"])
    assert.ok(added.includes(k), k);
  // (read()'s resize path, web build: drawn without a CPU copy, the copy marked stale for syncCpuCopy)
  const web = added.slice(added.indexOf('+#ifdef __EMSCRIPTEN__\n+            // Orthros (orthros-r4.patch): drawn onto the overlay texture only'));
  assert.ok(web.length > 0);
  assert.match(web.slice(0, web.indexOf('+#else')), /std::move\(texture\), true, false,[\s\S]*mCpuCopyStale = true;/);
});

test('the r3 page (when installed): exterior grid preloaded by default, ?wq=inline back to the old mode', () => {
  const page = path.join(DEFAULT_ENGINES_DIR, 'openmw-web-v1.5.3-orthros-r3', 'index.html');
  if (!fs.existsSync(page)) return;
  const html = fs.readFileSync(page, 'utf8');
  assert.ok(html.includes("(/[?&]wq=inline\\b/.test(location.search) ? 'preload exterior grid = false\\n' : 'preload exterior grid = true\\n')"));
  for (const k of ['OPENMW_WORKQUEUE_INLINE', 'OPENMW_WORKQUEUE_THREADED', 'OPENMW_WORKQUEUE_BUDGET_MS']) assert.ok(html.includes(`ENV.${k}`), k);
});
