/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a reply drawn incrementally while it streamed ends up with the same DOM as the same
// reply drawn from scratch. For each scenario: new chat, send, wait for the footer, snapshot the
// reply (normalized), then reload the window (the chat is drawn from saved history in one full
// pass) and snapshot again. Prints OK or the first difference.
// With --chat, all scenarios go to one chat and the whole thread is compared (a thread that grew
// turn by turn against the same thread drawn in one pass).
// Usage: node build/volt/renderSuite/voltEquivalence.mjs --port 9961 [--chat] 'bench:r09 cps=2000' ...

import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '..', '..', '..', 'package.json'));
const CDP = require('chrome-remote-interface');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args.splice(portIndex, 2)[1]) : 9961;
const chatIndex = args.indexOf('--chat');
const oneChat = chatIndex >= 0 && !!args.splice(chatIndex, 1);
const scenarios = args.length ? args : ['bench:r09 cps=2000'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const targets = await CDP.List({ port });
const client = await CDP({ port, target: targets.find(t => t.type === 'page' && /workbench/.test(t.url)) });
const ev = async body => {
	const r = await client.Runtime.evaluate({ expression: `(() => { ${body} })()`, returnByValue: true });
	if (r.exceptionDetails) {
		throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
	}
	return r.result.value;
};
const clickSel = async (selector) => {
	const p = await ev(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { return null; } const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
	if (!p) {
		return false;
	}
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
	}
	return true;
};

// Normalized HTML of the last reply (or the whole thread): fades and chunk boxes unwrapped, editors reduced to their text.
const snapshot = whole => `
	const body = ${whole ? `document.querySelector('.volt-agent-thread-inner').cloneNode(true)` : `[...document.querySelectorAll('.volt-agent-turn.agent')].pop().querySelector('.volt-agent-thread-body').cloneNode(true)`};
	const unwrap = el => el.replaceWith(...el.childNodes);
	body.querySelectorAll('.volt-agent-fresh-text').forEach(unwrap);
	body.querySelectorAll('.volt-md-chunk').forEach(unwrap);
	body.querySelectorAll('.volt-md-chunked').forEach(el => el.classList.remove('volt-md-chunked'));
	body.querySelectorAll('.volt-md-code-editor, code.volt-md-code').forEach(el => { const text = el.textContent.replace(/\\s+/g, ' ').length; el.replaceChildren(); el.setAttribute('data-len', String(text)); });
	// Monaco numbers its editors; a site whose favicon failed once is not decorated again.
	body.querySelectorAll('[data-keybinding-context]').forEach(el => el.removeAttribute('data-keybinding-context'));
	body.querySelectorAll('img.volt-md-link-favicon').forEach(el => el.remove());
	body.querySelectorAll('.volt-md-link').forEach(el => el.classList.remove('volt-md-link'));
	// Relative times tick.
	body.querySelectorAll('.volt-agent-ago').forEach(el => el.replaceChildren());
	// The pinned prompt and the fade under it follow the scroll position.
	body.querySelectorAll('[style*="--volt-sticky-fade-end"]').forEach(el => el.style.removeProperty('--volt-sticky-fade-end'));
	body.querySelectorAll('.stuck, .has-stuck-turn').forEach(el => el.classList.remove('stuck', 'has-stuck-turn'));
	// A cleared inline style leaves an empty attribute behind.
	body.querySelectorAll('[style=""]').forEach(el => el.removeAttribute('style'));
	const walker = document.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
	const comments = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) { comments.push(n); } comments.forEach(n => n.remove());
	// Attribute order is not content.
	for (const el of [body, ...body.querySelectorAll('*')]) {
		const attrs = [...el.attributes].map(a => [a.name, a.value]).sort((a, b) => a[0] < b[0] ? -1 : 1);
		attrs.forEach(([name]) => el.removeAttribute(name));
		attrs.forEach(([name, value]) => el.setAttribute(name, value));
	}
	body.normalize();
	return body.innerHTML.replace(/>\\s+</g, '><').replace(/list_id_\\d+/g, 'list_id');`;
const SNAPSHOT = snapshot(false);

const send = async text => {
	await ev(`const ta = [...document.querySelectorAll('textarea.inputarea')].find(t => t.getClientRects().length && t.closest('.volt-agent-editor')); ta.focus(); return 1;`);
	await client.Input.insertText({ text });
	await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const footers = () => ev(`return [...document.querySelectorAll('.volt-agent-turn.agent')].filter(t => t.querySelector('.volt-agent-footer')).length;`);

let failures = 0;
try {
	for (const scenario of oneChat ? [scenarios.join(' + ')] : scenarios) {
		await clickSel('.volt-agent-home-row.is-new');
		await sleep(1200);
		const nonce = `eq${Date.now().toString(36)}`;
		const prompts = oneChat ? scenarios : [scenario];
		for (const [n, prompt] of prompts.entries()) {
			await send(`${prompt} ${nonce}`);
			for (let i = 0; i < 900 && await footers() < n + 1; i++) {
				await sleep(200);
			}
			await sleep(800);
		}
		await sleep(1500);
		const incremental = await ev(oneChat ? snapshot(true) : SNAPSHOT);
		// History is written a moment after the turn ends.
		await sleep(2500);
		await client.Page.reload({ ignoreCache: false });
		let restored = false;
		for (let i = 0; i < 150 && !restored; i++) {
			await sleep(200);
			const row = `[...document.querySelectorAll('.volt-agent-home-row')].find(r => r.textContent.includes(${JSON.stringify(nonce)}))`;
			if (!await ev(`return !!${row};`).catch(() => false)) {
				continue;
			}
			if (!await ev(`return !!document.querySelector('.volt-agent-turn.user')?.textContent.includes(${JSON.stringify(nonce)});`).catch(() => false)) {
				const p = await ev(`const r = ${row}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
				for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
					await client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
				}
				await sleep(600);
			}
			restored = await ev(`return !!document.querySelector('.volt-agent-turn.user')?.textContent.includes(${JSON.stringify(nonce)}) && !!document.querySelector('.volt-agent-turn.agent .volt-agent-footer');`).catch(() => false);
		}
		if (!restored) {
			console.log(`SKIP ${scenario}: the chat did not come back after a reload`);
			continue;
		}
		// Highlighting and diagrams finish asynchronously after a cold render.
		await sleep(2500);
		// A live run leaves its "Worked for" fold open; a reopened chat starts with it closed.
		// (Every one of them, in a whole chat; each click redraws the thread.)
		for (let open = 0; open < incremental.split('volt-tr-group worked open').length - 1; open++) {
			const clicked = await ev(`const turns = [...document.querySelectorAll('.volt-agent-turn.agent')]; const h = (${oneChat} ? document : turns.pop()).querySelector('.volt-tr-group.worked:not(.open) > .volt-tr-header'); h?.click(); return !!h;`);
			if (!clicked) {
				break;
			}
			await sleep(1200);
		}
		const full = await ev(oneChat ? snapshot(true) : SNAPSHOT);
		if (incremental === full) {
			console.log(`OK   ${scenario} (${full.length} chars)`);
			continue;
		}
		failures++;
		let i = 0;
		while (i < incremental.length && incremental[i] === full[i]) {
			i++;
		}
		console.log(`DIFF ${scenario} at ${i}:\n  streamed: …${incremental.slice(Math.max(0, i - 160), i + 240)}\n  full:     …${full.slice(Math.max(0, i - 160), i + 240)}`);
	}
} finally {
	await client.close();
}
process.exitCode = failures ? 1 : 0;
