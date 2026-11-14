#!/usr/bin/env python3
# Measurement aid for d52d10e640c: rewrite a stored window snapshot (written by the minified after build, which predates
# the commit) the way the commit's capture writes it: keep the :root icon variables of icons the snapshot shows
# (codicon-<id> classes), of icons a runtime rule names through var(), and of icons the product stylesheet names
# (PRODUCT_REFS, read from the after build's workbench.desktop.main.css); drop the other icon variables.
#   trimsnap.py <in.json> <out.json> <product.css>
import json, re, sys
src, dst, product_css = sys.argv[1:4]
d = json.load(open(src))
icons = set(re.findall(r'codicon-([\w-]+)', json.dumps(d['root'])))
REF = re.compile(r'var\(\s*--vscode-icon-([\w-]+?)-(?:content|font-family)\s*[,)]')
icons |= set(REF.findall(open(product_css).read()))
icons |= set(REF.findall(d['css']))
VAR = re.compile(r'^\s*--vscode-icon-(.+)-(content|font-family)\s*:')
def trim(m):
    decls = [x for x in m.group(2).split(';') if x.strip()]
    kept = [x for x in decls if not (VAR.match(x) and VAR.match(x).group(1) not in icons)]
    return f'{m.group(1)}{{{";".join(kept)}; }}' if kept else ''
before = len(d['css'])
d['css'] = re.sub(r'([^{}\n]*)\{([^{}]*--vscode-icon-[^{}]*)\}', trim, d['css'])
json.dump(d, open(dst, 'w'))
print(f'icons kept {len(icons)}, css {before} -> {len(d["css"])}')
