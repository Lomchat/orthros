# orthros-r18: review fixes checked (2026-10-31)

- `lua-tests-lua51.txt`: the engine's whole `wasm-build/lua-tests/run.lua` under Lua 5.1.5 (Docker `alpine:3` +
  `apk add lua5.1`, as `run.sh` runs it; `--memory 2g`) on two scratch trees built from the pinned source
  (`data/engines/src/openmw-web-v1.5.3`) with `git apply --exclude='deps/*'` of orthros-r1..r17:
  - with the fix (r1..r18): 497 passed, 0 failed;
  - without it (r1..r17 + only r18's `run.lua` hunk): 495 passed, 2 failed — the two new jump checks
    (13500 u and 409 u off). Every other check is the same in both.
- `http-backend-slow-without-fix.txt`: `tests/http-backend-slow.test.js` of this commit run against `http-backend.js`
  without the archive-stream exemption: the new archive-stream test fails (`still queued`: its 5 queued read-aheads
  dropped while another file was read in turn); with the fix, 19 of 19 pass.

# orthros-r18 validated against the live r17 (2026-10-31): SHIP (docs/openmw.md, r18 section)

`validation/`: r18 (data/engines, this branch's code, a scratch games overlay) against r17 (main 30ff5ec, live games),
each server on a fresh copy of the live learned state and a frozen copy of the live br-cache; one browser at a time.
- `mp/r18-*.json|log`, `mp/r17-*`: two-client checks (r18-1: harness setup failure, gateway without `data/`; r18-5 is its rerun).
- `perf/` (5 pairs), `perfx/` (3 crossed rounds: 17 r17+main, 18 r18+branch, 17x r17 engine+branch page, 18x r18 engine+main page).
- `pl-r1[78]-save.jsonl`, `pl-r1[78]-save85k.jsonl`: place-load save from the menu, 1.8 MB/s and 85 KB/s.
- `lean-engine-files.txt`: engine files through the proxy in the warm-ups and the measured runs.
- `check/`, `overlay-check-*.txt`, `other/` (GoldSrc, re3, Win32 boot, Win32 85 KB/s main vs branch), `scripts/`, `logs/`
  (runs started with memory and load, memory every 30 s: never under 41 GB available).
