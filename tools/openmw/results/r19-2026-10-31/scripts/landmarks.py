import gzip,json,sys
for run in sys.argv[1:]:
  tr=json.load(gzip.open(run+'/read-trace.json.gz','rt'))
  ents=tr['trace']

  marks=[('Morrowind.bsa',0),('Splash',0),('Morrowind.esm',None),('Tribunal.esm',None),('Bloodmoon.esm',None),('Morrowind.bsa',213516288),('openmw-web-assets.bsa',19202048),('Morrowind.bsa',210829312),('morrowind title.mp3',1769472),('Morrowind.bsa',168361984),('Morrowind.bsa',209387520)]
  out=[]
  for f,off in marks:
    for e in ents:
      if e.get('k') in ('sync','spin','late','async') and f in (e.get('f') or '') and (off is None or e.get('off')==off):
        out.append(f"{f.split('.')[0][:10]}@{off}:{e['t']/1000:.1f}+{e.get('ms',0)/1000:.2f}"); break
  tot=sum(e.get('ms',0) for e in ents if e.get('k') in ('sync','late','spin'))
  print(run.split('/')[-1][:22], ' '.join(out))
