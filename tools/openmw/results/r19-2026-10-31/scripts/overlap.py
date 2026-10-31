import gzip,json,sys,re
run,a,b=sys.argv[1],float(sys.argv[2])*1000,float(sys.argv[3])*1000
tr=json.load(gzip.open(run+'/read-trace.json.gz','rt'))
px=[json.loads(l) for l in gzip.open(run+'/proxy.jsonl.gz','rt') if l.strip()]
off=[p for p in px if '/__qa/mark' in p.get('url','')][0]['t']-tr['markAt']
for p in sorted(px,key=lambda p:p['t']):
  s=p['t']-off; e=s+p.get('ms',0)
  if e>=a and s<=b: print(f"{s/1000:6.2f}-{e/1000:6.2f} {p.get('kind'):7s} {p.get('wire',0)>>10:5d}K {p.get('url','')[:100]}")
