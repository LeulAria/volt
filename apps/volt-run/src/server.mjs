/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Finds, starts and stops a profile's agent server the way Volt does
// (src/vs/platform/voltAgentServer/node/agentServerLauncher.ts): one server per profile, found
// through runtime.json and trusted once it answers /health with the profile's token.

import { spawn } from 'node:child_process';
import { promises as fs, openSync, closeSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const LOOPBACK = '127.0.0.1';

/** A checkout's server exits with this to load its recompiled code (AGENT_SERVER_RESTART_EXIT_CODE in protocol.ts). */
export const RESTART_EXIT_CODE = 75;

/** @param {string} host */
export function isLoopbackHost(host) {
	return host === LOOPBACK || host === 'localhost' || host === '::1';
}

/** @param {number} pid */
export function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

/**
 * runtime.json and the token, when both are there and well formed.
 * @param {ReturnType<import('./paths.mjs').agentServerPaths>} paths
 */
export async function readServerFiles(paths) {
	const [info, token] = await Promise.all([
		fs.readFile(paths.runtimeFile, 'utf8').then(JSON.parse).catch(() => undefined),
		fs.readFile(paths.tokenFile, 'utf8').then(text => text.trim()).catch(() => undefined),
	]);
	if (!info || info.version !== 1 || !Number.isInteger(info.port) || !Number.isInteger(info.pid) || !token) {
		return undefined;
	}
	return { info, token };
}

/** `http://127.0.0.1:<port>`: the server's address from this computer, whatever it listens on. */
export function localBase(info) {
	return `http://${isLoopbackHost(info.host) || info.host === '0.0.0.0' || info.host === '::' ? LOOPBACK : info.host}:${info.port}`;
}

/**
 * GET with a short timeout; resolves the status and body, or undefined when nothing answers.
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeout?: number, method?: string }} [o]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string } | undefined>}
 */
export function request(url, o = {}) {
	return new Promise(resolve => {
		const req = http.request(url, { method: o.method ?? 'GET', headers: o.headers, timeout: o.timeout ?? 2_000 }, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', chunk => body += chunk);
			res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			res.on('error', () => resolve(undefined));
		});
		req.on('error', () => resolve(undefined));
		req.on('timeout', () => {
			req.destroy();
			resolve(undefined);
		});
		req.end();
	});
}

/**
 * The profile's server when it is alive and answers with the profile's token.
 * @param {ReturnType<import('./paths.mjs').agentServerPaths>} paths
 */
export async function findServer(paths) {
	const files = await readServerFiles(paths);
	if (!files || !isAlive(files.info.pid)) {
		return undefined;
	}
	const health = await request(`${localBase(files.info)}/health`, { headers: { Authorization: `Bearer ${files.token}` } });
	return health?.status === 200 ? files : undefined;
}

/** Whether the profile's server should listen on the network (Volt's Settings > Devices sets it). */
export async function readNetworkAccess(paths) {
	try {
		return JSON.parse(await fs.readFile(paths.networkFile, 'utf8')).network === true;
	} catch {
		return false;
	}
}

/** The same setting, so Volt's windows keep the server the way it was started instead of restarting it. */
export async function writeNetworkAccess(paths, network) {
	await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await fs.writeFile(paths.networkFile, JSON.stringify({ network }), { mode: 0o600 });
}

/** Variables from a Volt or VS Code terminal that would point the server at the wrong app. */
const INHERITED = /^(VSCODE_|ELECTRON_)/;

/**
 * Starts the agent server: Volt's Electron in Node mode (native modules match the build), in its
 * own process group, logging to the profile's agent-server.log.
 * @param {{ runtime: import('./runtime.mjs').IRuntime, paths: ReturnType<import('./paths.mjs').agentServerPaths>, host?: string, port?: number, keepAlive: boolean }} o
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function startServer(o) {
	const { runtime, paths } = o;
	const args = [path.join(runtime.appRoot, 'out', 'volt-agent-server-main.js'), '--user-data-dir', paths.userDataDir];
	if (o.host) {
		args.push('--host', o.host);
	}
	if (o.port) {
		args.push('--port', String(o.port));
	}
	/** @type {NodeJS.ProcessEnv} */
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.test(key)));
	env.ELECTRON_RUN_AS_NODE = '1';
	env.NODE_COMPILE_CACHE = paths.compileCacheDir;
	if (runtime.dev) {
		env.VSCODE_DEV = '1';
		env.NODE_ENV = 'development';
	}
	if (o.keepAlive) {
		// It runs until Ctrl+C, not until it has been alone for 15 minutes.
		env.VOLT_AGENT_SERVER_IDLE_EXIT = '0';
	}
	await fs.mkdir(path.dirname(paths.logFile), { recursive: true });
	const log = openSync(paths.logFile, 'a');
	try {
		const child = spawn(runtime.electron, args, { cwd: runtime.appRoot, env, detached: true, stdio: ['ignore', log, log], windowsHide: true });
		await new Promise((resolve, reject) => {
			child.once('spawn', resolve);
			child.once('error', reject);
		});
		return child;
	} finally {
		closeSync(log);
	}
}

/**
 * Waits until a new server for the profile answers. Fails early when the process exits.
 * @param {ReturnType<import('./paths.mjs').agentServerPaths>} paths
 * @param {{ child?: import('node:child_process').ChildProcess, previousPid?: number, timeout?: number }} o
 */
export async function waitForServer(paths, o = {}) {
	let exit;
	o.child?.once('exit', (code, signal) => exit = { code, signal });
	const deadline = Date.now() + (o.timeout ?? 60_000);
	while (Date.now() < deadline) {
		if (exit) {
			throw Object.assign(new Error(`The Volt agent server stopped while starting (${exit.signal ?? `exit code ${exit.code}`}).`), { log: await logTail(paths.logFile) });
		}
		const running = await findServer(paths);
		if (running && running.info.pid !== o.previousPid) {
			return running;
		}
		await sleep(80);
	}
	throw Object.assign(new Error('The Volt agent server did not start in time.'), { log: await logTail(paths.logFile) });
}

/**
 * Asks a server to stop (it saves its chats first), then makes sure it is gone.
 * @param {number} pid
 */
export async function stopServer(pid, timeout = 8_000) {
	if (!isAlive(pid)) {
		return false;
	}
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return false;
	}
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline && isAlive(pid)) {
		await sleep(80);
	}
	if (isAlive(pid)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// gone meanwhile
		}
	}
	return true;
}

/**
 * What browsers can do with this server: the public environment descriptor, and whether `/`
 * signs a browser in (builds before 0.0.6 served a separate web app there instead).
 * @param {string} base
 */
export async function browserSupport(base) {
	const [descriptor, page] = await Promise.all([
		request(`${base}/.well-known/volt/environment`),
		request(`${base}/`, { headers: { Accept: 'text/html' } }),
	]);
	let environment;
	try {
		environment = descriptor?.status === 200 ? JSON.parse(descriptor.body) : undefined;
	} catch {
		environment = undefined;
	}
	return {
		environment,
		workbench: environment?.capabilities?.workbench === true,
		signIn: page?.status === 200 && /text\/html/.test(String(page.headers['content-type'])) && page.body.includes('/api/workbench/session'),
	};
}

/**
 * A one-time pairing code with its links (needs the server's own token).
 * @param {string} base
 * @param {string} token
 * @returns {Promise<{ code: string, expiresAt: number, urls: { kind: string, url: string, via?: string }[], network: boolean } | undefined>}
 */
export async function createPairingCode(base, token) {
	const response = await request(`${base}/api/auth/code`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
	if (response?.status !== 200) {
		return undefined;
	}
	try {
		return JSON.parse(response.body);
	} catch {
		return undefined;
	}
}

/** The last lines of the server's log, for an error message. */
export async function logTail(file, lines = 15) {
	try {
		const handle = await fs.open(file, 'r');
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, 16 * 1024);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
		} finally {
			await handle.close();
		}
	} catch {
		return '';
	}
}
