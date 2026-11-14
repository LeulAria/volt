// Picks the arena folder as the new chat's project through the in-window folder dialog
// (files.simpleDialog.enable, set by lib.writeSettings), typing its absolute path.
//   node pickproject.mjs [folder=~/.volt-r5/firstword/arena]
import { cdp, sleep, FOLDER } from './lib.mjs';

const folder = (process.argv[2] ?? FOLDER).replace(/\/?$/, '/');
const c = await cdp();
const clickText = async t => {
	const pt = await c.evaluate(`(() => { const e=[...document.querySelectorAll("*")].filter(e=>e.offsetParent!==null && (e.innerText||"").trim()===${JSON.stringify(t)}).at(-1); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]; })()`);
	if (!pt) { throw new Error('nothing reads ' + t); }
	await c.click(pt[0], pt[1]);
};
const findText = t => c.evaluate(`(() => { const e=[...document.querySelectorAll("*")].filter(e=>e.offsetParent!==null && (e.innerText||"").trim()===${JSON.stringify(t)}).at(-1); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]; })()`);
let opened = false;
for (let attempt = 0; attempt < 6 && !opened; attempt++) {
	// The landing's project picker can take a while to appear on a loaded machine.
	let label;
	for (let i = 0; i < 40 && !label; i++) {
		label = await c.evaluate('[...document.querySelectorAll(".volt-agent-landing-pick")].filter(e=>e.offsetParent)[0]?.innerText');
		if (!label) { await sleep(500); }
	}
	if (!label) { throw new Error('no project picker'); }
	await clickText(label.trim());
	for (let i = 0; i < 20; i++) {
		await sleep(500);
		const pt = await findText('Local folders');
		if (pt) { await c.click(pt[0], pt[1]); opened = true; break; }
	}
	if (!opened) { await c.key('Escape', 'Escape', 27); await sleep(1000); }
}
if (!opened) { throw new Error('the project menu never offered Local folders'); }
for (let i = 0; i < 20; i++) {
	await sleep(500);
	if (await c.evaluate('[...document.querySelectorAll("input")].some(e=>e.offsetParent && /Type a path/.test(e.placeholder))')) { break; }
}
await c.evaluate(`(() => { const i=[...document.querySelectorAll("input")].find(e=>e.offsetParent && /Type a path/.test(e.placeholder)); i.focus(); i.select(); return true })()`);
await c.send('Input.insertText', { text: folder });
await sleep(1200);
await c.key('Enter', 'Enter', 13, 0, '\r');
await sleep(1500);
const picked = await c.evaluate('[...document.querySelectorAll(".volt-agent-landing-pick")].filter(e=>e.offsetParent).map(e=>e.innerText).join("|")');
console.log(picked);
c.close();
if (!picked.startsWith(folder.replace(/\/$/, '').split('/').pop())) { throw new Error('the project is not ' + folder); }
