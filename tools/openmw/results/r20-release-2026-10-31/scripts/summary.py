#!/usr/bin/env python3
"""The installed r20's smoke check: place-load rows by side (R = the installed release, C = r20dev-c) and the JSPI evidence,
the two-client runs. usage: summary.py <results dir>"""
import json, os, sys, glob
R = sys.argv[1]
def rows(f):
    p = os.path.join(R, f)
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
g = lambda o, *k: ([o := (o or {}).get(x) for x in k][-1])
for kind in ['save', 'coe']:
    for side in ['r20R', 'r20c']:
        for r in rows(f'pl-{side}-{kind}.jsonl'):
            j = r.get('jspiProbe') or {}; it = r.get('inputTrace') or {}; s = g(r, 'streamfs', 'load') or {}
            print(f'{kind:4} {side}: tag {r.get("tag")} engine {g(r, "engine", "engine")} error {str(r.get("error"))[:100]} faults {len(r.get("faults") or [])}')
            print(f'   menu {g(r, "engineStart", "menuS")} firstFrame {g(r, "engineStart", "firstFrameS")} engine inWorld {g(r, "engineStart", "inWorldS")}'
                  f'  load: F9/COE->world {g(r, "load", "inWorldS")} cellReached {g(r, "load", "cellReachedS")} steady {g(r, "load", "steadyS")}'
                  f' frozen {g(r, "load", "frozenMs")} coeInFrame {g(r, "load", "coeInFrame")} coeSync {g(r, "load", "coeSyncMs")}')
            print(f'   page block {j.get("blockMaxMs")} freeze {j.get("frameGapMaxMs")} suspended {g(j, "engine", "suspendedMs")}'
                  f'  soonSuspends {s.get("soonSuspends")} stallMs {round(s.get("stallMs") or 0)} lateOld {g(r, "precompile", "lateOld")}')
            if it:
                print(f'   input p50 {it.get("p50Ms")} p95 {it.get("p95Ms")} max {it.get("maxMs")} events {it.get("events")} unanswered {it.get("unanswered")}'
                      f'  block check: first {g(it, "block", "firstMs")} residual max {g(it, "block", "residual", "max")} moves {g(it, "block", "events")}')
for d in sorted(glob.glob(os.path.join(R, 'mp', '*'))):
    f = os.path.join(d, 'result.json')
    if not os.path.exists(f): print(f'mp {os.path.basename(d)}: ?'); continue
    m = json.load(open(f)); c = m.get('checks') or {}
    print(f'mp {os.path.basename(d)}: engine {m.get("engine")} ok {m.get("ok")} seconds {m.get("seconds")} checks {sum(1 for v in c.values() if (v or {}).get("ok"))}/{len(c)}'
          f' failed {[k for k, v in c.items() if not (v or {}).get("ok")]} faults {m.get("faults")}')
