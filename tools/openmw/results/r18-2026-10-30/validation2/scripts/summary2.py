#!/usr/bin/env python3
"""The second full validation's numbers by side (r17, r18): place-load rows (<V>/pl-<side>-<kind>.jsonl), perf.json
files (<V>/perf/<side>-N/), the two-client runs (<V>/mp/<side>-N/). usage: summary2.py <validation dir>"""
import json, os, sys, glob, statistics
V = sys.argv[1]
def rows(f):
    p = os.path.join(V, f)
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
def rng(xs):
    xs = [x for x in xs if x is not None]
    return '-' if not xs else (f'{min(xs)}' if min(xs) == max(xs) else f'{min(xs)}-{max(xs)}') + f' ({len(xs)})'
for kind in ['save', 'coe', 'saveNew', 'save85k', 'forced', 'glide85k', 'door']:
    for side in ['r17', 'r18']:
        R = rows(f'pl-{side}-{kind}.jsonl')
        if not R: continue
        J = [r.get('jspiProbe') or {} for r in R]
        A = [r.get('jspiAfter') or {} for r in R]
        E = [(j.get('engine') or {}) for j in J]
        print(f'{kind:8} {side}: menu {rng([(r.get("engineStart") or {}).get("menuS") for r in R])}  firstFrame {rng([(r.get("engineStart") or {}).get("firstFrameS") for r in R])}  inWorld(key->world) {rng([(r.get("load") or {}).get("inWorldS") for r in R])}'
              f'  steady {rng([(r.get("load") or {}).get("steadyS") for r in R])}  block {rng([j.get("blockMaxMs") for j in J])}  input p50 {rng([j.get("inputP50Ms") for j in J])} p95 {rng([j.get("inputP95Ms") for j in J])}'
              f'  freeze {rng([j.get("frameGapMaxMs") for j in J])}  after-gap {rng([a.get("frameGapMaxMs") for a in A])}  lateOld {rng([(r.get("precompile") or {}).get("lateOld") for r in R])}'
              f'  timeouts {rng([((r.get("stage3") or {}).get("load") or {}).get("timeouts") for r in R])}  suspended {rng([e.get("suspendedMs") for e in E])} soonSuspends {rng([e.get("soonSuspends") for e in E])}'
              f'  faults {sum(len(r.get("faults") or []) for r in R)} errors {sum(1 for r in R if r.get("error"))}')
for side in ['r17', 'r18']:
    P = []
    for d in sorted(glob.glob(os.path.join(V, 'perf', f'{side}-*'))):
        f = [x for x in glob.glob(os.path.join(d, '*.json')) if os.path.basename(x).startswith('perf')] or glob.glob(os.path.join(d, '*.json'))
        if f: P.append(json.load(open(f[0])))
    if P:
        p99 = [p["work"]["p99"] for p in P]
        print(f'play     {side}: fps {rng([p.get("fps") for p in P])}  longest gap {rng([p["gap"]["max"] for p in P])}  stalls/min {rng([p.get("dataStallMs") for p in P])}'
              f'  work p50 {rng([p["work"]["p50"] for p in P])} p99 {rng(p99)} (median {statistics.median(p99)})')
for side in ['r17', 'r18']:
    out = []
    for d in sorted(glob.glob(os.path.join(V, 'mp', f'{side}-*'))):
        r = glob.glob(os.path.join(d, 'result*.json'))
        if r:
            j = json.load(open(r[0])); out.append(f'{os.path.basename(d)}:{j.get("pass", j.get("ok"))}')
        else:
            out.append(f'{os.path.basename(d)}:?')
    if out: print(f'mp       {side}: ' + ' '.join(out))
