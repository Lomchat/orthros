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

test('r12: r11 plus its patch, the same exports; each kept frame-cost change read from its switch, the dropped ones absent', () => {
  const r11 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r11'), r12 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r12');
  assert.ok(r12, 'r12 is a build');
  assert.deepEqual(r12.patches, [...r11.patches, 'orthros-r12.patch']);
  assert.deepEqual(r12.exports, r11.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r12.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const f of ['deps/src/osg/src/osg/Referenced.cpp', 'deps/src/osg/src/osg/Program.cpp', 'deps/src/osg/src/osg/Shader.cpp',
    'openmw/components/myguiplatform/myguirendermanager.cpp', 'wasm-build/orthros-openal.js', 'openmw/components/terrain/chunkmanager.cpp',
    'openmw/components/lua/scriptscontainer.cpp', 'openmw/apps/openmw/mwgui/layout.cpp'])
    assert.ok(patch.includes(`+++ b/${f}`), f);
  for (const s of ['REFATOMIC', 'GUIBATCHES', 'GUIUPLOAD', 'ALCACHE', 'TERRAINREADY', 'UNIFORMVALUES', 'IDLECALLS', 'SHADERLOG'])
    assert.ok(added.includes(`OPENMW_ORTHROS_${s}`), s);
  // (measured without a gain of their own, or not checked by pictures: left out)
  for (const s of ['STATEGRAPHS', 'PRELOADREADY', 'CELLREADS']) assert.ok(!patch.includes(`OPENMW_ORTHROS_${s}`), s);
});

test('r13: r12 plus its patch, r12\'s exports and orthros_content_light (launch-set.js CONTENT_EXPORT), exported by the patch', () => {
  const r12 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r12'), r13 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r13');
  assert.ok(r13, 'r13 is a build');
  assert.deepEqual(r13.patches, [...r12.patches, 'orthros-r13.patch']);
  assert.deepEqual(r13.exports.slice(0, r12.exports.length), r12.exports, 'r12\'s exports kept');
  assert.deepEqual(r13.exports.slice(r12.exports.length).map((e) => e.name), ['orthros_content_light']);
  const e = r13.exports.at(-1);
  assert.equal(e.returns, 'number'); assert.deepEqual(e.args, []); assert.ok(e.call.startsWith("Module.ccall('orthros_content_light'"));
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r13.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  // (exported as r1's are: EMSCRIPTEN_KEEPALIVE in engine.cpp, no change to the link script's exports)
  assert.ok(patch.includes('+++ b/openmw/apps/openmw/engine.cpp'));
  for (const k of ['extern "C" EMSCRIPTEN_KEEPALIVE int orthros_content_light()', 'VFS::orthrosContentLoad(false);', 'VFS::orthrosContentLoad(true);',
    'globalThis.orthrosContentLoaded : globalThis.orthrosContentLoading', 'var f = globalThis.orthrosContentIds;'])
    assert.ok(added.includes(k), k);
});

test('r13 patch: the content load told to the page (its content files light until then), the cells\' ranges read ahead or put off', () => {
  const file = path.join(tools, 'patches/orthros-r13.patch');
  const patch = fs.readFileSync(file, 'utf8'), added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  // (an r13 build, once in the lock: r12's patches and its own, its exports r12's and the content's — launch-set.js
  // CONTENT_EXPORT: the server marks its versions' content files light only then)
  const r13 = lock.builds.find((b) => b.patches.includes('orthros-r13.patch'));
  if (r13) {
    assert.equal(r13.patches.at(-1), 'orthros-r13.patch'); assert.equal(r13.patches.at(-2), 'orthros-r12.patch');
    assert.ok(r13.exports.some((e) => e.name === 'orthros_content_light'), 'CONTENT_EXPORT among its exports');
  }
  for (const k of [
    // (the export, and the hooks around World::loadData: light from its start, the files from its end)
    'extern "C" EMSCRIPTEN_KEEPALIVE int orthros_content_light()', 'VFS::orthrosContentLoad(false);', 'VFS::orthrosContentLoad(true);',
    'globalThis.orthrosContentLoaded : globalThis.orthrosContentLoading',
    // (a cell's ranges: each content file's CELL context, an exterior's LAND context)
    'void orthrosCellRanges(const MWWorld::ESMStore& store, const ESM::Cell& cell, bool refs, bool land,',
    'for (const ESM::ESM_Context& context : cell.mContextList)', 'bool orthrosLandRange(const ESM::Land& land, VFS::OrthrosRange& out)',
    'std::size_t orthrosWillReadRanges(std::span<const OrthrosRange> ranges, std::string_view label)',
    // (announced and waited for before the loads that read them; put off between frames until there)
    'orthrosReadCells(records, "meshes:" + std::to_string(playerCellX) + "," + std::to_string(playerCellY));',
    'orthrosReadCells(records, "meshes:" + Misc::StringUtils::lowerCase(cellName));',
    'if (VFS::orthrosWillReadRanges(ranges, "terrain:" + place) > 0)', 'orthrosReadSavedCells(filepath);', '"cells:save"',
    'if (!VFS::orthrosRangesReady(ranges))', 'orthrosCellReady(mWorld.getWorldModel().getExterior(cellIndex, false))',
    // (a cell's references listed by their ids — a search through every cell — read from the light copies)
    'void orthrosContentIds(bool on)', 'var f = globalThis.orthrosContentIds;'])
    assert.ok(added.includes(k), k);
  // (the ids-only guard inside CellStore::listRefs(const ESM::Cell&), before its readers are restored)
  const cells = patch.slice(patch.indexOf('+++ b/openmw/apps/openmw/mwworld/cellstore.cpp'));
  const guard = cells.indexOf('} orthrosIdsOnly;');
  assert.ok(guard > cells.indexOf('void CellStore::listRefs(const ESM::Cell& cell)') && guard < cells.indexOf('// Load references from all plugins that do something with this cell.'));
  assert.ok(cells.indexOf('OrthrosIdsOnly() { VFS::orthrosContentIds(true); }') > 0 && cells.indexOf('~OrthrosIdsOnly() { VFS::orthrosContentIds(false); }') > 0);
  // (the hooks around the whole content load: the content files, the groundcover's, the references counted)
  const world = patch.slice(patch.indexOf('+++ b/openmw/apps/openmw/mwworld/worldimp.cpp'));
  const on = world.indexOf('VFS::orthrosContentLoad(false);'), off = world.indexOf('VFS::orthrosContentLoad(true);');
  assert.ok(on > 0 && on < world.indexOf(' loadContentFiles(fileCollections, contentFiles, encoder, listener);'));
  assert.ok(off > world.indexOf(' mStore.validateRecords(mReaders);'));
  // (the grid's cells read ahead before getExterior loads their references)
  const scene = patch.slice(patch.indexOf('+++ b/openmw/apps/openmw/mwworld/scene.cpp'));
  const read = scene.indexOf('orthrosReadCells(records, "meshes:" + std::to_string(');
  assert.ok(read > 0 && read < scene.indexOf('\n             std::vector<CellStore*> cells;', read));
});

test('r14: r13 plus its patch, the same exports; Lua\'s update on its own thread (off in multiplayer), LuaUi diffing, clock and gamma, each behind its switch', () => {
  const r13 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r13'), r14 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r14');
  assert.ok(r14, 'r14 is a build');
  assert.deepEqual(r14.patches, [...r13.patches, 'orthros-r14.patch']);
  assert.deepEqual(r14.exports, r13.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r14.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const f of ['openmw/apps/openmw/mwlua/worker.cpp', 'openmw/apps/openmw/mwlua/mainthread.hpp', 'openmw/components/lua_ui/element.cpp',
    'openmw/apps/openmw/mwrender/postprocessor.cpp', 'wasm-build/orthros-clock.js'])
    assert.ok(patch.includes(`+++ b/${f}`), f);
  for (const s of ['LUATHREAD', 'LUAUIDIFF', 'CLOCK', 'GAMMA']) assert.ok(added.includes(`OPENMW_ORTHROS_${s}`), s);
  // (a multiplayer session keeps Lua's update inline: openmw.mp's state is not shared with another thread)
  assert.ok(added.includes('OPENMW_MP_URL'));
});

test('r15: r14 plus its patch, the same exports; actor preload, StateGraph prune, programs precompiled under the loading screen, Lua incremental GC, post-processing programs kept, GUI arena buffer, each behind its switch', () => {
  const r14 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r14'), r15 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r15');
  assert.ok(r15, 'r15 is a build');
  assert.deepEqual(r15.patches, [...r14.patches, 'orthros-r15.patch']);
  assert.deepEqual(r15.exports, r14.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r15.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const f of ['deps/src/osg/src/osgUtil/StateGraph.cpp', 'openmw/apps/openmw/mwworld/cellpreloader.cpp', 'deps/src/osg/src/osg/Program.cpp',
    'openmw/apps/openmw/mwgui/loadingscreen.cpp', 'openmw/components/lua/luastate.cpp', 'openmw/components/fx/pass.cpp',
    'openmw/components/myguiplatform/myguirendermanager.cpp'])
    assert.ok(patch.includes(`+++ b/${f}`), f);
  for (const s of ['STATEGRAPHS', 'ACTORPRELOAD', 'PRECOMPILE', 'LUAGCINC', 'FXPROGRAMS', 'GUIONEBUFFER']) assert.ok(added.includes(`OPENMW_ORTHROS_${s}`), s);
  // (multiview programs are never compiled ahead: not GLSL ES, never drawn in WebGL)
  assert.ok(added.includes('find("multiview")'));
  // (measured without a gain or with a visible cost in rounds 2-4: left out)
  for (const s of ['TEXRELOAD', 'COOPDEADLINE', 'LUAGCMINOR', 'SHADERASYNC', 'GLSTATE', 'LUAGCPACE']) assert.ok(!added.includes(`OPENMW_ORTHROS_${s}`), s);
});

test('r16: r15 plus its patch, the same exports; Lua chunks compiled once per path, textures uploaded ahead, NIF read whole and parsed on a thread, each behind its switch', () => {
  const r15 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r15'), r16 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r16');
  assert.ok(r16, 'r16 is a build');
  assert.deepEqual(r16.patches, [...r15.patches, 'orthros-r16.patch']);
  assert.deepEqual(r16.exports, r15.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r16.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const f of ['openmw/components/lua/luastate.cpp', 'deps/src/osg/src/osg/Texture2D.cpp', 'openmw/components/resource/imagemanager.cpp',
    'openmw/components/resource/niffilemanager.cpp', 'openmw/components/files/constrainedfilestreambuf.cpp'])
    assert.ok(patch.includes(`+++ b/${f}`), f);
  for (const s of ['LUACHUNKS', 'TEXAHEAD', 'NIFTHREAD', 'WHOLEREAD']) assert.ok(added.includes(`OPENMW_ORTHROS_${s}`), s);
  // (the diagnostic Lua timings stay out of the production stack)
  assert.ok(!added.includes('OPENMW_ORTHROS_LUATIMES'));
});

test('r17: r16 plus its patch, the same exports; preloads patient for their files, LuaUi layout passes and text heights kept, each behind its switch', () => {
  const r16 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r16'), r17 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r17');
  assert.ok(r17, 'r17 is a build');
  assert.deepEqual(r17.patches, [...r16.patches, 'orthros-r17.patch']);
  assert.deepEqual(r17.exports, r16.exports);
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r17.patch'), 'utf8');
  const added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  for (const f of ['openmw/components/terrain/quadtreeworld.cpp', 'openmw/apps/openmw/mwworld/cellpreloader.cpp', 'openmw/components/sceneutil/workqueue.cpp',
    'openmw/components/lua_ui/flex.cpp', 'openmw/components/lua_ui/textedit.cpp'])
    assert.ok(patch.includes(`+++ b/${f}`), f);
  for (const s of ['PRELOADPATIENT', 'LUAUILAYOUT', 'LUAUITEXTSIZE']) assert.ok(added.includes(`OPENMW_ORTHROS_${s}`), s);
  // (the diagnostic Lua profiler and the chunk slicing, measured without a gain, stay out)
  for (const s of ['LUAPROF', 'CHUNKSLICE', 'CHUNKTHREAD', 'REFCACHE']) assert.ok(!added.includes(`OPENMW_ORTHROS_${s}`), s);
});

test('r18 patch: the frame and the boot suspend on a read the page does not answer within a few ms (JSPI), worker threads\' reads at once, the page\'s calls after the frame; no put-off of distant chunks', () => {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r18.patch'), 'utf8'), added = patch.split('\n').filter((l) => l.startsWith('+')).join('\n');
  // (r17 plus its patch; its exports r17's and the JSPI mark — the page tells the release by it; files none of its own)
  const r17 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r17'), r18 = lock.builds.find((b) => b.id === 'openmw-web-v1.5.3-orthros-r18');
  assert.ok(r18, 'r18 is a build');
  assert.deepEqual(r18.patches, [...r17.patches, 'orthros-r18.patch']);
  assert.deepEqual(r18.exports.filter((x) => x.name !== 'orthros_jspi'), r17.exports);
  const e = r18.exports.find((x) => x.name === 'orthros_jspi');
  assert.ok(e, 'orthros_jspi among its exports'); assert.equal(e.returns, 'number'); assert.deepEqual(e.args, []);
  assert.ok(r18.exports.some((x) => x.name === 'orthros_content_light'), 'r13\'s exports kept');
  assert.deepEqual(r18.files, {});
  for (const f of ['openmw/apps/openmw/engine.cpp', 'openmw/apps/openmw/main.cpp', 'openmw/apps/openmw/mwgui/loadingscreen.cpp', 'openmw/apps/openmw/mwgui/savegamedialog.cpp',
    'openmw/apps/openmw/mwstate/statemanagerimp.cpp', 'openmw/components/vfs/manager.cpp', 'play/index.html', 'wasm-build/link-openmw.sh', 'wasm-build/orthros-jspi.js'])
    assert.ok(patch.includes(`+++ b/${f}`), f);
  // (the link: JSPI, the frame a promising export — main() is by default —, the library after the system's)
  for (const k of ['-sJSPI=1 "-sJSPI_EXPORTS=[\'omw_pump_frame\']"', '--js-library "$ROOT/wasm-build/orthros-jspi.js"', 'extern "C" EMSCRIPTEN_KEEPALIVE int orthros_jspi()',
    'orthros_jspi_enter(0);', 'orthros_jspi_leave(0);', 'orthros_jspi_enter(1);', 'orthros_jspi_leave(1);', 'return orthros_read_wait(timeoutMs) != 0;',
    // (the engine's loads told to the glue: its loading screen on and off)
    'orthros_jspi_loading(1);', 'orthros_jspi_loading(0);'])
    assert.ok(added.includes(k), k);
  const lib = patch.slice(patch.indexOf('+++ b/wasm-build/orthros-jspi.js'));
  // (a read spins first — the store's answers — and suspends only on the page's promise; the announced wait alike)
  for (const k of ['s.soon ? s.soon(position, length, orthrosSpinMs())', "OPENMW_ORTHROS_JSPI_SPIN_MS", "OPENMW_ORTHROS_JSPI_PLAY_SPIN_MS", "ENV['OPENMW_ORTHROS_JSPI'] === '0'",
    'var r = soon(timeoutMs, J.spinMs);', 'Module.orthrosLoading = () => J.boot > 0 || J.loading > 0 || J.loadFrame > 0;', "if (!r || typeof r.then != 'function') return r ? 1 : 0;", 'orthros_fd_read_async__async: true', 'orthros_fd_sync_async__async: true',
    // (suspends only under a promising export, one at a time, in a load — or in play when allowed, ?jspiplay=N)
    "'OrthrosJspi.on > 0 && !OrthrosJspi.plain && !OrthrosJspi.suspended && !OrthrosJspi.off && (OrthrosJspi.boot > 0 || OrthrosJspi.loading > 0 || OrthrosJspi.loadFrame > 0 || OrthrosJspi.playSpinMs >= 0)'"])
    assert.ok(lib.includes(k), k);
  // (the C library's read is the plain import — never suspending: a worker thread's read proxied here, a plain frame's,
  // a call that reached the engine while its frame is suspended — answered at once; the suspending one apart, called by
  // engine.cpp's wrap only when the engine may suspend: an import that suspends throws SuspendError outside a promising
  // export even when it returns a number, measured)
  assert.ok(!lib.includes('fd_read__async') && !lib.includes('fd_sync__async: true,\n  fd_sync:') && !lib.includes('{ then: (f) => f(r) }'));
  assert.ok(!lib.includes('Promise.resolve().then(pread)'), 'never a pending promise for a proxied read');
  for (const k of ['__wrap___wasi_fd_read', '__wrap___wasi_fd_sync', '__wrap_emscripten_sleep', 'if (emscripten_is_main_runtime_thread() && orthros_jspi_may())\n+        return orthros_fd_read_async(fd, iovs, n, nread);',
    '-Wl,--wrap=__wasi_fd_read -Wl,--wrap=__wasi_fd_sync -Wl,--wrap=emscripten_sleep'])
    assert.ok(patch.includes(k), k);
  // (the suspending calls of the loading screen and the announced wait made only when the engine may)
  assert.equal((patch.match(/\+        if \(orthros_jspi_may\(\)\)\n\+            orthros_jspi_(present|breathe)\(\);/g) ?? []).length, 3);
  assert.ok(patch.includes('+            if (orthros_jspi_may())\n+                orthros_jspi_settle();'));
  assert.ok(patch.includes('+        if (orthros_jspi_may())\n+            return orthros_read_wait(timeoutMs) != 0;'));
  // (a frame of play is plain — on the page's stack —; a load it would start put off to the next, promising, frame)
  for (const k of ['extern "C" EMSCRIPTEN_KEEPALIVE void omw_pump_frame_plain()', 'const bool orthrosLoadLater = (mNewGameRequest || mLoadRequest) && orthros_jspi_defer();',
    'if (mLoadRequest && !orthrosLoadLater)', 'if (mNewGameRequest && !orthrosLoadLater)', 'getStateManager()->requestLoad(mCurrentCharacter, mCurrentSlot->mPath);', 'if (g_debugAsks.mCoe && orthros_jspi_defer())'])
    assert.ok(added.includes(k), k);
  // (the page's calls and the engine's WebSocket events while suspended: after the frame, in order, ccall whole)
  for (const k of ["Module['ccall'] = later(Module['ccall'])", 'webSockets.allocated.includes(this)', 'queueMicrotask(orthrosFlush)', 'Module.orthrosEngineBusy', 'orthrosSuspendedMs'])
    assert.ok(lib.includes(k), k);
  // (a WebSocket event put off and run after its socket was deleted or its handler replaced: dropped — the engine's
  // object reused by a reconnect never gets the old socket's close or message)
  assert.ok(lib.includes('if ((current.get(socket) || {})[key] === wrapped && webSockets.allocated.includes(socket)) fn.call(socket, e);'));
  // (the handler current for a socket is the one the library's setter last set, never read back through the getter: a
  // script wrapping the same setters — a test's — made every event of the engine dropped)
  assert.ok(lib.includes('mine[key] = wrapped;') && !lib.includes('d.get.call(socket) === wrapped'));
  // (the settings' save never put off: the page's leaving persists the file at once after it)
  assert.ok(lib.includes('/^_(omw_pump_frame|omw_pump_frame_plain|omw_save_settings|orthros_jspi|orthros_content_light)$/'));
  // (the debug COE and teleport at the next frame's start, under the frame's enter: their loads' reads may suspend)
  const engine = patch.slice(patch.indexOf('+++ b/openmw/apps/openmw/engine.cpp'), patch.indexOf('+++ b/openmw/apps/openmw/main.cpp'));
  assert.ok(engine.indexOf('+            orthrosRunDebugAsks();\n             g_emTick(g_emArg);') > engine.indexOf('+        orthros_jspi_enter(0);'));
  for (const k of ['g_debugAsks.mCoe = true;', 'g_debugAsks.mTeleport = true;', 'var span = Array.of($1); span.push(performance.now()); ran[UTF8ToString($0)] = span;'])
    assert.ok(engine.includes(k), k);
  // (the page: a pump that arrives while a frame is in flight runs and counts nothing)
  assert.ok(added.includes('if (pumping) return;'));
  // (the page: the frame's promise awaited before the next is scheduled, the switches)
  // (and after a load's frame — a promising one that lasted —, the next frame at once, not at the next animation frame)
  for (const k of ["if (r && typeof r.then === 'function') r.then(function(){ pumping = false; pumpDone(a, true); }", 'scheduleNext(promised && b - a >= 100);',
    'if (now && !document.hidden) { mc.port2.postMessage(0); return; }', 'ENV.OPENMW_ORTHROS_JSPI_GL_MAX_MS=', "ENV.OPENMW_ORTHROS_JSPI='0'", 'ENV.OPENMW_ORTHROS_JSPI_SPIN_MS=', 'ENV.OPENMW_ORTHROS_JSPI_PLAY_SPIN_MS=', 'ENV.OPENMW_ORTHROS_JSPI_PRESENT_MS=', 'ENV.OPENMW_ORTHROS_JSPI_BREATH_MS=',
    "ENV.OPENMW_ORTHROS_JSPI_PLAIN='0'", 'ENV.OPENMW_ORTHROS_JSPI_SETTLE_MS='])
    assert.ok(added.includes(k), k);
  // (no put-off of distant chunks by the cull: measured no better than JSPI alone — its reads suspend the frame — and
  // holding the page 0.7 s more at a view raise; the terrain as r17 builds it)
  for (const k of ['quadtreeworld.cpp', 'quadtreeworld.hpp', 'orthrosPutOff', 'OPENMW_ORTHROS_CULLWAIT_MS', 'cullwait', 'orthrosTurns', 'orthrosReceived'])
    assert.ok(!patch.includes(k), k);
});

test('r18: a read suspends in a load (the boot, a loading screen) after a short wait, never in play unless allowed (?jspiplay=N); the loads nest; a loading screen\'s frame presented', async () => {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r18.patch'), 'utf8');
  const file = patch.slice(patch.indexOf('+++ b/wasm-build/orthros-jspi.js'));
  const lib = file.slice(file.indexOf('\n') + 1).split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
  // (a library entry `  name: (args) => body,` — on one line, or a block closed by `  },`)
  const fn = (name) => {
    const at = lib.indexOf(`\n  ${name}: (`); assert.ok(at >= 0, name);
    const from = at + name.length + 5, line = lib.slice(from, lib.indexOf('\n', from));
    return line.endsWith('{') ? lib.slice(from, lib.indexOf('\n  },', from) + 4) : line.replace(/,$/, '');
  };
  // (the defaults: never in play, a loading screen's frame presented at most every 200 ms)
  assert.ok(lib.includes('spinMs: 10, playSpinMs: -1, presentMs: 200, presentedAt: 0, breathMs: 100, settleMs: 3000, plain: 0, want: 0, plainOff: false, loadFrame: 0, glMs: 50, glMaxMs: 300, glAt: 0, freedAt: 0'));
  const J = { on: 0, boot: 0, loading: 0, ready: true, suspended: 0, off: false, plain: 0, want: 0, spinMs: 10, playSpinMs: -1, presentMs: 200, presentedAt: 0, settleMs: 3000, after: [] };
  const may = fn('$orthrosMaySuspend').replace(/^\(\) => \{\{\{ ASYNCIFY == 2 \? '(.*)' : 'false' \}\}\}$/, '$1');
  const maySuspend = () => new Function('OrthrosJspi', `return ${may};`)(J);
  const make = (src) => new Function('OrthrosJspi', 'orthrosJspiReady', 'orthrosFlush', 'orthrosMaySuspend', 'orthrosSuspend', 'orthrosNote', `return ${src};`)(J, () => {}, () => {}, maySuspend, (p, path, kind, then) => p.then(() => then(true)), () => {});
  const enter = make(fn('orthros_jspi_enter')), leave = make(fn('orthros_jspi_leave')), loading = make(fn('orthros_jspi_loading')), spin = make(fn('$orthrosSpinMs'));
  enter(1); assert.equal(spin(), 10, 'the boot (main): a load'); assert.ok(maySuspend(), 'the boot may suspend'); leave(1);
  enter(0); assert.ok(!maySuspend(), 'a frame in play never suspends');
  loading(1); loading(1); assert.equal(spin(), 10, 'a loading screen on (nested)'); assert.ok(maySuspend());
  loading(0); assert.equal(spin(), 10, 'still on'); loading(0); assert.ok(maySuspend(), 'off: the rest of the load\'s frame still a load');
  leave(0); enter(0); assert.ok(!maySuspend(), 'the next frame: play again');
  J.playSpinMs = 100; assert.ok(maySuspend(), '?jspiplay=100: may in play'); assert.equal(spin(), 100); J.playSpinMs = -1;
  loading(0); assert.equal(J.loading, 0, 'never below 0'); leave(0);
  // (a loading screen's frame: presented — a suspension until the browser's rendering update — in a load only, at most
  // every presentMs, never with ?jspipresent=0)
  const present = make(fn('orthros_jspi_present'));
  const raf = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = (f) => setTimeout(f, 1);
  try {
    enter(0); assert.equal(present(), undefined, 'in play: nothing');
    J.presentedAt = -1e9; loading(1); const p = present(); assert.ok(p && typeof p.then === 'function', 'in a load: suspends'); await p;
    assert.ok(J.presentedAt > 0, 'presented now'); assert.equal(present(), undefined, 'not again within presentMs');
    J.presentedAt = -1e9; J.presentMs = 0; assert.equal(present(), undefined, '?jspipresent=0: never'); J.presentMs = 200;
    loading(0); leave(0);
  } finally { if (raf) globalThis.requestAnimationFrame = raf; else delete globalThis.requestAnimationFrame; }
  assert.ok(patch.includes('+        if (orthros_jspi_may())\n+            orthros_jspi_present();'), 'LoadingScreen::draw presents its frame');
  // (in a load, a read gives the page's thread a turn when it had none for breathMs — never in play, never with 0)
  const breath = make(fn('$orthrosBreath'));
  const MC = globalThis.MessageChannel;
  J.breathMs = 100; J.freedAt = 0;
  enter(0); assert.equal(breath(), null, 'in play: none');
  loading(1); assert.equal(breath(), null, 'the first read of a load starts the count'); assert.ok(J.freedAt > 0);
  assert.equal(breath(), null, 'not within breathMs');
  J.freedAt = performance.now() - 150; const b = breath(); assert.ok(b && typeof b.then === 'function', 'held 150 ms: a turn'); await b;
  J.freedAt = performance.now() - 150; J.breathMs = 0; assert.equal(breath(), null, '?jspibreath=0: never'); J.breathMs = 100;
  loading(0); leave(0); assert.equal(globalThis.MessageChannel, MC);
  assert.ok(lib.includes("var breath = orthrosBreath();\n    if (breath) return orthrosSuspend(breath, null, 'breath', () => orthrosRead(fd, iov, iovcnt, offset, pnum));"));
  assert.ok(lib.includes('J.freedAt = performance.now();'), 'every suspension frees the page: the count restarts');
  // (the load's progress breathes too)
  assert.equal((patch.match(/\+            orthros_jspi_breathe\(\);/g) ?? []).length, 2, 'setProgress and increaseProgress');
  assert.ok(lib.includes("orthros_jspi_breathe: () => {\n    var breath = orthrosBreath();\n    if (breath) return orthrosSuspend(breath, null, 'breath', () => {});"));
  // (an announced wait is a load's: it may suspend in play — a cell change's read-ahead comes before its loading
  // screen —, after the load's short wait)
  const wait = fn('orthros_read_wait');
  assert.ok(wait.includes("{{{ ASYNCIFY == 2 ? 'J.on > 0 && !J.plain && !J.suspended && !J.off' : 'false' }}}") && wait.includes('soon(timeoutMs, J.spinMs)'), wait);
  assert.ok(!wait.includes('orthrosMaySuspend()'));
  assert.ok(lib.includes("if (kind === 'present') { b.presents++; b.presentMs += ms; return; }"));
  // (not a budget of the frame's waits: measured, it put suspensions back in play — docs/openmw.md)
  assert.ok(!lib.includes('orthrosAsk') && !lib.includes('J.spun'));
  assert.equal(J.on, 0); assert.equal(J.boot, 0);
  // (the suspensions in play counted apart: Module.orthrosBlocked.play / playMs)
  assert.ok(lib.includes("if (kind !== 'proxied' && !(OrthrosJspi.boot > 0 || OrthrosJspi.loading > 0 || OrthrosJspi.loadFrame > 0)) { b.play++; b.playMs += ms; }"));
  assert.ok(lib.includes("J.playSpinMs = play;"));
});

test('r18: a frame of play is plain (never suspending), a load put off to a promising frame; the suspending imports only when the engine may; a load\'s end waits for the GPU', async () => {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r18.patch'), 'utf8');
  const file = patch.slice(patch.indexOf('+++ b/wasm-build/orthros-jspi.js'));
  const lib = file.slice(file.indexOf('\n') + 1).split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
  const fn = (name) => {
    const at = lib.indexOf(`\n  ${name}: (`); assert.ok(at >= 0, name);
    const from = at + name.length + 5, line = lib.slice(from, lib.indexOf('\n', from));
    return line.endsWith('{') ? lib.slice(from, lib.indexOf('\n  },', from) + 4) : line.replace(/,$/, '');
  };
  const J = { on: 0, boot: 0, loading: 0, ready: true, suspended: 0, off: false, plain: 0, want: 0, settleMs: 3000, after: [] };
  const tmpl = (src) => src.replace(/\{\{\{ ASYNCIFY == 2 \? '([^']*)' : '[^']*' \}\}\}/g, '$1');
  const may0 = fn('$orthrosMaySuspend').replace(/^\(\) => /, '');
  const maySuspend = () => new Function('OrthrosJspi', `return ${tmpl(may0)};`)(J);
  const make = (src) => new Function('OrthrosJspi', 'orthrosJspiReady', 'orthrosMaySuspend', 'orthrosSuspend', 'orthrosGpuIdle', 'orthrosNote', `return ${tmpl(src)};`)(J, () => {}, maySuspend, (p, path, kind, then) => p.then(() => then(true)), () => Promise.resolve(), () => {});
  const enter = make(fn('orthros_jspi_enter')), leave = make(fn('orthros_jspi_leave').replace('queueMicrotask(orthrosFlush)', '0')), plain = make(fn('orthros_jspi_plain')), defer = make(fn('orthros_jspi_defer')), may = make(fn('orthros_jspi_may')), loading = make(fn('orthros_jspi_loading'));
  // (a plain frame: nothing suspends, a load asked put off — the next frame wanted promising)
  plain(1); enter(0); assert.equal(may(), 0, 'a plain frame never calls a suspending import'); loading(1); assert.ok(!maySuspend(), 'not even under a loading screen');
  loading(0); assert.equal(defer(), 1, 'a load put off'); assert.equal(J.want, 1); leave(0); plain(0);
  // (the next frame, promising: the want cleared, the load now; reads may suspend in its load)
  enter(0); assert.equal(J.want, 0); assert.equal(defer(), 0, 'in a promising frame the load runs now'); assert.equal(may(), 1);
  loading(1); assert.ok(maySuspend()); J.suspended = 1; assert.equal(may(), 0, 'a call that reaches the engine while it is suspended: plain imports'); J.suspended = 0;
  // (the load's end: the GPU's queue waited for, the page's thread free — in a load only, never with ?jspisettle=0)
  const settle = make(fn('orthros_jspi_settle'));
  const p = settle(); assert.ok(p && typeof p.then === 'function', 'a load\'s end suspends'); await p;
  J.settleMs = 0; assert.equal(settle(), undefined, '?jspisettle=0: never'); J.settleMs = 3000;
  loading(0); leave(0); enter(0); assert.equal(settle(), undefined, 'in play: never'); leave(0);
  J.off = true; plain(1); enter(0); assert.equal(defer(), 0, 'JSPI off: loads at once'); leave(0); plain(0); J.off = false;
  assert.equal(J.on, 0); assert.equal(J.plain, 0);
  // (the page's pump: the plain export unless a load is wanted or on, or ?jspiplain=0; a frame timer wrapping the pump wraps the choice)
  for (const k of ["if (typeof plain == 'function' && !J.plainOff && !J.want && J.boot === 0 && J.loading === 0) { Module.orthrosFrames.plain++; return plain(...a); }",
    "Object.defineProperty(Module, '_omw_pump_frame', { configurable: true, enumerable: true, get: () => pump, set: (f) => { if (!promising) { promising = f; pump = choose; } else pump = f; } });",
    "J.plainOff = ENV['OPENMW_ORTHROS_JSPI_PLAIN'] === '0';", 'c.fenceSync(c.SYNC_GPU_COMMANDS_COMPLETE, 0)', 'c.getSyncParameter(s, c.SYNC_STATUS) === c.SIGNALED'])
    assert.ok(lib.includes(k), k);
  assert.ok(patch.includes('+        if (mNestedLoadingCount == 1)\n+            if (orthros_jspi_may())\n+                orthros_jspi_settle();'), 'the outermost loading screen\'s end settles');
  // (a framebuffer's status in a load's frame — its loading screen, the world's first draw after it —: asked once the GPU
  // ran its queue, the engine suspended meanwhile; at most every glMs, never in play, never with ?jspigl=0)
  const J2 = { on: 1, boot: 0, loading: 0, plain: 0, suspended: 0, off: false, loadFrame: 0, glMs: 50, glAt: 0 };
  const gl = new Function('OrthrosJspi', 'orthrosMaySuspend', 'orthrosSuspend', 'orthrosGpuIdle', `return ${fn('orthros_gl_settle')};`)(J2, () => true, (p, path, kind, then) => p.then(() => then(true)), () => Promise.resolve());
  assert.equal(gl(), undefined, 'in play: never');
  const loading2 = new Function('OrthrosJspi', 'orthrosNote', `return ${fn('orthros_jspi_loading')};`)(J2, () => {});
  loading2(1); loading2(0); assert.equal(J2.loadFrame, 1, 'the rest of the load\'s frame');
  const g1 = gl(); assert.ok(g1 && typeof g1.then === 'function', 'a load\'s frame: suspends'); await g1;
  assert.equal(gl(), undefined, 'not again within glMs');
  J2.glAt = -1e9; J2.glMs = 0; assert.equal(gl(), undefined, '?jspigl=0: never');
  // (the promising exports' stacks made deep first — 1,024 plain wasm frames at their base —: Chromium's native stack
  // walker, which stops at 255 frames, never reaches a JSPI stack's end, past which it read and crashed the renderer;
  // the plain frame goes straight to the work)
  for (const k of ['constexpr int ORTHROS_JSPI_DEPTH = 1024;', 'return orthrosDeep(ORTHROS_JSPI_DEPTH, fn, arg);', 'g_orthrosDeepSink = g_orthrosDeepSink + 1;',
    'extern "C" EMSCRIPTEN_KEEPALIVE void omw_pump_frame()\n+{\n+    orthros_jspi_deep(', '+    orthros_jspi_plain(1);\n+    orthrosPumpFrame();\n+    orthros_jspi_plain(0);',
    'const int status = orthros_jspi_deep(', 'return Debug::wrapApplication(&runApplication, a->argc, a->argv, "OpenMW");'])
    assert.ok(patch.includes(k), k);
  for (const k of ['-Wl,--wrap=glCheckFramebufferStatus -Wl,--wrap=emscripten_glCheckFramebufferStatus', 'unsigned int __wrap_glCheckFramebufferStatus(unsigned int target)', "ENV.OPENMW_ORTHROS_JSPI_GL_MS=", 'if (J.on === 0 && J.loading === 0) J.loadFrame = 0;'])
    assert.ok(patch.includes(k), k);
});

/**
 * The r18 library's WebSocket setter wrappers (wasm-build/orthros-jspi.js, from the patch), run against a stand-in
 * WebSocket: `wrap` true makes another script wrap the same setters first, as a debugging tool or a test's counter
 * would (its getter the native one: it answers the tool's own function, never the library's).
 */
function r18Sockets({ wrap, variant = (code) => code }) {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r18.patch'), 'utf8');
  const file = patch.slice(patch.indexOf('+++ b/wasm-build/orthros-jspi.js'));
  const lib = file.slice(file.indexOf('\n') + 1).split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
  const from = lib.indexOf("    if (typeof WebSocket != 'undefined') {"), to = lib.indexOf('\n#endif', from);
  assert.ok(from > 0 && to > from, 'the WebSocket block in orthros-jspi.js');
  class WebSocket { constructor() { this.native = {}; } fire(name, e) { this.native[name]?.call(this, e); } }
  for (const name of ['onopen', 'onmessage', 'onerror', 'onclose'])
    Object.defineProperty(WebSocket.prototype, name, { configurable: true, enumerable: true, get() { return this.native[name] ?? null; }, set(fn) { this.native[name] = fn; } });
  const seen = [];
  if (wrap) {
    for (const name of ['onmessage', 'onopen']) {
      const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, name);
      Object.defineProperty(WebSocket.prototype, name, { configurable: true, enumerable: true, get: d.get, set(fn) { d.set.call(this, typeof fn == 'function' ? function (e) { seen.push(name); return fn.call(this, e); } : fn); } });
    }
  }
  const J = { suspended: 0, after: [], flushing: false };
  const orthrosLater = (fn) => { if (J.suspended > 0 || (J.after.length > 0 && !J.flushing)) { J.after.push(fn); return true; } fn(); return false; };
  const flush = () => { J.flushing = true; while (J.after.length) J.after.shift()(); J.flushing = false; };
  const webSockets = { allocated: [null] };
  new Function('WebSocket', 'webSockets', 'orthrosLater', variant(lib.slice(from, to)))(WebSocket, webSockets, orthrosLater);
  return { WebSocket, webSockets, J, flush, seen };
}

test('r18: the engine\'s WebSocket events reach it — after the frame while suspended — with or without another script wrapping the setters; dropped once its handler is replaced or its socket deleted', () => {
  for (const wrap of [false, true]) {
    const { WebSocket, webSockets, J, flush, seen } = r18Sockets({ wrap });
    const ws = new WebSocket(), got = [];
    webSockets.allocated.push(ws);
    ws.onopen = () => got.push('open');
    ws.onmessage = (e) => got.push(e.data);
    ws.fire('onopen', {}); ws.fire('onmessage', { data: 'm1' });
    assert.deepEqual(got, ['open', 'm1'], `wrap ${wrap}: delivered at once`);
    // (the engine suspended: put off, in order, delivered at the frame's end)
    J.suspended = 1; ws.fire('onmessage', { data: 'm2' }); ws.fire('onmessage', { data: 'm3' });
    assert.deepEqual(got, ['open', 'm1'], `wrap ${wrap}: put off while suspended`);
    J.suspended = 0; flush();
    assert.deepEqual(got, ['open', 'm1', 'm2', 'm3'], `wrap ${wrap}: after the frame, in order`);
    if (wrap) assert.deepEqual(seen, ['onopen', 'onmessage', 'onmessage', 'onmessage'], 'the other script still sees every event');
    // (a handler replaced while an event of the old one is queued: dropped)
    J.suspended = 1; ws.fire('onmessage', { data: 'old' });
    const got2 = []; ws.onmessage = (e) => got2.push(e.data);
    J.suspended = 0; flush();
    assert.deepEqual(got.slice(4), [], `wrap ${wrap}: the old handler's queued event dropped`);
    ws.fire('onmessage', { data: 'new' });
    assert.deepEqual(got2, ['new'], `wrap ${wrap}: the new handler gets the next event`);
    // (the socket deleted — emscripten_websocket_delete: out of webSockets.allocated — with an event queued: dropped)
    J.suspended = 1; ws.fire('onmessage', { data: 'gone' });
    webSockets.allocated.splice(webSockets.allocated.indexOf(ws), 1);
    J.suspended = 0; flush();
    assert.deepEqual(got2, ['new'], `wrap ${wrap}: a deleted socket's queued event dropped`);
    // (a socket the engine did not make — the page's own —: its handler untouched, never put off)
    const own = new WebSocket(), mine = [];
    own.onmessage = (e) => mine.push(e.data);
    J.suspended = 1; own.fire('onmessage', { data: 'page' }); J.suspended = 0;
    assert.deepEqual(mine, ['page'], `wrap ${wrap}: the page's own socket not put off`);
  }
  // (the check the first two-client run broke on — the handler compared through the socket's getter —: with another
  // script wrapping the setters, every event of the engine dropped; this test catches it)
  const { WebSocket, webSockets } = r18Sockets({ wrap: true, variant: (code) => { assert.ok(code.includes('(current.get(socket) || {})[key] === wrapped')); return code.replace('(current.get(socket) || {})[key] === wrapped', 'd.get.call(socket) === wrapped'); } });
  const ws = new WebSocket(), got = [];
  webSockets.allocated.push(ws);
  ws.onmessage = (e) => got.push(e.data);
  ws.fire('onmessage', { data: 'm' });
  assert.deepEqual(got, [], 'the getter-based check drops the engine\'s events');
});

test('r18: a remote player\'s copy is not carried on past a jump (MWMP interp.lua: the step\'s time at least the stream\'s mean gap, no extrapolation above 2000 u/s), with the engine\'s own Lua test of it', () => {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r18.patch'), 'utf8');
  const at = patch.indexOf('+++ b/openmw/files/data/scripts/mp/interp.lua');
  assert.ok(at >= 0, 'the patch changes interp.lua');
  const hunk = patch.slice(at, patch.indexOf('\ndiff --git', at) >>> 0);
  for (const line of ['+local EXTRAP_MIN_DT = 0.033', '+local EXTRAP_MAX_SPEED = 2000', '+                local dt = math.max(a.t - p.t, self.mean or EXTRAP_MIN_DT, EXTRAP_MIN_DT)',
    '+                if sx * sx + sy * sy + sz * sz > (EXTRAP_MAX_SPEED * dt) ^ 2 then return a end', '+                local k = h / dt', '-                local k = h / (a.t - p.t)']) {
    assert.ok(hunk.includes(line), line);
  }
  assert.ok(patch.includes('+++ b/wasm-build/lua-tests/run.lua') && patch.includes("+  check('a 300 u jump 1-5 ms after the last pose leaves the copy where its owner stands"), 'the engine\'s Lua test of it');
});

test('r18: a load\'s framebuffer status waits for the GPU\'s queue 300 ms at most by default (?jspiglmax=N), then is asked as is', () => {
  const patch = fs.readFileSync(path.join(tools, 'patches/orthros-r18.patch'), 'utf8');
  const file = patch.slice(patch.indexOf('+++ b/wasm-build/orthros-jspi.js'));
  const lib = file.slice(file.indexOf('\n') + 1).split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
  const settle = lib.slice(lib.indexOf('\n  orthros_gl_settle: ('), lib.indexOf('\n  },', lib.indexOf('\n  orthros_gl_settle: (')));
  assert.ok(settle.includes('orthrosGpuIdle(J.glMaxMs)'), settle);
  assert.ok(lib.includes("var glMax = Number(ENV['OPENMW_ORTHROS_JSPI_GL_MAX_MS']);") && lib.includes('glMaxMs: 300'));
  assert.ok(patch.includes("+       if (/[?&]jspiglmax=(\\d+)\\b/.test(location.search)) ENV.OPENMW_ORTHROS_JSPI_GL_MAX_MS="));
});
