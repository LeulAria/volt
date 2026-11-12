// One orchestration run in a Volt test window over CDP, then its metrics.
//   node b1run.mjs <cdpPort> <userDataDir> <promptFile> <tag> [--sandbox off|ws] [--access full|keep] [--timeout 600]
// Opens a new chat (project stays the window's current one), sets access and sandbox from the
// composer's chip, sends the prompt with `{TAG}` replaced, waits until the chat tree is idle, then
// prints one JSON line (also appended to <promptFile dir>/../runs.jsonl when --log is given).
// Metrics come from Volt's own traces (User/voltTraces) and the saved tree (User/voltOrchestrator).
import { readdirSync, readFileSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const [port, ud, promptFile, tag] = process.argv.slice(2);
const opt = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const sandbox = opt('sandbox', 'keep');
const access = opt('access', 'full');
const timeoutS = +opt('timeout', '600');
const logFile = opt('log', '');
const user = join(ud, 'User');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title) ?? targets.find(t => t.type === 'page' && /workbench/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); } };
const center = async script => evaluate(`(() => { const e = ${script}; if (!e) { return undefined; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const byText = text => `[...document.querySelectorAll('*')].filter(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;
const key = async (k, code) => { for (const type of ['keyDown', 'keyUp']) { await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code }); } };

const traces = join(user, 'voltTraces');
const before = new Set(existsSync(traces) ? readdirSync(traces) : []);
const newAgent = await center(`[...document.querySelectorAll('[aria-label="New Agent"]')].find(e => e.offsetParent)`);
if (newAgent) { await click(...newAgent); }
await sleep(1500);
const chip = await center(`[...document.querySelectorAll('[aria-label^="Permissions:"]')].find(e => e.offsetParent)`);
if (chip && (access === 'full' || sandbox !== 'keep')) {
	if (access === 'full') {
		await click(...chip); await sleep(500);
		const item = await center(byText('Full access'));
		if (item) { await click(...item); await sleep(400); } else { await key('Escape', 27); }
	}
	if (sandbox !== 'keep') {
		await click(...chip); await sleep(500);
		const item = await center(byText(sandbox === 'off' ? 'Off' : 'Workspace write'));
		if (item) { await click(...item); await sleep(400); } else { await key('Escape', 27); }
	}
}
const chipLabel = await evaluate(`[...document.querySelectorAll('[aria-label^="Permissions:"]')].find(e => e.offsetParent)?.getAttribute('aria-label')`);
const focused = await evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } t.focus(); return true; })()`);
if (!focused) { throw new Error('no composer'); }
await send('Input.insertText', { text: readFileSync(promptFile, 'utf8').trim().replaceAll('{TAG}', tag) });
await sleep(300);
const load = execSync('uptime').toString().replace(/.*averages?: /, '').trim();
const sentAt = Date.now();
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
let chat;
// The root is the new chat with a saved tree of its own (subagent chats live in their root's tree).
for (let i = 0; i < 400 && !chat; i++) {
	await sleep(500);
	chat = (existsSync(traces) ? readdirSync(traces) : []).filter(name => !before.has(name)).map(name => name.replace(/\.jsonl$/, ''))
		.find(name => existsSync(join(user, 'voltOrchestrator', 'roots', `${name}.json`)));
}
if (!chat) { throw new Error('no new chat trace'); }
const rootFile = join(user, 'voltOrchestrator', 'roots', `${chat}.json`);
let idleSince = 0;
const deadline = Date.now() + timeoutS * 1000;
let timedOut = true;
while (Date.now() < deadline) {
	await sleep(1000);
	if (!existsSync(rootFile)) { continue; }
	let tree;
	try { tree = JSON.parse(readFileSync(rootFile, 'utf8')); } catch { continue; }
	const busy = tree.threads.some(thread => thread.active || thread.queue?.length || thread.inputs?.length)
		|| tree.tasks.some(task => ['queued', 'running', 'waiting'].includes(task.state) || task.delivery === 'pending');
	const settled = tree.threads.find(thread => thread.id === chat)?.last;
	if (busy || !settled) { idleSince = 0; continue; }
	idleSince ||= Date.now();
	if (Date.now() - idleSince > 6000 && Date.now() - statSync(rootFile).mtimeMs > 6000) { timedOut = false; break; }
}
ws.close();
const metrics = JSON.parse(execSync(`node ${join(import.meta.dirname, 'orchmetrics.mjs')} ${ud} ${chat} ${sentAt}`, { encoding: 'utf8' }));
const row = { tag, sentAt, load, chip: chipLabel, sandbox, timedOut, ...metrics };
console.log(JSON.stringify(row));
if (logFile) { appendFileSync(logFile, JSON.stringify(row) + '\n'); }
