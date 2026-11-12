/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// One live run in a Volt test instance: resets the fixture repo, opens a new chat, sends the
// prompt, waits until the chat tree is idle, then prints analyzeVolt.mjs's metrics plus the
// fixture's test result. Usage:
//   node scripts/volt-e2e/orch/runVolt.mjs <cdpPort> <profile/User> <repo> <prompt-file> <label>
import { execSync } from 'child_process';
import { readdirSync, readFileSync, statSync, existsSync, appendFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const [port, user, repo, promptFile, label] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../package.json'));
const CDP = require('chrome-remote-interface');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

execSync('git checkout -q . && git clean -fdq', { cwd: repo });
const targets = await CDP.List({ port: Number(port) });
const client = await CDP({ port: Number(port), target: targets.find(t => t.type === 'page' && /workbench/.test(t.url)) });
const evaluate = async expression => (await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })).result.value;
// Before the new chat exists: setting its access mode can already write its trace.
const traces = join(user, 'voltTraces');
const before = new Set(readdirSync(traces));
await evaluate(`[...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New Chat/.test(e.getAttribute('aria-label'))).click()`);
await sleep(1500);
// Measure the orchestration, not the user approving: the chat runs in Full access (sandbox kept).
const click = async (x, y) => {
	for (const type of ['mousePressed', 'mouseReleased']) {
		await client.Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 });
	}
};
const center = async script => evaluate(`(() => { const e = ${script}; if (!e) { return undefined; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const chip = await center(`[...document.querySelectorAll('[aria-label^="Permissions:"]')].find(e => e.offsetParent)`);
if (chip) {
	await click(...chip);
	await sleep(500);
	const item = await center(`[...document.querySelectorAll('*')].filter(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === 'Full access').at(-1)`);
	if (item) {
		await click(...item);
		await sleep(500);
	}
}
const focused = await evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } t.focus(); return true; })()`);
if (!focused) {
	throw new Error('no composer');
}
await client.Input.insertText({ text: readFileSync(promptFile, 'utf8').trim() });
await sleep(300);
const sentAt = Date.now();
await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
let chat;
for (let i = 0; i < 60 && !chat; i++) {
	await sleep(500);
	chat = readdirSync(traces).find(name => !before.has(name))?.replace(/\.jsonl$/, '');
}
if (!chat) {
	throw new Error('no new chat trace');
}
// Idle: the root and its subagents run nothing, nothing is queued or undelivered, for 8 s.
const rootFile = join(user, 'voltOrchestrator', 'roots', `${chat}.json`);
let idleSince = 0;
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
	await sleep(1000);
	if (!existsSync(rootFile)) {
		continue;
	}
	let tree;
	try {
		tree = JSON.parse(readFileSync(rootFile, 'utf8'));
	} catch {
		continue;
	}
	const busy = tree.threads.some(thread => thread.active || thread.queue?.length || thread.inputs?.length)
		|| tree.tasks.some(task => ['queued', 'running', 'waiting'].includes(task.state) || task.delivery === 'pending');
	const settled = tree.threads.find(thread => thread.id === chat)?.last;
	if (busy || !settled) {
		idleSince = 0;
		continue;
	}
	idleSince ||= Date.now();
	if (Date.now() - idleSince > 8000 && Date.now() - statSync(rootFile).mtimeMs > 8000) {
		break;
	}
}
await client.close();
let tests = '';
try {
	tests = execSync('npm test 2>&1', { cwd: repo, encoding: 'utf8' });
} catch (err) {
	tests = String(err.stdout ?? err);
}
const pass = /\u2139 pass (\d+)/.exec(tests)?.[1];
const fail = /\u2139 fail (\d+)/.exec(tests)?.[1];
const metrics = JSON.parse(execSync(`node ${join(here, 'analyzeVolt.mjs')} ${user} ${chat} --json`, { encoding: 'utf8' }));
const diff = execSync('git status --short', { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const row = { label, sentAt, ...metrics, testsPass: Number(pass ?? 0), testsFail: Number(fail ?? 0), changed: diff };
console.log(JSON.stringify(row));
appendFileSync('/tmp/volt-e2e/orch/live/volt-runs.jsonl', JSON.stringify(row) + '\n');
