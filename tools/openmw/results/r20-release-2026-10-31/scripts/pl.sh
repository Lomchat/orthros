#!/bin/bash
# usage: pl.sh <R|C> <tag> <out jsonl> [place-load options...]
#   R: the INSTALLED openmw-web-v1.5.3-orthros-r20 (data/engines read only, its own .br), own warm profile (w20R, its own warm-up)
#   C: the validated dev build r20dev-c (jspi4, --engine-br), the fair validation's warm profile (jspi5/w20c, read: each run copies it)
#   both: this task's fresh pristine learned state + frozen br-cache copy, data-r19's -2,6 save
T=/tmp/orthros-scratch/r20-rel; S=/tmp/orthros-scratch/data-r19; W=/srv/orthros/.claude/worktrees/data-r15
side=$1; tag=$2; out=$3; shift 3
case $side in
  R) eng=(--engines-dir /srv/orthros/data/engines --engine openmw-web-v1.5.3-orthros-r20); dir=(--scratch $T/w20R) ;;
  C) eng=(--engines-dir $S/eng --engine openmw-web-v1.5.3-orthros-r20dev-c --engine-br); dir=(--scratch $T/w20c --profile-warm /tmp/orthros-scratch/jspi5/w20c/profile-warm) ;;
  *) echo "side?"; exit 2 ;;
esac
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) place-load side=$side tag=$tag $*" >> $T/logs/runs-started.txt
cd $W && exec /srv/orthros/tools/with-browser-slot.sh node tools/openmw/place-load.mjs morrowind-goty-en --tree $W --warm-tree $W "${dir[@]}" --pristine $T/pristine "${eng[@]}" --save $S/saves/-2_6.omwsave --runs 1 --tag "$tag" --out "$out" "$@"
