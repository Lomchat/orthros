#!/bin/bash
# the evidence into the worktree's results folder (rows, run folders' logs and traces, perf.json, chosen profiles, bench, scripts)
S=/tmp/orthros-scratch/data-r19; R=/srv/orthros/.claude/worktrees/data-r15/tools/openmw/results/r19-2026-10-31
mkdir -p $R/scripts $R/bench $R/logs
cp $S/bin/*.sh $S/bin/*.py $R/scripts/ 2>/dev/null; cp /tmp/orthros-scratch/prof-sum.py $R/scripts/
cp $S/bench/b.c $S/bench/b.mjs $S/bench/sweep.mjs $S/bench/run-chrome.mjs $S/bench/chrome.out $R/bench/; gzip -c $S/bench/chrome-sweep.json > $R/bench/chrome-sweep.json.gz
cp $S/logs/*.log $S/logs/runs-started.txt $R/logs/ 2>/dev/null; gzip -f $R/logs/*.log
cp $S/patches/*.patch $R/ 2>/dev/null
for b in diag1 play1 load2 load3 load4 gl5; do
  [ -d $S/res/$b ] || continue; mkdir -p $R/$b
  cp $S/res/$b/*.jsonl $R/$b/ 2>/dev/null
  for p in $(ls -d $S/res/$b/perf/*/ 2>/dev/null); do n=$(basename $p); mkdir -p $R/$b/perf/$n; cp $p/perf.json $R/$b/perf/$n/; gzip -c $p/perf.log > $R/$b/perf/$n/perf.log.gz 2>/dev/null; done
  for c in $S/res/$b/check-*; do [ -d $c ] && { mkdir -p $R/$b/$(basename $c); cp $c/tool.log $R/$b/$(basename $c)/; }; done
done
# run folders (console, proxy log, read trace) of every row of these batches
mkdir -p $R/runs
for d in $S/pl18/runs/* $S/pl19/runs/* $S/pl19a/runs/*; do [ -d $d ] && { mkdir -p $R/runs/$(basename $d); cp $d/*.gz $R/runs/$(basename $d)/ 2>/dev/null; [ -f $d/load.cpuprofile ] && gzip -c $d/load.cpuprofile > $R/runs/$(basename $d)/load.cpuprofile.gz; }; done
# the profiles the text cites: diag1's in-play main threads, play1's half-busy worker of each side
mkdir -p $R/profiles
gzip -c $S/res/diag1/perf/r18-prof/perf.cpuprofile > $R/profiles/play-main-r18.cpuprofile.gz
gzip -c $S/res/diag1/perf/r19-prof/perf.cpuprofile > $R/profiles/play-main-r19d.cpuprofile.gz
gzip -c $S/res/play1/perf/r18-w/perf-worker-7.cpuprofile > $R/profiles/play-worker-r18.cpuprofile.gz
gzip -c $S/res/play1/perf/r19d-w/perf-worker-4.cpuprofile > $R/profiles/play-worker-r19d.cpuprofile.gz
gzip -c $S/res/play1/perf/r19a-w/perf-worker-5.cpuprofile > $R/profiles/play-worker-r19a.cpuprofile.gz
du -sh $R
