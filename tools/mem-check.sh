#!/bin/bash
# The server's memory, for the project's heavy jobs (CLAUDE.md "Shared server budget": incident of 2026-10-30 — test
# browsers, an engine compile and other projects together filled the 62 GB and swap, the server froze and rebooted).
# Usage: tools/mem-check.sh            prints the available memory in GB (MemAvailable)
#        tools/mem-check.sh -w|--wait <GB>  waits (every 20 s, a line on stderr each minute) until at least <GB> GB are
#                                      available, then exits 0
#        tools/mem-check.sh -q|--quiet <GB> exits 0 if at least <GB> GB are available now, 1 otherwise (no wait)
set -u
avail() { awk '/^MemAvailable:/ { printf "%d", $2 / 1048576 }' /proc/meminfo; }
case "${1:-}" in
  -w|--wait)
    need=${2:?GB}; n=0
    while [ "$(avail)" -lt "$need" ]; do
      [ $((n % 3)) -eq 0 ] && echo "mem-check: $(avail) GB available, waiting for $need GB" >&2
      n=$((n + 1)); sleep 20
    done ;;
  -q|--quiet) [ "$(avail)" -ge "${2:?GB}" ] ;;
  *) avail; echo ;;
esac
