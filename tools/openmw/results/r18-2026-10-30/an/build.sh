#!/bin/bash
# dev build openmw-web-v1.5.3-orthros-r18dev over the kept r17dev tree: old base reverted, main's r17, our r18
S=/tmp/orthros-scratch/data-r18; O=/tmp/orthros-scratch/data-r17; W=/srv/orthros/.claude/worktrees/data-r15
echo $$ > $S/build.pid
( while kill -0 $$ 2>/dev/null; do echo "$(date +%T) avail=$(free -g | awk '/^Mem/{print $7}') load=$(cut -d' ' -f1 /proc/loadavg)"; sleep 30; done ) >> $S/mem-build.log &
cd $W
/srv/orthros/tools/mem-check.sh; free -g | sed -n 2p; uptime
sh tools/openmw/dev-build.sh $O/build-r17/root $O/engines/openmw-web-v1.5.3-orthros-r17dev $S/engines/openmw-web-v1.5.3-orthros-r18dev \
  --patch $S/unbase-old-r17.patch --patch $W/tools/openmw/patches/orthros-r17.patch --patch $W/tools/openmw/patches/orthros-r18.patch
echo BUILD-END $?
/bin/rm -f $S/build.pid
