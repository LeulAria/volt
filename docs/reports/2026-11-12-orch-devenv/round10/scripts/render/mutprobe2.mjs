// What changes in the visible chat per frame: running animations (name, property, target, rect, composited-able?)
// and 1.5 s of DOM mutations by kind and target (with the target's rect relative to the scroller's content top).
import { cdp } from './lib.mjs';
const c = await cdp();
const r = await Promise.race([c.evaluate(`new Promise(resolve => {
	const inner = [...document.querySelectorAll('.volt-agent-thread-inner')].find(e => e.offsetParent);
	const top = inner ? inner.getBoundingClientRect().top - inner.scrollTop : 0;
	const desc = e => { if (!e || !e.getBoundingClientRect) return String(e && e.nodeName); const r = e.getBoundingClientRect(); return (e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 3).join('.')).slice(0, 70) + ' @' + Math.round(r.top - top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); };
	const anims = {};
	for (const a of document.getAnimations()) { const t = a.effect && a.effect.target; if (!t || !t.isConnected) continue; const k = (a.animationName || a.transitionProperty || a.constructor.name) + ' | ' + desc(t).replace(/@-?\\d+ /, '@ '); anims[k] = (anims[k] || 0) + 1; }
	const muts = {};
	const mo = new MutationObserver(list => { for (const m of list) { let t = m.target.nodeType === 3 ? m.target.parentElement : m.target; const k = m.type + (m.attributeName ? ':' + m.attributeName : '') + ' | ' + desc(t).replace(/ \\d+x\\d+$/, ''); muts[k] = (muts[k] || 0) + 1; } });
	mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
	setTimeout(() => { mo.disconnect(); resolve(JSON.stringify({ anims, muts })); }, 1500);
})`), new Promise(r => setTimeout(() => r('{"timeout":1}'), 10000))]);
const o = JSON.parse(r);
console.log('== running animations (count | name | target)');
for (const [k, n] of Object.entries(o.anims ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(n, k);
console.log('== mutations in 1.5 s');
for (const [k, n] of Object.entries(o.muts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(n, k);
c.close(); process.exit(0);
