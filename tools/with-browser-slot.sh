#!/bin/bash
# Run a command that starts a test browser (tools/headless.mjs, Playwright) within the project's resource budget on
# this shared server (see CLAUDE.md, "Shared server budget"): at most ORTHROS_BROWSERS (default 3) such commands at
# once for the whole project, and a new one starts only while the 1-minute load average is below ORTHROS_LOAD_MAX
# (default half the CPU count). Otherwise it waits (every 20 s) for a slot.
# Usage: tools/with-browser-slot.sh node tools/headless.mjs bfme2 --seconds 120 ...
set -u
max=${ORTHROS_BROWSERS:-3}
loadmax=${ORTHROS_LOAD_MAX:-$(( $(nproc) / 2 ))}
while :; do
  load=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$load" -v m="$loadmax" 'BEGIN { exit !(l < m) }'; then
    for i in $(seq 1 "$max"); do
      # (-E 75: "slot busy" is told apart from the command's own exit status)
      flock -n -E 75 "/tmp/orthros-browser-slot.$i" "$@"
      rc=$?
      [ "$rc" -ne 75 ] && exit "$rc"
    done
  fi
  sleep 20
done
