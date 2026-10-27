#!/usr/bin/env python3
# A Chrome CPU profile (.cpuprofile: perf.mjs --profile, tools/port-perf.mjs) read for an engine's frame: WebAssembly
# frames named from the build's symbol map (Emscripten's --emit-symbol-map, "N:name" lines: the wasm-function[N] the
# profile names), the busy time (everything but "(idle)"), the functions by self time, the inclusive time of the
# functions whose name holds a given text (a function counted once per sample however deep it recurses), and who calls
# a function or what it calls (its inclusive time split by its direct callers or callees). Shares are of the busy time;
# --frames N adds milliseconds a frame (the measured frames, perf.mjs's "frames"). Run with python3 -I.
# Usage: python3 -I tools/cpuprofile-report.py <profile> [--symbols <openmw.js.symbols>] [--top 40] [--frames N]
#          [--match <text>]... [--callers <text>] [--callees <text>] [--depth 1]
import collections, json, re, sys

def main(argv):
    if not argv or argv[0].startswith('-'):
        sys.exit(__doc__ or 'usage: cpuprofile-report.py <profile> [options]')
    path, args = argv[0], argv[1:]
    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default
    def opts(name):
        return [args[i + 1] for i, a in enumerate(args) if a == name and i + 1 < len(args)]
    symbols = {}
    if opt('--symbols'):
        for line in open(opt('--symbols'), encoding='utf-8', errors='replace'):
            i, _, n = line.rstrip('\n').partition(':')
            symbols[i] = n
    top, frames = int(opt('--top', 40)), int(opt('--frames', 0))
    prof = json.load(open(path))
    nodes = {n['id']: n for n in prof['nodes']}
    parent = {}
    for n in prof['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']

    def name(nid):
        f = nodes[nid]['callFrame']
        n = f.get('functionName') or '(anonymous)'
        m = re.match(r'^\$?(?:wasm-function\[(\d+)\]|(\d+))$', n)
        if m:
            n = symbols.get(m.group(1) or m.group(2), n)
        return n

    # (time per sample: the delta to the next sample)
    t = collections.Counter()
    for s, d in zip(prof['samples'], prof['timeDeltas']):
        t[s] += d / 1000.0
    total = sum(t.values())
    idle = sum(ms for nid, ms in t.items() if name(nid) in ('(idle)',))
    busy = max(1e-9, total - idle)
    selfc, incl = collections.Counter(), collections.Counter()
    callers, callees = collections.Counter(), collections.Counter()
    want_callers, want_callees = opt('--callers'), opt('--callees')
    depth = int(opt('--depth', 1))
    for nid, ms in t.items():
        if name(nid) == '(idle)':
            continue
        selfc[name(nid)] += ms
        chain, x = [], nid
        while x is not None:
            chain.append(name(x)); x = parent.get(x)
        for k in set(chain):
            incl[k] += ms
        # (chain[0] the leaf: a function's callers further along the chain, its callees before it)
        if want_callers:
            for i, k in enumerate(chain):
                if want_callers in k:
                    callers[' <- '.join(chain[i + 1:i + 1 + depth]) or '(root)'] += ms
                    break
        if want_callees:
            for i in range(len(chain) - 1, -1, -1):
                if want_callees in chain[i]:
                    callees[' -> '.join(reversed(chain[max(0, i - depth):i])) or '(self)'] += ms
                    break

    def line(ms):
        per = f' {ms / frames:7.3f} ms/frame' if frames else ''
        return f'{ms / busy * 100:6.2f}%{per}'
    print(f'total {total:.0f} ms, idle {idle:.0f}, busy {busy:.0f}' + (f' ({busy / frames:.2f} ms a frame over {frames} frames)' if frames else ''))
    print('--- self time')
    for k, v in selfc.most_common(top):
        print(f'{line(v)}  {k[:150]}')
    for m in opts('--match'):
        print(f'--- inclusive, names holding "{m}"')
        for k, v in sorted(((k, v) for k, v in incl.items() if m in k), key=lambda kv: -kv[1])[:top]:
            print(f'{line(v)}  {k[:150]}')
    if want_callers:
        print(f'--- callers of "{want_callers}" (its inclusive time by caller, {depth} deep)')
        for k, v in callers.most_common(top):
            print(f'{line(v)}  {k[:200]}')
    if want_callees:
        print(f'--- callees of "{want_callees}" (its inclusive time by callee, {depth} deep)')
        for k, v in callees.most_common(top):
            print(f'{line(v)}  {k[:200]}')

if __name__ == '__main__':
    main(sys.argv[1:])
