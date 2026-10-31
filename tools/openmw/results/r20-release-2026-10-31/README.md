# OpenMW engine orthros-r20 — smoke check of the INSTALLED release (2026-10-31)

The release `openmw-web-v1.5.3-orthros-r20` (engine `ecdde7a22836`, built by build.sh at 6a487c0, installed in
data/engines) checked as it would be served, before the switch. The live service still runs r19 (main 414dce8); nothing
merged, pushed, switched or restarted.

Setup (scripts/):
- A fresh copy of the live learned state and br-cache, made at 18:09 (`logs/copied-at.txt`). The br-cache was frozen and
  includes lean3 of package 2c6b8e83 (4,133,415 bytes), which r19 and r20 share.
- A scratch games folder (`overlay.mjs`, place-load's `scratchGames`): every Morrowind version (goty-en/fr,
  goty-vanilla-plus-en/fr) names r20; the live folder is only read. Servers ran data-r15's code with
  `--engines-dir /srv/orthros/data/engines` (read only).
- The page fetched `/engines/openmw-web-v1.5.3-orthros-r20/e/` with js/wasm from the pinned hashes 421d60e9… /
  82ee01a1… (`check/engine-url-fr.txt`).
- One browser at a time through tools/with-browser-slot.sh. Memory was logged every 30 s (`logs/memory.log`): the lowest
  available was 43 GB and nothing came near 16 GB.

Results (`summary.txt`):
- **check.mjs** `morrowind-goty-vanilla-plus-en` passed in both languages:
  - EN: 38,628 draws.
  - `--lang fr` (ran goty-vanilla-plus-fr): 35,148 draws.
  - Both: cross-origin isolated, header fps 60, "Saved in this browser".
- **overlay-check.mjs** `--engine openmw-web-v1.5.3-orthros-r20` passed for both games (morrowind,
  morrowind-vanilla-plus): all overlays agree with their originals.
- **Warm save** (`--mode save --input-trace --input-block 2000`). R is the installed release (its own warm-up,
  `warm-r20R.json`). C is r20dev-c, run on the fair validation's warm profile (jspi5/w20c).

  | | menu | F9 → world | steady | frozen | input p50 / p95 / max | page block | 2 s block check |
  |---|---|---|---|---|---|---|---|
  | R | 7.4 s | 3.8 s | 6.1 s | 1,917 ms | 655 / 2,602 / 2,902 ms over 179 events (none unanswered) | 898 ms | first 2,000 ms, residual ≤ 47 ms |
  | C | 7.4 s | 3.9 s | 11.1 s | 1,900 ms | 497 / 2,014 / 2,239 ms over 179 events (none unanswered) | 2,008 ms | first 1,997 ms, residual ≤ 42 ms |

  Both sides are within noise: the fair validation's six r20c runs had input p95 1,962–2,758 ms, page block
  403–2,023 ms, F9 4.0–4.1 s and one steady at 11.6 s.
- **COE** (`--mode coe`):
  - R: frozen 1,750 ms, cell reached 3.7 s, steady 5.8 s, coeSync 2,559 ms, page block 220 ms.
  - C: frozen 1,533 ms, cell reached 3.6 s, steady 5.7 s, coeSync 2,426 ms, page block 217 ms.
  - Both are within noise.
- **JSPI is on in the page:**
  - The release's openmw.js has the `_orthros_jspi` exports, `WebAssembly.Suspending` and `promising`.
  - Both COEs ran in the frame through `orthros_jspi`: `coeInFrame: true`.
  - `jspiProbe.engine.on: true`, with these suspensions:

    | | R | C |
    |---|---|---|
    | save, suspended | 2,408 ms | 2,407 ms |
    | COE, suspended | 3,053 ms | 2,793 ms |
    | soonSuspends | 9 | 9 |

  - The two-client pages counted suspensions as well: suspendedMs 3,306 and 5,579, soonSuspends 29 and 87.
  - **lateOld 0** in all four rows.
- **Two clients** (r17 mp-check.mjs, the installed release, `--engines-dir data/engines`): PASS, 9/9 checks, 222 s,
  no page error (`mp/r20R-1`).
- **Faults:** the only page faults were headless Chromium's "The root document of this element is not valid for pointer
  lock." (1 in each save row, 2 in each COE row), the same as in the earlier validations.
- **Kernel log:** no new chrome segfault or OOM kill since 18:09. `logs/dmesg-segfault-before.txt` and `-after.txt`
  are identical; the last chrome segfault is 06:06:37 that morning.
- **Load:** the one-minute load reached 28.6 during the runs (shared host); every browser start went through the slot
  gate.

Verdict: the installed r20 behaves like the validated r20dev-c.
