#!/bin/bash
# avail/load every 30 s; under 16 GB available: this task's place-load (naming jspi5 scratch, with --input-trace) stopped
L=/tmp/orthros-scratch/jspifair/logs/memory.log
while true; do
  a=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')
  echo "$(date +%T) avail=${a}G load=$(cut -d' ' -f1 /proc/loadavg)" >> $L
  if [ "$a" -lt 16 ]; then
    for p in $(pgrep -f '^node tools/openmw/place-load\.mjs .*jspi5.*--input-trace'); do echo "$(date +%T) LOW MEMORY ${a}G: killing $p" >> $L; kill $p; done
  fi
  sleep 30
done
