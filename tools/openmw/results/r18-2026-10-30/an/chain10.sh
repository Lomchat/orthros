#!/bin/bash
S=/tmp/orthros-scratch/data-r18
until grep -q "CHAIN9 DONE" $S/logs/chain9.log; do sleep 10; done
for i in 1 2; do
PLDIR=pl17x $S/bin/pl.sh 17x r17-on-r18store-$i $S/res/diag-r17-on-r18store.jsonl --mode save --entry engine --read-trace
done
echo CHAIN10 DONE
