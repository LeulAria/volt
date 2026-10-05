import math, random, sys

# `python3 volt-icon.py` writes the release icon; `--beta` writes the early-access
# galaxy variant (same bolt and gravity-well grid, deep-space background).
BETA = "--beta" in sys.argv
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

# Gravity-well grid: straight blueprint lines bent inward toward the bolt's core,
# like spacetime around a mass. r' = r * (1 - pull * e^(-(r/reach)^2)).
def warped_grid(step=103, pull=0.5, reach=310):
    def bend(x, y):
        dx, dy = x-512, y-512; r = math.hypot(dx, dy)
        f = 1-pull*math.exp(-(r/reach)**2)
        return 512+dx*f, 512+dy*f
    d = ""
    for k in range(-8, 9):
        a = 512+k*step
        for horizontal in (False, True):
            pts = [bend(t, a) if horizontal else bend(a, t) for t in range(-300, 1325, 6)]
            d += "M"+" L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    return d
grid = warped_grid()

# Beta starfield: seeded so every run draws the same sky.
def starfield(count=170, seed=7):
    rng = random.Random(seed); out = []
    for _ in range(count):
        x, y = rng.uniform(100, 924), rng.uniform(100, 924)
        r = rng.choice([1.2, 1.4, 1.7, 2.0, 2.4, 3.2]) if rng.random() > 0.08 else rng.uniform(3.6, 4.6)
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#fff" opacity="{rng.uniform(0.25, 0.95):.2f}"/>')
    # a few bright stars with a soft halo
    for x, y in [(236, 262), (790, 300), (300, 770), (760, 820), (850, 610)]:
        out.append(f'<circle cx="{x}" cy="{y}" r="16" fill="url(#starHalo)"/><circle cx="{x}" cy="{y}" r="3.6" fill="#fff"/>')
    return "\n  ".join(out)

# Beta nebula: soft colour clouds, each an ellipse whose radial gradient fades to nothing
# (a big blur filter leaves hard tile edges in Chromium's renderer).
NEBULA = [  # cx, cy, rx, ry, rotation, colour, opacity
    (300, 300, 420, 290, -30, "#6A2BD8", 0.5),
    (760, 740, 440, 270, -30, "#C0307F", 0.34),
    (700, 260, 320, 230, 0, "#1F4FD6", 0.45),
    (290, 760, 320, 210, 0, "#2A6BE0", 0.28),
    (512, 512, 700, 170, -35, "#9A6BFF", 0.2),
]
def nebula():
    defs, shapes = [], []
    for i, (cx, cy, rx, ry, rot, col, op) in enumerate(NEBULA):
        defs.append(f'<radialGradient id="neb{i}"><stop offset="0" stop-color="{col}" stop-opacity="{op}"/>'
                    f'<stop offset="0.45" stop-color="{col}" stop-opacity="{op*0.55:.3f}"/>'
                    f'<stop offset="1" stop-color="{col}" stop-opacity="0"/></radialGradient>')
        shapes.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="url(#neb{i})" transform="rotate({rot} {cx} {cy})"/>')
    return "<defs>"+"".join(defs)+"</defs>\n  "+"\n  ".join(shapes)

# The foot of the body sinks into shade: nested unblurred strokes stack into a soft
# inner edge (a blurred stroke tiles into hard-edged bands in Chromium).
rim_shade = "".join(f'<path d="{body}" fill="none" stroke="url(#rimShade)" stroke-width="{w}" opacity="0.2"/>'
                    for w in range(10, 91, 10))

if BETA:
    background = f'''<path d="{body}" fill="url(#bodyFill)"/>
  {nebula()}
  {starfield()}
  <path d="{grid}" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" mask="url(#gridMask)"/>'''
    pal = dict(top="#1A1048", mid="#0D0A2C", low="#07061C", foot="#030210", well="#000000", well2="#05031A",
               grid0="0.14", grid1="0.08", shade="#020110", shadow="#05021A", bevel="#9C93C9", glyphFoot="#E3DDF7")
else:
    background = f'''<path d="{body}" fill="url(#bodyFill)"/>
  <path d="{grid}" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round" mask="url(#gridMask)"/>'''
    pal = dict(top="#3A9BF2", mid="#1B58D4", low="#0F37A3", foot="#061653", well="#030B30", well2="#040F3D",
               grid0="0.26", grid1="0.13", shade="#061A5E", shadow="#04154F", bevel="#7E9CCF", glyphFoot="#D9E6FA")

svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <!-- body: electric blue (release) or deep space (beta), darkening toward the foot -->
  <linearGradient id="bodyFill" x1="0.3" y1="0" x2="0.7" y2="1">
    <stop offset="0" stop-color="{pal['top']}"/>
    <stop offset="0.45" stop-color="{pal['mid']}"/>
    <stop offset="0.75" stop-color="{pal['low']}"/>
    <stop offset="1" stop-color="{pal['foot']}"/>
  </linearGradient>
  <!-- the gravity well: shade deepening toward the bolt's core -->
  <radialGradient id="glow" cx="0.5" cy="0.5" r="0.42">
    <stop offset="0" stop-color="{pal['well']}" stop-opacity="0.75"/>
    <stop offset="0.55" stop-color="{pal['well2']}" stop-opacity="0.28"/>
    <stop offset="1" stop-color="{pal['well2']}" stop-opacity="0"/>
  </radialGradient>
  <!-- blueprint grid, pulled into the bolt's gravity well -->
  <linearGradient id="gridFade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="{pal['grid0']}"/>
    <stop offset="1" stop-color="#fff" stop-opacity="{pal['grid1']}"/>
  </linearGradient>
  <mask id="gridMask"><rect width="1024" height="1024" fill="url(#gridFade)"/></mask>
  <!-- glass rim: light catches the top edge, the foot sinks into shade -->
  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.75"/>
    <stop offset="0.18" stop-color="#fff" stop-opacity="0.12"/>
    <stop offset="0.8" stop-color="#fff" stop-opacity="0.04"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.3"/>
  </linearGradient>
  <linearGradient id="rimShade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0.55" stop-color="#0A2A8A" stop-opacity="0"/>
    <stop offset="1" stop-color="{pal['shade']}" stop-opacity="0.6"/>
  </linearGradient>
  <!-- the bolt: white porcelain, cooling slightly toward its foot -->
  <linearGradient id="glyphFill" x1="0.35" y1="0" x2="0.65" y2="1">
    <stop offset="0" stop-color="#FFFFFF"/>
    <stop offset="0.55" stop-color="#F6F9FF"/>
    <stop offset="1" stop-color="{pal['glyphFoot']}"/>
  </linearGradient>
  <filter id="iconShadow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.32"/></feComponentTransfer>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <!-- bolt lifts off the body: a wide soft shadow plus a tight contact shadow -->
  <filter id="glyphShadow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="14" result="b1"/>
    <feOffset in="b1" dy="10" result="o1"/>
    <feFlood flood-color="{pal['shadow']}" flood-opacity="0.24"/>
    <feComposite in2="o1" operator="in" result="s1"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b2"/>
    <feOffset in="b2" dy="3" result="o2"/>
    <feFlood flood-color="{pal['shadow']}" flood-opacity="0.18"/>
    <feComposite in2="o2" operator="in" result="s2"/>
    <feMerge><feMergeNode in="s1"/><feMergeNode in="s2"/></feMerge>
  </filter>
  <!-- bevel: a lit top edge and a cool shaded bottom edge inside the bolt -->
  <filter id="glyphBevel" x="-10%" y="-10%" width="120%" height="120%">
    <feOffset in="SourceAlpha" dy="7" result="down"/>
    <feComposite in="SourceAlpha" in2="down" operator="out" result="topEdge"/>
    <feGaussianBlur in="topEdge" stdDeviation="2.5" result="topSoft"/>
    <feFlood flood-color="#FFFFFF" flood-opacity="1"/>
    <feComposite in2="topSoft" operator="in" result="hi"/>
    <feOffset in="SourceAlpha" dy="-9" result="up"/>
    <feComposite in="SourceAlpha" in2="up" operator="out" result="botEdge"/>
    <feGaussianBlur in="botEdge" stdDeviation="5" result="botSoft"/>
    <feFlood flood-color="{pal['bevel']}" flood-opacity="0.55"/>
    <feComposite in2="botSoft" operator="in" result="lo"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="lo"/><feMergeNode in="hi"/></feMerge>
    <feComposite in2="SourceAlpha" operator="in"/>
  </filter>
  <filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter>
  <radialGradient id="starHalo"><stop offset="0" stop-color="#CFE0FF" stop-opacity="0.7"/><stop offset="1" stop-color="#CFE0FF" stop-opacity="0"/></radialGradient>
  <clipPath id="bodyClip"><path d="{body}"/></clipPath>
</defs>
<path d="{body}" fill="#000" filter="url(#iconShadow)"/>
<g clip-path="url(#bodyClip)">
  {background}
  <path d="{body}" fill="url(#glow)"/>
  {rim_shade}
  <path d="{body}" fill="none" stroke="url(#rim)" stroke-width="6"/>
  <path d="{glyph}" fill-rule="evenodd" fill="#000" filter="url(#glyphShadow)"/>
</g>
<path d="{glyph}" fill-rule="evenodd" fill="url(#glyphFill)" filter="url(#glyphBevel)"/>
</svg>'''
open("volt-icon-beta.svg" if BETA else "volt-icon.svg","w").write(svg)
print("C",C,"k",k)
