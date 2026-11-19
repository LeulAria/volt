// Shared helpers for the round-5 firstword rig (copied from round 4's weight rig) (ADEMark Track A method, unofficial, measured in-app over CDP).
// Env: SPEED_UD (~/.volt-r6/firstword/ud), SPEED_CDP (9972), SPEED_REPLAY (18972), SPEED_CHECKOUT (this worktree),
// SPEED_FOLDER (~/.volt-r6/firstword/arena).
import { execSync, spawn } from 'child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const R6 = join(homedir(), '.volt-r6/firstword');
export const CHECKOUT = process.env.SPEED_CHECKOUT ?? join(here, '../../../../../..');
export const UD = process.env.SPEED_UD ?? join(R6, 'ud');
export const EXT = process.env.SPEED_EXT ?? join(R6, 'ext');
export const PORT = Number(process.env.SPEED_CDP ?? 9972);
export const REPLAY = Number(process.env.SPEED_REPLAY ?? 18972);
export const FOLDER = process.env.SPEED_FOLDER ?? join(R6, 'arena');
export const REPLAY_LOG = process.env.SPEED_REPLAY_LOG ?? join(R6, 'replay.jsonl');
export const DATA = process.env.SPEED_DATA ?? join(here, '../../data/firstword');
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
		'volt.agent.defaultModel': process.env.FW_MODEL ?? 'agent:seed-claude-code:claude-haiku-5-5',
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
	}
	env.VSCODE_SKIP_PRELAUNCH = '1';
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
		await approach(x, y);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
		}
	};
	// HUMAN=1 (round 5): a pointer reaches what it clicks the way a hand moves it: from 300 px away in 400 ms (25
	// moves, 16 ms apart), then 150 ms at rest on the target. Without it a click lands with no move before it.
	const approach = async (x, y) => {
		if (process.env.HUMAN !== '1') { return; }
		const [x0, y0] = [Math.max(1, x - 240), Math.max(1, y - 180)];
		for (let i = 1; i <= 25; i++) {
			const f = 1 - (1 - i / 25) ** 3;
			await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x - x0) * f, y: y0 + (y - y0) * f });
			await new Promise(r => setTimeout(r, 16));
		}
		await new Promise(r => setTimeout(r, 150));
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
