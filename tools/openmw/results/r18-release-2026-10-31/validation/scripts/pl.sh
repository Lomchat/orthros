#!/bin/bash
# usage: pl.sh <17|18> <tag> <out jsonl> [place-load options...]
S=/tmp/orthros-scratch/r18-ship; T=/srv/orthros/.claude/worktrees/r18-small
side=$1; tag=$2; out=$3; shift 3
case $side in
  17) tree=/srv/orthros; eng=(); dir=pl17 ;;
  18) tree=$T; eng=(--engine openmw-web-v1.5.3-orthros-r18); dir=pl18 ;;
esac
/srv/orthros/tools/mem-check.sh -w 24
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) pl side=$side tag=$tag $*" >> $S/logs/runs-started.txt
cd $T && /srv/orthros/tools/with-browser-slot.sh node tools/openmw/place-load.mjs morrowind-goty-en --tree $tree --warm-tree $tree --scratch $S/$dir --pristine $S/pristine --engines-dir /srv/orthros/data/engines "${eng[@]}" --save $S/saves/-2_6.omwsave --listen 18747 --runs 1 --tag "$tag" --out "$out" "$@"
