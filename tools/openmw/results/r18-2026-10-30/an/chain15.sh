#!/bin/bash
S=/tmp/orthros-scratch/data-r18
for i in 1 2; do
for q in jspiglmax=600 jspiglmax=1000; do
PLDIR=v18 $S/bin/pl.sh 18c r18c-eng-$q-$i $S/res/diag-r18c-eng-${q/=/}.jsonl --mode save --entry engine --read-trace --query $q
done; done
echo CHAIN15 DONE
