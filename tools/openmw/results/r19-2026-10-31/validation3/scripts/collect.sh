#!/bin/bash
# the third validation's evidence into the worktree's results folder (validation3/): rows, run folders' logs and traces, perf.json, checks, mp, fc, logs, scripts
S=/tmp/orthros-scratch/data-r19; V=$S/v3; R=$V/res; O=/srv/orthros/.claude/worktrees/data-r15/tools/openmw/results/r19-2026-10-31/validation3
mkdir -p $O/scripts $O/logs $O/runs $O/perf $O/mp $O/check
cp $V/bin/*.sh $V/bin/*.py $O/scripts/
cp $V/logs/runs-started.txt $O/logs/; for f in $V/logs/*.log; do gzip -c $f > $O/logs/$(basename $f).gz; done
cp $R/*.jsonl $R/overlay-check-*.txt $O/ 2>/dev/null
grep -E "^ℹ|^# (tests|pass|fail)" $R/make-test.log > $O/make-test-summary.txt
for p in $R/perf/*/; do n=$(basename $p); mkdir -p $O/perf/$n; cp $p/perf.json $O/perf/$n/ 2>/dev/null; gzip -c $p/perf.log > $O/perf/$n/perf.log.gz; done
for m in $R/mp/*/; do n=$(basename $m); mkdir -p $O/mp/$n; cp $m/result.json $m/run.log $O/mp/$n/ 2>/dev/null; cp $m/*.gz $O/mp/$n/ 2>/dev/null; done
for c in en fr; do [ -f $R/check-$c/tool.log ] && cp $R/check-$c/tool.log $O/check/$c.log; done
if [ -d $R/fc ]; then mkdir -p $O/frame-compare; cp $R/fc/tool.log $O/frame-compare/; cp $R/fc/out/*.json $O/frame-compare/ 2>/dev/null; fi
for d in $V/w18/runs/* $V/w19a/runs/*; do [ -d $d ] && { mkdir -p $O/runs/$(basename $d); cp $d/*.gz $O/runs/$(basename $d)/ 2>/dev/null; [ -f $d/console.log ] && gzip -c $d/console.log > $O/runs/$(basename $d)/console.log.gz; }; done
python3 -I $V/bin/summary3.py $R > $O/summary.txt
du -sh $O
