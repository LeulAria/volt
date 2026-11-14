import { createRequire } from 'node:module';
const require = createRequire('/Users/leularia/Desktop/VOLT/volt/package.json');
const CDP = require('chrome-remote-interface');
const port = +(process.argv[2] ?? 9975);
const t = (await CDP.List({ port })).find(t => t.type === 'page' && /workbench/.test(t.url) && (!process.env.TITLE || t.title.includes(process.env.TITLE)));
const c = await CDP({ port, target: t });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = async e => (await c.Runtime.evaluate({ expression: e, returnByValue: true })).result.value;
const chip = await ev(`(() => { const e=[...document.querySelectorAll('*')].find(e=>e.offsetParent && e.children.length<2 && /^Supervised$/.test(e.innerText?.trim()||'')); if(!e) return null; const b=e.getBoundingClientRect(); return [Math.round(b.x+b.width/2), Math.round(b.y+b.height/2)]; })()`);
if (chip) {
	for (const type of ['mousePressed', 'mouseReleased']) await c.Input.dispatchMouseEvent({ type, x: chip[0], y: chip[1], button: 'left', clickCount: 1 });
	await sleep(900);
	const key = async (key, code, vk) => { await c.Input.dispatchKeyEvent({ type: 'keyDown', key, code, windowsVirtualKeyCode: vk }); await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await sleep(150); };
	for (let i = 0; i < 3; i++) await key('ArrowDown', 'ArrowDown', 40);
	console.log('focused:', await ev(`document.querySelector('.monaco-list-row.focused')?.innerText`));
	await key('Enter', 'Enter', 13);
	await sleep(800);
}
console.log(await ev(`[...document.querySelectorAll('*')].filter(e=>e.offsetParent && e.children.length<2 && /^(Supervised|Full access)$/.test(e.innerText?.trim()||'')).map(e=>e.innerText).join(',')`));
await c.close();
