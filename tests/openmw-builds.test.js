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

test('r5: r4 plus its patch, the same exports; preloads put off what waits for the network — between frames only, for a while', () => {
  const r4 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r4'), r5 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r5');
  assert.ok(r5, 'r5 is a build');
  assert.deepEqual(r5.patches, [...r4.patches, 'orthros-r5.patch']);
  assert.deepEqual(r5.exports, r4.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r5.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const k of [
    // (the page asked: a BSA member's own bytes, a loose file whole)
    'var f = globalThis.orthrosRangeReady;', 'Files::pathToUnicodeString(mFile->getFile()->getPath()), mInfo->mOffset, mInfo->mFileSize);',
    'return orthrosRangeReady(Files::pathToUnicodeString(mPath), 0, ~std::uint64_t{ 0 });',
    // (a template: its NIF and the textures it names)
    'bool SceneManager::orthrosTemplateReady(VFS::Path::NormalizedView path)', 'record->mRecordType != Nif::RC_NiSourceTexture',
    // (who asks: object paging's chunks, the terrain preload's entries, the cell preload's meshes)
    'bool ObjectPaging::chunkReady(', 'bool QuadTreeWorld::chunksReady(', 'bool meshReady(std::string_view path)',
    // (between frames only — a deadline —, and for dataWaitLimit at most; the queue runs the others meanwhile)
    'const bool mayWait = deadline != std::chrono::steady_clock::time_point::max()', 'now() - since < limit',
    'if (mWorld->preloadWaitingForData())', 'waiting.push_back(item.get());', 'OPENMW_PRELOAD_WAIT_MS', 'ENV.OPENMW_PRELOAD_WAIT_MS='])
    assert.ok(added.includes(k), k);
  const page = path.join(DEFAULT_ENGINES_DIR, 'openmw-web-v1.5.3-orthros-r5', 'index.html');
  if (fs.existsSync(page)) assert.ok(fs.readFileSync(page, 'utf8').includes('ENV.OPENMW_PRELOAD_WAIT_MS='), 'the installed page takes ?preloadwait=');
});

test('r6: r5 plus its patch, the same exports; no FBO status asked again per composite map, no distant chunk built for a ray', () => {
  const r5 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r5'), r6 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r6');
  assert.ok(r6, 'r6 is a build');
  assert.deepEqual(r6.patches, [...r5.patches, 'orthros-r6.patch']);
  assert.deepEqual(r6.exports, r5.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r6.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const k of [
    // (the composite maps' FBO: its status asked until found complete)
    '= mOrthrosFboComplete ? GL_FRAMEBUFFER_COMPLETE_EXT : ext->glCheckFramebufferStatus(GL_FRAMEBUFFER_EXT);',
    'mOrthrosFboComplete = status == GL_FRAMEBUFFER_COMPLETE_EXT;',
    // (a ray: the chunks built already, a missing one not built nor its node kept; the active grid's built as before)
    'virtual osg::ref_ptr<osg::Node> getChunkForRay(', 'osg::ref_ptr<osg::Node> ObjectPaging::getChunkForRay(',
    'return getChunk(size, center, lod, lodFlags, activeGrid, viewPoint, false);', 'missing = true;',
    'isCullVisitor ? nullptr : &partial', '*partial = pat;'])
    assert.ok(added.includes(k), k);
  // (the drawing's traversal unchanged: getChunk with its compile flag when no ray asks)
  assert.ok(added.includes(': m->getChunk(entry.mNode->getSize(), entry.mNode->getCenter(), lod, entry.mLodFlags, activeGrid,'));
});

test('r7: r6 plus its patch, the same exports; no terrain chunk outside the active grid built for a ray, an FBO of a kind found complete not asked again', () => {
  const r6 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r6'), r7 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r7');
  assert.ok(r7, 'r7 is a build');
  assert.deepEqual(r7.patches, [...r6.patches, 'orthros-r7.patch']);
  assert.deepEqual(r7.exports, r6.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r7.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  // (the patch reaches OSG's sources too: the build applies it at the tree's root, deps/src/osg beside openmw/)
  assert.ok(patch.includes('+++ b/deps/src/osg/src/osgUtil/RenderStage.cpp'));
  for (const k of [
    'osg::ref_ptr<osg::Node> ChunkManager::getChunkForRay(', 'if (activeGrid)\n+            return getChunk(size, center, lod, lodFlags, activeGrid, viewPoint, false);',
    'missing = true;',
    // (single-sampled FBOs whose every attachment's format is known; asked when unknown or not complete before)
    'if (!fbo_multisample.valid())', 'orthrosKind.clear();',
    'GLenum status = orthrosKnown ? GLenum(GL_FRAMEBUFFER_COMPLETE_EXT) : ext->glCheckFramebufferStatus(GL_FRAMEBUFFER_EXT);',
    'if (status == GL_FRAMEBUFFER_COMPLETE_EXT && !orthrosKind.empty())'])
    assert.ok(added.includes(k), k);
});

test('r11: r10 plus its patch, the same exports; each frame-cost change read from its switch, the page setting only OPENMW_ORTHROS_* from ?omwenv=, the GL glue linked', () => {
  const r10 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r10'), r11 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r11');
  assert.ok(r11, 'r11 is a build');
  assert.deepEqual(r11.patches, [...r10.patches, 'orthros-r11.patch']);
  assert.deepEqual(r11.exports, r10.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r11.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  // (OSG's sources too: the build applies the patch at the tree's root)
  for (const f of ['deps/src/osg/include/osg/State', 'deps/src/osg/src/osg/Program.cpp', 'deps/src/osg/src/osg/BufferObject.cpp',
    'openmw/components/sceneutil/lightmanager.cpp', 'openmw/components/myguiplatform/myguirendermanager.cpp', 'wasm-build/orthros-gl.js', 'play/index.html'])
    assert.ok(patch.includes(`+++ b/${f}`), f);
  for (const k of ['getenv("OPENMW_ORTHROS_UNIFORMS")', 'getenv("OPENMW_ORTHROS_LIGHTCACHE")', 'getenv("OPENMW_ORTHROS_VAO")',
    'getenv("OPENMW_ORTHROS_LIGHTUBO")', "OPENMW_ORTHROS_GLGLUE", 'orthrosApplyUniforms',
    '--js-library "$ROOT/wasm-build/orthros-gl.js"', '/^(OPENMW_ORTHROS_[A-Z0-9_]+)=([A-Za-z0-9._-]*)$/'])
    assert.ok(added.includes(k), k);
  // (the page's hook: an address's ?omwenv= reaches the engine's environment for that prefix only)
  const hook = /var omwEnv = [\s\S]*?\}\);/.exec(added)?.[0].replace(/^\+/gm, '');
  assert.ok(hook, 'the ?omwenv= hook');
  const run = (search) => { const ENV = {}; new Function('location', 'ENV', hook)({ search }, ENV); return ENV; };
  assert.deepEqual(run('?tier=mid&omwenv=OPENMW_ORTHROS_UNIFORMS=0,OPENMW_ORTHROS_VAO=0'), { OPENMW_ORTHROS_UNIFORMS: '0', OPENMW_ORTHROS_VAO: '0' });
  assert.deepEqual(run('?omwenv=HOME=/x,LD_PRELOAD=a,OPENMW_ORTHROS_X=a%20b'), {}, 'other names, or values with spaces, never');
});

test('r10 patch: read-ahead of a cell change — the page told the files about to be read, a bounded wait, then the textures the NIFs name', () => {
  // (the release is r9 plus this patch, r9's exports; the patch stays clear of r9's files)
  const r9 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r9'), r10 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r10');
  assert.ok(r9 && r10, 'r9 and r10 are builds');
  assert.deepEqual(r10.patches, [...r9.patches, 'orthros-r10.patch']);
  assert.deepEqual(r10.exports, r9.exports, 'r10 keeps r9\'s exports');
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r10.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  for (const f of ['openmw/apps/openmw/mwinput/bindingsmanager.cpp', 'wasm-build/build-deps.sh', 'wasm-build/link-openmw.sh', 'wasm-build/orthros-openal.js'])
    assert.ok(!files.includes(f), f);
  for (const k of [
    // (the contract with src/ports/openmw/streamfs.js: one call per batch, records 'path\x1Foffset\x1Fsize' joined by '\x1E')
    'var f = globalThis.orthrosWillRead;', 'f(UTF8ToString($0, $1), UTF8ToString($2, $3))', "list += '\\x1E';", "list += '\\x1F';",
    'var f = globalThis.orthrosReadWait;', 'MAIN_THREAD_EM_ASM_INT', 'emscripten_is_main_runtime_thread()',
    // (the files' ranges shared by r5's readiness and the read-ahead)
    'bool orthrosRange(std::string& path, std::uint64_t& offset, std::uint64_t& size) const override',
    // (two phases, each wait bounded; labels '<kind>:<place>')
    'void SceneManager::orthrosPrefetch(', 'constexpr double waitMs = 15000;', '"meshes:" + std::string(place)',
    '"textures:" + std::string(place)', '"terrain:" + std::string(place)', 'orthrosTexturesOf(file, textures);',
    'void Storage::orthrosLandTextures(ESM::ExteriorCellLocation cellLocation',
    // (the call sites: the grid's cells before the sync terrain preload, the interior after getInterior, the
    // distant chunks inside the sync terrain preload)
    'orthrosReadAhead(cells, std::to_string(playerCellX) + "," + std::to_string(playerCellY));',
    'orthrosReadAhead(cells, Misc::StringUtils::lowerCase(cellName));',
    'if (deadline == std::chrono::steady_clock::time_point::max() && !abort)', 'void QuadTreeWorld::orthrosReadAhead(',
    // (an NPC met for the first time: autoEquip's likely choice per slot type, not every item of its record — a
    // merchant's stock)
    'std::map<int32_t, const ESM::Armor*> armor;', 'c->mData.mType == ESM::Clothing::Ring ? 2 : 1', 'weapons[w->mData.mType] = { damage, w };'])
    assert.ok(added.includes(k), k);
  // (the grid's read-ahead just before the terrain's setup and synchronous preload, and only in the web build)
  const scene = patch.slice(patch.indexOf('+++ b/openmw/apps/openmw/mwworld/scene.cpp'));
  const grid = scene.indexOf('+        // Orthros (orthros-r10.patch): the grid\'s cells about to load');
  assert.ok(grid > 0 && grid < scene.indexOf('\n         mPreloader->setTerrain(mRendering.getTerrain());', grid));
  assert.ok(scene.lastIndexOf('+#ifdef __EMSCRIPTEN__', grid) > 0);
});
