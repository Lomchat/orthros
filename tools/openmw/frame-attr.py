#!/usr/bin/env python3
# Where an OpenMW port's frame goes: a Chrome CPU profile (tools/openmw/perf.mjs --profile: <out>/perf.cpuprofile, the
# page's thread; --workers: <out>/perf-worker-<n>.cpuprofile, one per worker) read with the release's symbol map
# (Emscripten's --emit-symbol-map, <release>/e/<hash>/openmw.js.symbols: "N:name" lines naming the profile's
# wasm-function[N]). Run with python3 -I.
#
# Usage: python3 -I tools/openmw/frame-attr.py <profile> --symbols <openmw.js.symbols> [--frames N]
#          [--hitches MS] [--list 40] [--top N] [--callers <text>] [--callees <text>] [--skip-start 0.4] [--no-trim]
#          [--json <file>]
#
# The window: the first --skip-start seconds dropped (0.4: the profiler's own start), and on the page's thread the tail
# from perf.mjs's closing read on (its renderer's getContext outside the engine — the measured frames end there);
# --no-trim keeps it. A sample lasts until the next one (timeDeltas[i + 1]). Busy: every sample but "(idle)"
# ("(program)" and "(garbage collector)" count: the thread was not free). --frames: the measured frames (ms per frame);
# by default perf.json's "frames" beside the profile.
#
# Buckets (busy ms per frame and share): each sample goes to ONE bucket —
#   1. read-sync if a synchronous read of the game data is anywhere on its stack (JS fetchSync, fetchChunkSync,
#      readSync: the thread waits for the data worker or the network, whoever asked);
#   2. otherwise the first frame, walking from the leaf up, that a rule below matches (rules tried in this order on
#      each frame; a frame's name is its qualified function name, return type and arguments dropped):
#        wait        a thread waiting: futex / condition / semaphore / join / yield / sleep (Emscripten's waits spin
#                    or block without the profiler seeing "(idle)": a worker's pool thread waiting for work, the page's
#                    thread waiting for a worker)
#        lua-ui      LuaUi::...updateWidget / updateContent (the Lua UI's layouts applied)
#        lua-sync    MWLua::LuaManager::synchronizedUpdate (its lambdas too)
#        lua-update  MWLua::LuaManager::update (its lambdas too; with Lua's update on its own thread, r14
#                    OPENMW_ORTHROS_LUATHREAD, it is in that worker's profile, MWLua::Worker)
#        physics     MWPhysics::*, Bullet (bt*)
#        sound       MWSound::*, OpenAL's JS (AL.*, _al*)
#        gui         MWGui::*, MyGUI::*, osgMyGUI::*, Gui::*
#        mechanics   MWMechanics::*
#        osg-cull    osgUtil::CullVisitor::*, osgUtil::SceneView::cull*, osgViewer::Renderer::cull
#        osg-draw+GL osgUtil::SceneView::draw*, RenderStage/RenderBin/RenderLeaf::*, osgViewer::Renderer::draw, and
#                    every GL entry point (_emscripten_gl*, _gl*, gl*, orthrosGL*, webgl*: a GL call is GL whoever
#                    makes it)
#        osg-update  osgViewer::Viewer::updateTraversal, osgUtil::UpdateVisitor::*
#      so a leaf's own subsystem wins over the phase that called it (Lua calling into mechanics: mechanics; a cull
#      callback's engine code: osg-cull, being in no rule itself);
#   3. no rule matched: engine-other if any frame is the engine's WebAssembly, other otherwise (the page's JS, GC,
#      "(program)": the browser's own work).
#
# --hitches MS: every busy stretch longer than MS ms (consecutive non-idle samples; in a worker's profile — no
# omw_pump_frame in it — its waits end a stretch too; on the page's thread a wait is frame time): its start (s into the
# profile), length, buckets, top functions (inclusive, a function once a sample, dispatch left out) and ONE cause: per
# sample the outermost specific frame (walking from the root down, the first frame that is not dispatch — page/JS glue,
# worker entry, omw_pump_frame, OMW::Engine::frame, the viewer's frame and traversals, the graphics context's
# operations, OSG's node/visitor/render-bin plumbing, the post-processing's ping-pong cull, LuaManager's update /
# synchronizedUpdate / delayed actions and the Lua UI's element/widget/content updates, sol/Lua's interpreter, std::),
# or the leaf when every frame is dispatch; the stretch's cause is the one with the most time in it (a stretch of
# ordinary frame work names its biggest piece). Then the stretches aggregated by cause (count, total, longest, main
# bucket). --list: how many stretches printed (longest first; 40).
# --top N: the N functions with the most self time, with their bucket. --callers / --callees <text>: the inclusive time
# of the functions whose name holds <text>, split by their direct callers / callees.
# --json <file>: the same numbers, machine-readable.
import collections, json, os, re, sys

RULES = [
    ('wait', re.compile(r'^(?:_do_futex_wait|emscripten_futex_wait|__timedwait(?:_cp)?|__pthread_cond_timedwait|__wait|sem_wait'
                        r'|sem_timedwait|pthread_join|__pthread_join|sched_yield|emscripten_thread_sleep|nanosleep)$')),
    ('lua-ui', re.compile(r'^LuaUi::(?:.*::)?(?:updateWidget|updateContent)\b')),
    ('lua-sync', re.compile(r'MWLua::LuaManager::synchronizedUpdate\b')),
    ('lua-update', re.compile(r'MWLua::LuaManager::update(?:\(|$)')),
    ('physics', re.compile(r'^(?:MWPhysics::|bt[A-Z]\w*(?:::|$))')),
    ('sound', re.compile(r'^(?:MWSound::|AL\.|_al[A-Z])')),
    ('gui', re.compile(r'^(?:MWGui::|MyGUI::|osgMyGUI::|Gui::)')),
    ('mechanics', re.compile(r'^MWMechanics::')),
    ('osg-cull', re.compile(r'^(?:osgUtil::CullVisitor::|osgUtil::SceneView::cull|osgViewer::Renderer::cull$)')),
    ('osg-draw+GL', re.compile(r'^(?:osgUtil::SceneView::draw|osgUtil::(?:RenderStage|RenderBin|RenderLeaf)::|osgViewer::Renderer::draw$'
                               r'|_?emscripten_gl|_gl[A-Z]|gl[A-Z]\w*$|orthrosGL|webgl)')),
    ('osg-update', re.compile(r'^(?:osgViewer::Viewer::updateTraversal|osgUtil::UpdateVisitor::)')),
]
READ_SYNC = re.compile(r'^(?:fetchSync|fetchChunkSync|readSync)$')
BUCKETS = ['osg-draw+GL', 'osg-cull', 'osg-update', 'lua-update', 'lua-sync', 'lua-ui', 'read-sync', 'wait', 'physics', 'mechanics',
           'sound', 'gui', 'engine-other', 'other']
# (dispatch: frames passed through when looking for a hitch's cause)
DISPATCH = re.compile(
    r'^(?:\(root\)|\(anonymous\)|js-to-wasm|wasm-to-js|dynCall|invoke_|callUserCallback|tick|timed|pump\w*|_?omw_pump_frame'
    r'|handleMessage|invokeEntryPoint|\S*::webThreadMain|start_thread|_?emscripten_thread_\w*'
    r'|OMW::Engine::frame|OMW::Engine::go|osgViewer::(?:ViewerBase|Viewer|CompositeViewer)::(?:frame|renderingTraversals|eventTraversal|updateTraversal|advance)'
    r'|osgViewer::Renderer::(?:cull_draw|cull|draw|operator)|osgUtil::SceneView::(?:cull|draw)\w*'
    r'|osg::GraphicsContext::runOperations|osg::GraphicsOperation::operator'
    r'|osgUtil::SceneView::cullStage|MWRender::PostProcessor::traverse|SceneUtil::NodeCallback<MWRender::PingPongCull'
    r'|MWLua::LuaManager::(?:update|synchronizedUpdate|applyDelayedActions|DelayedAction::apply)|LuaUtil::invokeProtectedCall<MWLua::LuaManager::'
    r'|LuaUi::Element::update|LuaUi::(?:.*::)?(?:updateWidget|updateContent)\b'
    r'|osgUtil::(?:RenderStage|RenderBin|RenderLeaf)::(?:draw|drawImplementation|drawInner|drawPreRenderStages|drawPostRenderStages|render)\w*'
    r'|osgUtil::CullVisitor::(?:apply|traverse|handle_cull_callbacks_and_traverse|handle_cull_callbacks_and_accept)'
    r'|osgUtil::UpdateVisitor::(?:apply|traverse|handle_callbacks)\w*'
    r'|osg::(?:Node|Group|Transform|MatrixTransform|PositionAttitudeTransform|Switch|LOD|PagedLOD|Geode|Camera|Drawable|NodeVisitor|Callback|NodeCallback|DrawableCullCallback|CallbackObject)::(?:accept|traverse|apply|run|operator)\w*'
    r'|osg::NodeVisitor::|std::|sol::|LuaUtil::invokeProtectedCall|LuaUtil::call|lua[A-Z_]|luaD_|luaV_|luaT_|luaG_|f_call|resume|precallC)')

def qualified(name):
    """A demangled C++ name's function: return type and arguments dropped ("int A::f<B::g()>(x) const" -> "A::f<B::g()>")."""
    s = name.replace('(anonymous namespace)', '{anon}')
    depth, cut = 0, len(s)
    for i, ch in enumerate(s):
        if ch == '<':
            depth += 1
        elif ch == '>' and depth:
            depth -= 1
        elif ch == '(' and depth == 0 and not s[:i].endswith('operator') and i > 0:
            cut = i
            break
    head, parts, depth, cur = s[:cut], [], 0, ''
    for ch in head:
        if ch == '<':
            depth += 1
        elif ch == '>' and depth:
            depth -= 1
        if ch == ' ' and depth == 0:
            parts.append(cur); cur = ''
        else:
            cur += ch
    parts.append(cur)
    q = parts[-1] or head
    return q.replace('{anon}', '(anonymous namespace)')

def main(argv):
    if not argv or argv[0].startswith('-'):
        sys.exit('usage: frame-attr.py <profile> --symbols <openmw.js.symbols> [--frames N] [--hitches MS] [--list 40] '
                 '[--top N] [--callers <text>] [--callees <text>] [--skip-start 0.4] [--no-trim] [--json <file>]')
    path, args = argv[0], argv[1:]
    def opt(k, d=None):
        return args[args.index(k) + 1] if k in args and args.index(k) + 1 < len(args) else d
    symbols = {}
    if opt('--symbols'):
        for line in open(opt('--symbols'), encoding='utf-8', errors='replace'):
            i, _, n = line.rstrip('\n').partition(':')
            symbols[i] = n
    else:
        print('frame-attr: no --symbols: WebAssembly frames keep their numbers', file=sys.stderr)
    frames = int(opt('--frames', 0))
    if not frames:
        pj = os.path.join(os.path.dirname(os.path.abspath(path)), 'perf.json')
        if os.path.exists(pj):
            frames = int(json.load(open(pj)).get('frames') or 0)
    prof = json.load(open(path))
    nodes = {n['id']: n for n in prof['nodes']}
    parent = {}
    for n in prof['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']

    names, quals, wasm = {}, {}, {}
    for nid, n in nodes.items():
        f = n['callFrame']
        nm = f.get('functionName') or '(anonymous)'
        m = re.match(r'^\$?(?:wasm-function\[(\d+)\]|(\d+))$', nm)
        if m:
            nm = symbols.get(m.group(1) or m.group(2), nm)
        url = f.get('url') or ''
        wasm[nid] = url.endswith('.wasm')
        quals[nid] = qualified(nm) if wasm[nid] else nm
        names[nid] = nm if wasm[nid] or not url else f'{nm} [{url.rsplit("/", 1)[-1].split("?")[0]}]'

    stacks = {}
    def stack(nid):  # leaf first
        if nid not in stacks:
            st, x = [], nid
            while x is not None:
                st.append(x); x = parent.get(x)
            stacks[nid] = st
        return stacks[nid]

    bucket_of = {}
    def bucket(nid):
        if nid in bucket_of:
            return bucket_of[nid]
        st, b = stack(nid), None
        if any(not wasm[x] and READ_SYNC.match(quals[x]) for x in st):
            b = 'read-sync'
        else:
            for x in st:
                q = quals[x]
                for cat, rx in RULES:
                    if rx.search(q):
                        b = cat; break
                if b:
                    break
            if not b:
                b = 'engine-other' if any(wasm[x] for x in st) else 'other'
        bucket_of[nid] = b
        return b

    cause_of = {}
    def cause(nid):
        if nid not in cause_of:
            st = stack(nid)
            c = next((quals[x] for x in reversed(st) if not DISPATCH.match(quals[x])), quals[st[0]])
            cause_of[nid] = c
        return cause_of[nid]

    # (the samples, their times and durations; the window)
    samples, deltas = prof['samples'], prof['timeDeltas']
    ts, t = [], prof['startTime']
    for d in deltas:
        t += d; ts.append(t)
    dur = [(ts[i + 1] - ts[i]) / 1000.0 if i + 1 < len(ts) else max(0, prof['endTime'] - ts[i]) / 1000.0 for i in range(len(ts))]
    t0 = prof['startTime'] + float(opt('--skip-start', 0.4)) * 1e6
    lo = next((i for i, x in enumerate(ts) if x >= t0), len(ts))
    hi = len(ts)
    if '--no-trim' not in args:
        closing = lambda nid: any(quals[x] == 'getContext' for x in stack(nid)) and not any(wasm[x] for x in stack(nid))
        first = next((i for i in range(lo, len(samples)) if closing(samples[i])), None)
        if first is not None:
            hi = first
    idle_ids = {nid for nid in nodes if quals[nid] == '(idle)'}
    win = range(lo, hi)
    wall = (ts[hi - 1] - ts[lo]) / 1000.0 + dur[hi - 1] if hi > lo else 0.0

    by_bucket, selfc = collections.Counter(), collections.Counter()
    busy = 0.0
    for i in win:
        nid = samples[i]
        if nid in idle_ids:
            continue
        ms = dur[i]; busy += ms
        by_bucket[bucket(nid)] += ms
        selfc[nid] += ms
    perf = lambda ms: ms / frames if frames else None
    waited = by_bucket.get('wait', 0.0)
    out = {'profile': path, 'frames': frames, 'windowMs': round(wall, 1), 'busyMs': round(busy, 1), 'waitMs': round(waited, 1),
           'busyPerFrame': round(perf(busy), 2) if frames else None, 'buckets': {}}
    print(f'{os.path.basename(path)}: window {wall / 1000:.2f} s, busy {busy:.0f} ms ({100 * busy / max(wall, 1e-9):.1f} %)'
          + (f', {frames} frames: busy {busy / frames:.2f} ms/frame' if frames else ' (no --frames: totals only)')
          + (f'; without waits {busy - waited:.0f} ms' + (f' ({(busy - waited) / frames:.2f} ms/frame)' if frames else '') if waited else ''))
    print(f'  {"bucket":<13} {"ms":>9} {"ms/frame":>9} {"share":>7}')
    for b in BUCKETS:
        ms = by_bucket.get(b, 0.0)
        out['buckets'][b] = {'ms': round(ms, 1), 'perFrame': round(perf(ms), 3) if frames else None, 'share': round(ms / max(busy, 1e-9), 4)}
        print(f'  {b:<13} {ms:9.1f} {(f"{ms / frames:9.2f}" if frames else "        -")} {100 * ms / max(busy, 1e-9):6.1f}%')

    top = int(opt('--top', 0))
    if top:
        agg, bk = collections.Counter(), {}
        for nid, ms in selfc.items():
            agg[names[nid]] += ms; bk.setdefault(names[nid], collections.Counter())[bucket(nid)] += ms
        print(f'\nself time, top {top}:')
        out['top'] = []
        for nm, ms in agg.most_common(top):
            b = bk[nm].most_common(1)[0][0]
            out['top'].append({'name': nm, 'ms': round(ms, 1), 'bucket': b})
            print(f'  {ms:8.1f} ms {100 * ms / max(busy, 1e-9):5.1f}%  {b:<12} {nm[:150]}')

    for flag, key in (('--callers', 'callers'), ('--callees', 'callees')):
        want = opt(flag)
        if not want:
            continue
        incl, split = 0.0, collections.Counter()
        for i in win:
            nid = samples[i]
            if nid in idle_ids:
                continue
            st, ms = stack(nid), dur[i]
            hits = [k for k, x in enumerate(st) if want in names[x]]
            if not hits:
                continue
            incl += ms
            seen = set()
            for k in hits:
                other = (names[st[k + 1]] if k + 1 < len(st) else '(none)') if key == 'callers' else (names[st[k - 1]] if k > 0 else '(self)')
                if other not in seen:
                    seen.add(other); split[other] += ms
        print(f'\n{key} of functions holding "{want}": inclusive {incl:.1f} ms' + (f' ({incl / frames:.2f} ms/frame)' if frames else ''))
        out[key] = {'match': want, 'inclusiveMs': round(incl, 1), 'split': []}
        for nm, ms in split.most_common(30):
            out[key]['split'].append({'name': nm, 'ms': round(ms, 1)})
            print(f'  {ms:8.1f} ms {100 * ms / max(incl, 1e-9):5.1f}%  {nm[:150]}')

    if opt('--hitches'):
        limit, show = float(opt('--hitches')), int(opt('--list', 40))
        # (a worker's waits end its stretches: its pool waits for work; on the page's thread a wait is frame time)
        split_waits = not any(quals[x] in ('omw_pump_frame', '_omw_pump_frame') for x in nodes)
        runs, run = [], None
        for i in win:
            nid = samples[i]
            if nid in idle_ids or (split_waits and bucket(nid) == 'wait'):
                if run:
                    runs.append(run); run = None
                continue
            if run is None:
                run = {'start': (ts[i] - prof['startTime']) / 1e6, 'ms': 0.0, 'ids': []}
            run['ms'] += dur[i]; run['ids'].append((nid, dur[i]))
        if run:
            runs.append(run)
        long = [r for r in runs if r['ms'] > limit]
        by_cause = collections.defaultdict(lambda: {'n': 0, 'ms': 0.0, 'max': 0.0, 'bucket': collections.Counter()})
        out['hitches'] = []
        for r in long:
            causes, bks, incl = collections.Counter(), collections.Counter(), collections.Counter()
            for nid, ms in r['ids']:
                causes[cause(nid)] += ms; bks[bucket(nid)] += ms
                for nm in {names[x] for x in stack(nid)} - {'(root)'}:
                    incl[nm] += ms
            r['cause'] = causes.most_common(1)[0][0]
            r['buckets'], r['top'] = bks, incl
            c = by_cause[r['cause']]
            c['n'] += 1; c['ms'] += r['ms']; c['max'] = max(c['max'], r['ms']); c['bucket'].update(bks)
        long.sort(key=lambda r: -r['ms'])
        total = sum(r['ms'] for r in long)
        print(f'\nbusy stretches over {limit:g} ms: {len(long)}, {total:.0f} ms' + (f' (longest {show})' if len(long) > show else ''))
        for r in long:
            out['hitches'].append({'start': round(r['start'], 3), 'ms': round(r['ms'], 1), 'cause': r['cause'],
                                   'buckets': {k: round(v, 1) for k, v in r['buckets'].most_common()},
                                   'top': [[k, round(v, 1)] for k, v in r['top'].most_common(12)]})
        for r in long[:show]:
            bk = ', '.join(f'{k} {v:.0f}' for k, v in r['buckets'].most_common(4))
            print(f'\n  {r["ms"]:6.1f} ms at {r["start"]:7.2f} s  cause: {r["cause"][:120]}\n    buckets: {bk}')
            for nm, ms in [x for x in r['top'].most_common(30) if not DISPATCH.match(qualified(x[0].split(' [')[0]))][:8]:
                print(f'    {ms:6.1f}  {nm[:140]}')
        print(f'\nby cause:\n  {"n":>4} {"total ms":>9} {"max ms":>7}  {"bucket":<12} cause')
        out['byCause'] = []
        for k, c in sorted(by_cause.items(), key=lambda kv: -kv[1]['ms']):
            b = c['bucket'].most_common(1)[0][0]
            out['byCause'].append({'cause': k, 'n': c['n'], 'ms': round(c['ms'], 1), 'max': round(c['max'], 1), 'bucket': b})
            print(f'  {c["n"]:4d} {c["ms"]:9.1f} {c["max"]:7.1f}  {b:<12} {k[:120]}')

    if opt('--json'):
        with open(opt('--json'), 'w') as f:
            json.dump(out, f, indent=1)

if __name__ == '__main__':
    main(sys.argv[1:])
