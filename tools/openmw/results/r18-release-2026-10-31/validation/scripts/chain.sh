#!/bin/bash
# after val.sh: the r18 two-client run lost to the gateway's missing data/ link (r18-1, a harness setup failure) run again, then oth.sh
S=/tmp/orthros-scratch/r18-ship
while pgrep -f '^/bin/bash /tmp/orthros-scratch/r18-ship/bin/val.sh' >/dev/null; do sleep 20; done
echo "=== $(date +%T) mp r18-5"; $S/bin/mp.sh 18 $S/val/mp/r18-5
exec $S/bin/oth.sh
