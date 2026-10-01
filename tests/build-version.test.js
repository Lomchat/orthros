// The served build's version (telemetry context): commit, '+' when src/ differs, newest source modification time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVersion } from '../src/host/server.js';

test('build version of this tree', () => {
  assert.match(buildVersion(), /^([0-9a-f]{4,}|nogit)\+?@\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('build version of a tree without git: the newest source time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-version-'));
  fs.mkdirSync(path.join(dir, 'src/a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a/x.js'), '');
  fs.utimesSync(path.join(dir, 'src/a/x.js'), new Date('2026-01-02T03:04:05Z'), new Date('2026-01-02T03:04:05Z'));
  assert.equal(buildVersion(dir), 'nogit@2026-01-02T03:04:05Z');
  fs.rmSync(dir, { recursive: true });
});
