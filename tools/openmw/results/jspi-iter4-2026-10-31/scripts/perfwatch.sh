#!/bin/bash
# usage: perfwatch.sh <runs dir> <out file> [seconds]: waits for a new run's marker request (proxy.jsonl), then records the busiest
# renderer's main thread with Linux perf (V8's --perf-basic-prof map: ORTHROS_CHROME_ARGS) for <seconds>
runs=$1; out=$2; secs=${3:-9}
before=$(ls $runs 2>/dev/null | wc -l)
for i in $(seq 900); do
  d=$(ls -td $runs/*/ 2>/dev/null | head -1)
  if [ -n "$d" ] && [ $(ls $runs | wc -l) -gt $before ] && zcat -f $d/proxy.jsonl 2>/dev/null | grep -q '__qa/mark'; then break; fi
  sleep 0.2
done
# (the renderer: the busiest chrome --type=renderer process now, of a browser on this run's profile)
scr=$(dirname $runs)
b=$(pgrep -f -- "--user-data-dir=$scr" | head -1)
desc() { for c in $(ps -o pid= --ppid $1); do echo $c; desc $c; done; }
pid=$(for c in $(desc $b); do ps -o pid=,pcpu=,args= -p $c; done | grep -- '--type=renderer' | sort -k2 -nr | head -1 | awk '{print $1}')
echo "$(date +%T) recording renderer $pid $secs s ($d)" >&2
perf record ${PERFG:-} -F 1999 -t $pid -o $out -- sleep $secs 2>&1 | tail -2 >&2
echo $pid > $out.pid
