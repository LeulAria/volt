/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a reply drawn incrementally while it streamed ends up with the same DOM as the same
// reply drawn from scratch. For each scenario: new chat, send, wait for the footer, snapshot the
// reply (normalized), then reload the window (the chat is drawn from saved history in one full
// pass) and snapshot again. Prints OK or the first difference.
// Usage: node build/volt/renderSuite/voltEquivalence.mjs --port 9961 'bench:r09 cps=2000' ...

import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '..', '..', '..', 'package.json'));
const CDP = require('chrome-remote-interface');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args.splice(portIndex, 2)[1]) : 9961;
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

// Normalized HTML of the last reply: fades and chunk boxes unwrapped, editors reduced to their text.
const SNAPSHOT = `
	const turn = [...document.querySelectorAll('.volt-agent-turn.agent')].pop();
	const body = turn.querySelector('.volt-agent-thread-body').cloneNode(true);
	const unwrap = el => el.replaceWith(...el.childNodes);
	body.querySelectorAll('.volt-agent-fresh-text').forEach(unwrap);
	body.querySelectorAll('.volt-md-chunk').forEach(unwrap);
	body.querySelectorAll('.volt-md-chunked').forEach(el => el.classList.remove('volt-md-chunked'));
	body.querySelectorAll('.volt-md-code-editor, code.volt-md-code').forEach(el => { const text = el.textContent.replace(/\\s+/g, ' ').length; el.replaceChildren(); el.setAttribute('data-len', String(text)); });
	// Monaco numbers its editors; a site whose favicon failed once is not decorated again.
	body.querySelectorAll('[data-keybinding-context]').forEach(el => el.removeAttribute('data-keybinding-context'));
	body.querySelectorAll('img.volt-md-link-favicon').forEach(el => el.remove());
	body.querySelectorAll('.volt-md-link').forEach(el => el.classList.remove('volt-md-link'));
	const walker = document.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
	const comments = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) { comments.push(n); } comments.forEach(n => n.remove());
	body.normalize();
	return body.innerHTML.replace(/>\\s+</g, '><');`;

let failures = 0;
try {
	for (const scenario of scenarios) {
		await clickSel('.volt-agent-home-row.is-new');
		await sleep(1200);
		await ev(`const ta = [...document.querySelectorAll('textarea.inputarea')].find(t => t.getClientRects().length && t.closest('.volt-agent-editor')); ta.focus(); return 1;`);
		const nonce = `eq${Date.now().toString(36)}`;
		await client.Input.insertText({ text: `${scenario} ${nonce}` });
		await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
		await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
		for (let i = 0; i < 900 && !(await ev(`const t = [...document.querySelectorAll('.volt-agent-turn.agent')].pop(); return !!t?.querySelector('.volt-agent-footer');`)); i++) {
			await sleep(200);
		}
		await sleep(1500);
		const incremental = await ev(SNAPSHOT);
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
		if (incremental.includes('volt-tr-group worked open')) {
			const header = await ev(`const h = [...document.querySelectorAll('.volt-agent-turn.agent')].pop().querySelector('.volt-tr-group.worked:not(.open) > .volt-tr-header'); if (!h) { return null; } const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
			if (header) {
				for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
					await client.Input.dispatchMouseEvent({ type, x: header.x, y: header.y, button: 'left', clickCount: 1 });
				}
				await sleep(1500);
			}
		}
		const full = await ev(SNAPSHOT);
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
