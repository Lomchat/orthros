#!/bin/sh
# the new orthros-r18.patch: pw/base (r1..r17) against pw/work (r18's edits), paths from the tree's root
S=/tmp/orthros-scratch/data-r18
cd $S/pw && git diff --no-index --no-prefix base work > $S/pw/new.patch.raw
# (git diff --no-index names them base/x work/x: rewritten to a/x b/x)
sed -e 's|^diff --git base/\(.*\) work/\(.*\)$|diff --git a/\1 b/\2|' -e 's|^--- base/|--- a/|' -e 's|^+++ work/|+++ b/|' -e "s|^diff --git work/\(.*\) work/\(.*\)$|diff --git a/\1 b/\2|" $S/pw/new.patch.raw > $S/pw/new.patch
echo "$(grep -c '^diff' $S/pw/new.patch) files"
