// Puts a <webview> over the window (worst cases of the transparent-window skill: in a transparent fixed layer, the
// page with a backdrop-filter header and a moving element), then reports the compositor's quads vs overlays.
//   node webviewprobe.mjs [opaque]   (opaque: the webview sits on a solid, contained layer as rule 2 asks)
import { cdp, sleep } from './lib.mjs';
import { createServer } from 'http';
const page = `<html><body style="margin:0;background:transparent;font:14px system-ui;color:#ddd"><div style="position:sticky;top:0;height:40px;backdrop-filter:blur(12px);background:rgba(40,40,40,.4)">frosted header</div><div id=m style="margin:20px;width:60px;height:20px;background:#3a7"></div>${'<p>row</p>'.repeat(80)}<script>let n=0;setInterval(()=>{m.style.marginLeft=(20+(n++%100))+'px';scrollTo(0,(n*3)%800)},16)</script></body></html>`;
const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); }).listen(18992);
const c = await cdp();
await c.evaluate(`(() => { document.getElementById('wvprobe')?.remove(); const host = document.createElement('div'); host.id = 'wvprobe'; host.style.cssText = 'position:fixed;right:20px;top:60px;width:420px;height:420px;z-index:9999;${process.argv[2] === 'opaque' ? 'background:#1e1e1e;isolation:isolate;contain:paint' : 'background:transparent'}'; const w = document.createElement('webview'); w.setAttribute('partition', 'persist:volt-browser'); w.setAttribute('src', 'http://127.0.0.1:18992/'); w.style.cssText = 'width:100%;height:100%' + ${JSON.stringify(process.env.WV_OPACITY ? ';opacity:' + process.env.WV_OPACITY : '')}; host.appendChild(w); document.body.appendChild(host); })()`);
c.close();
await sleep(Number(process.env.WV_HOLD_MS ?? 4000));
server.close(); process.exit(0);
