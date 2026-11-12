// CDP driver for the round-2 UI pass.
// node cdp.mjs <port> eval '<expr>' | evalf <file.js> | shot <file.png> [x y w h] | type '<text>' | enter
//                     | click <x> <y> | move <x> <y> | wheel <x> <y> <dy> | viewport <w> <h>|clear | key <key> [modifiers] | reload
// Screenshots paint html/body/.monaco-workbench with the window's base colour first: the transparent
// agent window otherwise composites over white in CDP (white-composite trap).
const [port, cmd, ...args] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title) ?? targets.find(t => t.type === 'page' && /workbench/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => {
	const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	return r.result?.result?.value ?? r.result?.exceptionDetails ?? r;
};
const OPAQUE = `(() => { const wb = document.querySelector('.monaco-workbench'); const bg = getComputedStyle(wb).getPropertyValue('--volt-agent-window-bg-base').trim() || (wb.classList.contains('vs') ? '#f8f8f8' : '#141414'); for (const el of [document.documentElement, document.body, wb]) { el.style.setProperty('background-color', bg, 'important'); } return bg; })()`;
if (cmd === 'eval') {
	console.log(JSON.stringify(await evaluate(args[0]), null, 1));
} else if (cmd === 'evalf') {
	const src = (await import('node:fs')).readFileSync(args[0], 'utf8');
	console.log(JSON.stringify(await evaluate(src), null, 1));
} else if (cmd === 'shot') {
	await evaluate(OPAQUE);
	const [x, y, w, h] = args.slice(1).map(Number);
	const params = { format: 'png' };
	if (w) {
		params.clip = { x, y, width: w, height: h, scale: 1 };
	}
	const r = await send('Page.captureScreenshot', params);
	(await import('node:fs')).writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
	console.log('saved', args[0]);
} else if (cmd === 'type') {
	await send('Input.insertText', { text: args[0] });
	console.log('typed');
} else if (cmd === 'reload') {
	await send('Page.reload', { ignoreCache: true });
	console.log('reloaded');
} else if (cmd === 'enter') {
	for (const type of ['keyDown', 'keyUp']) {
		await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
	}
	console.log('enter');
} else if (cmd === 'click' || cmd === 'move') {
	const [x, y] = args.map(Number);
	await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
	if (cmd === 'click') {
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
	}
	console.log(cmd, x, y);
} else if (cmd === 'wheel') {
	const [x, y, dy] = args.map(Number);
	await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
	console.log('wheel', dy);
} else if (cmd === 'viewport') {
	// viewport <width> <height> | viewport clear: emulate a narrow window (the layout follows it).
	if (args[0] === 'clear') {
		// Width/height 0 turns the override off; clearing alone left Electron's window at the old size.
		await send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
		await send('Emulation.clearDeviceMetricsOverride');
	} else {
		const [width, height] = args.map(Number);
		await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
	}
	console.log('viewport', args.join(' '));
} else if (cmd === 'key') {
	const [key, mods] = args;
	const codes = { Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Enter: 13, Space: 32 };
	const modifiers = Number(mods ?? 0);
	for (const type of ['keyDown', 'keyUp']) {
		await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0), modifiers });
	}
	console.log('key', key);
}
ws.close();
