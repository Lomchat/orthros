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
