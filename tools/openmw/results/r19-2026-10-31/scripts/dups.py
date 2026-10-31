# requests of the same file range overlapping in time on the link (asked twice at once), from a run's proxy log
import gzip,json,sys,re,collections
for run in sys.argv[1:]:
  px=[json.loads(l) for l in gzip.open(run+'/proxy.jsonl.gz','rt') if l.strip()]
  by=collections.defaultdict(list)
  for p in px:
    m=re.search(r'/gamez/[^/]+/([^?]*)\?r=(\d+)-(\d+)',p.get('url',''))
    if m and 'ms' in p: by[(m.group(1),m.group(2),m.group(3))].append((p['t'],p['t']+p['ms'],p.get('wire',0)))
  n=0; wire=0; big=[]
  for k,v in by.items():
    v.sort()
    for i in range(1,len(v)):
      if any(v[i][0]<v[j][1] for j in range(i)): n+=1; wire+=v[i][2]; big.append((v[i][2],k[0].split('/')[-1],k[1]))
  big.sort(reverse=True)
  print(run.split('/')[-1][:24], 'ranges asked again while on the link:', n, 'wire MB', round(wire/1e6,2), big[:3])
