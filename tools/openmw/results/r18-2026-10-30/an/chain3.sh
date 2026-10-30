#!/bin/bash
S=/tmp/orthros-scratch/data-r18
$S/bin/pl.sh 18 r18-save85k-fixA-1 $S/res/diag-r18-save85k-fixA.jsonl --mode save --rate 85k --read-trace
$S/bin/pl.sh 17 r17-save85k-fixA-1 $S/res/diag-r17-save85k-fixA.jsonl --mode save --rate 85k --read-trace
echo CHAIN3 DONE
