#!/bin/bash
# Run a command that starts a test browser (tools/headless.mjs, Playwright) within the project's resource budget on
# this shared server (see CLAUDE.md, "Shared server budget"): at most ORTHROS_BROWSERS (default 3) such commands at
# once for the whole project, and a new one starts only while the 1-minute load average is below ORTHROS_LOAD_MAX
# (default half the CPU count) and at least ORTHROS_MEM_MIN_GB (default 12) GB of memory are available. Otherwise it
# waits (every 20 s) for a slot. The command runs in a memory-limited scope (ORTHROS_BROWSER_MEM, default 12G, no swap):
# a browser that grows past it (SwiftShader's GPU process grows over long runs) is killed alone instead of the server
# running out of memory (incident of 2026-10-30: the server froze and rebooted). ORTHROS_BROWSER_MEM=0: no scope.
# Usage: tools/with-browser-slot.sh node tools/headless.mjs bfme2 --seconds 120 ...
set -u
# (no browser while Orthros' scratch is over its disk budget or the disk is too full: CLAUDE.md "Disk budget")
"$(dirname "$0")/disk-check.sh" -q || exit 3
max=${ORTHROS_BROWSERS:-3}
loadmax=${ORTHROS_LOAD_MAX:-$(( $(nproc) / 2 ))}
memmin=${ORTHROS_MEM_MIN_GB:-12}
mem=${ORTHROS_BROWSER_MEM:-12G}
scope=()
if [ "$mem" != "0" ] && command -v systemd-run >/dev/null && systemd-run --scope --quiet -p MemoryMax=64M -- true 2>/dev/null; then
  scope=(systemd-run --scope --quiet -p "MemoryMax=$mem" -p MemorySwapMax=0 --)
fi
while :; do
  load=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$load" -v m="$loadmax" 'BEGIN { exit !(l < m) }' && "$(dirname "$0")/mem-check.sh" -q "$memmin"; then
    for i in $(seq 1 "$max"); do
      # (-E 75: "slot busy" is told apart from the command's own exit status)
      flock -n -E 75 "/tmp/orthros-browser-slot.$i" "${scope[@]}" "$@"
      rc=$?
      [ "$rc" -ne 75 ] && exit "$rc"
    done
  fi
  sleep 20
done
