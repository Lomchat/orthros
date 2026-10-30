#!/bin/bash
S=/tmp/orthros-scratch/data-r18; V=$S/val
while pgrep -f "node tools/openmw/place-load.mjs .*data-r18" >/dev/null; do sleep 5; done
for i in 1 2; do
PLDIR=v18 $S/bin/pl.sh 18bx r18bx-save-$i $S/res/diag-r18bx-save.jsonl --mode save --read-trace
PLDIR=v18 $S/bin/pl.sh 18b r18b-save-v-$i $S/res/diag-r18b-save-v.jsonl --mode save --read-trace
done
echo CHAIN12 DONE
