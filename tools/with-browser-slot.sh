#!/bin/bash
# Run a command that starts a test browser (tools/headless.mjs, Playwright) within the project's resource budget on
# this shared server (see CLAUDE.md, "Shared server budget"): at most ORTHROS_BROWSERS (default 3) such commands at
# once for the whole project, and a new one starts only while the 1-minute load average is below ORTHROS_LOAD_MAX
# (default half the CPU count) and at least ORTHROS_MEM_MIN_GB (default 12) GB of memory are available. Otherwise it
# waits (every 20 s) for a slot. The command runs in a memory-limited scope (ORTHROS_BROWSER_MEM, default 12G, no swap),
# its CPU capped (ORTHROS_BROWSER_CPU, default 400%: 4 cores, as the server's navig does; low CPU weight):
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
scope=() pinned=0
cpu=${ORTHROS_BROWSER_CPU:-400%}
cpus=${ORTHROS_BROWSER_CPUS-auto}
if [ "$mem" != "0" ] && command -v systemd-run >/dev/null && systemd-run --scope --quiet -p MemoryMax=64M -- true 2>/dev/null; then
  scope=(systemd-run --scope --quiet -p "MemoryMax=$mem" -p MemorySwapMax=0 -p "CPUQuota=$cpu" -p CPUWeight=20)
  # ORTHROS_BROWSER_CPUS: the cores the browser is pinned to besides its quota. auto (the default): as many cores as the
  # quota gives (400 %: 4), a set of its own per slot counted from the last core (48 cores: slot 1 44-47, slot 2 40-43,
  # slot 3 36-39); <cpu list> (e.g. 44-47): those; empty (ORTHROS_BROWSER_CPUS=): the quota alone. A quota alone on
  # this 48-core host lets SwiftShader's 16 worker threads burn the quota in a few ms of each 100 ms period, then the
  # whole scope — the emulator's thread included — is stopped for the rest (docs/render-worker.md section 11): RotWK play
  # ran (--gl-discard) at 13 fps and 7.2 ns per guest instruction in the frame accounting with the quota alone, 28 fps
  # and 2.5 ns pinned (docs/jit-code-shape.md "Chrome against Node"). Pinned, the model is a 4-core PC, where at most 4
  # threads run at once. (Whole cores the quota covers, rounded down: more cores than the quota would throttle again.)
  if [ "$cpus" = auto ]; then
    q=${cpu%\%}; case "$q" in ''|*[!0-9]*) pinned=0 ;; *) pinned=$(( q / 100 )); [ "$pinned" -lt 1 ] && pinned=1 ;; esac
  elif [ -n "$cpus" ]; then scope+=(-p "AllowedCPUs=$cpus"); fi
fi
while :; do
  load=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$load" -v m="$loadmax" 'BEGIN { exit !(l < m) }' && "$(dirname "$0")/mem-check.sh" -q "$memmin"; then
    for i in $(seq 1 "$max"); do
      run=("${scope[@]}")
      if [ ${#run[@]} -gt 0 ] && [ "$pinned" -gt 0 ]; then
        hi=$(( $(nproc --all) - (i - 1) * pinned - 1 )); lo=$(( hi - pinned + 1 ))
        [ "$lo" -ge 0 ] && run+=(-p "AllowedCPUs=$lo-$hi")
      fi
      [ ${#run[@]} -gt 0 ] && run+=(--)
      # (-E 75: "slot busy" is told apart from the command's own exit status)
      flock -n -E 75 "/tmp/orthros-browser-slot.$i" "${run[@]}" "$@"
      rc=$?
      [ "$rc" -ne 75 ] && exit "$rc"
    done
  fi
  sleep 20
done
