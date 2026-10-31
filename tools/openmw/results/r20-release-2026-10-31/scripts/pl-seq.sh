#!/bin/bash
# warm-up of R, then save (input trace, 2 s block check) R, C; COE C, R — one browser at a time
T=/tmp/orthros-scratch/r20-rel; B=$T/bin; R=$T/res
step() { echo "=== $(date +%T) $*"; }
step warm-up R; [ -d $T/w20R/profile-warm ] || $B/pl.sh R r20R-warm $R/pl-r20R-warm.jsonl --mode save --warm-only
step save R; $B/pl.sh R r20R-save-1 $R/pl-r20R-save.jsonl --mode save --input-trace --input-block 2000
step save C; $B/pl.sh C r20c-save-1 $R/pl-r20c-save.jsonl --mode save --input-trace --input-block 2000
step coe C; $B/pl.sh C r20c-coe-1 $R/pl-r20c-coe.jsonl --mode coe
step coe R; $B/pl.sh R r20R-coe-1 $R/pl-r20R-coe.jsonl --mode coe
step PL DONE
