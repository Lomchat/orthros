#!/bin/bash
S=/tmp/orthros-scratch/data-r18
until grep -q "CHAIN10 DONE" $S/logs/chain10.log; do sleep 10; done
$S/bin/pl.sh 18b r18b-eng-loaf-1 $S/res/diag-r18b-eng-loaf.jsonl --mode save --entry engine --read-trace
$S/bin/pl.sh 17 r17-eng-loaf-1 $S/res/diag-r17-eng-loaf.jsonl --mode save --entry engine --read-trace
echo CHAIN11 DONE
