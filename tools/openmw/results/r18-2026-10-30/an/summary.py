#!/usr/bin/env python3
"""The validation's numbers by side (r17, r18): place-load rows (val/pl-<side>-<kind>.jsonl) and perf.json files."""
import json, os, sys, glob
V = sys.argv[1]
def rows(f):
    p = os.path.join(V, f)
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
def rng(xs):
    xs = [x for x in xs if x is not None]
    return '-' if not xs else (f'{min(xs)}' if min(xs) == max(xs) else f'{min(xs)}-{max(xs)}') + f' ({len(xs)})'
for kind in ['save', 'coe', 'saveNew', 'save85k', 'forced']:
    for side in ['r17', 'r18']:
        R = rows(f'pl-{side}-{kind}.jsonl')
        if not R: continue
        J = [r.get('jspiProbe') or {} for r in R]
        A = [r.get('jspiAfter') or {} for r in R]
        print(f'{kind:8} {side}: menu {rng([r["engineStart"].get("menuS") for r in R])}  firstFrame {rng([r["engineStart"].get("firstFrameS") for r in R])}  inWorld(key->world) {rng([r["load"].get("inWorldS") for r in R])}'
              f'  steady {rng([r["load"].get("steadyS") for r in R])}  block {rng([j.get("blockMaxMs") for j in J])}  input p50 {rng([j.get("inputP50Ms") for j in J])} p95 {rng([j.get("inputP95Ms") for j in J])}'
              f'  freeze {rng([j.get("frameGapMaxMs") for j in J])}  after-gap {rng([a.get("frameGapMaxMs") for a in A])}  lateOld {rng([(r.get("precompile") or {}).get("lateOld") for r in R])}'
              f'  timeouts {rng([((r.get("stage3") or {}).get("load") or {}).get("timeouts") for r in R])}  faults {sum(len(r.get("faults") or []) for r in R)} errors {sum(1 for r in R if r.get("error"))}')
for side in ['r17', 'r18']:
    P = []
    for d in sorted(glob.glob(os.path.join(V, 'perf', f'{side}-*'))):
        f = glob.glob(os.path.join(d, '*.json'))
        f = [x for x in f if os.path.basename(x).startswith('perf')] or f
        if f: P.append(json.load(open(f[0])))
    if P:
        print(f'play     {side}: fps {rng([p.get("fps") for p in P])}  longest gap {rng([p["gap"]["max"] for p in P])}  stalls/min {rng([p.get("dataStallMs") for p in P])}'
              f'  work p50 {rng([p["work"]["p50"] for p in P])} p99 {rng([p["work"]["p99"] for p in P])}')
