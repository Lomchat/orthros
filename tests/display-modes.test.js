import test from 'node:test';
import assert from 'node:assert/strict';
import { displayModes } from '../src/win32/display-modes.js';

test('display modes: common 4:3/16:10/16:9 up to the screen, current and manifest modes always present, ascending', () => {
  const l = displayModes({ width: 1024, height: 768, nominal: [1024, 768], screenSize: [1920, 1080] });
  const has = (w, h) => l.some((m) => m[0] === w && m[1] === h);
  assert.ok(has(800, 600) && has(1024, 768) && has(1280, 800) && has(1920, 1080));
  assert.ok(!has(2560, 1440) && !has(1920, 1200));
  const odd = displayModes({ width: 1000, height: 700, nominal: [1111, 555], screenSize: [800, 600] });
  assert.ok(odd.some((m) => m[0] === 1000 && m[1] === 700) && odd.some((m) => m[0] === 1111 && m[1] === 555));
  assert.deepEqual(odd, [...odd].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
});

test('a new player\'s display mode (the largest): a publishing session given it as its screen gets the same, so the same snapshot key', async () => {
  const { largestMode } = await import('../src/win32/display-modes.js');
  const { publishMode } = await import('../src/server/snapshot-store.js');
  const man = { display: { width: 1024, height: 768 }, newProfileIni: { 'AppData/G/Options.ini': { '': { Resolution: '{modeWidth} {modeHeight}' } } } };
  const at = (screenSize) => largestMode({ width: 1024, height: 768, nominal: [1024, 768], screenSize });
  assert.deepEqual(at([1920, 1080]), [1920, 1080]);
  assert.deepEqual(at([1536 * 2.5, 960 * 2.5]), [3840, 2160]);
  // (players' screens: physical pixels, odd ones too; the server queues the page's mode, the session runs at it)
  for (const screen of [[1920, 1080], [2560, 1440], [1536, 864], [1366, 768], [1280, 900], [800, 600], [3840, 2400], [1440, 900], [1920, 911], [2880, 1800]]) {
    const mode = at(screen).join('x');
    assert.equal(publishMode(man, mode), mode, `${screen}: its mode is one a session can be run at`);
    assert.equal(at(mode.split('x').map(Number)).join('x'), mode, `${screen}: the session at ${mode} takes ${mode}`);
  }
  assert.equal(publishMode(man, '9999x9999'), null);
  assert.equal(publishMode({ display: man.display }, '1920x1080'), '', 'a manifest whose settings do not name the mode: none');
});
