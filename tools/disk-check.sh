#!/bin/bash
# Disk budget of Orthros' scratch on this shared server (CLAUDE.md, "Disk budget"): exits 1 with a message when the
# scratch (/tmp/orthros-scratch + the agent worktrees in .claude/worktrees) exceeds ORTHROS_SCRATCH_GB (default 30) or
# the disk holding /tmp is fuller than ORTHROS_DISK_MAX_PCT (default 85). Prints the usage otherwise.
# Usage: tools/disk-check.sh [-q]
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
max_gb=${ORTHROS_SCRATCH_GB:-30}
max_pct=${ORTHROS_DISK_MAX_PCT:-85}
dirs=()
for d in /tmp/orthros-scratch "$root/.claude/worktrees"; do [ -d "$d" ] && dirs+=("$d"); done
used_kb=0
[ ${#dirs[@]} -gt 0 ] && used_kb=$(du -sk "${dirs[@]}" 2>/dev/null | awk '{s += $1} END {print s + 0}')
used_gb=$(( used_kb / 1048576 ))
pct=$(df --output=pcent /tmp | tail -1 | tr -dc '0-9')
msg="Orthros scratch ${used_gb} GB of ${max_gb} GB; disk ${pct}% used (max ${max_pct}%)"
if [ "$used_gb" -ge "$max_gb" ] || [ "$pct" -ge "$max_pct" ]; then
  echo "disk-check: OVER BUDGET — $msg. Clean up your finished test outputs and merged worktrees first (CLAUDE.md, Disk budget)." >&2
  du -sh "${dirs[@]}" "$root"/.claude/worktrees/* 2>/dev/null | sort -rh | head -12 >&2
  exit 1
fi
[ "${1:-}" = "-q" ] || echo "disk-check: $msg"
exit 0
