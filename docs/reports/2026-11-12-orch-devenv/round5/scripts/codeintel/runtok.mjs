// Round 5 codeintel copy of round 4's tokens/runtok.mjs (defaults: ~/.volt-r5/codeintel, CDP 9975, proxy 19975, the openclaw fixture).
// ADEMark Track B (B1 "hi", B3 real prompt) on Volt, unofficial: a dev test instance whose Claude Code
// processes send every model request through proxy.mjs (ANTHROPIC_BASE_URL), on a throwaway Claude config
// dir (mkcfg.sh: the live login's access token only, no user settings, MCP servers, skills or memory, like
// ADEMark's dedicated `ademark` macOS user).
//   node runtok.mjs launch [--checkout <volt checkout>]      start the test instance (CDP 9954)
//   node runtok.mjs run <label> <model ref> <prompt> [rep]   one new chat, wait for the answer + 30 s
//   node runtok.mjs stop                                     quit it and kill its agent server
// Each run appends a window {label, rep, model, prompt, start, sent, end, chat, answer} to windows.jsonl;
// analyze.mjs splits the captured requests by these windows. Env: VOLT_UD (/tmp/v3-tokens-ud),
// VOLT_CDP (9954), TOK_DIR (/tmp/v3-tokens), TOK_PROXY (http://127.0.0.1:19955), TOK_CFG (<TOK_DIR>/cfg).
import { execSync, spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const UD = process.env.VOLT_UD ?? '/Users/leularia/.volt-r5/codeintel/ud';
const EXT = process.env.VOLT_EXT ?? '/Users/leularia/.volt-r5/codeintel/ext';
const PORT = Number(process.env.VOLT_CDP ?? 9975);
const DIR = process.env.TOK_DIR ?? '/Users/leularia/.volt-r5/codeintel/run';
const PROXY = process.env.TOK_PROXY ?? 'http://127.0.0.1:19975';
const CFG = process.env.TOK_CFG ?? join(DIR, 'cfg-clean');
const FOLDER = process.env.TOK_FOLDER ?? '/Users/leularia/.volt-r5/codeintel/fx/openclaw';
const USER = join(UD, 'User');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ADEMark's 30 s for side calls; the capability check (capcheck.sh) needs none.
const SIDE_CALL_WAIT_MS = Number(process.env.TOK_SIDE_WAIT_MS ?? 30_000);

function writeSettings(model, extra = {}) {
	mkdirSync(USER, { recursive: true });
	const file = join(USER, 'settings.json');
	let s = {};
	try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { }
	Object.assign(s, {
		'volt.agent.defaultModel': model,
		'window.dialogStyle': 'custom',
		'workbench.startupEditor': 'none',
		'security.workspace.trust.enabled': false,
		'update.mode': 'none',
		'telemetry.telemetryLevel': 'off',
	}, extra);
	writeFileSync(file, JSON.stringify(s, null, '\t'));
}

async function cdp() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	if (!page) { throw new Error('no workbench target'); }
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let id = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	return { send, evaluate, close: () => ws.close() };
}

async function launch() {
	const checkout = process.argv.includes('--checkout') ? process.argv[process.argv.indexOf('--checkout') + 1] : join(here, '../../../../../..');
	writeSettings(process.env.TOK_MODEL ?? 'agent:seed-claude-code:claude-haiku-5-5');
	execSync(`CLEAN=1 ${join(DIR, 'mkcfg.sh')} ${CFG}`);
	// A clean environment: nothing from the Claude Code session that starts the rig (CLAUDE_*, MCP sockets).
	const env = {
		HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, SHELL: process.env.SHELL ?? '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR,
		PATH: process.env.PATH,
		VSCODE_SKIP_PRELAUNCH: '1', CLAUDE_CONFIG_DIR: CFG, ANTHROPIC_BASE_URL: PROXY,
	};
	const log = openSync(join(DIR, 'volt-dev.log'), 'a');
	const child = spawn('./scripts/code.sh', ['--user-data-dir', UD, '--extensions-dir', EXT, `--remote-debugging-port=${PORT}`,
		'--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', FOLDER],
		{ cwd: checkout, env, detached: true, stdio: ['ignore', log, log] });
	child.unref();
	const t0 = Date.now();
	for (let i = 0; i < 150; i++) {
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

function readTrace(id) {
	const file = join(USER, 'voltTraces', `${id}.jsonl`);
	if (!existsSync(file)) { return []; }
	return readFileSync(file, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
}

/**
 * A new chat starts on the last project, or on none (a scratch folder, without the arena's AGENTS.md):
 * pick the arena through the composer's project picker (its search opens any folder by path).
 */
async function ensureProject(c) {
	const name = FOLDER.split('/').at(-1);
	const shown = () => c.evaluate(`(() => [...document.querySelectorAll('*')].some(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(name)} && /label|project/.test(e.className)))()`);
	if (await shown()) { return; }
	// The landing's project button: "Select project", or the last project's name.
	const opened = await c.evaluate(`(() => { const e = [...document.querySelectorAll('button.volt-agent-landing-pick')].filter(e => e.offsetParent && e.querySelector('.label')).at(0); if (!e) { return false; } e.click(); return true; })()`);
	if (!opened) { throw new Error('no project picker'); }
	await sleep(800);
	// Rows read "<name>, <parent>" with the home folder as ~. A search by full path finds a folder Volt has
	// not listed yet; one it lists already (a recent project) is found by its name.
	const parent = FOLDER.slice(0, -name.length - 1);
	const tilde = process.env.HOME && parent.startsWith(process.env.HOME) ? '~' + parent.slice(process.env.HOME.length) : parent;
	let picked = false;
	for (const text of [FOLDER, name]) {
		await c.evaluate(`(() => { const i = [...document.querySelectorAll('input')].filter(e => e.offsetParent && /search projects/i.test(e.placeholder)).at(-1); i?.focus(); i?.select(); return !!i; })()`);
		await c.send('Input.insertText', { text });
		await sleep(1500);
		picked = await c.evaluate(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].filter(e => { const l = e.getAttribute('aria-label') ?? ''; return e.offsetParent && (l.endsWith(${JSON.stringify(FOLDER)}) || l === ${JSON.stringify(`${name}, ${tilde}`)}); }).at(-1); r?.click(); return !!r; })()`);
		if (picked) { break; }
	}
	await sleep(1500);
	if (!picked || !await shown()) { throw new Error(`could not pick the project ${FOLDER}`); }
}

async function newChat(c) {
	const ok = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))); if (!e) { return false; } e.click(); return true; })()`);
	if (!ok) { throw new Error('no New Chat button'); }
	await sleep(1500);
	// The OS sandbox blocks loopback ports it did not grant, the capture proxy's included: sandbox Off
	// for these chats (the agent's prompt is the same). Permissions stay on the default (Supervised);
	// TOK_ACCESS=full picks Full access as the round-2 rig did.
	// The menu lists the Sandbox section only once the chat knows its model is an agent: retry until
	// the entry is there.
	const pick = async label => {
		for (let attempt = 0; attempt < 12; attempt++) {
			const opened = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label^="Permissions:"], button.volt-agent-status-access')].filter(e => e.offsetParent).at(-1); if (!e) { return false; } e.click(); return true; })()`);
			await sleep(600);
			const ok = opened && await c.evaluate(`(() => { const e = [...document.querySelectorAll('.volt-agent-access-menu .monaco-highlighted-label')].filter(e => e.offsetParent && e.textContent.trim() === ${JSON.stringify(label)}).at(-1); e?.click(); return !!e; })()`);
			await sleep(400);
			if (ok) { return true; }
			await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
			await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
			await sleep(500);
		}
		return false;
	};
	await ensureProject(c);
	if (process.env.TOK_SANDBOX !== 'keep' && !await pick('Off')) { throw new Error('could not turn the sandbox off'); }
	if (process.env.TOK_ACCESS === 'full' && !await pick('Full access')) { throw new Error('could not pick Full access'); }
	if (process.env.TOK_ACCESS) {
		const access = await c.evaluate(`(() => [...document.querySelectorAll('[aria-label^="Permissions:"], button.volt-agent-status-access')].filter(e => e.offsetParent).map(e => e.getAttribute('aria-label') || e.textContent.trim()).at(-1) ?? '')()`);
		console.log(JSON.stringify({ access }));
	}
}

const modelLabel = c => c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-model-label')].filter(e => e.offsetParent).at(-1)?.textContent ?? '')()`);

async function run(label, model, prompt, rep = '1') {
	writeSettings(model);
	// The copied access token lives a few hours: copy the live one again before every run.
	execSync(`CLEAN=1 ${join(DIR, 'mkcfg.sh')} ${CFG}`);
	await sleep(800);
	const c = await cdp();
	const traces = join(USER, 'voltTraces');
	mkdirSync(traces, { recursive: true });
	const sessionsDir = join(USER, 'agentSessions', 'sessions');
	mkdirSync(sessionsDir, { recursive: true });
	const beforeSessions = new Set(readdirSync(sessionsDir));
	const start = Date.now();
	await newChat(c);
	let shown = await modelLabel(c);
	const want = model.split(':').at(-1).replace(/^claude-/, '').replace(/-(\d)-(\d)/, ' $1.$2').toLowerCase();
	for (let i = 0; i < 20 && !shown.toLowerCase().includes(want); i++) { await sleep(250); shown = await modelLabel(c); }
	const focused = await c.evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } t.focus(); return true; })()`);
	if (!focused) { throw new Error('no composer'); }
	await c.send('Input.insertText', { text: prompt });
	await sleep(300);
	const load = execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
	const sent = Date.now();
	for (const type of ['keyDown', 'keyUp']) {
		await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
	}
	let chat;
	for (let i = 0; i < 240 && !chat; i++) {
		await sleep(250);
		chat = readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl') && !beforeSessions.has(n)).find(n => {
			try { return !JSON.parse(readFileSync(join(sessionsDir, n), 'utf8').split('\n')[0]).parentId; } catch { return false; }
		})?.replace(/\.jsonl$/, '');
	}
	if (!chat) { c.close(); throw new Error('no new chat'); }
	const deadline = sent + 5 * 60_000;
	let ended = false;
	// TOK_SKIP_QUESTIONS=1 (capability check): a question tray that shows up is recorded and skipped, so the turn goes on.
	const questions = [];
	// TOK_FIRST_ONLY=1 (first-request size of the round-2 tasks): Stop the turn once the first model request has answered.
	let stopped = false;
	while (Date.now() < deadline) {
		await sleep(1000);
		if (process.env.TOK_SKIP_QUESTIONS === '1') {
			const asked = await c.evaluate(`(() => { const skip = [...document.querySelectorAll('button.volt-question-pill.ghost')].filter(e => e.offsetParent).at(-1); if (!skip) { return undefined; } const tray = skip.parentElement?.parentElement; const text = (tray?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300); skip.click(); return text || '(question)'; })()`);
			if (asked) { questions.push(asked); continue; }
		}
		const ev = readTrace(chat).filter(l => l.kind === 'event');
		if (process.env.TOK_FIRST_ONLY === '1' && !stopped && ev.some(l => l.event.type === 'tool.start' || l.event.type === 'host.tool' || l.event.type === 'text.end' || l.event.type === 'text.delta')) {
			stopped = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label="Stop"], [title="Stop"]')].filter(e => e.offsetParent).at(-1); e?.click(); return !!e; })()`);
		}
		const starts = ev.filter(l => l.event.type === 'run.start').length;
		const ends = ev.filter(l => l.event.type === 'run.end').length;
		if (starts > 0 && ends >= starts) { ended = true; break; }
	}
	const answeredAt = Date.now();
	// TESTS.md §3: wait 30 s after the answer for side calls (titles, branch names, summaries).
	await sleep(SIDE_CALL_WAIT_MS);
	const ev = readTrace(chat).filter(l => l.kind === 'event');
	const lastRun = ev.filter(l => l.event.type === 'run.start').at(-1)?.runId;
	const answer = ev.filter(l => l.event.type === 'text.end' && l.runId === lastRun).map(l => l.event.delta ?? '').join('\n').trim();
	const tools = ev.filter(l => l.event.type === 'tool.start' || l.event.type === 'host.tool').map(l => l.event.name ?? l.event.title ?? l.event.type);
	const title = await c.evaluate(`(() => document.title)()`);
	c.close();
	const row = { label, rep: Number(rep), model, shownModel: shown, prompt, start, sent, answeredAt, end: Date.now(), ended, chat, load, answer: answer.slice(0, 4000), tools, title, ...(questions.length ? { questions } : {}), ...(stopped ? { stopped: true } : {}) };
	appendFileSync(join(DIR, 'windows.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ label, rep, chat, ms: answeredAt - sent, ended, shown, load, answer: answer.slice(0, 200), tools }));
}

async function stop() {
	try {
		const c = await cdp();
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 });
		c.close();
	} catch { }
	await sleep(4000);
	// UD as a whole path: /tmp/v3-tokens-ud must not match the base instance's /tmp/v3-tokens-ud-base.
	const esc = UD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const mine = new RegExp(`(--user-data-dir[ =]|--volt-user-data-dir=)${esc}(\\s|$)|${esc}/`);
	const ps = execSync('ps -axo pid=,command=').toString().split('\n').filter(l => mine.test(l));
	for (const l of ps) {
		const pid = Number(l.trim().split(/\s+/)[0]);
		if (pid === process.pid) { continue; }
		console.log('kill', pid, l.trim().slice(0, 160));
		try { process.kill(pid, 'SIGTERM'); } catch { }
	}
	console.log('launchd agent servers:', execSync(`launchctl list | grep com.volt.agent-server || true`).toString().trim() || 'none');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'launch') {
	await launch();
} else if (cmd === 'run') {
	await run(...rest);
} else if (cmd === 'stop') {
	await stop();
} else {
	console.log('usage: runtok.mjs launch|run <label> <model> <prompt> [rep]|stop');
}
