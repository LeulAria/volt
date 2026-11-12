// Hotel code-intelligence A/B, round 2: each question runs in both arms at the same time
// (arm 1 = headless Claude Code without Volt, arm 2 = a Volt dev window over CDP), so load drift
// hits both. Derived from /tmp/vbench-gt/arm1.mjs and arm2.mjs (round 1).
//
//   node ab.mjs <outDir> <tag> <ids comma|all> [runs=3] [port=9946] [ud=/tmp/v2-ide-ud]
//
// Writes <outDir>/<arm>/<Q>-<tag>-r<n>.{answer.md,…} and <outDir>/summary.jsonl (one row per arm run).
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageFor } from './usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire('/Users/leularia/Desktop/VOLT/volt-e2e-ide/package.json');
const CDP = require('chrome-remote-interface');
const [outDir, tag, ids = 'all', runsArg = '3', port = '9946', ud = '/tmp/v2-ide-ud'] = process.argv.slice(2);
const ARMS = (process.env.ARMS ?? '1,2').split(',');
const TR = `${ud}/User/voltTraces`;
const HOTEL = '/private/tmp/vbench-hotel';
const qs = JSON.parse(fs.readFileSync(`${HERE}/questions.json`, 'utf8')).filter(q => ids === 'all' || ids.split(',').includes(q.id));
const SUFFIX = '\n\nAnswer concisely with file:line references. This is a read-only question: do not modify any files.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = () => execFileSync('uptime').toString().trim().replace(/.*load averages?: /, '');
for (const a of ['arm1', 'arm2']) {
	fs.mkdirSync(`${outDir}/${a}`, { recursive: true });
}
const record = row => { fs.appendFileSync(`${outDir}/summary.jsonl`, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ arm: row.arm, id: row.id, run: row.run, wallS: Math.round(row.wallMs / 100) / 10, cost: row.cost, calls: row.toolCalls, volt: row.voltCalls, load: row.load })); };
const voltCalls = tools => Object.entries(tools).filter(([k]) => /^mcp__volt__/.test(k)).reduce((a, [, v]) => a + v, 0);

function arm1(q, run) {
	return new Promise(resolve => {
		const t0 = Date.now();
		const loadAt = load();
		const p = spawn('claude', ['-p', q.q + SUFFIX, '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', `--mcp-config=${HERE}/empty-mcp.json`, '--allowedTools', 'Bash,Read,Grep,Glob,Task,Agent,LS'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: HOTEL, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
		let buf = '';
		const lines = [];
		p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
		p.stderr.on('data', () => { });
		p.on('close', () => {
			const ev = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
			const tools = {};
			for (const e of ev) {
				if (e.type === 'assistant') {
					for (const c of e.message?.content ?? []) {
						if (c.type === 'tool_use') { tools[c.name] = (tools[c.name] ?? 0) + 1; }
					}
				}
			}
			const res = ev.find(e => e.type === 'result') ?? {};
			const mu = Object.values(res.modelUsage ?? {});
			const sum = k => mu.reduce((a, m) => a + (m[k] ?? 0), 0);
			const base = `${outDir}/arm1/${q.id}-${tag}-r${run}`;
			fs.writeFileSync(`${base}.jsonl`, lines.join('\n'));
			fs.writeFileSync(`${base}.answer.md`, res.result ?? '(no result)');
			const toolCalls = Object.values(tools).reduce((a, b) => a + b, 0);
			resolve({ arm: 1, id: q.id, tag, run, load: loadAt, wallMs: Date.now() - t0, turns: res.num_turns, cost: res.total_cost_usd, input: sum('inputTokens'), cacheWrite: sum('cacheCreationInputTokens'), cacheRead: sum('cacheReadInputTokens'), output: sum('outputTokens'), toolCalls, voltCalls: 0, tools });
		});
	});
}

async function page() {
	const t = (await CDP.List({ port: +port })).find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	return CDP({ port: +port, target: t });
}
async function ev(c, expr) { return (await c.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true })).result.value; }
const traces = () => new Set((fs.existsSync(TR) ? fs.readdirSync(TR) : []).filter(f => f.endsWith('.jsonl') && f.startsWith('agent-')));
const parse = file => fs.readFileSync(`${TR}/${file}`, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

async function arm2(q, run) {
	const loadAt = load();
	const c = await page();
	await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 4 });
	await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 4 });
	await sleep(1500);
	if (process.env.ACCESS === 'full') {
		execFileSync('node', [`${HERE}/setfull.mjs`, port]);
	}
	const ok = await ev(c, `(() => { const t=[...document.querySelectorAll('.agent-composer textarea, textarea.inputarea, .native-edit-context')].filter(e=>e.offsetParent).at(-1); if(!t) return false; t.focus(); return true; })()`);
	if (!ok) { await c.close(); return { arm: 2, id: q.id, tag, run, error: 'no composer' }; }
	const before = traces();
	await c.Input.insertText({ text: q.q + SUFFIX });
	await sleep(400);
	const t0 = Date.now();
	await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
	await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await c.close();
	let file;
	while (!file && Date.now() - t0 < 120_000) { await sleep(700); file = [...traces()].find(f => !before.has(f)); }
	if (!file) { return { arm: 2, id: q.id, tag, run, error: 'no trace' }; }
	let metrics;
	let approvals = 0;
	while (Date.now() - t0 < 900_000) {
		await sleep(1000);
		try {
			const c2 = await page();
			if (await ev(c2, `(() => { const b=[...document.querySelectorAll('a,button,.monaco-button')].find(e=>e.offsetParent && /^Always Run/.test(e.innerText?.trim()||'')); if(!b) return false; b.click(); return true; })()`)) { approvals++; }
			await c2.close();
		} catch { }
		const m = parse(file).filter(x => x.kind === 'metrics').at(-1);
		if (m) { metrics = m.metrics; break; }
	}
	const wallMs = Date.now() - t0;
	const L = parse(file);
	const starts = new Map();
	const titles = new Map();
	let text = '';
	for (const x of L) {
		const e = x.event;
		if (!e) { continue; }
		if (e.type === 'tool.start') { starts.set(e.callId, e.name || ''); text = ''; }
		if (e.type === 'tool.update' && e.title && !titles.has(e.callId)) { titles.set(e.callId, e.title); }
		if (e.type === 'text.end' && typeof e.delta === 'string') { text += e.delta + '\n'; }
	}
	const base = `${outDir}/arm2/${q.id}-${tag}-r${run}`;
	fs.copyFileSync(`${TR}/${file}`, `${base}.trace.jsonl`);
	fs.writeFileSync(`${base}.answer.md`, text);
	fs.writeFileSync(`${base}.tools.txt`, [...starts].map(([id, n]) => `${n} | ${titles.get(id) ?? ''}`).join('\n'));
	const u = usageFor(q.q.slice(0, 80), t0 - 5000);
	const { toolUses, ...usage } = u;
	const toolCalls = Object.values(toolUses).reduce((a, b) => a + b, 0);
	return { arm: 2, id: q.id, tag, run, load: loadAt, chat: file, wallMs, totalMs: metrics?.totalMs, outcome: metrics?.outcome, approvals, cost: usage.cost, input: usage.input, cacheWrite: usage.cacheWrite1h + usage.cacheWrite5m, cacheRead: usage.cacheRead, output: usage.output, transcripts: usage.files, toolCalls, voltCalls: voltCalls(toolUses), tools: toolUses };
}

const runs = Number(runsArg);
for (let run = 1; run <= runs; run++) {
	for (const q of qs) {
		const jobs = [];
		if (ARMS.includes('1')) { jobs.push(arm1(q, run).then(record)); }
		if (ARMS.includes('2')) { jobs.push(arm2(q, run).then(record)); }
		await Promise.all(jobs);
		await sleep(1500);
	}
}
