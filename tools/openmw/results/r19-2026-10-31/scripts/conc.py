# mean number of background requests in flight while the engine waited on a read (boot, page clock < upto), and their bytes
import gzip,json,sys,re
run,upto=sys.argv[1],float(sys.argv[2])
tr=json.load(gzip.open(run+'/read-trace.json.gz','rt'))
px=[json.loads(l) for l in gzip.open(run+'/proxy.jsonl.gz','rt') if l.strip()]
off=[p for p in px if '/__qa/mark' in p.get('url','')][0]['t']-tr['markAt']
bg=[(p['t']-off,p['t']-off+p.get('ms',0),p.get('wire',0)) for p in px if re.search(r'[?&]p=1',p.get('url',''))]
waits=[(e['t'],e['t']+e['ms']) for e in tr['trace'] if e.get('k') in ('sync','late') and e['t']<upto and e.get('ms',0)>=20]
W=sum(b-a for a,b in waits); C=0; started=0; wire=0
for a,b in waits:
  for s,e,w in bg:
    o=max(0,min(b,e)-max(a,s)); C+=o
    if a<=s<b: started+=1; wire+=w
print(run.split('/')[-1][:20], 'waits',len(waits),'ms',int(W),'mean bg in flight',round(C/max(W,1),1),'bg started during waits',started, 'wireMB',round(wire/1e6,2), 'bg total before', len([1 for s,e,w in bg if s<upto]))
