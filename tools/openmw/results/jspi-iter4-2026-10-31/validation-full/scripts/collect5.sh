#!/bin/bash
# the full validation's evidence into the worktree (jspi-iter4-2026-10-31/validation-full/)
J=/tmp/orthros-scratch/jspi5; R=$J/res; O=/srv/orthros/.claude/worktrees/data-r15/tools/openmw/results/jspi-iter4-2026-10-31/validation-full
mkdir -p $O/scripts $O/logs $O/runs $O/perf $O/mp $O/check
cp $J/bin/*.sh $J/bin/*.py $O/scripts/
cp $J/logs/runs-started.txt $J/pristine/copied-at.txt $O/logs/; for f in $J/logs/*.log; do gzip -c $f > $O/logs/$(basename $f).gz; done
cp $R/*.jsonl $R/overlay-check-*.txt $O/ 2>/dev/null
grep -E "^ℹ|^# (tests|pass|fail)" $R/make-test.log > $O/make-test-summary.txt
for p in $R/perf/*/; do n=$(basename $p); mkdir -p $O/perf/$n; cp $p/perf.json $O/perf/$n/ 2>/dev/null; gzip -c $p/perf.log > $O/perf/$n/perf.log.gz; done
for m in $R/mp/*/; do n=$(basename $m); mkdir -p $O/mp/$n; cp $m/result.json $m/run.log $O/mp/$n/ 2>/dev/null; cp $m/*.gz $O/mp/$n/ 2>/dev/null; done
for c in en fr; do [ -f $R/check-$c/tool.log ] && cp $R/check-$c/tool.log $O/check/$c.log; done
if [ -d $R/fc ]; then mkdir -p $O/frame-compare; cp $R/fc/tool.log $O/frame-compare/; cp $R/fc/out/*.json $O/frame-compare/ 2>/dev/null; fi
for d in $J/w19L/runs/* $J/w20c/runs/*; do [ -d $d ] && { mkdir -p $O/runs/$(basename $d); cp $d/*.gz $O/runs/$(basename $d)/ 2>/dev/null; [ -f $d/console.log ] && gzip -c $d/console.log > $O/runs/$(basename $d)/console.log.gz; }; done
python3 -I $J/bin/summary5.py $R > $O/summary.txt
python3 -I $J/bin/phases.py $(ls -d $J/w19L/runs/*save-* $J/w20c/runs/*save-* | grep -v saveNew | grep -v forced | grep -v 85k) >> $O/summary.txt 2>&1
du -sh $O
