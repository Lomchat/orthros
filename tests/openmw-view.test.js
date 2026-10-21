// The OpenMW engine page's view distance on a link that is not fast (src/ports/openmw/view-grow.js, view.lua; the
// page's hooks put in by src/host/openmw.js withProgressiveView): short at boot, raised by steps as the game data is
// quiet and the frames short, its far loads light; the player's own setting wins; Orthros' script always loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VIEW, VIEW_FILE, CONTENT, growStep, parseView, install } from '../src/ports/openmw/view-grow.js';
import { withProgressiveView } from '../src/host/openmw.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';

const LUA = fs.readFileSync(new URL('../src/ports/openmw/view.lua', import.meta.url), 'utf8');

test('the view grows by steps in an exterior, the game data quiet and the frames short, up to the tier\'s distance', () => {
  const s = { phase: 'wait', start: 8192, target: 12288, value: 8192, since: 0 };
  const look = (o) => growStep(s, { report: { live: s.value, base: 8192 }, exterior: true, quiet: true, framesOk: true, now: 0, ...o });
  assert.deepEqual(growStep(s, { report: null, exterior: true, quiet: true, framesOk: true, now: 0 }), {}, 'not in the world yet');
  assert.deepEqual(look({ exterior: false }), {}, 'inside: held');
  assert.deepEqual(look({ quiet: false }), {}, 'a read waited: held');
  assert.deepEqual(look({ framesOk: false }), {}, 'long frames: held');
  assert.deepEqual(look({ now: 1000 }), { write: 10240, prefer: 'light' }, 'a step: its loads light');
  assert.equal(s.phase, 'loading');
  assert.deepEqual(growStep(s, { report: { live: 8192, base: 8192 }, exterior: true, quiet: true, framesOk: true, now: 9000 }), {}, 'not applied by the script yet');
  assert.deepEqual(look({ now: 2000 }), {}, 'applied, not quiet for long enough since');
  assert.deepEqual(look({ now: 1000 + VIEW.quietMs, quiet: false }), {}, 'its loads wait');
  assert.deepEqual(look({ now: 1000 + VIEW.quietMs }), { prefer: null }, 'loaded');
  assert.equal(s.phase, 'wait');
  assert.deepEqual(look({ now: 5000 }), { write: 12288, prefer: 'light' });
  assert.deepEqual(look({ now: 9000 }), { prefer: null }); assert.equal(s.phase, 'done');
  assert.deepEqual(look({ now: 20000 }), {}, 'done: left alone');
});

test('the player\'s own view distance (saved, or changed in Options) stops the growth', () => {
  const s = { phase: 'loading', start: 8192, target: 16384, value: 10240, since: 0 };
  assert.deepEqual(growStep(s, { report: { live: 14336, base: 14336 }, exterior: true, quiet: true, framesOk: true, now: 9000 }), { prefer: null });
  assert.equal(s.phase, 'stopped');
  assert.deepEqual(parseView('10240 8192'), { live: 10240, base: 8192 }); assert.equal(parseView(undefined), null); assert.equal(parseView('x'), null);
});

/** An engine page's stand-ins: its window, its FS, the game data's quiet, a clock. */
function page({ slow, streamfs = true }) {
  const files = new Map(), dirs = [], ticks = [], data = { quiet: () => true, kind: 'unset', prefer(k) { this.kind = k; } };
  const win = { omw: { state: {} }, ...(streamfs ? { StreamFS: { data: () => data } } : {}) };
  const FS = { mkdirTree: (d) => dirs.push(d), writeFile: (f, t) => files.set(f, t) };
  let t = 0;
  return { win, FS, files, dirs, ticks, data, at: (v) => { t = v; }, o: { lua: LUA, slow, now: () => t, setInterval: (f) => { ticks.push(f); return 1; }, clearInterval: () => {} } };
}

test('on a link that is not fast the engine boots short and Orthros\' script steers its view; the content always loaded', async () => {
  const p = page({ slow: true });
  const g = await install(p.win, p.o);
  assert.equal(p.win.orthrosViewBoot('16384'), '8192'); assert.equal(p.win.orthrosViewStart, 8192); assert.equal(p.win.orthrosViewTarget, 16384);
  const cfg = p.win.orthrosContent(p.FS, ['data=/mwdata', 'content=Morrowind.esm']);
  assert.deepEqual(cfg.slice(-1), [`content=${CONTENT}`]);
  assert.equal(p.files.get('/resources/vfs/orthros.omwscripts'), 'PLAYER: scripts/orthros/view.lua\n');
  assert.equal(p.files.get('/resources/vfs/scripts/orthros/view.lua'), LUA);
  assert.equal(p.files.get(VIEW_FILE), '8192 8192');
  assert.equal(p.win.orthrosContent(p.FS, cfg).filter((l) => l === `content=${CONTENT}`).length, 1, 'once');
  assert.equal(p.ticks.length, 1, 'its look every half second');
  p.win.omw.state['orthros.view'] = '8192 8192'; p.win.omw.state['orthros.cell'] = '-3 -2';
  p.win.orthrosFrames = { p99: 200 }; p.at(1000); g.tick();
  assert.equal(p.files.get(VIEW_FILE), '8192 8192', 'long frames: held');
  p.win.orthrosFrames = { p99: 16 }; p.at(1000 + VIEW.holdMs); g.tick();
  assert.equal(p.files.get(VIEW_FILE), '10240 8192'); assert.equal(p.data.kind, 'light');
  p.win.omw.state['orthros.view'] = '10240 8192'; p.at(1000 + VIEW.holdMs + VIEW.quietMs); g.tick();
  assert.equal(p.data.kind, null, 'the step loaded: the link decides again');
});

test('on a fast link (or the release\'s own streaming) the engine boots at its tier\'s distance, the script left idle', async () => {
  for (const o of [{ slow: false }, { slow: true, streamfs: false }]) {
    const p = page(o);
    await install(p.win, p.o);
    assert.equal(p.win.orthrosViewBoot('12288'), '12288');
    assert.deepEqual(p.win.orthrosContent(p.FS, []), [`content=${CONTENT}`]);
    assert.equal(p.files.get(VIEW_FILE), '0 0'); assert.equal(p.ticks.length, 0);
  }
  const p = page({ slow: true });
  await install(p.win, p.o);
  assert.equal(p.win.orthrosViewBoot('8192'), '8192', 'the low tier: nothing to grow');
});

test('Orthros\' script reads the page\'s file, sets the camera only, tells the page its view and exterior cell', () => {
  for (const api of ["require('openmw.camera')", "require('openmw.vfs')", "require('openmw.mp')", 'camera.setViewDistance(', 'camera.getBaseViewDistance()',
    "vfs.open('orthros/view.txt')", 'core.getRealTime()', "mp.set(key, value)", "'orthros.view'", "'orthros.cell'", 'cell.gridX', 'onFrame']) assert.ok(LUA.includes(api), api);
  assert.ok(!/openmw\.settings|pollCommands/.test(LUA), 'never the settings, never the multiplayer queue');
  assert.equal(VIEW_FILE, '/resources/vfs/orthros/view.txt');
});

test('the engine page loads the view module before its engine, its boot distance and content through it', () => {
  const html = `<html><head><title>x</title></head><body><script>
    var s = '[Camera]\\n' + 'viewing distance = ' + ((/[?&]vd=(\\d+)/.exec(location.search)||[])[1] || TIER.vd) + '.0\\n';
    FS.writeFile('/openmw.cfg', cfg.join('\\n'));
    FS.writeFile('/openmw.cfg',cfg.join('\\n'));
    (function(){ var s = document.createElement('script'); document.body.appendChild(s); })();
  </script></body></html>`;
  const out = withProgressiveView(html);
  assert.ok(out.startsWith(`<html><head><script>window.orthrosViewReady = import('/src/ports/openmw/view-grow.js')`));
  assert.ok(out.includes('|| (window.orthrosViewBoot ? window.orthrosViewBoot(TIER.vd) : TIER.vd))'));
  assert.equal(out.split("FS.writeFile('/openmw.cfg', (window.orthrosContent ? window.orthrosContent(FS, cfg) : cfg).join('\\n'))").length, 3);
  assert.ok(out.includes('Promise.resolve(window.orthrosViewReady).then(function () { document.body.appendChild(s); });'));
  // (the installed release's page, when here: every hook found)
  const release = path.join(DEFAULT_ENGINES_DIR, 'openmw-web-v1.5.3/index.html');
  if (fs.existsSync(release)) {
    const real = withProgressiveView(fs.readFileSync(release, 'utf8'));
    for (const [k, n] of [['orthrosViewReady = import', 1], ['orthrosViewBoot(TIER.vd)', 1], ['orthrosContent(FS, cfg)', 3], ['Promise.resolve(window.orthrosViewReady)', 1]]) assert.equal(real.split(k).length - 1, n, k);
  }
});
