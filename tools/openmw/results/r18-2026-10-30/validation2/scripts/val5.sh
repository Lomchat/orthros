#!/bin/bash
# Two more in-play pairs (r18-1 fell outside r17's spread on fps and work p99): 6 a side
S=/tmp/orthros-scratch/data-r18; V=$S/val2; E18=openmw-web-v1.5.3-orthros-r18dev-d; E17=openmw-web-v1.5.3-orthros-r17
while kill -0 2713453 2>/dev/null; do sleep 10; done
for i in 5 6; do
  echo "=== $(date +%T) perf $i"
  $S/bin2/perf.sh $E17 18961 $V/perf/r17-$i --query tier=mid --discard --seconds 60 --warm 0
  $S/bin2/perf.sh $E18 18962 $V/perf/r18-$i --query tier=mid --discard --seconds 60 --warm 0
done
echo "=== $(date +%T) VAL5 DONE"
