/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shared helpers for the Volt runtime benchmarks: launch a dev or packaged Volt with a fresh
// profile and a CDP port, drive it, and sample the memory of its whole process tree.

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const CDP = require('chrome-remote-interface');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Resolves the Electron executable: 'dev' runs this checkout, anything else is a path to a .app bundle. */
export function resolveApp(app) {
	if (app === 'dev') {
		const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
		return { exe: path.join(root, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', 'Electron'), dev: true };
	}
	const macos = path.join(app, 'Contents', 'MacOS');
	const exe = fs.readdirSync(macos).map(name => path.join(macos, name)).find(file => fs.statSync(file).isFile());
	return { exe, dev: false };
}

/**
 * Creates a fresh profile. `fixtures` is copied into `<profile>/User` (e.g. an agentSessions folder).
 * The path stays short because the instance socket path is limited to 103 characters.
 */
export function createProfile(dir, { fixtures = [], settings = {} } = {}) {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, 'User'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'ext'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'User', 'settings.json'), JSON.stringify({
		'window.dialogStyle': 'custom',
		'security.workspace.trust.enabled': false,
		'telemetry.telemetryLevel': 'off',
		'update.mode': 'none',
		'extensions.autoCheckUpdates': false,
		...settings,
	}, null, '\t'));
	for (const fixture of fixtures) {
		fs.cpSync(fixture, path.join(dir, 'User', path.basename(fixture)), { recursive: true });
	}
}

export function launch({ app, profile, port, args = [], env = {} }) {
	const { exe, dev } = resolveApp(app);
	const childEnv = { ...process.env, ...env };
	delete childEnv.ELECTRON_RUN_AS_NODE;
	if (dev) {
		Object.assign(childEnv, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', VSCODE_SKIP_PRELAUNCH: '1' });
	}
	const fullArgs = [
		...(dev ? ['.', '--disable-extension=vscode.vscode-api-tests'] : []),
		'--user-data-dir', profile,
		'--extensions-dir', path.join(profile, 'ext'),
		`--remote-debugging-port=${port}`,
		'--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
		'--skip-release-notes', '--skip-welcome', '--use-mock-keychain',
		...args,
	];
	const startedAt = Date.now();
	const log = fs.openSync(`${profile}.log`, 'a');
	const child = spawn(exe, fullArgs, { cwd: root, env: childEnv, stdio: ['ignore', log, log], detached: true });
	return { child, startedAt, pid: child.pid };
}

export async function stop(instance) {
	if (!instance?.pid) {
		return;
	}
	const pids = processTree(instance.pid).map(p => p.pid);
	try { process.kill(-instance.pid, 'SIGTERM'); } catch { /* gone */ }
	for (let i = 0; i < 50 && isAlive(instance.pid); i++) {
		await sleep(100);
	}
	for (const pid of pids) {
		try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
	}
}

function isAlive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/** All descendants of `rootPid` (inclusive) with RSS in KiB and a coarse role. */
export function processTree(rootPid) {
	const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const rows = out.split('\n').filter(Boolean).map(line => {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		return m && { pid: +m[1], ppid: +m[2], rssKiB: +m[3], args: m[4] };
	}).filter(Boolean);
	const children = new Map();
	for (const row of rows) {
		(children.get(row.ppid) ?? children.set(row.ppid, []).get(row.ppid)).push(row);
	}
	const self = rows.find(row => row.pid === rootPid);
	if (!self) {
		return [];
	}
	const result = [];
	const queue = [self];
	while (queue.length) {
		const row = queue.shift();
		result.push({ ...row, role: roleOf(row.args) });
		queue.push(...(children.get(row.pid) ?? []));
	}
	return result;
}

function roleOf(args) {
	if (/--type=renderer/.test(args)) {
		return /--vscode-window-config|workbench/.test(args) ? 'renderer' : 'renderer';
	}
	if (/--type=gpu-process/.test(args)) { return 'gpu'; }
	if (/--type=utility/.test(args)) {
		if (/network\.mojom/.test(args)) { return 'network'; }
		if (/audio\.mojom|video_capture|storage\.mojom/.test(args)) { return 'chromium-service'; }
		return 'node-utility';
	}
	if (/--type=zygote|crashpad/.test(args)) { return 'helper'; }
	if (/Contents\/MacOS\/(Electron|VOLT|Volt)( |$)/.test(args) && !/--type=/.test(args)) { return 'main'; }
	return 'child-process';
}

/** Process tree RSS summed by role, in MiB. */
export function memorySnapshot(rootPid) {
	const tree = processTree(rootPid);
	const byRole = {};
	for (const p of tree) {
		byRole[p.role] = (byRole[p.role] ?? 0) + p.rssKiB / 1024;
	}
	for (const key of Object.keys(byRole)) {
		byRole[key] = Math.round(byRole[key]);
	}
	return { totalMiB: Math.round(tree.reduce((sum, p) => sum + p.rssKiB, 0) / 1024), processes: tree.length, byRole };
}

/** Waits until the workbench page target exists and returns a connected CDP client. */
export async function connectWorkbench(port, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const targets = await CDP.List({ port });
			const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
			if (page) {
				const client = await CDP({ port, target: page });
				await client.Runtime.enable();
				return client;
			}
		} catch { /* not up yet */ }
		await sleep(50);
	}
	throw new Error(`no workbench target on port ${port}`);
}

export async function evaluate(client, expression) {
	const r = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) {
		throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
	}
	return r.result.value;
}

/** Polls `predicate` (a JS expression evaluated in the page) until truthy; returns its value. */
export async function waitFor(client, predicate, timeoutMs = 60_000, intervalMs = 25) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const value = await evaluate(client, predicate);
			if (value) {
				return value;
			}
		} catch { /* page navigating */ }
		await sleep(intervalMs);
	}
	throw new Error(`timed out waiting for ${predicate}`);
}

export async function marks(client) {
	return evaluate(client, `(() => Object.fromEntries((globalThis.MonacoPerformanceMarks?.getMarks() ?? []).map(m => [m.name, m.startTime])))()`);
}

/** Renderer JS heap after a forced GC (measurement only), plus DOM size and listener counts. */
export async function rendererMetrics(client, { gc = true } = {}) {
	if (gc) {
		await client.HeapProfiler.collectGarbage();
	}
	await client.Performance.enable();
	const { metrics } = await client.Performance.getMetrics();
	const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
	return {
		jsHeapUsedMiB: Math.round(m.JSHeapUsedSize / 1048576 * 10) / 10,
		jsHeapTotalMiB: Math.round(m.JSHeapTotalSize / 1048576 * 10) / 10,
		domNodes: m.Nodes,
		listeners: m.JSEventListeners,
		documents: m.Documents,
		frames: m.Frames,
	};
}

/** Presses a key chord in the focused window. `mods`: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export async function press(client, key, mods = 0, code = undefined) {
	const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, F1: 112, Tab: 9 })[key];
	const base = { modifiers: mods, key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
	await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', ...base });
	await client.Input.dispatchKeyEvent({ type: 'keyUp', ...base });
}

/** Runs a command through the command palette (works in dev and packaged builds). */
export async function runCommand(client, label) {
	await evaluate(client, `(() => { document.querySelector('.monaco-workbench')?.focus(); return true; })()`);
	await press(client, 'P', 4 | 8);
	await waitFor(client, `!!document.querySelector('.quick-input-widget:not([style*="display: none"]) input')`, 10_000);
	await client.Input.insertText({ text: label });
	await sleep(300);
	await press(client, 'Enter');
	await sleep(200);
}

export function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
