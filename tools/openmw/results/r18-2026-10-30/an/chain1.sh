#!/bin/bash
S=/tmp/orthros-scratch/data-r18
$S/bin/pl.sh 17 r17-save-1 $S/res/pl-r17-save.jsonl --mode save --read-trace
$S/bin/pl.sh 18 r18-save-1 $S/res/pl-r18-save.jsonl --mode save --read-trace
$S/bin/pl.sh 17 r17-save85k-1 $S/res/pl-r17-save85k.jsonl --mode save --rate 85k --read-trace
$S/bin/pl.sh 18 r18-save85k-1 $S/res/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace
echo CHAIN1 DONE
