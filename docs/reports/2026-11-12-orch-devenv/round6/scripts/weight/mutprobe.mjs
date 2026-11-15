// Exploratory: who writes the DOM after a turn. One `replay:seed` turn in the current chat, then a MutationObserver over
// the whole document for `watch` s (starting `after` s after the turn ends); prints the mutations grouped by target
// (tag.classes, attribute or text), with counts and a sample of old -> new.
//   node mutprobe.mjs [watch s=12] [after s=3]
import { cdp, focusComposer, paste, sleep } from './lib.mjs';

const watch = Number(process.argv[2] ?? 12);
const after = Number(process.argv[3] ?? 3);
const c = await cdp();
const count = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => (m.textContent.match(/unchanged/g) || []).length)[0] || 0`;
const before = await c.evaluate(count);
await focusComposer(c);
await paste(c, 'replay:seed');
await sleep(500);
await c.key('Enter', 'Enter', 13, 0, '\r');
for (let t = 0; t < 150 && await c.evaluate(count) <= before; t++) { await sleep(200); }
await sleep(after * 1000);
await c.evaluate(`(() => {
	const desc = n => { const e = n.nodeType === 3 ? n.parentElement : n; if (!e) { return '?'; } const path = []; let x = e; for (let i = 0; i < 4 && x && x !== document.body; i++, x = x.parentElement) { path.unshift(x.tagName.toLowerCase() + (x.className && typeof x.className === 'string' ? '.' + x.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')); } return path.join(' > '); };
	window.__mut = new Map();
	window.__mo = new MutationObserver(records => { for (const r of records) { const key = r.type + ' ' + (r.attributeName ?? '') + ' @ ' + desc(r.target); const e = window.__mut.get(key) ?? { n: 0, samples: [] }; e.n++; if (e.samples.length < 2) { e.samples.push((r.oldValue ?? '').toString().slice(0, 60) + ' -> ' + (r.type === 'characterData' ? r.target.data.slice(0, 60) : r.type === 'attributes' ? (r.target.getAttribute(r.attributeName) ?? '').slice(0, 60) : 'added ' + r.addedNodes.length + ' removed ' + r.removedNodes.length + ' ' + [...r.addedNodes].map(n => n.nodeType === 3 ? JSON.stringify(n.data.slice(0, 40)) : (n.tagName + '.' + (n.className || '')).slice(0, 50)).join(','))); } window.__mut.set(key, e); } });
	window.__mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
	return true;
})()`);
await sleep(watch * 1000);
const out = await c.evaluate(`(() => { window.__mo.disconnect(); return JSON.stringify([...window.__mut.entries()].sort((a, b) => b[1].n - a[1].n)); })()`);
for (const [key, e] of JSON.parse(out)) {
	console.log(`${String(e.n).padStart(4)}  ${key}`);
	for (const s of e.samples) { console.log(`        ${s}`); }
}
c.close();
