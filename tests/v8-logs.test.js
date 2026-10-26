// tools/v8-logs.mjs: V8's log files under the scratch, not in the browser's working directory (the repository's root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v8LogArgs } from '../tools/v8-logs.mjs';
import { launchOptions } from '../tools/port-perf.mjs';

test('v8 logs: every --js-flags gets a --logfile in the directory, made first; other switches untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-logs-')), dir = path.join(root, 'logs');
  try {
    assert.deepEqual(v8LogArgs(['--no-sandbox', '--mute-audio'], dir), ['--no-sandbox', '--mute-audio']);
    assert.equal(fs.existsSync(dir), false); // (no V8 flag, no directory)
    assert.deepEqual(v8LogArgs(['--x', '--js-flags=--prof --log-maps'], dir), ['--x', `--js-flags=--prof --log-maps --logfile=${dir}/v8.log`]);
    assert.ok(fs.statSync(dir).isDirectory());
    // (a --logfile given is kept; --logfile-per-isolate is another flag)
    assert.deepEqual(v8LogArgs(['--js-flags=--log --logfile=/x/v8.log'], dir), ['--js-flags=--log --logfile=/x/v8.log']);
    assert.deepEqual(v8LogArgs(['--js-flags=--logfile=-'], dir), ['--js-flags=--logfile=-']);
    assert.deepEqual(v8LogArgs(['--js-flags=--log --logfile-per-isolate'], dir), [`--js-flags=--log --logfile-per-isolate --logfile=${dir}/v8.log`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('v8 logs: the ports\' launch options route a --js-flags through it', () => {
  const o = launchOptions({ gl: 'gpu', channel: 'shell', args: ['--js-flags=--log-function-events'] });
  assert.ok(o.args.includes('--js-flags=--log-function-events --logfile=/tmp/orthros-scratch/v8-logs/v8.log'), o.args.join(' '));
});
