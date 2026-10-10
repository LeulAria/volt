import math

# `python3 volt-icon-fold.py` writes the release icon (volt-icon.svg): a white
# folded-paper bolt on a black squircle, with two grey facets where the upper blade
# tucks under the lower one. It prints the bolt path; the in-app marks (letterpress-*.svg,
# code-icon*.svg) cut that path out of their squircle. volt-icon.py --beta still draws
# the beta galaxy icon.
def squircle(cx, cy, r, n=5.0, steps=720):
    pts=[]
    for i in range(steps):
        t=2*math.pi*i/steps; c,s=math.cos(t),math.sin(t)
        pts.append(f"{cx+r*math.copysign(abs(c)**(2/n),c):.2f},{cy+r*math.copysign(abs(s)**(2/n),s):.2f}")
    return "M"+" L".join(pts)+" Z"

# Traced from the reference art: top, left, inner-low, bottom, right, inner-high
raw=[(718,215),(372,640),(595,665),(497,1030),(868,558),(666,532)]
# Point-symmetric through the centre: vertex i mirrors vertex i+3.
C=(sum(x for x,_ in raw)/6, sum(y for _,y in raw)/6)
sym=[]
for i,(x,y) in enumerate(raw):
    px,py=raw[(i+3)%6]
    sym.append(((x+2*C[0]-px)/2, (y+2*C[1]-py)/2))
H=max(y for _,y in sym)-min(y for _,y in sym)
k=625/H
V=[(512+(x-C[0])*k, 512+(y-C[1])*k) for x,y in sym]
T,L,NL,B,R,NH=V
R_=[13,13,8,13,13,8]          # tip and notch softness

def rounded(V,R):
    # Each corner becomes a circular arc of radius R[i] tangent to both edges.
    n=len(V); segs=[]
    for i in range(n):
        x,y=V[i]; ax,ay=V[i-1]; bx,by=V[(i+1)%n]; r=R[i]
        ux,uy=ax-x,ay-y; la=math.hypot(ux,uy); ux,uy=ux/la,uy/la
        vx,vy=bx-x,by-y; lb=math.hypot(vx,vy); vx,vy=vx/lb,vy/lb
        theta=math.acos(max(-1,min(1,ux*vx+uy*vy)))
        d=r/math.tan(theta/2)
        sweep=1 if (ux*vy-uy*vx)<0 else 0
        segs.append(((x+ux*d,y+uy*d),(x+vx*d,y+vy*d),r,sweep))
    f=lambda p:f"{p[0]:.1f},{p[1]:.1f}"
    d="M"+f(segs[0][1])
    for pi,po,r,sw in segs[1:]+segs[:1]: d+=f" L{f(pi)} A{r},{r} 0 0 {sw} {f(po)}"
    return d+" Z"
glyph=rounded(V,R_)
body=squircle(512,512,412)

# Fold facets. The crease runs from the upper notch down the lower blade's left edge
# to Q, 38% of the way from the lower notch to the bottom tip.
Q=(NL[0]+(B[0]-NL[0])*0.38, NL[1]+(B[1]-NL[1])*0.38)
poly=lambda P:"M"+" L".join(f"{x:.1f},{y:.1f}" for x,y in P)+" Z"
# Where the crease crosses the lower notch's height.
t=(NL[1]-NH[1])/(Q[1]-NH[1]); M=(NH[0]+(Q[0]-NH[0])*t, NL[1])
shadow_face=poly([L,NH,M,NL])          # underside of the upper blade
light_face=poly([NH,R,Q])              # the lower blade turning away from the light

svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <!-- body: near-black, a breath lighter at the top -->
  <linearGradient id="bodyFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#141415"/>
    <stop offset="1" stop-color="#050505"/>
  </linearGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
    <stop offset="0.25" stop-color="#fff" stop-opacity="0.06"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.1"/>
  </linearGradient>
  <linearGradient id="shadowFace" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#C9C9CC"/>
    <stop offset="1" stop-color="#ADADB1"/>
  </linearGradient>
  <linearGradient id="lightFace" x1="0.2" y1="0" x2="0.5" y2="1">
    <stop offset="0" stop-color="#E2E2E5"/>
    <stop offset="1" stop-color="#CFCFD3"/>
  </linearGradient>
  <filter id="iconShadow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="8"/><feOffset dy="5"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.2"/></feComponentTransfer>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <clipPath id="glyphClip"><path d="{glyph}"/></clipPath>
</defs>
<path d="{body}" fill="#000" filter="url(#iconShadow)"/>
<path d="{body}" fill="url(#bodyFill)"/>
<path d="{body}" fill="none" stroke="url(#rim)" stroke-width="4"/>
<path d="{glyph}" fill="#FFFFFF"/>
<g clip-path="url(#glyphClip)">
  <path d="{shadow_face}" fill="url(#shadowFace)"/>
  <path d="{light_face}" fill="url(#lightFace)"/>
</g>
</svg>'''
open("volt-icon.svg","w").write(svg)

print(glyph)
