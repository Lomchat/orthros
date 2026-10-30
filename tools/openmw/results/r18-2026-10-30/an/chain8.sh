#!/bin/bash
S=/tmp/orthros-scratch/data-r18
for i in 1 2; do
$S/bin/pl.sh 18b r18b-eng-noyield-$i $S/res/diag-r18b-eng-noyield.jsonl --mode save --entry engine --read-trace --query jspipresent=0\&jspibreath=0\&jspispin=3000\&jspigl=0
$S/bin/pl.sh 18b r18b-eng-jspi0-$i $S/res/diag-r18b-eng-jspi0.jsonl --mode save --entry engine --read-trace --query jspi=0
done
$S/bin/pl.sh 17 r17-eng-2 $S/res/diag-r17-eng.jsonl --mode save --entry engine --read-trace
echo CHAIN8 DONE
