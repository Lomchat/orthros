import json,sys,glob,os,statistics as st
rows={}
for f in sorted(glob.glob(sys.argv[1]+'/*/perf.json')):
  k=os.path.basename(os.path.dirname(f)); d=json.load(open(f)); side=k.rsplit('-',1)[0]
  w=d.get('work') or {}; g=d.get('gap') or {}
  rows.setdefault(side,[]).append((k,d.get('fps'),w.get('p50'),w.get('p99'),g.get('max'),d.get('dataStallMs'),d.get('syncFetches'),len(d.get('faults') or [])))
for side,rs in rows.items():
  for r in rs: print(*r)
  if len(rs)>1:
    f=[r[1] for r in rs if r[1]]; p=[r[3] for r in rs if r[3]]
    print(f"  {side}: n={len(rs)} fps med {st.median(f):.2f} [{min(f)}-{max(f)}]  p99 med {st.median(p):.1f} [{min(p)}-{max(p)}]  p50 med {st.median([r[2] for r in rs]):.1f}")
