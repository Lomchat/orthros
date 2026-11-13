# Fourth round of 2026-11-12/13, combined and measured against main

Branch `wave4-int` (from main 5d6ba87): the ten levers of the night's research plan, merged when their review allowed it,
with the review's blocking findings fixed at integration; then the combined build measured against main on the metrics
the owner follows. Each lever's own document holds its details; this page is the integration's record.

## What went in

| lever (branch) | in | default | integration fixes (from its review) |
|---|---|---|---|
| telemetry (4b7-1): GPU fences read on wake-up, compatibility gaps, ready signal | yes | on (fixes) | the ready signal and its `ready` event once: `shell.hideLoader` ignores calls during its 850 ms fade (stats every 500 ms sent it twice, the second possibly `hidden:false`); gpu-probe test bound 10 → 100 ms (late timers in a parallel `make test`) |
| snapshots-fr (4b7-2): warm jobs in the players' languages, bfme1-108 learn scenario, serialized puts | yes | on with `--warm-jobs` | `SnapshotQueue`: a job past its ttl under an older key of the same version goes, a full queue drops its oldest finished jobs (11-16 jobs a wave, a few deploys a day filled `max=32` and refused players' 404 publishes for 6 h) — tests/warm-jobs.test.js |
| mapload-wait (4b7-3): Sleep(0) between units of work is not a spin | yes | on (`ORTHROS_SLEEP0_SPIN_INSNS=128`) | docs: on a virtual clock the rule stalls BFME 1.08's load (below) |
| aotr (4b7-4): fixed start position in the AotR scenarios, play/memory diagnosis, `startbench --mem` | yes | — (scenarios, tools) | — |
| archive-fill (4b7-5): files waited on in play filled whole on medium links | yes (squashed) | **off** (`ORTHROS_ARCHIVE_FILL`) | a streamed file and a wait inside a load's burst (`NetLink.inBurst`) are no wait-minutes; docs: `archiveLink` needs this page's measure, the budget lives as long as the store |
| thin-link (4b7-6): snapshot weighed against a cold start, pieces into OPFS, data worker on thin links | yes | on (`?snapfetch=0` off) | first answer's piece index fixed before the id check (a republished snapshot restored corrupted); CRC-32 per piece (`X-Piece-Sum`) checked by the page; a refused store write goes on in memory; pieces dropped when a cold start is chosen or a profile exists; no 1 GB/s rate when all pieces are here; gzip pieces async and cached; one temporary file per piece build; **cold-start cost = max(reads, start-up), not their sum** (measured below) |
| snapshot-key (4b7-7): key from the state's shape | tool + docs only | — (NO-GO) | tool scratch under /tmp/orthros-scratch |
| compat (4b7-8): `orthros scan`, kernel32 Vista+, API sets, SxS VC80/90, unknown imports stop | yes | on (`ORTHROS_UNKNOWN_IMPORT=stub` off) | a cdecl DLL's unimplemented export (msvcrt, msvcrt40, crtdll; `?…@@YA`) keeps the 0-argument stub (`ApiRegistry.callerPops`), in the VM and the scan |
| drop-folder (4b7-9): "launch my game" from a folder | yes | **off** (`?dropgame=1`) | security: a dropped folder's manifest.json keeps only Win32 options (`LOCAL_KEYS`; a `launchUrl` of `javascript:` ran on Orthros' origin), descriptions filtered again on load, main ignores `launchUrl` for a local game; a block missing from a local copy fails without a request (`HttpBackend.offline`) |
| cpu-margin (4b7-10): skirmish CPU growth diagnosis, `guest-profile.mjs` | tools + docs | — (NO-GO ×3) | `guest-profile.mjs`: empty export names, `$lib_` kernels |

`make test`: 1812 tests, 1807 pass, 0 fail, 3 skipped, 2 todo, 81 s.

## Measured, main → combined

Conditions: 2026-11-13 02:40-05:00, load average 4-12 (the other agents mostly idle). Chrome: headless shell through
`tools/with-browser-slot.sh` (4 cores each), `--gl-discard --game-lang fr`, the two arms at once in two slots (the first
started alternated), each tree's own harness server on its own copy of the live learned directory and one frozen copy
of the live brotli units (`--br-cache-frozen`); `--net <ms>:<Mbit/s>` the simulated link; the combined arm with
`--dbg ORTHROS_DATA_WORKER=auto` as a player's page. A new French player: a fresh browser profile, no French shared
snapshot on main (the live store has only English ones), the combined arm's French snapshots published first by its own
server's warm jobs (`--snapshot-jobs --warm-jobs --warm-langs fr`, as a deploy would). Node: `ab-virtual
--variant-tree main=<git archive of main>`, both arms at once, 2 runs each; BFME1 map load on a real clock (`startbench
bfme1-108 --bench bfme1-108-quick --until-api none --sleeps`, the two trees at once, 2 rounds).

| metric | main | combined |
|---|---|---|
| New French player, BFME 1.08, 1.25 MB/s: menu (first image) | 82 s (55), 81 s (54) — cold, no French snapshot | 105 s (89) with the summed cost model (93 MB snapshot taken); **87 s (60)** with the final model (cold chosen) |
| New French player, Age of the Ring, 1.25 MB/s: menu (first image) | 196 s (180), cold | **90 s (62)**, the French snapshot |
| New French player, BFME 1.08, 85 KB/s: menu (first image) | 741 s (366), cold | 745 s (370), cold chosen (same path) |
| New French player, Age of the Ring, 85 KB/s | not reached in 2400 s (still in the launcher) | not reached in 2400 s: snapshot restored at 664 s, then 80+ MB of reads at 83 KB/s with 3 frames (see below) |
| Returning player (own snapshot, 2nd session, same build), 1.25 MB/s: BFME 1.08 / AotR menu (first image) | 35 s (19) / 118 s (95) | **28 s (4)** / 119 s (95) |
| BFME 1.08 map load, Node real clock (`bfme1-108-quick`, 2 rounds): load phase; longest frame | 56.9, 50.9 s; 20.4, 15.3 s | **36.3, 36.3 s; 1.8, 1.7 s** |
| BFME 1.08 map load, Chrome (`--bench bfme1-108-quick`, 1.25 MB/s, `--opfs`): session 1 / session 2 | 65.0 / 52.7 s | 73.2 / **38.9 s** |
| BFME 1.08 play, Chrome, 120 s: fps, frames > 40 ms /min, > 100 ms /min — session 1 | 28.2, 260, 7.0 | 26.6, 352, 16.5 |
| same, session 2 (same profile) | 27.7, 354, 12.0 | 28.3, 289, 9.0 |
| Age of the Ring skirmish, Chrome | not measured (the scenario stayed on the menu in both arms) | — |
| Age of the Ring endurance | not run again: the aotr branch's 8 Node sessions (peak 1031 MiB, no allocation without room; 60 min of play not reached — the passive player is beaten at 13-15 min) | — |
| Thread CPU per frame in play, Node virtual clock (ms; batches) — RotWK `fixplay` | 10.86, 11.58, 11.54 | 11.38, 11.22, 11.58 (+0.6 % on the means) |
| BFME 1.08 `fixplay` (both arms `ORTHROS_SLEEP0_SPIN_INSNS=0`, see below) | 15.20 | 15.47 (+1.8 %) |
| Age of the Ring `fixplay` (both arms `=0`) | 16.30, 15.95 | 16.85, 15.66 (+0.8 %) |
| Vice City `drive` | 9.03 | 9.08 (+0.5 %) |

Spread: one Chrome run per arm and case (two for BFME1 at 1.25 MB/s). Node batches of the same build moved by up to ±4 %
(RotWK `fixplay`: +4.7 %, −3.1 %, +0.3 % in three batches): the play CPU is unchanged within that noise — no lever of
this round targets the translated code (cpu-margin was a NO-GO). The guest instruction counts of the compared phases
are equal (RotWK ±0.1 %: the Sleep(0) rule moves an interleaving). The Chrome play rows are one run each: session 1
combined had its menu reads skipped by the snapshot and fetched more during the load and play; session 2 is the
like-for-like one.

## Found

- **The snapshot's cost model summed the cold start's reads and its start-up.** They overlap: BFME 1.08 at 1.25 MB/s
  reached its menu cold in 82 s (57 MB launch set: 61 s of link; 59 s of start-up), and the sum (120 s estimated) took
  its 93 MB snapshot instead: 105 s. Now `max(reads, start-up)`; Age of the Ring (170 MB launch set, 252 s start-up)
  keeps its snapshot on every link, BFME1 at 85 KB/s still starts cold. The same was true on main for English players
  (the whole 93 MB snapshot taken at 1.25 MB/s, 106 s in thin-link's measures).
- **The Sleep(0) work rule on a virtual clock**: BFME 1.08's map load never ends under `startbench --virtual` (the clock
  advances only by sleeps; the throttles were what moved it): docs/api-layer.md. Virtual-clock A/B of a load: both arms
  with `--dbg ORTHROS_SLEEP0_SPIN_INSNS=0`. Real clocks are not concerned (Node real clock and Chrome measured above).
- **Age of the Ring, a new French player at 85 KB/s**: the combined arm restored the French snapshot at 664 s
  (thin-link measured the English one to the menu in 702 s), then read 80+ MB more at the link's rate for 1700 s with
  three frames shown, the menu not reached at 2400 s. Not explained (one run): the French session's reads after the
  restore are probably not in the learned order (learned from English sessions), so each comes on demand. To look at
  with `--net-log` before counting on French AotR players on thin links.
- **AotR in the Chrome skirmish scenario** (`fixes-aotr-play`, a fresh profile): both arms stayed on the main menu
  (16 draws per frame) for 1500 s — the profile screen's anchor never came; not measured in Chrome. Node covers its play.
