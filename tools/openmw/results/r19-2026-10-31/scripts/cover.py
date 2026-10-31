# each slow wait (>=N ms) of a run's boot (page clock < upto): which link requests covered its bytes, their kind, size, start/end on the page's clock
import gzip,json,sys,re
run,upto,minms=sys.argv[1],float(sys.argv[2]),float(sys.argv[3])
tr=json.load(gzip.open(run+'/read-trace.json.gz','rt'))
px=[json.loads(l) for l in gzip.open(run+'/proxy.jsonl.gz','rt') if l.strip()]
mk=[p for p in px if '/__qa/mark' in p.get('url','')]
off=mk[0]['t']-tr['markAt']
reqs=[]
for p in px:
  m=re.search(r'/gamez/[^/]+/(.*)\?r=(\d+)-(\d+)',p.get('url',''))
  if m: reqs.append((m.group(1).split('/')[-1].replace('%20',' '),int(m.group(2)),int(m.group(3)),p['t']-off,p['t']-off+p['ms'],p.get('kind'),p.get('wire')))
tot={}
for e in tr['trace']:
  if e.get('k') in ('sync','late') and e['t']<upto and e.get('ms',0)>=minms:
    f=(e.get('f') or '').split('/')[-1]; a=e['off']
    cov=[r for r in reqs if r[0]==f and r[1]<=a<r[2] and r[3]<=e['t']+e['ms']+50 and r[4]>=e['t']-50]
    desc=' | '.join(f"{r[5]} {(r[2]-r[1])>>10}K {r[3]/1000:.2f}-{r[4]/1000:.2f}" for r in cov)
    k=cov[0][5] if cov else 'none'; tot[k]=tot.get(k,0)+e['ms']
    print(f"{e['t']/1000:6.2f} {e['k']:4s} {e['ms']:5d} {f[:24]:24s} {a:10d} <- {desc}")
print('wait ms by covering kind', tot)
