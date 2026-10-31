#!/bin/bash
# orthros-r19.patch with its engine.cpp and orthros-jspi.js sections made again from pw/b (the r19 state + the dev changes)
set -e
S=/tmp/orthros-scratch/data-r19/pw; P=/srv/orthros/.claude/worktrees/data-r15/tools/openmw/patches/orthros-r19.patch
T=$(mktemp -d /tmp/orthros-scratch/data-r19/regen.XXXX); cd $T; git init -q .
mkdir -p openmw/apps/openmw wasm-build; cp $S/pre/openmw/apps/openmw/engine.cpp openmw/apps/openmw/; git add -A; git -c user.email=x -c user.name=x commit -qm pre
cp $S/b/openmw/apps/openmw/engine.cpp openmw/apps/openmw/; cp $S/b/wasm-build/orthros-jspi.js wasm-build/; git add -A
git diff --cached -- openmw/apps/openmw/engine.cpp > eng.diff; git diff --cached -- wasm-build/orthros-jspi.js > jspi.diff
python3 - "$P" eng.diff jspi.diff <<'PY'
import re,sys
P,eng,jspi=sys.argv[1:]
s=open(P).read(); parts=re.split(r'(?m)^(?=diff --git )',s)
out=[]
for p in parts:
  m=re.match(r'diff --git a/(\S+) b/',p)
  if m and m.group(1)=='openmw/apps/openmw/engine.cpp': p=open(eng).read()
  elif m and m.group(1)=='wasm-build/orthros-jspi.js': p=open(jspi).read()
  out.append(p)
t=''.join(out).encode()
open(P+'.new','wb').write(t)
import os; os.replace(P+'.new',P)
PY
cd /; /bin/rm -rf $T; echo regenerated
