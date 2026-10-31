#!/bin/bash
# avail/load every 30 s; under 16 GB available: this task's own measuring jobs (node tools/openmw/*.mjs naming jspi4 or data-r19/v3 scratch) stopped
L=/tmp/orthros-scratch/jspi4/logs/memory.log
while true; do
  a=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')
  echo "$(date +%T) avail=${a}G load=$(cut -d' ' -f1 /proc/loadavg) disk=$(du -s /tmp/orthros-scratch 2>/dev/null | awk '{printf "%.1fG", $1/1048576}')" >> $L
  if [ "$a" -lt 16 ]; then
    for p in $(pgrep -f '^node tools/openmw/[^ ]*\.mjs .*(orthros-scratch/jspi4|orthros-scratch/data-r19/v3)'); do
      echo "$(date +%T) LOW MEMORY ${a}G: killing $p $(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-150)" >> $L; kill $p
    done
  fi
  sleep 30
done
