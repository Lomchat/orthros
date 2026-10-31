#!/usr/bin/env python3
"""The fair validation's numbers and the pre-registered criteria (plan.txt). usage: summary.py <results dir>"""
import json, os, sys, glob, statistics as st
R = sys.argv[1]
def rows(f):
    p = os.path.join(R, f)
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
def med(xs): xs = [x for x in xs if x is not None]; return round(st.median(xs), 3) if xs else None
def each(xs): return '[' + ' '.join(str(x) for x in xs) + ']'
def ok(b): return 'MET' if b else 'NOT MET'
out = {}
for kind in ['save', 'saveNew']:
    for side in ['r19L', 'r20c']:
        Rw = rows(f'pl-{side}-{kind}.jsonl'); good = [r for r in Rw if not r.get('error')]
        it = [r.get('inputTrace') or {} for r in good]
        d = dict(tags=[r.get('tag') for r in Rw], errors=[str(r.get('error'))[:100] for r in Rw if r.get('error')],
                 menu=[(r.get('engineStart') or {}).get('menuS') for r in good], f9=[(r.get('load') or {}).get('inWorldS') for r in good],
                 steady=[(r.get('load') or {}).get('steadyS') for r in good],
                 p50=[i.get('p50Ms') for i in it], p95=[i.get('p95Ms') for i in it], mx=[i.get('maxMs') for i in it],
                 ev=[i.get('events') for i in it], mvp95=[((i.get('byKind') or {}).get('move') or {}).get('p95Ms') for i in it],
                 keyp95=[((i.get('byKind') or {}).get('key') or {}).get('p95Ms') for i in it],
                 car=[i.get('carriers') for i in it], byd=[i.get('byDispatch') for i in it], un=[i.get('unanswered') for i in it],
                 bfirst=[(i.get('block') or {}).get('firstMs') for i in it], bres=[((i.get('block') or {}).get('residual') or {}).get('max') for i in it],
                 bev=[(i.get('block') or {}).get('events') for i in it],
                 block=[(r.get('jspiProbe') or {}).get('blockMaxMs') for r in good], freeze=[(r.get('jspiProbe') or {}).get('frameGapMaxMs') for r in good],
                 lateOld=[(r.get('precompile') or {}).get('lateOld') for r in good], faults=sum(len(r.get('faults') or []) for r in Rw))
        out[(kind, side)] = d
        if not Rw: continue
        print(f'{kind:7} {side}: {len(Rw)} rows, errors {d["errors"]}  tags {each(d["tags"])}')
        print(f'   menu {each(d["menu"])} med {med(d["menu"])}  F9->world {each(d["f9"])} med {med(d["f9"])}  steady {each(d["steady"])}')
        if kind == 'save':
            print(f'   input p50 {each(d["p50"])} med {med(d["p50"])}  p95 {each(d["p95"])} med {med(d["p95"])}  max {each(d["mx"])}')
            print(f'   events {each(d["ev"])}  moves p95 {each(d["mvp95"])}  keys p95 {each(d["keyp95"])}  byDispatch {each(d["byd"])} unanswered {each(d["un"])}')
            print(f'   carriers {d["car"]}')
            print(f'   block check: moves {each(d["bev"])} first {each(d["bfirst"])} residual max {each(d["bres"])}')
        print(f'   page block {each(d["block"])}  freeze {each(d["freeze"])}  lateOld {each(d["lateOld"])}  faults {d["faults"]}')
P = {}
for side in ['r19L', 'r20c']:
    L = []
    for dd in sorted(glob.glob(os.path.join(R, 'perf', f'{side}-*')), key=lambda d: int(d.rsplit('-', 1)[1])):
        f = os.path.join(dd, 'perf.json')
        L.append(json.load(open(f)) if os.path.exists(f) else None)
    P[side] = L
    good = [p for p in L if p]
    if L:
        print(f'play    {side}: {len(L)} runs ({len(L) - len(good)} without perf.json)\n   fps {each([p.get("fps") for p in good])} med {med([p.get("fps") for p in good])}'
              f'\n   work p99 {each([p["work"]["p99"] for p in good])} med {med([p["work"]["p99"] for p in good])}  p50 med {med([p["work"]["p50"] for p in good])}'
              f'  longest gap med {med([p["gap"]["max"] for p in good])}')
print('\nPre-registered criteria')
s19, s20 = out[('save', 'r19L')], out[('save', 'r20c')]
if s19['p95'] and s20['p95']:
    a, b = med(s20['p95']), med(s19['p95']); print(f'1a input p95 median r20 {a} <= r19 {b} + 100 = {b + 100}: {ok(a <= b + 100)}')
    a, b = max(s20['f9']), max(s19['f9']); print(f'1b F9 every r20 (max {a}) <= r19 max {b} + 0.15 = {round(b + 0.15, 2)}: {ok(a <= b + 0.15 + 1e-9)}')
g19 = [p for p in P.get('r19L', []) if p]; g20 = [p for p in P.get('r20c', []) if p]
if g19 and g20:
    a, b = med([p['fps'] for p in g20]), med([p['fps'] for p in g19]); print(f'2a fps median r20 {a} >= r19 {b} - 0.3: {ok(a >= b - 0.3)} (n {len(g20)}/{len(g19)})')
    a, b = med([p['work']['p99'] for p in g20]), med([p['work']['p99'] for p in g19]); print(f'2b work p99 median r20 {a} <= r19 {b} + 0.5: {ok(a <= b + 0.5 + 1e-9)}')
n19, n20 = out[('saveNew', 'r19L')], out[('saveNew', 'r20c')]
if n19['menu'] and n20['menu']:
    a, b = med(n20['menu']), med(n19['menu']); print(f'3a new-device menu median r20 {a} <= r19 {b} + 0.3: {ok(a <= b + 0.3 + 1e-9)}')
    a, b = med(n20['f9']), med(n19['f9']); print(f'3b new-device F9 median r20 {a} <= r19 {b} + 0.3: {ok(a <= b + 0.3 + 1e-9)}')
