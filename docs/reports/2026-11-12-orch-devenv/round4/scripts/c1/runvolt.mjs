// ADEMark C1 (Orchestrated Build) on Volt, ADEMark method, unofficial.
//   node runvolt.mjs launch --checkout <volt checkout>     start the test instance (CDP VOLT_CDP, profile VOLT_UD)
//   node runvolt.mjs run <id> [--model <ref>]              one C1 run in a fresh arena clone
//   node runvolt.mjs stop                                  quit the instance, kill its processes (matched on VOLT_UD)
// The instance's Claude Code processes use a clean config dir (cfg-clean: the live login's access token only, no
// user settings, MCP, skills or memory, like ADEMark's fresh `ademark` user) and send every model request through
// proxy.mjs (ANTHROPIC_BASE_URL). Volt's sandbox would refuse that loopback port, so the profile's sandbox default
// is Off and the access default Full access (ADEMark's pin: full access in its worktree), for the lead and for every
// subagent, on both builds alike.
// A run: a fresh clone of the arena (on main) becomes the chat's project; the trigger line and the C1 prompt (with the
// run's handoff codes, byte for byte) are typed into a new chat; t0 is taken just before Enter. The end follows
// TESTS.md 4 (since 2026-11-11): after the first end of turn, the run is over when no request answered a tool for 5
// minutes; the end time is the last tool answer (or the first end of turn when none followed). Cap 45 min.
import { execSync, spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import { grade } from './grade.mjs';
import { agentsSeen, ARENA_BASE, CAP_MS, CFG, DATA, fanOut, here, loadAvg, PROXY, QUIET_MS, readJsonl, rowsBetween, RUNS, seedFor, sessionIntervals, sleep, taskPrompt, tokensOf, usdOf } from './common.mjs';

const UD = process.env.VOLT_UD ?? '/tmp/v4-c1-ud';
const EXT = process.env.VOLT_EXT ?? `${UD}-ext`;
const PORT = Number(process.env.VOLT_CDP ?? 9948);
const USER = join(UD, 'User');
const opt = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;

async function cdp() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	if (!page) { throw new Error('no workbench target'); }
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let n = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	const key = async (key, code, vk, modifiers = 0) => {
		await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
	};
	return { send, evaluate, key, close: () => ws.close() };
}

function writeSettings(extra = {}) {
	mkdirSync(USER, { recursive: true });
	const file = join(USER, 'settings.json');
	let s = {};
	try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { }
	Object.assign(s, {
		'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
		'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
	}, extra);
	writeFileSync(file, JSON.stringify(s, null, '\t'));
}

/**
 * The runtime's application storage (the agent server's `application.vscdb`; the instance must not run): sandbox
 * default Off with no chat pins, access default Full access. Effort High for Opus 5.5 is picked once in the model
 * picker (Edit > Effort > High) and is kept there as `volt.runtime.modelOptions`; this prints it to check.
 */
function writeStorage() {
	const db = join(UD, 'agentServer', 'application.vscdb');
	if (!existsSync(db)) { return false; }
	const q = sql => execSync(`sqlite3 ${JSON.stringify(db)} ${JSON.stringify(sql)}`).toString().trim();
	const put = (key, value) => q(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${key}', '${value.replace(/'/g, "''")}')`);
	put('volt.runtime.sandbox', JSON.stringify({ v: 2, defaults: { level: 'off', network: true }, chats: {} }));
	put('volt.runtime.accessMode', 'full-access');
	console.log(q(`SELECT key || ' = ' || value FROM ItemTable WHERE key IN ('volt.runtime.sandbox', 'volt.runtime.accessMode', 'volt.runtime.modelOptions')`));
	return true;
}

async function launch() {
	const checkout = opt('--checkout', join(here, '../../../../../..'));
	writeSettings({ 'volt.agent.defaultModel': opt('--model', 'agent:seed-claude-code:claude-opus-5-5') });
	const env = {
		HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, SHELL: process.env.SHELL ?? '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR,
		PATH: process.env.PATH, VSCODE_SKIP_PRELAUNCH: '1', CLAUDE_CONFIG_DIR: CFG, ANTHROPIC_BASE_URL: PROXY,
	};
	const log = openSync(join(UD + '-dev.log'), 'a');
	const child = spawn('./scripts/code.sh', ['--user-data-dir', UD, '--extensions-dir', EXT, `--remote-debugging-port=${PORT}`,
		'--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'],
		{ cwd: checkout, env, detached: true, stdio: ['ignore', log, log] });
	child.unref();
	const t0 = Date.now();
	for (let i = 0; i < 180; i++) {
		await sleep(1000);
		try {
			const c = await cdp();
			const ok = await c.evaluate('document.readyState === "complete" && !!document.querySelector(".monaco-workbench")');
			c.close();
			if (ok) { console.log(JSON.stringify({ launched: true, pid: child.pid, ms: Date.now() - t0, checkout })); return; }
		} catch { }
	}
	throw new Error('test instance did not come up');
}

const readTrace = chat => readJsonl(join(USER, 'voltTraces', `${chat}.jsonl`));
const readTree = chat => { try { return JSON.parse(readFileSync(join(USER, 'voltOrchestrator', 'roots', `${chat}.json`), 'utf8')); } catch { return undefined; } };

/** The new chat's project: the landing's project picker; its search opens any folder by path. */
async function pickProject(c, folder) {
	const name = folder.split('/').at(-1);
	const shown = () => c.evaluate(`(() => [...document.querySelectorAll('*')].some(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(name)} && /label|project/.test(e.className)))()`);
	const opened = await c.evaluate(`(() => { const e = [...document.querySelectorAll('button.volt-agent-landing-pick')].filter(e => e.offsetParent && e.querySelector('.label')).at(0); if (!e) { return false; } e.click(); return true; })()`);
	if (!opened) { throw new Error('no project picker'); }
	await sleep(800);
	await c.evaluate(`(() => { const i = [...document.querySelectorAll('input')].filter(e => e.offsetParent && /search projects/i.test(e.placeholder)).at(-1); i?.focus(); i?.select(); return !!i; })()`);
	await c.send('Input.insertText', { text: folder });
	await sleep(1500);
	const picked = await c.evaluate(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && (e.getAttribute('aria-label') ?? '').endsWith(${JSON.stringify(folder)})).at(-1) ?? [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /^Open /.test(e.textContent.trim())).at(-1); r?.click(); return !!r; })()`);
	await sleep(1500);
	if (!picked || !await shown()) { throw new Error(`could not pick the project ${folder}`); }
}

/**
 * The model for the chat (ADEMark's pin: Opus 5.5, high effort): a new chat starts on the last chat's model, so the
 * picker's row is clicked; its label carries the effort the model is set to ("Opus 5.5 High").
 */
async function pickModel(c, rowLabel) {
	const chipText = () => c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-model')].filter(e => e.offsetParent).at(-1)?.textContent.replace(/\\s+/g, ' ').trim() ?? '')()`);
	// The chip's model and effort are two spans with no space between them.
	const same = text => text.replace(/\s+/g, '') === rowLabel.replace(/\s+/g, '');
	if (same(await chipText())) { return rowLabel; }
	await c.evaluate(`(() => { [...document.querySelectorAll('.volt-agent-model')].filter(e => e.offsetParent).at(-1)?.click(); })()`);
	await sleep(1200);
	const at = await c.evaluate(`(() => { const e = [...document.querySelectorAll('.monaco-list-row *')].filter(e => e.offsetParent && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === ${JSON.stringify(rowLabel)})).at(0); if (!e) { return null; } const r = e.getBoundingClientRect(); return [r.x + 20, r.y + r.height / 2]; })()`);
	if (!at) { throw new Error(`no model row ${rowLabel}`); }
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await c.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
	}
	await sleep(1000);
	const shown = await chipText();
	if (!same(shown)) { throw new Error(`model chip shows "${shown}", not "${rowLabel}"`); }
	return shown;
}

/** What the chat shows under the composer: model, access, sandbox. */
const chips = c => c.evaluate(`(() => ({ model: [...document.querySelectorAll('.volt-agent-model-label')].filter(e => e.offsetParent).map(e => e.textContent.trim()), access: [...document.querySelectorAll('button.volt-agent-status-access')].filter(e => e.offsetParent).map(e => e.getAttribute('aria-label') + ' / ' + (e.dataset.mode ?? '')) }))()`);

function workTree(repo) {
	// Every cwd whose git common dir is the arena clone's .git: the clone and every worktree of it.
	const cache = new Map();
	const gitDir = realpathSync(join(repo, '.git'));
	return cwd => {
		if (!cache.has(cwd)) {
			let ok = cwd.startsWith(repo);
			try { ok ||= realpathSync(execSync(`git -C ${JSON.stringify(cwd)} rev-parse --path-format=absolute --git-common-dir`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) === gitDir; } catch { }
			cache.set(cwd, ok);
		}
		return cache.get(cwd);
	};
}

async function run(id) {
	const repo = join(RUNS, id);
	if (existsSync(repo)) { throw new Error(`${repo} exists`); }
	mkdirSync(DATA, { recursive: true });
	execSync(`git clone -q ${ARENA_BASE} ${repo} && git -C ${repo} remote remove origin`);
	const seed = seedFor(id);
	const trigger = readFileSync(join(here, 'prompts', 'volt-trigger.txt'), 'utf8').replace(/\n$/, '');
	// TASKS.md / tracks/c/c1-orchestrated-build.ts: `${trigger}\n${renderHandoffCodes(task.prompt, seed)}`.
	// --prompt <file>: a rig smoke test only (ids smoke-*), never a C1 row.
	const prompt = opt('--prompt') ? readFileSync(opt('--prompt'), 'utf8') : `${trigger}\n${taskPrompt('orchestrated', seed)}`;
	if (opt('--prompt') && !id.startsWith('smoke')) { throw new Error('--prompt is for smoke-* ids only'); }
	writeFileSync(join(DATA, `${id}.prompt.txt`), prompt);
	const c = await cdp();
	const okNew = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))); if (!e) { return false; } e.click(); return true; })()`);
	if (!okNew) { throw new Error('no New Chat button'); }
	await sleep(1500);
	await pickProject(c, repo);
	await sleep(1000);
	const modelChip = await pickModel(c, opt('--model-row', 'Opus 5.5 High'));
	const shown = { ...await chips(c), modelChip };
	if (!shown.access.some(a => /full-access/.test(a))) { throw new Error(`access is not Full access: ${shown.access}`); }
	const focused = await c.evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } t.focus(); return true; })()`);
	if (!focused) { throw new Error('no composer'); }
	await c.send('Input.insertText', { text: prompt });
	await sleep(600);
	const sessionsDir = join(USER, 'agentSessions', 'sessions');
	mkdirSync(sessionsDir, { recursive: true });
	const before = new Set(readdirSync(sessionsDir));
	const load = loadAvg();
	const t0 = Date.now();
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	let chat;
	for (let i = 0; i < 240 && !chat; i++) {
		await sleep(250);
		chat = readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl') && !before.has(n)).find(n => { try { return !JSON.parse(readFileSync(join(sessionsDir, n), 'utf8').split('\n')[0]).parentId; } catch { return false; } })?.replace(/\.jsonl$/, '');
	}
	c.close();
	if (!chat) { throw new Error('no chat'); }
	const state = { id, chat, repo, seed, t0, load, shown };
	writeFileSync(join(RUNS, `${id}.state.json`), JSON.stringify(state));
	console.log(JSON.stringify(state));
	await finish(state);
}

/** Waits for the end (TESTS.md 4), then grades and writes the row. Re-entrant from the saved state. */
async function finish({ id, chat, repo, seed, t0, load, shown }) {
	const children = () => (readTree(chat)?.tasks ?? []).filter(t => t.childId).map(t => t.childId);
	const firstEnd = () => Math.min(...[chat, ...children()].flatMap(ch => readTrace(ch).filter(l => l.event?.type === 'run.end').map(l => l.ts)));
	const cap = t0 + CAP_MS;
	let first = Infinity;
	let alone = false;
	while (Date.now() < cap) {
		first = firstEnd();
		if (Number.isFinite(first)) { break; }
		// TESTS.md 4: with one agent after 15 minutes the run stops there.
		if (Date.now() - t0 > 15 * 60_000 && agentsSeen(rowsBetween(t0)).agents < 2) { alone = true; break; }
		await sleep(5000);
	}
	let end = Math.min(Date.now(), cap);
	let timedOut = !Number.isFinite(first) && !alone;
	if (Number.isFinite(first)) {
		for (;;) {
			const last = Math.max(first, agentsSeen(rowsBetween(t0)).lastWorkMs ?? 0);
			if (last > cap) { timedOut = true; end = cap; break; }
			if (Date.now() - last >= QUIET_MS) { end = last; break; }
			await sleep(10_000);
		}
	}
	const rows = rowsBetween(t0, end);
	const after = rowsBetween(end + 1).filter(r => r.meta?.answersTool && r.t < end + QUIET_MS + 120_000);
	const seen = agentsSeen(rows);
	const tokens = tokensOf(rows);
	const usd = usdOf(rows);
	const tree = readTree(chat);
	const traces = [{ chat, lines: readTrace(chat) }, ...children().map(ch => ({ chat: ch, lines: readTrace(ch) }))];
	const intervals = sessionIntervals(CFG, t0, workTree(repo)).filter(s => s.start <= end);
	const fan = fanOut(intervals.filter(s => s.cwd !== repo));
	const graded = grade(repo, seed);
	const mainModel = rows.find(r => r.meta?.task)?.model ?? null;
	const efforts = [...new Set(rows.filter(r => r.meta).map(r => `${r.model}:${r.meta.effort ?? '-'}:${r.meta.thinking ?? '-'}`))];
	const invalid = [
		!rows.length && 'no model request captured',
		seen.agents < 2 && 'one agent did the work alone: the trigger did not start orchestration',
		alone && 'no second agent in the first 15 minutes',
		tokens.noUsage && 'a call has no usage (tokens-total invalid)',
		rows.filter(r => r.meta?.task).at(-1)?.status >= 400 && 'the run ended on a refused request',
	].filter(Boolean);
	const minutes = +((end - t0) / 60_000).toFixed(2);
	const row = {
		id, arm: 'volt', at: new Date(t0).toISOString(), load, chat, shown, timedOut, invalid,
		minutes, timeToGreen: graded.shipped === 5 && !timedOut ? minutes : null,
		shipped: graded.shipped, groups: graded.groups, handoff: graded.handoff, codesPlaced: graded.codesPlaced, npmTest: graded.npmTest,
		tokensTotal: tokens.total, usd: usd?.usd ?? null, tokens, requests: rows.length, afterEnd: after.length,
		agents: seen, fanOut: fan, sessions: intervals.map(s => ({ cwd: s.cwd, start: s.start - t0, end: s.end - t0, sidechain: s.sidechain })),
		mainModel, efforts,
		tasks: (tree?.tasks ?? []).map(t => ({ title: t.title, role: t.role, isolation: t.isolation, state: t.state, model: t.modelLabel ?? t.modelRef, childId: t.childId, startedAt: t.startedAt && t.startedAt - t0, endedAt: t.endedAt && t.endedAt - t0, report: t.result?.length, branch: t.worktree?.branch ?? t.branch })),
	};
	writeFileSync(join(DATA, `${id}.grade.json`), JSON.stringify(graded, null, 1));
	writeFileSync(join(DATA, `${id}.traces.json`), JSON.stringify({ tree, traces }));
	execSync(`gzip -f ${JSON.stringify(join(DATA, `${id}.traces.json`))}`);
	writeFileSync(join(DATA, `${id}.capture.jsonl`), rowsBetween(t0 - 5000, end + QUIET_MS + 120_000).map(r => JSON.stringify(r)).join('\n') + '\n');
	execSync(`gzip -f ${JSON.stringify(join(DATA, `${id}.capture.jsonl`))}`);
	appendFileSync(join(DATA, id.startsWith('smoke') ? 'smoke-runs.jsonl' : 'c1-runs.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ id, minutes, timeToGreen: row.timeToGreen, shipped: `${graded.shipped}/5`, handoff: `${graded.handoff}/4`, placed: `${graded.codesPlaced}/4`, tokensTotal: tokens.total, usd: row.usd, agents: seen.agents, fanOut: fan, invalid }));
}

async function stop() {
	try {
		const c = await cdp();
		await c.key('q', 'KeyQ', 81, 4);
		c.close();
	} catch { }
	await sleep(5000);
	const esc = UD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const mine = new RegExp(`(--user-data-dir[ =]|--volt-user-data-dir=)${esc}(\\s|$)|${esc}/`);
	// Never a shell or this rig's own node (their command lines can name the profile path too).
	const notOurs = /^\s*\d+\s+(\S*\/)?(zsh|bash|sh)\s|runvolt\.mjs|grep /;
	for (const l of execSync('ps -axo pid=,command=').toString().split('\n').filter(l => mine.test(l) && !notOurs.test(l))) {
		const pid = Number(l.trim().split(/\s+/)[0]);
		if (pid !== process.pid) {
			console.log('kill', pid, l.trim().slice(0, 140));
			try { process.kill(pid, 'SIGTERM'); } catch { }
		}
	}
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'launch') {
	await launch();
} else if (cmd === 'storage') {
	console.log(writeStorage() ? 'storage written' : 'no state.vscdb yet: launch once, stop, then run storage');
} else if (cmd === 'run') {
	await run(arg);
} else if (cmd === 'finish') {
	await finish(JSON.parse(readFileSync(join(RUNS, `${arg}.state.json`), 'utf8')));
} else if (cmd === 'stop') {
	await stop();
} else if (cmd === 'shot') {
	// A screenshot of the test window (setup checks) and the visible aria labels.
	const c = await cdp();
	const s = await c.send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(arg ?? `${UD}-shot.png`, Buffer.from(s.result.data, 'base64'));
	console.log(await c.evaluate(`document.title + ' | ' + [...document.querySelectorAll('[aria-label]')].filter(e => e.offsetParent).map(e => e.getAttribute('aria-label')).slice(0, 50).join(' / ')`));
	c.close();
} else if (cmd === 'hover' || cmd === 'click') {
	// Setup only: the mouse onto (and for click, a click on) the last visible element whose own text is `arg`.
	const c = await cdp();
	const at = await c.evaluate(`(() => { const e = [...document.querySelectorAll('*')].filter(e => e.offsetParent && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === ${JSON.stringify(arg)})).at(-1); if (!e) { return null; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	if (!at) { throw new Error(`no element with text ${arg}`); }
	await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
	if (cmd === 'click') {
		for (const type of ['mousePressed', 'mouseReleased']) {
			await c.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
		}
	}
	console.log(JSON.stringify(at));
	c.close();
} else if (cmd === 'pick') {
	// Setup check: the model pick alone, nothing is sent.
	const c = await cdp();
	console.log(await pickModel(c, arg ?? 'Opus 5.5 High'));
	c.close();
} else if (cmd === 'escape') {
	const c = await cdp();
	await c.key('Escape', 'Escape', 27);
	c.close();
} else if (cmd === 'clickxy') {
	// Setup only: a click at window coordinates "x,y".
	const [x, y] = arg.split(',').map(Number);
	const c = await cdp();
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
	}
	c.close();
} else if (cmd === 'eval') {
	const c = await cdp();
	console.log(JSON.stringify(await c.evaluate(arg), null, 1));
	c.close();
} else {
	console.log('usage: runvolt.mjs launch --checkout <dir> | storage | run <id> | finish <id> | stop');
}
