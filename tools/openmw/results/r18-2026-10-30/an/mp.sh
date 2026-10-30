#!/bin/bash
# usage: mp.sh <engine release> <out dir>
S=/tmp/orthros-scratch/data-r18; W=/srv/orthros/.claude/worktrees/data-r15
/srv/orthros/tools/mem-check.sh -w 24
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) mp $1 $2" >> $S/logs/runs-started.txt
cd $W && /srv/orthros/tools/with-browser-slot.sh node tools/openmw/results/r17-2026-10-30/mp-check.mjs $W $1 $2 --pristine $S/pristine --engines-dir $S/eng
