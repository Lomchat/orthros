#!/bin/bash
# in play, engine and page code crossed: 17 (r17, main), 18 (r18, r18-small), 17x (r17 engine, r18-small page), 18x (r18 engine, main page); 3 rounds
S=/tmp/orthros-scratch/r18-ship; V=$S/val/perfx; B=$S/bin; mkdir -p $V
for i in 1 2 3; do for side in 17 18x 18 17x; do
  echo "=== $(date +%T) perf $side-$i"
  $B/srv.sh $side 18765 $V/$side-$i tools/openmw/perf.mjs morrowind-goty-en --out $V/$side-$i --query tier=mid --discard --seconds 60 --warm 0
done; done
echo "=== $(date +%T) CROSS DONE"
