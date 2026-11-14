/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Drives a Volt test instance over CDP (chrome-remote-interface from the main checkout).
//   node cdp.mjs <port> eval '<expr>'          the value, JSON
//   node cdp.mjs <port> shot <file.png> [selector]   whole window, or one element's box
//   node cdp.mjs <port> click '<css selector>' [text]  a real mouse click (gesture-armed buttons need one)
//   node cdp.mjs <port> type '<text>'          inserts text at the focus
//   node cdp.mjs <port> key <Enter|Escape|...>
//   node cdp.mjs <port> palette '<command title>'    runs a command from the palette
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire('/Users/leularia/Desktop/VOLT/volt/package.json');
const CDP = require('chrome-remote-interface');
const [port, cmd, arg, arg2] = process.argv.slice(2);
const targets = await CDP.List({ port: +port });
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url)) ?? targets.find(t => t.type === 'page');
const c = await CDP({ port: +port, target: page });
const evaluate = async expression => {
	const r = await c.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) {
		throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
	}
	return r.result.value;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const box = (selector, text) => evaluate(`(() => {
	const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.offsetParent !== null || e.getClientRects().length);
	const el = ${text ? `els.find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}))` : 'els[0]'};
	if (!el) { return null; }
	const r = el.getBoundingClientRect();
	return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, width: r.width, height: r.height };
})()`);
const click = async (selector, text) => {
	const b = await box(selector, text);
	if (!b) {
		throw new Error(`nothing matches ${selector} ${text ?? ''}`);
	}
	await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: b.x, y: b.y });
	await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
	await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
	return b;
};
const key = async name => {
	const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
	await c.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: codes[name] ?? 0 });
	await c.Input.dispatchKeyEvent({ type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name] ?? 0 });
};
try {
	if (cmd === 'eval') {
		const value = await evaluate(arg);
		console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
	} else if (cmd === 'shot') {
		const b = arg2 ? await box(arg2) : null;
		const r = await c.Page.captureScreenshot({ format: 'png', ...(b ? { clip: { x: b.left - 8, y: b.top - 8, width: b.width + 16, height: b.height + 16, scale: 1 } } : {}) });
		writeFileSync(arg, Buffer.from(r.data, 'base64'));
		console.log(arg);
	} else if (cmd === 'click') {
		console.log(JSON.stringify(await click(arg, arg2)));
	} else if (cmd === 'type') {
		await c.Input.insertText({ text: arg });
	} else if (cmd === 'key') {
		await key(arg);
	} else if (cmd === 'palette') {
		await c.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 });
		await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 });
		await sleep(400);
		await c.Input.insertText({ text: arg });
		await sleep(700);
		await key('Enter');
	}
} finally {
	await c.close();
}
