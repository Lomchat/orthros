#!/bin/bash
# Two more two-client pairs (r18 failed 1 of 3 on a 57-unit gap, r17 passed 3 of 3): 5 a side
S=/tmp/orthros-scratch/data-r18; V=$S/val2; E18=openmw-web-v1.5.3-orthros-r18dev-d; E17=openmw-web-v1.5.3-orthros-r17
while kill -0 2616350 2>/dev/null; do sleep 10; done
echo "=== $(date +%T) mp extra"
for i in 4 5; do $S/bin2/mp.sh $E18 $V/mp/r18-$i; $S/bin2/mp.sh $E17 $V/mp/r17-$i; done
echo "=== $(date +%T) VAL4 DONE"
