import math
def squircle(cx, cy, r, n=5.0, steps=720):
    pts=[]
    for i in range(steps):
        t=2*math.pi*i/steps; c,s=math.cos(t),math.sin(t)
        pts.append(f"{cx+r*math.copysign(abs(c)**(2/n),c):.2f},{cy+r*math.copysign(abs(s)**(2/n),s):.2f}")
    return "M"+" L".join(pts)+" Z"

# Fitted brand vertices: top, left, inner-low, bottom, right, inner-high
raw=[(597,51),(227,509),(407,610),(370,953),(733,484),(539,403)]
# The bolt is point-symmetric: vertex i mirrors vertex i+3 through the core.
C=(sum(x for x,_ in raw)/6, sum(y for _,y in raw)/6)
sym=[]
for i,(x,y) in enumerate(raw):
    px,py=raw[(i+3)%6]
    sym.append(((x+2*C[0]-px)/2, (y+2*C[1]-py)/2))
# Put the core at the canvas centre, scale to size
H=max(y for _,y in sym)-min(y for _,y in sym)
k=700/H
V=[(512+(x-C[0])*k, 512+(y-C[1])*k) for x,y in sym]
R=[30,56,22,30,56,22]          # corner softness, mirrored pairs equal
hr=84*k*0.95

def rounded(V,R):
    n=len(V); segs=[]
    for i in range(n):
        x,y=V[i]; ax,ay=V[i-1]; bx,by=V[(i+1)%n]; d=R[i]
        la=math.hypot(ax-x,ay-y); lb=math.hypot(bx-x,by-y)
        pi=(x+(ax-x)*d/la, y+(ay-y)*d/la); po=(x+(bx-x)*d/lb, y+(by-y)*d/lb)
        c1=(pi[0]+(x-pi[0])*0.6, pi[1]+(y-pi[1])*0.6); c2=(po[0]+(x-po[0])*0.6, po[1]+(y-po[1])*0.6)
        segs.append((pi,c1,c2,po))
    f=lambda p:f"{p[0]:.1f},{p[1]:.1f}"
    d="M"+f(segs[0][3])
    for s in segs[1:]+segs[:1]: d+=f" L{f(s[0])} C{f(s[1])} {f(s[2])} {f(s[3])}"
    return d+" Z"
glyph=rounded(V,R)+f" M{512+hr:.1f},512 A{hr:.1f},{hr:.1f} 0 1 0 {512-hr:.1f},512 A{hr:.1f},{hr:.1f} 0 1 0 {512+hr:.1f},512 Z"
body=squircle(512,512,412)

svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <!-- glass rim: light catches the top-left and bottom-right edges -->
  <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.85"/>
    <stop offset="0.25" stop-color="#fff" stop-opacity="0.14"/>
    <stop offset="0.75" stop-color="#fff" stop-opacity="0.08"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.55"/>
  </linearGradient>
  <linearGradient id="rimSoft" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
    <stop offset="0.35" stop-color="#fff" stop-opacity="0"/>
    <stop offset="0.65" stop-color="#fff" stop-opacity="0"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.14"/>
  </linearGradient>
  <filter id="iconShadow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.32"/></feComponentTransfer>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="blur"><feGaussianBlur stdDeviation="8"/></filter>
  <clipPath id="bodyClip"><path d="{body}"/></clipPath>
</defs>
<path d="{body}" fill="#000" filter="url(#iconShadow)"/>
<g clip-path="url(#bodyClip)">
  <path d="{body}" fill="none" stroke="url(#rimSoft)" stroke-width="40" filter="url(#blur)"/>
  <path d="{body}" fill="none" stroke="url(#rim)" stroke-width="7"/>
</g>
<path d="{glyph}" fill-rule="evenodd" fill="#fff"/>
</svg>'''
open("volt.svg","w").write(svg)
open("volt.html","w").write('<html><body style="margin:0;background:transparent">'+svg+'</body></html>')
print("C",C,"k",k)
