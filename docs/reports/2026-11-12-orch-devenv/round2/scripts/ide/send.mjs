// Send one prompt to a new Volt chat over CDP and wait for the run to end.
//   node send.mjs <port> <ud> <prompt> [--full] [--same-chat]
// Prints a JSON line: chat trace file, wall time, tool calls (name | title), the answer text.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire('/Users/leularia/Desktop/VOLT/volt-e2e-ide/package.json');
const CDP = require('chrome-remote-interface');
const args = process.argv.slice(2);
const [port, ud, prompt] = args.filter(a => !a.startsWith('--'));
const TR = `${ud}/User/voltTraces`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = async () => CDP({ port: +port, target: (await CDP.List({ port: +port })).find(t => t.type === 'page' && /workbench/.test(t.url) && t.title) });
const ev = async (c, e) => (await c.Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: true })).result.value;
const traces = () => new Set((fs.existsSync(TR) ? fs.readdirSync(TR) : []).filter(f => f.endsWith('.jsonl') && f.startsWith('agent-')));
const parse = f => fs.readFileSync(`${TR}/${f}`, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const c = await page();
if (!args.includes('--same-chat')) {
	await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 4 });
	await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 4 });
	await sleep(1500);
}
if (args.includes('--full')) {
	console.error(execFileSync('node', [`${HERE}/setfull.mjs`, port]).toString().trim());
}
await ev(c, `(() => { const t=[...document.querySelectorAll('.agent-composer textarea, textarea.inputarea, .native-edit-context')].filter(e=>e.offsetParent).at(-1); t?.focus(); })()`);
const before = traces();
const sizes = Object.fromEntries([...before].map(f => [f, fs.statSync(`${TR}/${f}`).size]));
await c.Input.insertText({ text: prompt });
await sleep(400);
const t0 = Date.now();
await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.close();
let file;
while (!file && Date.now() - t0 < 120_000) {
	await sleep(700);
	const now = traces();
	file = [...now].find(f => !before.has(f)) ?? (args.includes('--same-chat') ? [...now].find(f => fs.statSync(`${TR}/${f}`).size !== sizes[f]) : undefined);
}
const startLine = file && args.includes('--same-chat') ? parse(file).length : 0;
let done = false;
let approvals = 0;
while (file && !done && Date.now() - t0 < 900_000) {
	await sleep(1000);
	try {
		const c2 = await page();
		if (!process.env.NO_APPROVE && await ev(c2, `(() => { const b=[...document.querySelectorAll('a,button,.monaco-button')].find(e=>e.offsetParent && /^(Always Run|Always Allow)$/.test(e.innerText?.trim()||'')); if(!b) return false; b.click(); return true; })()`)) { approvals++; }
		await c2.close();
	} catch { }
	done = parse(file).slice(startLine).some(x => x.kind === 'metrics');
}
const L = parse(file).slice(startLine);
const starts = new Map();
const titles = new Map();
const results = new Map();
let text = '';
for (const x of L) {
	const e = x.event;
	if (!e) { continue; }
	if (e.type === 'tool.start') { starts.set(e.callId, e.name || ''); text = ''; }
	if (e.type === 'tool.update' && e.title && !titles.has(e.callId)) { titles.set(e.callId, e.title); }
	if (e.type === 'tool.end' || e.type === 'tool.result') { results.set(e.callId, JSON.stringify(e).slice(0, 400)); }
	if (e.type === 'text.end' && typeof e.delta === 'string') { text += e.delta + '\n'; }
}
const m = L.filter(x => x.kind === 'metrics').at(-1)?.metrics;
console.log(JSON.stringify({ chat: file, wallMs: Date.now() - t0, totalMs: m?.totalMs, outcome: m?.outcome, approvals, tools: [...starts].map(([id, n]) => `${n} | ${titles.get(id) ?? ''}`), answer: text.trim() }));
