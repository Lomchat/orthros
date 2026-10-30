#!/bin/bash
# dev build: name in $1, patch in $2 (r1..r17 + that r18)
S=/tmp/orthros-scratch/data-r18; O=/tmp/orthros-scratch/data-r17; W=/srv/orthros/.claude/worktrees/data-r15
name=$1; patch=$2
( while true; do echo "$(date +%T) avail=$(free -g | awk '/^Mem/{print $7}') load=$(cut -d' ' -f1 /proc/loadavg)"; sleep 30; done ) >> $S/logs/mem-build.log & mon=$!
cd $W
/srv/orthros/tools/mem-check.sh; free -g | sed -n 2p; uptime
sh tools/openmw/dev-build.sh $O/build-r17/root $O/engines/openmw-web-v1.5.3-orthros-r17dev $S/engines/$name \
  --patch $S/unbase-old-r17.patch --patch $W/tools/openmw/patches/orthros-r17.patch --patch $patch
echo BUILD-END $?
kill $mon
ln -sfn $S/engines/$name $S/eng/$name
