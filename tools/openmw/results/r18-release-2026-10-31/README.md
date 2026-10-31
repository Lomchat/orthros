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
