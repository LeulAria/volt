#!/usr/bin/env node
// Picks a model for the chat on screen from the composer's model picker (its Claude tab):
// the test profile's chats start on the Codex default.  node pick-model.mjs [--chat "Long thread 75k|..."] [--model Haiku]
import { connect, sleep, rowCenter } from './lib.mjs';
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const want = new RegExp(opt('model', 'Haiku 5.5'), 'i');
const cdp = await connect(9953);
let row;
for (const name of opt('chat', 'Long thread 75k|Turn 1: keep reading the modules').split('|')) {
	row ??= await rowCenter(cdp, name);
}
await cdp.click(row.x, row.y);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 300 });
await sleep(3000);
const b = await cdp.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const m = ed.querySelector('.volt-agent-model'); const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await cdp.click(b.x, b.y); await sleep(1200);
// The picker's Claude tab (next to its search box).
const tab = await cdp.evaluate(`(() => { const inp = [...document.querySelectorAll('input')].find(i => /Search models/i.test(i.placeholder || '')); let box = inp; for (let k = 0; k < 6 && box; k++) box = box.parentElement; const t = box && [...box.querySelectorAll('button, [role=tab]')].find(b => b.offsetParent && (b.getAttribute('aria-label') || b.title) === 'Claude'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await cdp.click(tab.x, tab.y); await sleep(1200);
const rows = await cdp.evaluate(`[...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && e.getBoundingClientRect().x > 600).map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim().slice(0, 50), x: r.x + 40, y: r.y + r.height / 2 }; })`);
console.log(rows.map(r => r.t).join('\n'));
const h = rows.find(r => want.test(r.t));
if (h) { await cdp.click(h.x, h.y); await sleep(1000); console.log('picked', h.t); } else { await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); }
console.log(await cdp.evaluate(`[...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent).querySelector('.volt-agent-model').textContent`));
cdp.close();
