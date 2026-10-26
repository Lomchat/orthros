// The folders outside Git (README.md "Dossiers hors Git"): data/ the precious (games, engines, …: never tracked, never
// under build/), backups/ the backups, build/ the disposable (make clean); the live OpenMW state with the services'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GAMES_DIR } from '../src/host/game-catalog.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';
import { OPENMW_STATE_DIR } from '../src/host/openmw.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('layout: games and engines under data/, the OpenMW state out of the repository', () => {
  assert.equal(DEFAULT_GAMES_DIR, path.join(root, 'data/games'));
  assert.equal(DEFAULT_ENGINES_DIR, path.join(root, 'data/engines'));
  assert.ok(!OPENMW_STATE_DIR.startsWith(root + '/') && path.isAbsolute(OPENMW_STATE_DIR), OPENMW_STATE_DIR);
});

test('layout: data and backups ignored by Git as folders and as links (no trailing slash), build/ too', () => {
  // (a pattern ending in / leaves a symlink of that name trackable: a worktree's committed `data_games` link replaced
  // the live library on a fast-forward, 2026-10-02)
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
  for (const l of ['/data', '/backups', 'build/']) assert.ok(lines.includes(l), l);
});
