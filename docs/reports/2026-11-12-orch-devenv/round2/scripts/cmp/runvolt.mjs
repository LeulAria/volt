// The Volt arm of the cross-harness bench, in one script so it can be re-run on newer code.
//   node runvolt.mjs launch [--checkout <volt checkout>]   start the dev test instance (CDP 9941)
//   node runvolt.mjs run <arm> <task t0..t3> <rep>          one run in a new chat
//   node runvolt.mjs stop                                   quit it and kill its agent server
// Arms: volt (Claude Code harness, Haiku 5.5 parent and subagents), volt-cursor-sonnet,
// volt-cursor-grok (Cursor harness, same model for subagents). Env: VOLT_UD (default
// /tmp/v2-cmp-ud), VOLT_EXT, VOLT_CDP (9941), CMP_DATA.
// Numbers come from <ud>/User/voltTraces/<chat>.jsonl (root + delegated children) and the saved
// task tree <ud>/User/voltOrchestrator/roots/<chat>.json.
import { execSync, spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, openSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildPrompt } from './runcli.mjs';
import { resetFixture, scoreT1, scoreT2, scoreT3 } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CMP_DATA ?? join(here, '../../data/cmp');
const UD = process.env.VOLT_UD ?? '/tmp/v2-cmp-ud';
const EXT = process.env.VOLT_EXT ?? '/tmp/v2-cmp-ext';
const PORT = Number(process.env.VOLT_CDP ?? 9941);
const USER = join(UD, 'User');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ARMS = {
	volt: { model: 'agent:seed-claude-code:claude-haiku-5-5', sub: 'agent:seed-claude-code:claude-haiku-5-5', label: /Haiku 5\.5/ },
	// The same arm on changed code (a re-run after fixes): rows are kept apart from the baseline.
	'volt-after': { model: 'agent:seed-claude-code:claude-haiku-5-5', sub: 'agent:seed-claude-code:claude-haiku-5-5', label: /Haiku 5\.5/, settings: { 'volt.agent.multitask.warmSubagents': true } },
	// The same changed code with subagent warming off (interleaved with volt-after: same load).
	'volt-after-cold': { model: 'agent:seed-claude-code:claude-haiku-5-5', sub: 'agent:seed-claude-code:claude-haiku-5-5', label: /Haiku 5\.5/, settings: { 'volt.agent.multitask.warmSubagents': false } },
	// Cursor's catalog in Volt (from its ACP model list): base ids, effort/thinking are options.
	'volt-cursor-sonnet': { model: 'agent:seed-cursor-acp:claude-sonnet-5', sub: 'agent:seed-cursor-acp:claude-sonnet-5', label: /Sonnet 5(?!\.)/ },
	'volt-cursor-grok': { model: 'agent:seed-cursor-acp:grok-4.7', sub: 'agent:seed-cursor-acp:grok-4.7', label: /Grok 4\.7/ },
	// Cursor arms on the changed code (Cursor's ai-tracking database writable in the sandbox, warm subagents).
	'volt-cursor-sonnet-after': { model: 'agent:seed-cursor-acp:claude-sonnet-5', sub: 'agent:seed-cursor-acp:claude-sonnet-5', label: /Sonnet 5(?!\.)/ },
	'volt-cursor-grok-after': { model: 'agent:seed-cursor-acp:grok-4.7', sub: 'agent:seed-cursor-acp:grok-4.7', label: /Grok 4\.7/ },
};

function writeSettings(model, extra = {}) {
	mkdirSync(USER, { recursive: true });
	const file = join(USER, 'settings.json');
	let s = {};
	try {
		s = JSON.parse(readFileSync(file, 'utf8'));
	} catch { }
	Object.assign(s, {
		'volt.agent.defaultModel': model,
		'window.dialogStyle': 'custom',
		'workbench.startupEditor': 'none',
		'security.workspace.trust.enabled': false,
		'update.mode': 'none',
		'telemetry.telemetryLevel': 'off',
		'volt.agent.multitask.warmSubagents': true,
	}, extra);
	writeFileSync(file, JSON.stringify(s, null, '\t'));
}

async function cdp() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	if (!page) {
		throw new Error('no workbench target');
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let id = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	const click = async (x, y) => {
		for (const type of ['mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
		}
	};
	const center = async script => evaluate(`(() => { const e = ${script}; if (!e) { return undefined; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	return { ws, send, evaluate, click, center, close: () => ws.close() };
}

async function launch() {
	const checkout = process.argv.includes('--checkout') ? process.argv[process.argv.indexOf('--checkout') + 1] : join(here, '../../../../../..');
	writeSettings(ARMS.volt.model);
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const log = openSync('/tmp/vcmp/volt-dev.log', 'a');
	const child = spawn('./scripts/code.sh', ['--user-data-dir', UD, '--extensions-dir', EXT, `--remote-debugging-port=${PORT}`,
		'--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '/tmp/vcmp/w'],
		{ cwd: checkout, env: { ...env, VSCODE_SKIP_PRELAUNCH: '1' }, detached: true, stdio: ['ignore', log, log] });
	child.unref();
	const t0 = Date.now();
	for (let i = 0; i < 120; i++) {
		await sleep(1000);
		try {
			const c = await cdp();
			const ok = await c.evaluate('document.readyState === "complete" && !!document.querySelector(".monaco-workbench")');
			c.close();
			if (ok) {
				console.log(JSON.stringify({ launched: true, pid: child.pid, ms: Date.now() - t0, checkout }));
				return;
			}
		} catch { }
	}
	throw new Error('test instance did not come up');
}

function readTrace(id) {
	const file = join(USER, 'voltTraces', `${id}.jsonl`);
	if (!existsSync(file)) {
		return [];
	}
	return readFileSync(file, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
}

function readTree(id) {
	const file = join(USER, 'voltOrchestrator', 'roots', `${id}.json`);
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** Cost and tokens of one chat's runs (Claude's reported cost is cumulative per session). */
function spend(lines) {
	let cost = 0;
	let sessionCost = 0;
	const billed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const events = lines.filter(l => l.kind === 'event');
	for (const runId of new Set(events.map(l => l.runId))) {
		const usage = events.filter(l => l.runId === runId && l.event.type === 'usage');
		const costs = usage.map(l => l.event.costUsd).filter(v => typeof v === 'number');
		if (costs.length) {
			const last = costs.at(-1);
			cost += last >= sessionCost ? last - sessionCost : last;
			sessionCost = last;
		}
		const total = usage.filter(l => l.event.used === undefined).at(-1)?.event;
		const last = usage.filter(l => l.event.billed).at(-1)?.event.billed
			?? (total ? { input: total.input, output: total.output, cacheRead: total.cache, cacheWrite: total.cacheWrite } : undefined);
		if (last) {
			for (const k of Object.keys(billed)) {
				billed[k] += last[k] ?? 0;
			}
		}
	}
	return { cost, billed };
}

function analyze(chat, sentAt) {
	const tree = readTree(chat);
	const root = readTrace(chat);
	const ev = root.filter(l => l.kind === 'event');
	const metrics = root.filter(l => l.kind === 'metrics').map(l => l.metrics);
	const runEnds = ev.filter(l => l.event.type === 'run.end').map(l => l.ts);
	const childIds = (tree?.tasks ?? []).filter(t => t.childId).map(t => t.childId);
	const children = childIds.map(id => ({ id, lines: readTrace(id) }));
	const allEnds = [...runEnds, ...children.flatMap(c => c.lines.filter(l => l.event?.type === 'run.end').map(l => l.ts))];
	const end = Math.max(...allEnds);
	const firstOut = ev.find(l => ['usage', 'text.delta', 'text.end', 'thinking', 'reasoning', 'tool.start'].includes(l.event.type) && l.ts >= sentAt);
	const firstText = ev.find(l => l.event.type === 'text.end');
	const lastRun = ev.filter(l => l.event.type === 'run.start').at(-1)?.runId;
	const finalText = ev.filter(l => l.event.type === 'text.end' && l.runId === lastRun).map(l => l.event.delta ?? '').join('\n').trim();
	const rootSpend = spend(root);
	const childSpend = children.map(c => ({ id: c.id, ...spend(c.lines), metrics: c.lines.filter(l => l.kind === 'metrics').map(l => l.metrics) }));
	const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const s of [rootSpend, ...childSpend]) {
		for (const k of Object.keys(sum)) {
			sum[k] += s.billed[k];
		}
	}
	const tasks = (tree?.tasks ?? []).map(t => ({ id: t.id, title: t.title, state: t.state, createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt, after: t.after, kind: t.kind, source: t.source, model: t.model }));
	const delegateCalls = ev.filter(l => l.event.type === 'host.tool' && /delegate_task|message_task/.test(l.event.name)).map(l => ({ name: l.event.name, at: l.ts - sentAt }));
	return {
		chat,
		wallMs: end - sentAt,
		ttftMs: firstOut ? firstOut.ts - sentAt : null,
		firstTextEndMs: firstText ? firstText.ts - sentAt : null,
		parentRuns: metrics.length,
		parentMetrics: metrics.map(m => ({ agentSource: m.agentSource, preparedMs: m.preparedMs, agentReadyMs: m.agentReadyMs, promptMs: m.promptMs, firstEventMs: m.firstEventMs, firstTextMs: m.firstTextMs, totalMs: m.totalMs, startedAt: m.startedAt - sentAt, requests: m.usage?.requests, maxRequestInput: m.usage?.maxRequestInput, tools: m.tools?.count, slowestTool: m.tools?.slowest })),
		children: childSpend.map(c => ({ id: c.id, costUsd: c.cost, billed: c.billed, metrics: c.metrics.map(m => ({ agentSource: m.agentSource, preparedMs: m.preparedMs, agentReadyMs: m.agentReadyMs, firstEventMs: m.firstEventMs, firstTextMs: m.firstTextMs, totalMs: m.totalMs, startedAt: m.startedAt - sentAt, requests: m.usage?.requests, maxRequestInput: m.usage?.maxRequestInput, tools: m.tools?.count })) })),
		tasks: tasks.map(t => ({ ...t, createdAt: t.createdAt && t.createdAt - sentAt, startedAt: t.startedAt && t.startedAt - sentAt, endedAt: t.endedAt && t.endedAt - sentAt })),
		delegateCalls,
		subagents: tasks.length,
		sandboxDenials: ev.filter(l => l.event.type === 'sandbox.denial').length,
		approvals: ev.filter(l => l.event.type === 'access.ask').length,
		costUsd: rootSpend.cost + childSpend.reduce((a, c) => a + c.cost, 0),
		parentCostUsd: rootSpend.cost,
		usage: sum,
		finalText,
	};
}

async function newChat(c) {
	// New chat: the "New Chat"/"New Agent" button of the agent window.
	const ok = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))); if (!e) { return false; } e.click(); return true; })()`);
	if (!ok) {
		throw new Error('no New Chat button');
	}
	await sleep(1500);
	// Measure the orchestration, not a person approving: Full access for this chat.
	const chip = await c.center(`[...document.querySelectorAll('[aria-label^="Permissions:"], button.volt-agent-status-access')].find(e => e.offsetParent)`);
	let access = 'unchanged';
	if (chip) {
		await c.click(...chip);
		await sleep(500);
		const item = await c.center(`[...document.querySelectorAll('*')].filter(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === 'Full access').at(-1)`);
		if (item) {
			await c.click(...item);
			await sleep(500);
			access = 'full';
		}
	}
	const label = await c.evaluate(`(() => [...document.querySelectorAll('button.volt-agent-status-access')].find(e => e.offsetParent)?.textContent ?? '')()`);
	const model = await c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-model-label')].filter(e => e.offsetParent).at(-1)?.textContent ?? '')()`);
	return { access, label, model };
}

async function run(arm, task, rep) {
	const a = ARMS[arm];
	resetFixture(task);
	writeSettings(a.model, a.settings);
	await sleep(800);
	const prompt = buildPrompt('volt', task, a.sub);
	const c = await cdp();
	const traces = join(USER, 'voltTraces');
	mkdirSync(traces, { recursive: true });
	const before = new Set(readdirSync(traces));
	const sessionsDir = join(USER, 'agentSessions', 'sessions');
	mkdirSync(sessionsDir, { recursive: true });
	const beforeSessions = new Set(readdirSync(sessionsDir));
	const access = await newChat(c);
	// The new chat starts on volt.agent.defaultModel once the catalog has it: wait for the chip to say so.
	for (let i = 0; i < 20 && !a.label.test(access.model); i++) {
		await sleep(250);
		access.model = await c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-model-label')].filter(e => e.offsetParent).at(-1)?.textContent ?? '')()`);
	}
	const focused = await c.evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } t.focus(); return true; })()`);
	if (!focused) {
		throw new Error('no composer');
	}
	await c.send('Input.insertText', { text: prompt });
	await sleep(300);
	const load = execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
	const composerText = () => c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-composer .view-lines, .monaco-editor .view-lines')].filter(e => e.offsetParent).at(-1)?.textContent ?? '')()`);
	const enter = async () => {
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	};
	const sentAt = Date.now();
	await enter();
	let chat;
	let resent = 0;
	// The chat's trace is written when a run ends, so a long first turn has none yet: the new chat is the
	// new session file (agentSessions/sessions/<id>.jsonl) whose header is not a subagent's.
	const newRootSession = () => readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl') && !beforeSessions.has(n)).find(n => {
		try {
			return !JSON.parse(readFileSync(join(sessionsDir, n), 'utf8').split('\n')[0]).parentId;
		} catch {
			return false;
		}
	})?.replace(/\.jsonl$/, '');
	for (let i = 0; i < 240 && !chat; i++) {
		await sleep(250);
		chat = newRootSession() ?? readdirSync(traces).find(n => !before.has(n) && n.endsWith('.jsonl'))?.replace(/\.jsonl$/, '');
		// The Enter did not send (the composer still holds the prompt): send once more and say so in the row.
		if (!chat && i === 12 && !resent && (await composerText()).includes(prompt.slice(0, 40))) {
			resent = Date.now() - sentAt;
			await enter();
		}
	}
	if (!chat) {
		const shot = await c.send('Page.captureScreenshot', { format: 'png' });
		mkdirSync(join(DATA, 'raw'), { recursive: true });
		writeFileSync(join(DATA, 'raw', `${arm}-${task}-${rep}.nochat.png`), Buffer.from(shot.result.data, 'base64'));
		c.close();
		throw new Error(`no new chat trace (composer: ${(await composerText().catch(() => '')).slice(0, 80)})`);
	}
	if (resent) {
		access.resentAfterMs = resent;
	}
	// Done: the root chat ran at least once and nothing in its tree runs, is queued or undelivered, for 6 s.
	const deadline = sentAt + 10 * 60_000;
	let idleSince = 0;
	let timedOut = true;
	while (Date.now() < deadline) {
		await sleep(1000);
		const ev = readTrace(chat).filter(l => l.kind === 'event');
		const starts = ev.filter(l => l.event.type === 'run.start').length;
		const ends = ev.filter(l => l.event.type === 'run.end').length;
		const tree = readTree(chat);
		const busy = starts === 0 || starts > ends
			|| (tree && (tree.threads.some(t => t.active || t.queue?.length || t.inputs?.length)
				|| tree.tasks.some(t => ['queued', 'running', 'waiting'].includes(t.state) || t.delivery === 'pending')));
		if (busy) {
			idleSince = 0;
			continue;
		}
		idleSince ||= Date.now();
		if (Date.now() - idleSince > 6000) {
			timedOut = false;
			break;
		}
	}
	c.close();
	const r = analyze(chat, sentAt);
	let score;
	if (task === 't0') {
		score = { ok: /^\s*OK\s*\.?\s*$/.test(r.finalText) };
	} else if (task === 't1') {
		score = scoreT1(r.finalText);
	} else if (task === 't2') {
		score = scoreT2();
	} else {
		score = scoreT3();
	}
	const id = `${arm}-${task}-${rep}`;
	mkdirSync(join(DATA, 'raw'), { recursive: true });
	// Keep the traces of this run (root + children) next to the row.
	const rawTraces = [chat, ...r.children.map(ch => ch.id)].map(cid => ({ chat: cid, lines: readTrace(cid) }));
	writeFileSync(join(DATA, 'raw', `${id}.traces.json`), JSON.stringify({ tree: readTree(chat), traces: rawTraces }));
	const row = { id, arm, task, rep: Number(rep), at: new Date(sentAt).toISOString(), load, access, timedOut, ...r, finalText: r.finalText.slice(0, 2000), score };
	appendFileSync(join(DATA, 'runs.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ id, wallMs: r.wallMs, ttftMs: r.ttftMs, costUsd: r.costUsd, usage: r.usage, subagents: r.subagents, score, timedOut, load, access }));
}

async function stop() {
	try {
		const c = await cdp();
		// Cmd+Q runs workbench.action.quit (saves state), unlike a signal.
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 });
		c.close();
	} catch { }
	await sleep(4000);
	// The agent server outlives the window: kill only the one started for this profile.
	const ps = execSync('ps -axo pid=,command=').toString().split('\n').filter(l => l.includes(`--user-data-dir ${UD}`) || l.includes(`--user-data-dir=${UD}`));
	for (const l of ps) {
		const pid = Number(l.trim().split(/\s+/)[0]);
		console.log('kill', pid, l.trim().slice(0, 160));
		try { process.kill(pid, 'SIGTERM'); } catch { }
	}
	const labels = execSync(`launchctl list | grep com.volt.agent-server || true`).toString();
	console.log('launchd agent servers (check for this profile):', labels.trim() || 'none');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'launch') {
	await launch();
} else if (cmd === 'run') {
	await run(...rest);
} else if (cmd === 'stop') {
	await stop();
} else if (cmd === 'recover') {
	// A run the rig gave up on too early (no trace yet) that Volt finished: score it from its saved
	// chat, with the send time taken as the root chat's creation in the task tree (read-only tasks only).
	const [arm, task, rep, chat] = rest;
	const tree = readTree(chat);
	const sentAt = tree.events.find(e => e.event.type === 'thread.created' && e.event.thread.id === chat).at;
	const r = analyze(chat, sentAt);
	const score = task === 't0' ? { ok: /^\s*OK\s*\.?\s*$/.test(r.finalText) } : scoreT1(r.finalText);
	const id = `${arm}-${task}-${rep}`;
	writeFileSync(join(DATA, 'raw', `${id}.traces.json`), JSON.stringify({ tree, traces: [chat, ...r.children.map(ch => ch.id)].map(cid => ({ chat: cid, lines: readTrace(cid) })) }));
	const row = { id, arm, task, rep: Number(rep), at: new Date(sentAt).toISOString(), load: 'n/r (recovered)', recovered: true, timedOut: false, ...r, finalText: r.finalText.slice(0, 2000), score };
	appendFileSync(join(DATA, 'runs.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ id, wallMs: r.wallMs, costUsd: r.costUsd, subagents: r.subagents, score }));
} else {
	console.log('usage: runvolt.mjs launch|run <arm> <task> <rep>|stop');
}
