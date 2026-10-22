// The page frame's header (src/host/web/shell.js) hides elements with the `hidden` attribute — the game data's pills once
// done (shell.setData), the version tag, the loader's progress. An author rule that sets `display` on them beats the
// browser's own `[hidden] { display: none }`: each such rule of player.css needs its `[hidden]` counterpart, else the
// pill stays ("Preloading 100 %", "Ready to play" in the world: seen on the Morrowind multiplayer check, 2026-10-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/host/web/player.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

/** The selectors of elements the shell toggles with `hidden`, as player.css styles them. */
const TOGGLED = ['#topbar .pill', '#topbar .brand .tag', '#loader .progress', '#loader .signin'];

test('player.css: each toggled element shown by a display rule has a [hidden] rule hiding it', () => {
  for (const sel of TOGGLED) {
    const shows = rules.some((r) => r.sel.split(',').map((s) => s.trim()).includes(sel) && /display\s*:\s*(?!none)/.test(r.body));
    if (!shows) continue;
    const hides = rules.some((r) => r.sel.split(',').map((s) => s.trim()).includes(`${sel}[hidden]`) && /display\s*:\s*none/.test(r.body));
    assert.ok(hides, `${sel}[hidden] { display: none } missing`);
  }
});
