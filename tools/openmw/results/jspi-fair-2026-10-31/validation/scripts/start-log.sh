#!/bin/bash
# usage (inside the browser slot): start-log.sh <label> <command...>: the start's time, available memory and 1-min load logged when the slot is granted, then the command exec'd
L=/tmp/orthros-scratch/jspifair2/logs/runs-started.txt; lab=$1; shift
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) $lab" >> $L
exec "$@"
