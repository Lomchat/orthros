#!/bin/bash
S=/tmp/orthros-scratch/data-r18
until grep -q "CHAIN3 DONE" $S/logs/chain3.log; do sleep 10; done
$S/bin/pl.sh 18b r18b-save-1 $S/res/diag-r18b-save.jsonl --mode save --read-trace
$S/bin/pl.sh 17 r17-save-2 $S/res/diag-r17-save.jsonl --mode save --read-trace
echo CHAIN4 DONE
