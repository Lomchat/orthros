#!/bin/bash
S=/tmp/orthros-scratch/data-r18
for i in 1 2; do
PLDIR=v18 $S/bin/pl.sh 18bx r18bx-eng-$i $S/res/diag-r18bx-eng.jsonl --mode save --entry engine --read-trace
PLDIR=v18 $S/bin/pl.sh 18bx r18bx-eng-gl0-$i $S/res/diag-r18bx-eng-gl0.jsonl --mode save --entry engine --read-trace --query jspigl=0
done
echo CHAIN13 DONE
