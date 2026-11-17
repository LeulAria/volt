// node mutations.mjs [secs=10] [--focus]  which DOM nodes change while the window idles (attribute, text, children), by count
import { cdp, sleep } from './lib.mjs';
const args = process.argv.slice(2);
const secs = Number(args[0] && /^\d+$/.test(args[0]) ? args[0] : 10);
const c = await cdp();
if (args.includes('--focus')) { await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
if (args.includes('--settle')) { await sleep(Number(args[args.indexOf('--settle') + 1]) * 1000); }
await c.evaluate(`(() => {
	const desc = n => { const e = n.nodeType === 1 ? n : n.parentElement; if (!e) return '?'; const path = []; for (let x = e; x && path.length < 4; x = x.parentElement) { path.unshift(x.tagName.toLowerCase() + (x.className && typeof x.className === 'string' ? '.' + x.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')); } return path.join(' > '); };
	const counts = window.__mut = new Map();
	window.__mo = new MutationObserver(list => { for (const m of list) { const k = m.type + (m.attributeName ? '[' + m.attributeName + ']' : '') + ' ' + desc(m.target); counts.set(k, (counts.get(k) ?? 0) + 1); } });
	window.__mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	window.__anims = new Map();
	document.addEventListener('animationstart', e => window.__anims.set('anim ' + e.animationName + ' ' + desc(e.target), (window.__anims.get('anim ' + e.animationName + ' ' + desc(e.target)) ?? 0) + 1), true);
	document.addEventListener('transitionrun', e => window.__anims.set('trans ' + e.propertyName + ' ' + desc(e.target), (window.__anims.get('trans ' + e.propertyName + ' ' + desc(e.target)) ?? 0) + 1), true);
})()`);
await sleep(secs * 1000);
const out = await c.evaluate(`(() => { window.__mo.disconnect(); return [...window.__mut, ...window.__anims].sort((a, b) => b[1] - a[1]).slice(0, 40); })()`);
if (args.includes('--focus')) { await c.send('Emulation.setFocusEmulationEnabled', { enabled: false }); }
c.close();
for (const [k, v] of out) { console.log(String(v).padStart(5), k.slice(0, 220)); }
