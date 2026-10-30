#!/bin/bash
S=/tmp/orthros-scratch/data-r18
$S/bin/pl.sh 18 r18-save85k-2 $S/res/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace
$S/bin/pl.sh 17 r17-save85k-2 $S/res/pl-r17-save85k.jsonl --mode save --rate 85k --read-trace
echo CHAIN2 DONE
