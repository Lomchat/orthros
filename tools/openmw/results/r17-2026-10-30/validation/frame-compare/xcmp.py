# r16's reference captures against r17's: per view, the mean of the 4 frames each side (as frame-compare averages),
# then the mean absolute difference (0-255) and the share of pixels over 24 in a channel
import sys
from PIL import Image
import numpy as np
a,b=sys.argv[1],sys.argv[2]
def avg(d,view,tag):
    return np.mean([np.asarray(Image.open(f'{d}/{view}-{tag}-{i}.png').convert('RGB'),dtype=np.float64) for i in range(4)],axis=0)
for view in ('day','night','interior'):
    out={}
    for name,(x,y) in {'r16 vs r17':(avg(a,view,'ref'),avg(b,view,'ref')),'r16 noise':(avg(a,view,'ref'),avg(a,view,'ref2')),'r17 noise':(avg(b,view,'ref'),avg(b,view,'ref2'))}.items():
        d=np.abs(x-y); out[name]=(round(d.mean(),3), round(100*(d.max(axis=2)>24).mean(),2))
    print(view, out)
