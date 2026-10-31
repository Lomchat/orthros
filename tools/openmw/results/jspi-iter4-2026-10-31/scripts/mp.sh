#!/bin/bash
# usage: mp.sh <side 19L|20b> <out dir>: two clients (the r17 results' mp-check.mjs) on that side's engine release
S=/tmp/orthros-scratch/data-r19; V=$S/v3; J=/tmp/orthros-scratch/jspi4; W=/srv/orthros/.claude/worktrees/data-r15
case $1 in 19L) eng=openmw-web-v1.5.3-orthros-r19 ;; 20*) eng=openmw-web-v1.5.3-orthros-r20dev-${1#20} ;; esac
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) mp $1 $2" >> $J/logs/runs-started.txt
cd $W && /srv/orthros/tools/with-browser-slot.sh node tools/openmw/results/r17-2026-10-30/mp-check.mjs $W $eng $2 --pristine $V/pristine --engines-dir $S/eng
