// Shared helpers for the round-6 weight rig (round 4's, from round 3's speed rig) (ADEMark Track A method, unofficial, measured in-app over CDP).
// Env (set by arm.sh): SPEED_UD, SPEED_CDP (9986), SPEED_REPLAY (18996), SPEED_CHECKOUT (a dev tree) or SPEED_APP (a
// minified .app), SPEED_FOLDER (~/.volt-r8/agents/arena).
import { execSync, spawn } from 'child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const W = `${process.env.HOME}/.volt-r8/agents`;
export const CHECKOUT = process.env.SPEED_CHECKOUT ?? join(here, '../../../../../..');
/** A minified build (`.../VOLT.app`): launched as the app itself instead of `scripts/code.sh`. */
export const APP = process.env.SPEED_APP || undefined;
export const UD = process.env.SPEED_UD ?? `${W}/ud-after`;
export const EXT = process.env.SPEED_EXT ?? `${W}/ext-after`;
export const PORT = Number(process.env.SPEED_CDP ?? 9986);
export const REPLAY = Number(process.env.SPEED_REPLAY ?? 18996);
export const FOLDER = process.env.SPEED_FOLDER ?? `${W}/arena`;
export const REPLAY_LOG = process.env.SPEED_REPLAY_LOG ?? `${W}/replay.jsonl`;
export const DATA = process.env.SPEED_DATA ?? join(here, '../../data/agents');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function load() {
	return execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
}

/** Load gate for timed rows: waits (at most WEIGHT_LOAD_WAIT_S, default 900) for a 1-minute load <= WEIGHT_MAX_LOAD (14). */
export async function waitCalm() {
	const max = Number(process.env.WEIGHT_MAX_LOAD ?? 14);
	const until = Date.now() + Number(process.env.WEIGHT_LOAD_WAIT_S ?? 900) * 1000;
	const t0 = Date.now();
	while (parseFloat(load()) > max && Date.now() < until) { await sleep(5000); }
	return { waitedS: Math.round((Date.now() - t0) / 1000), calm: parseFloat(load()) <= max };
}

/**
 * Swap and memory pressure now. With swap nearly full, phys_footprint undercounts (pages swapped out or
 * compressed away still belong to the process), so every memory row carries this next to its numbers.
 * pressure: kern.memorystatus_vm_pressure_level (1 normal, 2 warn, 4 critical); freePct: memory_pressure's.
 */
export function mem() {
	const swap = execSync('sysctl vm.swapusage').toString();
	const num = re => Number(re.exec(swap)?.[1] ?? NaN);
	let freePct;
	try { freePct = Number(/free percentage: (\d+)%/.exec(execSync('memory_pressure').toString())?.[1]); } catch { }
	let pressure;
	try { pressure = Number(execSync('sysctl -n kern.memorystatus_vm_pressure_level').toString().trim()); } catch { }
	return { swapUsedMiB: Math.round(num(/used = ([\d.]+)M/)), swapTotalMiB: Math.round(num(/total = ([\d.]+)M/)), freePct, pressure };
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
		'files.simpleDialog.enable': true,
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
		// A built app runs its agent server as a launchd job, whose environment is only HOME and the app's plumbing: the
		// agents then reach the real API (live tokens), not the replay server. ADEMark itself uses `launchctl setenv`, which
		// would also reach the user's own Volt; the agent server is spawned by the app instead (same processes, other parent).
		// WEIGHT_LAUNCHD=1 keeps the shipped launchd job (A9: no turn runs, and the job's lifetime after a quit is the point).
		if (APP && process.env.WEIGHT_LAUNCHD !== '1') {
			env.VOLT_AGENT_SERVER_LAUNCHD = '0';
		}
	}
	env.VSCODE_SKIP_PRELAUNCH = '1';
	return env;
}

/** The executable inside a minified `.app` (CFBundleExecutable). */
export function appExecutable(app = APP) {
	const exe = execSync(`/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' '${app}/Contents/Info.plist'`).toString().trim();
	return join(app, 'Contents', 'MacOS', exe);
}

export function launchDev({ replay = true, args = [] } = {}) {
	const log = openSync(`${UD}.log`, 'a');
	const argv = ['--user-data-dir', UD, '--extensions-dir', EXT, `--remote-debugging-port=${PORT}`,
		'--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
		// A built app's fresh profile asks the macOS keychain otherwise: a system prompt on the user's screen, and CDP waits.
		...(APP ? ['--use-mock-keychain'] : []), ...args, ...(process.env.WEIGHT_EXTRA_ARGS?.split(' ').filter(Boolean) ?? []), FOLDER];
	const child = APP
		? spawn(appExecutable(), argv, { cwd: process.env.HOME, env: cleanEnv({ replay }), detached: true, stdio: ['ignore', log, log] })
		: spawn('./scripts/code.sh', argv, { cwd: CHECKOUT, env: cleanEnv({ replay }), detached: true, stdio: ['ignore', log, log] });
	child.unref();
	return child.pid;
}

export async function cdp(port = PORT) {
	// Bounded: a wedged instance must not hang `launch.mjs stop` (it then kills by profile path).
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(10_000) })).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title && !/hidden|spare|^vscode-file:/i.test(t.title)) ?? targets.find(t => t.type === 'page' && /workbench/.test(t.url));
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

/**
 * Puts `text` into the focused composer the way ADEMark does (GUIDE.md: "pastes the prompt with the clipboard
 * and Cmd+V"): a paste event on Monaco's textarea, so the editor runs its paste command, not `type`. CDP's
 * Input.insertText counts as typing, which (unlike a paste) starts the Tab predictor's agent process: round 5's
 * rest-20 rows carried one extra adapter and CLI that ADEMark's own runs would not have.
 */
export async function paste(c, text) {
	const ok = await c.evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
	if (!ok) {
		throw new Error('no composer to paste into');
	}
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
