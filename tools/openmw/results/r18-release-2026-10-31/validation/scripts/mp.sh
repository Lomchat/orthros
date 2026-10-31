#!/bin/bash
# usage: mp.sh <17|18> <out dir>
S=/tmp/orthros-scratch/r18-ship; T=/srv/orthros/.claude/worktrees/r18-small; M=/srv/orthros/.claude/worktrees/data-r15/tools/openmw/results/r17-2026-10-30/mp-check.mjs
case $1 in 17) tree=/srv/orthros; e=openmw-web-v1.5.3-orthros-r17 ;; 18) tree=$T; e=openmw-web-v1.5.3-orthros-r18 ;; esac
/srv/orthros/tools/mem-check.sh -w 24
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) mp $1 $2" >> $S/logs/runs-started.txt
cd $tree && /srv/orthros/tools/with-browser-slot.sh node $M $tree $e $2 --pristine $S/pristine --engines-dir /srv/orthros/data/engines --port 18751 --gw-port 28751
