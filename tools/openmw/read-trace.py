#!/usr/bin/env python3
"""A load's reads, from place-load.mjs --read-trace (data-client.js GameData.trace): what the page asked its game data
worker for, when, how long each took, which waited serially and which overlapped, what was asked while the engine stood
suspended (JSPI) — and, with the run's proxy log, what went over the link meanwhile.

usage: python3 -I tools/openmw/read-trace.py <run folder> [--from S] [--to S] [--list] [--json]
  <run folder>: place-load's run folder (read-trace.json.gz, proxy.jsonl.gz). Times in seconds from the trigger (the key
  or the COE: the row's P.from), --from/--to the window (default: the trigger to the player in the world, else +60 s).
  --list: every entry of the window (the engine's frames, loads and suspensions among them, from an engine that traces
  them — orthros-r19.patch orthrosNote —; --plain: its plain frames too); --json: the summary as one JSON line.
"""
import gzip, json, os, re, sys, urllib.parse
from collections import Counter, defaultdict


def load(run):
    with gzip.open(os.path.join(run, 'read-trace.json.gz'), 'rt') as f:
        return json.load(f)


def proxy(run):
    p = os.path.join(run, 'proxy.jsonl.gz')
    if not os.path.exists(p):
        return []
    with gzip.open(p, 'rt') as f:
        return [json.loads(l) for l in f if l.strip()]


def kind(url):
    return 'want' if re.search(r'[?&]w=1', url) else 'bg' if re.search(r'[?&]p=1', url) else 'ahead' if re.search(r'[?&]a=1', url) else 'demand' if re.search(r'[?&]s=', url) else 'other'


def short(path):
    return (path or '').split('/')[-1]


def busiest(intervals):
    """The most intervals [a, b) open at once, and the time with at least two open (ms)."""
    ev = sorted([(a, 1) for a, b in intervals] + [(b, -1) for a, b in intervals])
    n = top = 0; overlap = 0; last = None
    for t, d in ev:
        if last is not None and n >= 2:
            overlap += t - last
        n += d; top = max(top, n); last = t
    return top, round(overlap)


def main(argv):
    if not argv or argv[0].startswith('--'):
        print(__doc__); return 2
    run = argv[0]
    opt = lambda k: float(argv[argv.index(k) + 1]) if k in argv else None
    d = load(run)
    t0 = d.get('from')
    if t0 is None:
        print('no trigger time in the trace (P.from)'); return 1
    end = (d['inWorldAt'] - t0) / 1000 if d.get('inWorldAt') and d['inWorldAt'] > t0 else 60.0
    lo, hi = opt('--from') if opt('--from') is not None else 0.0, opt('--to') if opt('--to') is not None else end
    rows = [e for e in d['trace'] if lo <= (e['t'] - t0) / 1000 <= hi]
    out = {'window_s': [lo, round(hi, 2)], 'entries': len(rows)}
    by = Counter(e['k'] for e in rows)
    out['byKind'] = dict(by)
    # (the engine's waits: sync / spin / late / async, their time, and how much of them overlapped — serial or batched)
    waits = [e for e in rows if e['k'] in ('sync', 'spin', 'late', 'async') and e.get('ms') is not None]
    ms = defaultdict(int)
    for e in waits:
        ms[e['k']] += e['ms']
    out['waitMs'] = dict(ms)
    top, over = busiest([(e['t'], e['t'] + e['ms']) for e in waits if e['ms'] > 0])
    out['waitsAtOnce'] = top; out['waitOverlapMs'] = over
    out['waitsOver100ms'] = sum(1 for e in waits if e['ms'] >= 100)
    # (the background fetches — readable(): a preload's or a sound's readiness — and when: the engine suspended or not)
    bg = [e for e in rows if e['k'] == 'bg']
    out['bg'] = {'count': len(bg), 'whileBusy': sum(1 for e in bg if e.get('busy')), 'MBasked': round(sum(e['len'] for e in bg) / 1e6, 2),
                 'files': Counter(short(e['f']) for e in bg).most_common(6)}
    callers = Counter()
    for e in bg:
        st = e.get('st') or ''
        frames = [f for f in st.split(' < ') if f and 'data-client.js' not in f]
        callers[' < '.join(frames[:3])] += 1
    out['bgCallers'] = callers.most_common(5)
    # (announced batches and the waits for them)
    out['want'] = [{'atS': round((e['t'] - t0) / 1000, 2), 'seq': e['off'], 'entries': e['len'], 'MB': round(e.get('bytes', 0) / 1e6, 2), 'label': e.get('label')} for e in rows if e['k'] == 'want']
    out['wwait'] = [{'atS': round((e['t'] - t0) / 1000, 2), 'ms': e.get('ms'), 'ok': e.get('ok'), 'soon': e.get('soon', 0), 'left': e.get('left'), 'batches': [e['off'], e['len']]} for e in rows if e['k'] == 'wwait']
    # (the link meanwhile: the proxy's requests by kind, bytes on the wire — the marker aligns its clock)
    recs = proxy(run)
    mark = next((r for r in recs if r.get('url', '').startswith('/__qa/mark')), None)
    if mark and d.get('markAt') is not None:
        p0 = mark['t'] + (t0 - d['markAt'])
        wire = defaultdict(float); n = Counter()
        for r in recs:
            a = (r['t'] - p0) / 1000
            if lo <= a <= hi and ('/game/' in r['url'] or '/gamez/' in r['url']):
                k = kind(r['url']); wire[k] += r.get('wire', 0) / 1e6; n[k] += 1
        out['link'] = {k: {'requests': n[k], 'wireMB': round(v, 2)} for k, v in wire.items()}
    # (the engine's own marks, when it traces them: its suspensions by kind — count, ms —, loads, promising frames)
    js = [e for e in rows if e['k'] == 'jspi']
    if js:
        sus = defaultdict(lambda: [0, 0])
        for e in js:
            if e['ev'] == 'suspended':
                sus[e['x'][0]][0] += 1; sus[e['x'][0]][1] += e['x'][2]
        out['suspended'] = {k: v for k, v in sus.items()}
        out['loading'] = [[round((e['t'] - t0) / 1000, 3), e['x']] for e in js if e['ev'] == 'loading']
        out['promising'] = [[round((e['t'] - t0) / 1000, 3), e['ev']] for e in js if e['ev'] in ('enter', 'leave', 'defer')]
    if '--json' in argv:
        print(json.dumps(out)); return 0
    for k, v in out.items():
        print(f'{k}: {json.dumps(v)}')
    if '--list' in argv:
        for e in rows:
            if e['k'] == 'jspi':
                if e['ev'] != 'plain' or '--plain' in argv:
                    print(f"{(e['t'] - t0) / 1000:8.3f} jspi  {e['ev']} {json.dumps(e.get('x'))}")
                continue
            print(f"{(e['t'] - t0) / 1000:8.3f} {e['k']:5} {e.get('ms', ''):>6} busy={e.get('busy', 0)} load={e.get('load', 0)} {short(e.get('f'))} {e.get('off')}+{e.get('len')} {e.get('label') or ''}{(' ' + e['st'][:160]) if e.get('st') and e['k'] == 'bg' else ''}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
