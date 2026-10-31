// The scratch games folder of this check: every Morrowind version (both games) on the r20 release
import { scratchGames } from '/srv/orthros/.claude/worktrees/data-r15/tools/openmw/place-load.mjs';
const e = 'openmw-web-v1.5.3-orthros-r20';
const r = scratchGames({ live: '/srv/orthros/data/games', out: process.argv[2], engines: Object.fromEntries(['morrowind-goty-en', 'morrowind-goty-fr', 'morrowind-goty-vanilla-plus-en', 'morrowind-goty-vanilla-plus-fr'].map((v) => [v, e])) });
console.log(JSON.stringify(r.changed));
