#!/usr/bin/env python3
"""The iteration-4 numbers by side (r19L = the live r19, r20b = r20dev-b): place-load rows (<R>/pl-<side>-<kind>.jsonl),
perf.json files (<R>/perf/<side>-N/), the two-client runs (<R>/mp/<side>-N/). usage: summary4.py <results dir> [sides]"""
import json, os, sys, glob, statistics
R = sys.argv[1]; SIDES = sys.argv[2].split(',') if len(sys.argv) > 2 else ['r19L', 'r20b']
def rows(f):
    p = os.path.join(R, f)
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
def rng(xs):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    s = f'{min(xs)}' if min(xs) == max(xs) else f'{min(xs)}-{max(xs)}'
    return s + (f' med {round(statistics.median(xs), 3)}' if len(xs) > 2 else '') + f' ({len(xs)})'
def each(xs): return '[' + ' '.join(str(x) for x in xs) + ']'
for kind in ['save', 'coe', 'saveNew', 'save85k', 'forced', 'glide85k']:
    for side in SIDES:
        Rw = rows(f'pl-{side}-{kind}.jsonl')
        if not Rw: continue
        J = [r.get('jspiProbe') or {} for r in Rw]
        A = [r.get('jspiAfter') or {} for r in Rw]
        E = [(j.get('engine') or {}) for j in J]
        inW = [(r.get('load') or {}).get('inWorldS') for r in Rw]
        print(f'{kind:8} {side:4}: tags {each([r.get("tag") for r in Rw])}\n'
              f'   menu {rng([(r.get("engineStart") or {}).get("menuS") for r in Rw])}  firstFrame {rng([(r.get("engineStart") or {}).get("firstFrameS") for r in Rw])}'
              f'  inWorld(key->world) {rng(inW)} each {each(inW)}  steady {rng([(r.get("load") or {}).get("steadyS") for r in Rw])}\n'
              f'   block {rng([j.get("blockMaxMs") for j in J])}  input p50 {rng([j.get("inputP50Ms") for j in J])} p95 {rng([j.get("inputP95Ms") for j in J])}'
              f'  freeze(frameGapMax) {rng([j.get("frameGapMaxMs") for j in J])}  after-gap {rng([a.get("frameGapMaxMs") for a in A])}\n'
              f'   lateOld {rng([(r.get("precompile") or {}).get("lateOld") for r in Rw])}  timeouts {rng([((r.get("stage3") or {}).get("load") or {}).get("timeouts") for r in Rw])}'
              f'  suspended {rng([e.get("suspendedMs") for e in E])}  faults {sum(len(r.get("faults") or []) for r in Rw)} errors {sum(1 for r in Rw if r.get("error"))}')
for side in SIDES:
    P = []
    for d in sorted((d for d in glob.glob(os.path.join(R, 'perf', f'{side}-*')) if d.rsplit('-', 1)[1].isdigit()), key=lambda d: int(d.rsplit('-', 1)[1])):
        f = os.path.join(d, 'perf.json')
        if os.path.exists(f): P.append((os.path.basename(d), json.load(open(f))))
    if P:
        p99 = [p["work"]["p99"] for _, p in P]; fps = [p.get("fps") for _, p in P]
        print(f'play     {side:4}: runs {len(P)}  fps {rng(fps)} each {each(fps)}\n   work p99 {rng(p99)} each {each(p99)}  p50 {rng([p["work"]["p50"] for _, p in P])}'
              f'  longest gap {rng([p["gap"]["max"] for _, p in P])}  stalls/min {rng([p.get("dataStallMs") for _, p in P])}')
for side in SIDES:
    out = []
    for d in sorted(glob.glob(os.path.join(R, 'mp', f'{side}-*'))):
        r = os.path.join(d, 'result.json')
        if os.path.exists(r):
            j = json.load(open(r)); out.append(f'{os.path.basename(d)}:{j.get("pass", j.get("ok"))}')
        else: out.append(f'{os.path.basename(d)}:?')
    if out: print(f'mp       {side:4}: ' + ' '.join(out))
