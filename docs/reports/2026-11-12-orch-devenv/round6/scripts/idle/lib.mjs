// Shared helpers for the round-5 idle rig (ADEMark A3/A6/A8/A11 method, unofficial, over CDP), from round 4's
// smoothness rig. Two arms, one at a time on CDP 9977:
//   before = /Users/leularia/Desktop/VOLT/volt-e5-base (read-only), profile ~/.volt-r6/idle/ud/before
//   after  = /Users/leularia/Desktop/VOLT/volt-e5-idle,            profile ~/.volt-r6/idle/ud/after
// Env: SMOOTH_REPLAY (18977), SMOOTH_FOLDER (~/.volt-r6/idle/arena), SMOOTH_CDP (9977).
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.HOME;
function readyPath(file, fallback) {
	try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).at(-1) || fallback; } catch { return fallback; }
}
export const ARMS = {
	before: '/Users/leularia/Desktop/VOLT/volt-e5-base',
	after: '/Users/leularia/Desktop/VOLT/volt-e5-idle',
	// The after tree with the keystroke-first frame gate off (ccbbbbc3749): its out/ file is patched before launch so
	// yieldsToInput always says false, and restored before an `after` launch. Shares after's profile.
	nogate: '/Users/leularia/Desktop/VOLT/volt-e5-idle',
	// The shared minified "before" build (launch agent; read-only, launched with its own profile).
	// The shared minified "before" build (launch agent writes its app path into READY) and this area's own minified
	// "after" build (idle's minbuild, READY written the same way).
	minbase: readyPath(`${process.env.HOME}/.volt-r6/min/base/READY`, `${process.env.HOME}/.volt-r6/min/base/VOLT.app`),
	minafter: readyPath(`${process.env.HOME}/.volt-r6/min/idle/READY`, `${process.env.HOME}/.volt-r6/min/idle/VOLT.app`),
};
export const PORT = Number(process.env.SMOOTH_CDP ?? 9977);
export const REPLAY = Number(process.env.SMOOTH_REPLAY ?? 18977);
export const FOLDER = process.env.SMOOTH_FOLDER ?? `${HOME}/.volt-r6/idle/arena`;
export const DATA = process.env.SMOOTH_DATA ?? join(here, '../../data/idle');
export const NATIVE = process.env.SMOOTH_NATIVE ?? `${HOME}/.volt-r4/smooth/native/bin/ademark-native`;
export const ud = arm => `${HOME}/.volt-r6/idle/ud/${arm === 'nogate' ? 'after' : arm}`;
export const ext = arm => `${HOME}/.volt-r6/idle/ext/${arm === 'nogate' ? 'after' : arm}`;

const GATE_JS = `${ARMS.after}/out/vs/workbench/contrib/voltAgent/browser/editor/agentInputFrame.js`;
const GATE_ON = 'return states.get(win)?.yielding ?? false;';
const GATE_OFF = 'return false; /* a8 nogate arm */';
/** Turns the after tree's keystroke-first frame gate on or off in out/ (only while no instance of it runs). */
export function setGate(on) {
	if (!existsSync(GATE_JS)) {
		// The gate was reverted (ce91ce68668): nothing to switch; a nogate arm is the after arm.
		return;
	}
	const src = readFileSync(GATE_JS, 'utf8');
	const next = on ? src.replace(GATE_OFF, GATE_ON) : src.replace(GATE_ON, GATE_OFF);
	if (!next.includes(on ? GATE_ON : GATE_OFF)) {
		throw new Error('gate patch failed');
	}
	if (next !== src) {
		writeFileSync(GATE_JS, next);
	}
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 1-minute load average. */
export function load1() {
	return Number(execSync('sysctl -n vm.loadavg').toString().trim().replace(/[{}]/g, '').trim().split(/\s+/)[0]);
}

/**
 * Waits until the 1-minute load is at most `max` (the brief's gate), checking every 20 s. SMOOTH_GATE raises the gate
 * for exploration runs only (their rows go to SMOOTH_DATA elsewhere and never into results).
 */
export async function waitQuiet(max = 14, log = console.error) {
	max = Number(process.env.SMOOTH_GATE ?? max);
	for (; ;) {
		const l = load1();
		if (l <= max) {
			return l;
		}
		log(`load ${l} > ${max}, waiting`);
		await sleep(20_000);
	}
}

export function writeSettings(arm, extra = {}) {
	const dir = join(ud(arm), 'User');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, 'settings.json');
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
	storeWindowSize(arm);
}

/** ADEMark's window is 1600 x 1000 points; this Mac's screen is 1512 x 982, so macOS clamps it to the screen. */
export function storeWindowSize(arm, width = 1600, height = 1000) {
	const file = join(ud(arm), 'User', 'globalStorage', 'storage.json');
	if (!existsSync(file)) {
		return false;
	}
	const s = JSON.parse(readFileSync(file, 'utf8'));
	const last = s.windowsState?.lastActiveWindow;
	if (!last) {
		return false;
	}
	last.uiState = { ...last.uiState, mode: 1, x: 0, y: 0, width, height };
	writeFileSync(file, JSON.stringify(s, null, '\t'));
	return true;
}

/** The shell's Claude/VS Code variables removed, the model API pointed at the replay server. */
export function cleanEnv() {
	const env = { ...process.env };
	for (const k of Object.keys(env)) {
		if (/^(CLAUDE|VSCODE_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_)/.test(k)) {
			delete env[k];
		}
	}
	env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${REPLAY}`;
	env.VSCODE_SKIP_PRELAUNCH = '1';
	if (process.env.SMOOTH_INSPECT === '1') {
		// Analysis only: the dev agent server keeps SIGUSR1 (inspector on 9229) when this is set.
		env.VOLT_AGENT_SERVER_INSPECT = '1';
	}
	return env;
}

/**
 * Starts an arm's dev build. `keepRendering` adds Chromium's flags that keep painting a covered window: only for the
 * timing tests (A3, A8, A11), because the user works at this Mac and can cover the test window at any moment. Never for
 * A6 (idle CPU), which must see the app as it ships.
 */
export function launch(arm, { keepRendering = false, args = [], env = {} } = {}) {
	mkdirSync(ud(arm), { recursive: true });
	mkdirSync(ext(arm), { recursive: true });
	if (arm === 'after' || arm === 'nogate') {
		setGate(arm === 'after');
	}
	const log = openSync(`${ud(arm)}.log`, 'a');
	const keep = keepRendering ? ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] : [];
	const inspect = process.env.SMOOTH_INSPECT === '1' ? [`--inspect=${process.env.SMOOTH_INSPECT_PORT ?? 9987}`] : [];
	// A built app (the shared minified "before" build) runs its own binary, always with --use-mock-keychain (its notes).
	const app = ARMS[arm].endsWith('.app');
	const child = spawn(app ? `${ARMS[arm]}/Contents/MacOS/Electron` : './scripts/code.sh', [...(app ? ['--use-mock-keychain'] : []), '--user-data-dir', ud(arm), '--extensions-dir', ext(arm), `--remote-debugging-port=${PORT}`, ...inspect, ...keep, ...args, FOLDER],
		{ cwd: app ? HOME : ARMS[arm], env: { ...cleanEnv(), ...env }, detached: true, stdio: ['ignore', log, log] });
	child.unref();
	return child.pid;
}

export async function targets(port = PORT) {
	return (await fetch(`http://127.0.0.1:${port}/json`)).json();
}

export async function cdp(port = PORT) {
	const list = await targets(port);
	// The arena's main window first (a profile can bring back a second window, e.g. "New Agent").
	const page = list.find(t => t.type === 'page' && /workbench/.test(t.url) && / — arena$/.test(t.title)) ?? list.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title && !/hidden|spare/i.test(t.title)) ??list.find(t => t.type === 'page' && /workbench/.test(t.url));
	if (!page) {
		throw new Error('no workbench target');
	}
	return connect(page.webSocketDebuggerUrl, page.id);
}

export async function connect(url, targetId) {
	const ws = new WebSocket(url, { perMessageDeflate: false });
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
	const off = method => listeners.delete(method);
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
	return { ws, send, evaluate, on, off, click, center, key, targetId, close: () => ws.close() };
}

export async function waitWorkbench(timeoutMs = 240_000) {
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

function psRows() {
	return execSync('ps -axo pid=,ppid=,rss=,%cpu=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l);
		return m && { pid: +m[1], ppid: +m[2], rssKiB: +m[3], cpu: +m[4], cmd: m[5] };
	}).filter(Boolean);
}

/** Every process of an arm's profile: the app tree and the agent server tree (by profile path). */
export function profileProcesses(arm) {
	const UD = ud(arm);
	const rows = psRows();
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

export function mainPid(arm) {
	const row = psRows().find(r => r.cmd.includes(`--user-data-dir ${ud(arm)}`) && /MacOS\/(Electron|VOLT|Volt)( |$)/.test(r.cmd) && !r.cmd.includes('--type=') && !r.cmd.includes('volt-agent-server-main'));
	return row?.pid;
}

export async function stop(arm) {
	try {
		const c = await cdp();
		await c.key('q', 'KeyQ', 81, 4);
		c.close();
	} catch { }
	await sleep(5000);
	for (const p of profileProcesses(arm)) {
		try { process.kill(p.pid, 'SIGTERM'); } catch { }
	}
	await sleep(1500);
	for (const p of profileProcesses(arm)) {
		try { process.kill(p.pid, 'SIGKILL'); } catch { }
	}
	const plists = execSync(`grep -l '${ud(arm)}' ~/Library/LaunchAgents/com.volt.agent-server.*.plist 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
	for (const plist of plists) {
		const label = plist.replace(/^.*\//, '').replace(/\.plist$/, '');
		try { execSync(`launchctl bootout gui/$(id -u)/${label}`); } catch { }
		execSync(`rm -f '${plist}'`);
	}
}

export function median(values) {
	const s = [...values].filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
	if (!s.length) { return null; }
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile (ADEMark's Stats.percentileDouble uses the same rank). */
export function pct(values, p) {
	const s = [...values].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null;
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

export async function send(c, text) {
	if (!await focusComposer(c)) {
		throw new Error('no composer');
	}
	await c.send('Input.insertText', { text });
	await sleep(400);
	await c.key('Enter', 'Enter', 13, 0, '\r');
}

export function role(cmd) {
	if (/volt-agent-server-main/.test(cmd)) { return 'agent server'; }
	if (/voltPlugins\/node/.test(cmd)) { return 'plugin host'; }
	if (/--type=renderer/.test(cmd)) { return 'renderer'; }
	if (/--type=gpu-process/.test(cmd)) { return 'gpu'; }
	if (/network\.mojom/.test(cmd)) { return 'network service'; }
	if (/--utility-sub-type=node\.mojom\.NodeService/.test(cmd)) {
		// The extension host runs in the "(Plugin)" helper; the shared process (and a pty host) in the plain one.
		if (/extensionHost|Helper \(Plugin\)/.test(cmd)) { return 'extension host'; }
		return 'node utility';
	}
	if (/^\/usr\/bin\/log show|(^| )log show /.test(cmd)) { return 'log show'; }
	if (/\/du -sk|^du /.test(cmd)) { return 'du'; }
	if (/--type=utility/.test(cmd)) { return 'utility (other)'; }
	if (/claude-agent-acp/.test(cmd) && /node/.test(cmd)) { return 'ACP adapter'; }
	if (/\/claude( |$)/.test(cmd)) { return 'claude CLI'; }
	if (/volt-sandbox-helper/.test(cmd)) { return 'sandbox helper'; }
	if (/log stream/.test(cmd)) { return 'log stream'; }
	if (/MacOS\/(Electron|VOLT)/.test(cmd) && !/--type=/.test(cmd)) { return 'main'; }
	if (/voltCodeIndex|codeIndex/.test(cmd)) { return 'code index'; }
	if (/watcher|parcel/i.test(cmd)) { return 'file watcher'; }
	return 'other: ' + cmd.split(' ')[0].split('/').pop();
}
