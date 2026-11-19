// Round 10 IDE bench: shared driver.
// A Volt test instance (dev checkout or a built VOLT.app) on its own profile, and a client of that
// profile's agent server. Tools are called through the server's `hostTools.invokeTool` with
// `source: 'mcp'` and the chat's session id: the same call the MCP endpoint's bridge makes for an
// agent's `tools/call` (voltHostMcpBridge.ts `answer`), minus the HTTP + JSON-RPC hop. mcpHttp.mjs
// measures that hop on a dev build.
import { execFileSync, execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const HOME = process.env.IDE_HOME ?? join(homedir(), '.volt-r10/ide');
export const PORT = Number(process.env.IDE_CDP ?? 9991);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const load1 = () => Number(execSync('sysctl -n vm.loadavg').toString().trim().split(/\s+/)[1]);

/** Rough token count of a tool result: characters / 4 for prose-and-code text (the same rule for every arm). */
export const tokens = text => Math.ceil((text ?? '').length / 4);

export function profile(name) {
	const ud = join(HOME, 'ud-' + name);
	return { ud, ext: join(HOME, 'ext-' + name), user: join(ud, 'User') };
}

export function writeSettings(name, extra = {}) {
	const { user } = profile(name);
	mkdirSync(user, { recursive: true });
	writeFileSync(join(user, 'settings.json'), JSON.stringify({
		'window.dialogStyle': 'custom',
		'workbench.startupEditor': 'none',
		'security.workspace.trust.enabled': false,
		'update.mode': 'none',
		'telemetry.telemetryLevel': 'off',
		...extra,
	}, null, '\t'));
}

/** Starts the instance: `app` is a dev checkout (has scripts/code.sh) or a built VOLT.app. */
export function launch(app, name, args = []) {
	const { ud, ext } = profile(name);
	mkdirSync(ud, { recursive: true });
	const env = {
		HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, SHELL: process.env.SHELL ?? '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR,
		PATH: process.env.PATH, VSCODE_SKIP_PRELAUNCH: '1',
		...(process.env.VOLT_AGENT_SERVER_INSPECT ? { VOLT_AGENT_SERVER_INSPECT: process.env.VOLT_AGENT_SERVER_INSPECT } : {}),
	};
	const log = openSync(join(HOME, `volt-${name}.log`), 'a');
	const flags = ['--user-data-dir', ud, '--extensions-dir', ext, `--remote-debugging-port=${PORT}`,
		'--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', ...args];
	const dev = existsSync(join(app, 'scripts/code.sh'));
	const child = dev
		? spawn('./scripts/code.sh', flags, { cwd: app, env, detached: true, stdio: ['ignore', log, log] })
		: spawn(join(app, 'Contents/MacOS/Electron'), flags, { env, detached: true, stdio: ['ignore', log, log] });
	child.unref();
	return { pid: child.pid, started: Date.now() };
}

export async function cdp() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	if (!page) { throw new Error('no workbench target'); }
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); ws.addEventListener('close', () => rej(new Error('closed')), { once: true }); });
	let id = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise((r, rej) => { const i = ++id; pending.set(i, r); setTimeout(() => { if (pending.delete(i)) { rej(new Error('cdp timeout')); } }, 10_000); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	return { send, evaluate, close: () => ws.close() };
}

export async function waitWindow(timeoutMs = 150_000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		try {
			const c = await cdp();
			const ok = await c.evaluate('document.readyState === "complete" && !!document.querySelector(".monaco-workbench")');
			c.close();
			if (ok) { return true; }
		} catch { }
		await sleep(250);
	}
	throw new Error('test instance did not come up');
}

/** Kills only this profile's processes (the app, its helpers, its agent server and what that started). */
export function stop(name) {
	const { ud } = profile(name);
	// No shell: a shell's own command line would hold the profile path and be matched too.
	const run = (cmd, args) => { try { return execFileSync(cmd, args).toString(); } catch { return ''; } };
	const alive = () => run('pgrep', ['-f', '--', ud]).trim().split('\n').filter(Boolean).length;
	run('pkill', ['-f', '--', ud]);
	for (let i = 0; i < 40 && alive(); i++) { execFileSync('sleep', ['0.25']); }
	if (alive()) { run('pkill', ['-9', '-f', '--', ud]); execFileSync('sleep', ['0.5']); }
}

const uri = path => ({ $mid: 1, scheme: 'file', path, fsPath: path, external: 'file://' + path });

/** A client of the profile's agent server (`<ud>/agentServer/{runtime.json,token}`). */
export async function server(name, timeoutMs = 60_000) {
	const { ud } = profile(name);
	const until = Date.now() + timeoutMs;
	let info;
	while (Date.now() < until) {
		try {
			info = JSON.parse(readFileSync(join(ud, 'agentServer/runtime.json'), 'utf8'));
			process.kill(info.pid, 0);
			break;
		} catch { info = undefined; await sleep(100); }
	}
	if (!info) { throw new Error('no agent server for ' + ud); }
	const token = readFileSync(join(ud, 'agentServer/token'), 'utf8').trim();
	const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('agent server socket failed')), { once: true }); });
	let id = 0;
	const pending = new Map();
	let welcome;
	const welcomed = new Promise(r => { welcome = r; });
	ws.addEventListener('message', e => {
		const m = JSON.parse(e.data);
		if (m.t === 'welcome') { welcome(m); }
		if (m.t === 'ret' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
		// The server may ask this client things (it offers no capabilities): answer "cannot".
		if (m.t === 'call') { ws.send(JSON.stringify({ t: 'ret', id: m.id, ok: false, error: { code: 'NotFound', message: 'bench client' } })); }
	});
	ws.send(JSON.stringify({ t: 'hello', protocol: 1, token, client: { kind: 'test', id: 'ide-bench-' + process.pid, topics: ['server'] } }));
	const hello = await welcomed;
	const call = (method, ...params) => new Promise((res, rej) => {
		const i = ++id;
		pending.set(i, m => m.ok ? res(m.result) : rej(new Error(`${method}: ${m.error?.message ?? 'failed'}`)));
		ws.send(JSON.stringify({ t: 'call', id: i, method, params }));
	});
	/** One tool call as a chat's agent makes it; returns the result text, whether it is an error, ms and tokens. */
	const tool = async (chat, name, args) => {
		const t0 = performance.now();
		let result;
		try {
			result = await call('hostTools.invokeTool', name, args, { sessionId: chat.sessionId, source: 'mcp', cwd: chat.cwd, ...(chat.sandbox ? { sandbox: chat.sandbox } : {}) });
		} catch (err) {
			result = { error: String(err.message ?? err) };
		}
		const ms = performance.now() - t0;
		const text = result?.error ?? result?.text ?? '';
		return { text, isError: !!result?.error, ms, tokens: tokens(text) };
	};
	/**
	 * A chat on the project at `root`. The server resolves a chat's folder from its first run; a chat
	 * that has not run a turn (no model turns in this bench) names it in the call, which is where the
	 * server puts it for a running chat. `sandbox` is the chat's sandbox as the server would attach it
	 * (undefined: Full access / sandbox Off).
	 */
	const chat = async (root, sandbox, sessionId = 'bench-' + Math.random().toString(36).slice(2, 10)) => {
		const record = await call('projects.registerProject', uri(root));
		await call('projects.bindSession', sessionId, record.id);
		if (!sandbox) {
			// Sandbox Off in the chat's menu: the server refuses a sandboxed tool's call that names no sandbox for a chat it holds as sandboxed.
			await call('runtime.setSandboxSettings', sessionId, { level: 'off', network: true });
		}
		return { sessionId, cwd: root, sandbox };
	};
	/** Waits until the window's own tools (code_nav and the rest) are on the server; returns how long that took. */
	const toolsReady = async (timeoutMs = 120_000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			const names = new Set((await call('hostTools.listTools')).map(t => t.name));
			if (['code_nav', 'diagnostics', 'code_action', 'tests', 'debug'].every(name => names.has(name))) { return Date.now() - t0; }
			await sleep(100);
		}
		throw new Error('the window never registered its tools');
	};
	return { info, hello, call, tool, chat, toolsReady, close: () => ws.close() };
}

export function stats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
	return sorted.length ? { n: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted.at(-1) } : { n: 0 };
}
