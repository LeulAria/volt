// Shared helpers for the round-4 first-word rig (copied from round 3's speed rig; ADEMark Track A method,
// unofficial, measured in-app over CDP). Env: SPEED_UD (/tmp/v4-fw-ud), SPEED_CDP (9942), SPEED_REPLAY (18942),
// SPEED_CHECKOUT (this worktree), SPEED_FOLDER (/tmp/v4-fw/arena).
import { execSync, spawn } from 'child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
export const CHECKOUT = process.env.SPEED_CHECKOUT ?? join(here, '../../../../../..');
export const UD = process.env.SPEED_UD ?? '/tmp/v4-fw-ud';
export const EXT = process.env.SPEED_EXT ?? '/tmp/v4-fw-ext';
export const PORT = Number(process.env.SPEED_CDP ?? 9942);
export const REPLAY = Number(process.env.SPEED_REPLAY ?? 18942);
export const FOLDER = process.env.SPEED_FOLDER ?? '/tmp/v4-fw/arena';
export const REPLAY_LOG = process.env.SPEED_REPLAY_LOG ?? '/tmp/v4-fw/replay.jsonl';
export const DATA = process.env.SPEED_DATA ?? join(here, '../../data/firstword');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function load() {
	return execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
}

export function writeSettings(extra = {}) {
	mkdirSync(join(UD, 'User'), { recursive: true });
	const file = join(UD, 'User', 'settings.json');
	let s = {};
	try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { }
	Object.assign(s, {
		'volt.agent.defaultModel': 'agent:seed-claude-code:claude-haiku-5-5',
		'window.dialogStyle': 'custom',
		'workbench.startupEditor': 'none',
		'security.workspace.trust.enabled': false,
		'update.mode': 'none',
		'telemetry.telemetryLevel': 'off',
		'extensions.autoCheckUpdates': false,
	}, extra);
	writeFileSync(file, JSON.stringify(s, null, '\t'));
	storeWindowSize();
}

/** ADEMark's window is 1600 x 1000 points: written into the window state the app restores (Electron's CDP has no Browser.setWindowBounds). */
export function storeWindowSize(width = 1600, height = 1000) {
	const file = join(UD, 'User', 'globalStorage', 'storage.json');
	if (!existsSync(file)) {
		return false;
	}
	const s = JSON.parse(readFileSync(file, 'utf8'));
	const last = s.windowsState?.lastActiveWindow;
	if (!last) {
		return false;
	}
	last.uiState = { ...last.uiState, mode: 1, x: 40, y: 40, width, height };
	writeFileSync(file, JSON.stringify(s, null, '\t'));
	return true;
}

/** Env for the test instance: the shell's Claude/VS Code variables removed, the model API pointed at the replay server. */
export function cleanEnv({ replay = true } = {}) {
	const env = { ...process.env };
	for (const k of Object.keys(env)) {
		if (/^(CLAUDE|VSCODE_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_)/.test(k)) {
			delete env[k];
		}
	}
	if (replay) {
		env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${REPLAY}`;
	}
	env.VSCODE_SKIP_PRELAUNCH = '1';
	// Diagnosis only (never in timed A/B runs): extra variables for the instance, e.g. the CLI debug wrapper
	// `SPEED_EXTRA_ENV='{"CLAUDE_CODE_EXECUTABLE":"...","CLAUDE_AGENT_LOGS":"..."}'`.
	Object.assign(env, JSON.parse(process.env.SPEED_EXTRA_ENV || '{}'));
	return env;
}

export function launchDev({ replay = true, args = [] } = {}) {
	const log = openSync(`${UD}.log`, 'a');
	const child = spawn('./scripts/code.sh', ['--user-data-dir', UD, '--extensions-dir', EXT, `--remote-debugging-port=${PORT}`,
		'--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', ...args, FOLDER],
		{ cwd: CHECKOUT, env: cleanEnv({ replay }), detached: true, stdio: ['ignore', log, log] });
	child.unref();
	return child.pid;
}

export async function cdp(port = PORT) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title && !/hidden|spare/i.test(t.title)) ?? targets.find(t => t.type === 'page' && /workbench/.test(t.url));
	if (!page) {
		throw new Error('no workbench target');
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let id = 0;
	const pending = new Map();
	const listeners = new Map();
	ws.addEventListener('message', e => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
		else if (m.method) { for (const l of listeners.get(m.method) ?? []) { l(m.params); } }
	});
	const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => {
		const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) {
			throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
		}
		return r.result?.result?.value;
	};
	const on = (method, fn) => { (listeners.get(method) ?? listeners.set(method, []).get(method)).push(fn); };
	const click = async (x, y) => {
		for (const type of ['mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
		}
	};
	const center = async script => evaluate(`(() => { const e = ${script}; if (!e) { return undefined; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	const key = async (key, code, keyCode, modifiers = 0, text) => {
		await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
	};
	return { ws, send, evaluate, on, click, center, key, targetId: page.id, close: () => ws.close() };
}

export async function waitWorkbench(timeoutMs = 180_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const c = await cdp();
			const ok = await c.evaluate('document.readyState === "complete" && !!document.querySelector(".monaco-workbench")');
			c.close();
			if (ok) {
				return Date.now() - t0;
			}
		} catch { }
		await sleep(500);
	}
	throw new Error('test instance did not come up');
}

/** Every process that belongs to the test profile: the app tree (by pid) and the agent server tree (by ud path). */
export function profileProcesses() {
	const rows = execSync('ps -axo pid=,ppid=,rss=,%cpu=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l);
		return m && { pid: +m[1], ppid: +m[2], rssKiB: +m[3], cpu: +m[4], cmd: m[5] };
	}).filter(Boolean);
	const roots = rows.filter(r => r.cmd.includes(`--user-data-dir ${UD}`) || r.cmd.includes(`--user-data-dir=${UD}`) || r.cmd.includes(`${UD}/`) && /volt-agent-server|Electron|VOLT/.test(r.cmd));
	const kids = new Map();
	for (const r of rows) { (kids.get(r.ppid) ?? kids.set(r.ppid, []).get(r.ppid)).push(r); }
	const seen = new Map();
	const queue = [...roots];
	while (queue.length) {
		const r = queue.shift();
		if (seen.has(r.pid)) { continue; }
		seen.set(r.pid, r);
		queue.push(...(kids.get(r.pid) ?? []));
	}
	return [...seen.values()];
}

export async function stopInstance() {
	try {
		const c = await cdp();
		await c.key('q', 'KeyQ', 81, 4);
		c.close();
	} catch { }
	await sleep(5000);
	for (const p of profileProcesses()) {
		try { process.kill(p.pid, 'SIGTERM'); } catch { }
	}
	await sleep(1500);
	for (const p of profileProcesses()) {
		try { process.kill(p.pid, 'SIGKILL'); } catch { }
	}
	const plists = execSync(`grep -l '${UD}' ~/Library/LaunchAgents/com.volt.agent-server.*.plist 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
	for (const plist of plists) {
		const label = plist.replace(/^.*\//, '').replace(/\.plist$/, '');
		try { execSync(`launchctl bootout gui/$(id -u)/${label}`); } catch { }
		execSync(`rm -f '${plist}'`);
	}
}

/** Replay request log lines after `fromNs`. */
export function replayRequests(fromNs = 0n) {
	if (!existsSync(REPLAY_LOG)) {
		return [];
	}
	return readFileSync(REPLAY_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => BigInt(Math.round(r.t_ns)) >= fromNs);
}

export function median(values) {
	const s = [...values].filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
	if (!s.length) { return null; }
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function newChat(c) {
	const ok = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))); if (!e) { return false; } e.click(); return true; })()`);
	if (!ok) {
		throw new Error('no New Chat button');
	}
}

export async function focusComposer(c) {
	return c.evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } t.focus(); return true; })()`);
}
