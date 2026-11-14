// While the window snapshot is shown, report its codicon elements whose ::before has no glyph.
const end = Date.now() + 40000;
let ws;
while (Date.now() < end) {
  try {
    const l = await (await fetch('http://127.0.0.1:9944/json/list')).json();
    const p = l.find(x => x.type === 'page' && /workbench/.test(x.url));
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; }
  } catch { }
  await new Promise(r => setTimeout(r, 30));
}
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
const ev = expr => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
const EXPR = `(()=>{const s=document.getElementById('volt-window-snapshot'); if(!s) return null; const els=[...s.querySelectorAll('[class*="codicon-"]')];
 const bad=els.filter(e=>{const c=getComputedStyle(e,'::before').content; return !c||c==='none'||c==='normal'||c==='""'}).map(e=>e.className.slice(0,60));
 return JSON.stringify({icons:els.length, missing:bad.length, examples:bad.slice(0,5), css:[...document.querySelectorAll('style.volt-window-snapshot-style')].reduce((n,x)=>n+x.textContent.length,0)})})()`;
while (Date.now() < end) {
  const v = (await ev(EXPR)).result?.result?.value;
  if (v) { console.log(v); process.exit(0); }
  await new Promise(r => setTimeout(r, 20));
}
console.log('snapshot never seen'); process.exit(0);
