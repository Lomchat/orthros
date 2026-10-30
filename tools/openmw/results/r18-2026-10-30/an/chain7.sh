#!/bin/bash
S=/tmp/orthros-scratch/data-r18
for i in 1 2; do
$S/bin/pl.sh 18b r18b-eng-def-$i $S/res/diag-r18b-eng.jsonl --mode save --entry engine --read-trace
$S/bin/pl.sh 18b r18b-eng-nopb-$i $S/res/diag-r18b-eng-nopb.jsonl --mode save --entry engine --read-trace --query jspipresent=0\&jspibreath=0
done
$S/bin/pl.sh 17 r17-eng-1 $S/res/diag-r17-eng.jsonl --mode save --entry engine --read-trace
echo CHAIN7 DONE
