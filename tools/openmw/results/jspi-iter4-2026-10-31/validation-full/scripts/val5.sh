#!/bin/bash
# Iteration-5 full validation: r20dev-c (engine c99235bfa872 = r1..r19 + orthros-r20.patch as committed at 09fa36b, but
# for a write-only debug field) against the LIVE r19 (data/engines read-only, f5eb3ec76d9b, draw thread off as shipped),
# interleaved (order swapped every pair), one browser at a time through the slot script; each side its own warm profile
# made by its own warm-up; every server on its own copy of jspi5/pristine (the live learned state and br-cache copied at
# 13:11, br-cache frozen: lean3 of the one package 2c6b8e83 both engines' openmw.data share)
J=/tmp/orthros-scratch/jspi5; R=$J/res; B=$J/bin; S=/tmp/orthros-scratch/data-r19; W=/srv/orthros/.claude/worktrees/data-r15
E20=openmw-web-v1.5.3-orthros-r20dev-c
mkdir -p $R/perf $R/mp
step() { echo "=== $(date +%T) $*"; }
pair() { if [ $(($1 % 2)) = 1 ]; then $2; $3; else $3; $2; fi; }
FORCED='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native'
step warm-ups
[ -d $J/w19L/profile-warm ] || $B/pl.sh 19L r19L-warm $R/pl-r19L-warm.jsonl --mode save --warm-only
[ -d $J/w20c/profile-warm ] || $B/pl.sh 20c r20c-warm $R/pl-r20c-warm.jsonl --mode save --warm-only
for i in 1 2 3 4 5; do
  step save $i; pair $i "$B/pl.sh 19L r19L-save-$i $R/pl-r19L-save.jsonl --mode save --read-trace" "$B/pl.sh 20c r20c-save-$i $R/pl-r20c-save.jsonl --mode save --read-trace"
  step coe $i;  pair $((i+1)) "$B/pl.sh 19L r19L-coe-$i $R/pl-r19L-coe.jsonl --mode coe" "$B/pl.sh 20c r20c-coe-$i $R/pl-r20c-coe.jsonl --mode coe"
done
P="--query tier=mid --discard --seconds 60 --warm 0"
for i in 1 2 3 4 5 6 7 8; do
  step perf $i; pair $i "$B/perf.sh 19L 18971 $R/perf/r19L-$i $P" "$B/perf.sh 20c 18972 $R/perf/r20c-$i $P"
done
for i in 1 2 3 4; do
  step new $i; pair $i "$B/pl.sh 19L r19L-saveNew-$i $R/pl-r19L-saveNew.jsonl --mode save --profile new --read-trace" "$B/pl.sh 20c r20c-saveNew-$i $R/pl-r20c-saveNew.jsonl --mode save --profile new --read-trace"
done
for i in 1 2; do
  step 85k $i; pair $i "$B/pl.sh 19L r19L-save85k-$i $R/pl-r19L-save85k.jsonl --mode save --rate 85k --read-trace" "$B/pl.sh 20c r20c-save85k-$i $R/pl-r20c-save85k.jsonl --mode save --rate 85k --read-trace"
done
step frame-compare; $B/srvrun.sh 20c 18965 $R/fc tools/openmw/frame-compare.mjs --variant '' --variant jspi=0 --out $R/fc/out
step check; $B/srvrun.sh 20c 18966 $R/check-en tools/openmw/check.mjs --seconds 10; $B/srvrun.sh 20c 18967 $R/check-fr tools/openmw/check.mjs --lang fr --seconds 10
step overlay
for g in morrowind morrowind-vanilla-plus; do (cd $W && node tools/openmw/overlay-check.mjs /srv/orthros/data/games/$g/manifest.json --engines-dir $S/eng --engine $E20) > $R/overlay-check-$g.txt 2>&1; echo "overlay $g rc=$?" | tee -a $R/overlay-check-$g.txt; done
step mp
$B/mp.sh 20c $R/mp/r20c-1; $B/mp.sh 19L $R/mp/r19L-1; $B/mp.sh 20c $R/mp/r20c-2; $B/mp.sh 20c $R/mp/r20c-3; $B/mp.sh 19L $R/mp/r19L-2; $B/mp.sh 20c $R/mp/r20c-4
step forced
ORTHROS_CHROME_ARGS="$FORCED" $B/pl.sh 20c r20c-forced-save $R/pl-r20c-forced.jsonl --mode save
ORTHROS_CHROME_ARGS="$FORCED" $B/pl.sh 20c r20c-forced-coe $R/pl-r20c-forced.jsonl --mode coe
step VAL5 DONE
