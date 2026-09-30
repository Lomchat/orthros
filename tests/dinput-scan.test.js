// Scan codes of virtual keys (scripted input models a physical keyboard: DirectInput sees scan codes only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanCodeOfVk } from '../src/win32/dinput8.js';

test('scan code of a virtual key (bit 8: extended key)', () => {
  assert.equal(scanCodeOfVk(0x1b), 0x01); // Escape
  assert.equal(scanCodeOfVk(0x0d), 0x1c); // Enter
  assert.equal(scanCodeOfVk(0x20), 0x39); // Space
  assert.equal(scanCodeOfVk(0x41), 0x1e); // A
  assert.equal(scanCodeOfVk(0x51), 0x10); // Q
  assert.equal(scanCodeOfVk(0x30), 0x0b); // 0
  assert.equal(scanCodeOfVk(0x31), 0x02); // 1
  assert.equal(scanCodeOfVk(0x70), 0x3b); // F1
  assert.equal(scanCodeOfVk(0x26), 0x148); // Up (E0 48)
  assert.equal(scanCodeOfVk(0x2e), 0x153); // Delete (E0 53)
  assert.equal(scanCodeOfVk(0xa3), 0x11d); // right Control (E0 1D)
  assert.equal(scanCodeOfVk(0xff), 0);
});
