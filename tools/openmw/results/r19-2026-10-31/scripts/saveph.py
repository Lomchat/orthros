# a save load's phases from its read trace: key -> first announced batch, the loading screen's reads, the serial esm reads after it, their end -> in world
import gzip,json,sys
for run in sys.argv[1:]:
  tr=json.load(gzip.open(run+'/read-trace.json.gz','rt')); k=tr['keyAt']; T=lambda t: round((t-k)/1000,2)
  es=[e for e in tr['trace'] if e['t']>=k]
  esm=[e for e in es if e.get('k') in ('sync','late','spin') and (e.get('f') or '').endswith('Morrowind.esm') and e.get('ms',0)>=50]
  ww=[e for e in es if e.get('k')=='wwait']
  reads=[e for e in es if e.get('k') in ('sync','late','spin') and e['t']<(esm[0]['t'] if esm else 1e18)]
  lo=[e for e in es if e.get('k')=='jspi' and e.get('ev')=='loading']
  print(run.split('/')[-1][:16], 'inWorld', T(tr['inWorldAt']) if tr.get('inWorldAt') else None,
        'wwaits', [(T(e['t']),e.get('ms')) for e in ww], 'loadOff', T(lo[-1]['t']) if lo else None,
        'esm serial', (T(esm[0]['t']), T(esm[-1]['t']+esm[-1]['ms']), len(esm)) if esm else None,
        'reads before', len(reads), 'readMs', sum(e.get('ms',0) for e in reads))
