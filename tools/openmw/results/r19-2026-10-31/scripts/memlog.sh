#!/bin/bash
# avail/load every 30 s; under 16 GB available: this task's own measuring jobs (their command line names this scratch) stopped
while true; do
  a=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')
  echo "$(date +%T) avail=${a}G load=$(cut -d' ' -f1 /proc/loadavg)" >> /tmp/orthros-scratch/data-r19/logs/memory.log
  if [ "$a" -lt 16 ]; then
    for p in $(pgrep -f '^node tools/openmw/[^ ]*\.mjs .*(orthros-scratch/data-r19|127\.0\.0\.1:189[0-9][0-9])'); do
      echo "$(date +%T) LOW MEMORY ${a}G: killing $p $(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-150)" >> /tmp/orthros-scratch/data-r19/logs/memory.log; kill $p
    done
  fi
  sleep 30
done
