#!/bin/bash
# avail/load every 30 s; under 16 GB: this task's own measuring jobs (command lines naming r18-ship scratch or its ports) stopped
L=/tmp/orthros-scratch/r18-ship/logs/memory.log
while true; do
  a=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')
  echo "$(date +%T) avail=${a}G load=$(cut -d' ' -f1 /proc/loadavg)" >> $L
  if [ "$a" -lt 16 ]; then
    for p in $(pgrep -f '^node [^ ]*(tools/[^ ]*\.mjs|mp-check\.mjs) .*(r18-ship|127\.0\.0\.1:187[0-9][0-9])'); do
      echo "$(date +%T) LOW MEMORY ${a}G: killing $p $(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-150)" >> $L; kill $p
    done
  fi
  sleep 30
done
