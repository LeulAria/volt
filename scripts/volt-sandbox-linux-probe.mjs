/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Drives Volt's bubblewrap backend on a real Linux host (the Docker rig in
 * scripts/volt-sandbox-linux-test.sh) and checks that every isolation claim holds: it launches
 * real sandboxes through the real SandboxManager (resolver, proxy, backend) and, where a check
 * needs control the manager does not give (a fake proxy, killing mid-run), through the backend
 * directly. Prints a PASS/FAIL table, or JSON with --json.
 *
 *   node volt-sandbox-linux-probe.mjs [--json] [--only name,name] [--probe] [--bench]
 *
 * Reusable: `import { CHECKS, createContext, runChecks } from './volt-sandbox-linux-probe.mjs'`.
 * Each check gets the context and returns `{ pass, detail }` (or `{ gap: true }` for a limitation
 * the backend reports as partial). Set VOLT_OUT to the transpiled `out/` folder (default /volt/out).
 */

import { execFileSync, spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = process.env.VOLT_OUT ?? '/volt/out';
const PORTS = { fakeProxy: 18080, loopback: 18090, otherLoopback: 18091 };
const CANARY = { ssh: 'CANARY-SSH-7f3a', home: 'CANARY-HOME-91c2', env: 'CANARY-ENV-55d0', deepEnv: 'CANARY-DEEP-ENV-0b1e', secretVar: 'CANARY-VAR-c4d8' };

/** @param {string} path */
const load = path => import(pathToFileURL(join(OUT, 'vs/platform/voltSandbox', path)).href);

// --- context ----------------------------------------------------------------------------------

/**
 * A fake home and workspace with canaries, host-side servers (a fake filtering proxy, loopback
 * services) and a host unix socket, plus the manager and backend under test.
 */
export async function createContext() {
	const [{ BubblewrapBackend }, { SandboxManager }, profiles, resolver, { sandboxProxyEnv }] = await Promise.all([
		load('node/bubblewrapBackend.js'), load('node/sandboxManager.js'), load('common/sandboxProfiles.js'), load('node/sandboxResolver.js'), load('common/sandboxResolved.js'),
	]);
	const home = await fs.realpath(os.homedir());
	const ws = join(home, 'ws');
	const rig = '/tmp/volt-rig';
	await fs.rm(ws, { recursive: true, force: true });
	await fs.rm(rig, { recursive: true, force: true });
	await fs.mkdir(rig, { recursive: true });
	const files = {
		[join(home, '.ssh/id_rsa')]: CANARY.ssh,
		[join(home, 'notes.txt')]: CANARY.home,
		[join(ws, 'src/a.txt')]: 'source',
		[join(ws, '.env')]: CANARY.env,
		[join(ws, 'sub/deep/.env')]: CANARY.deepEnv,
		[join(ws, '.git/HEAD')]: 'ref: refs/heads/main\n',
		[join(ws, '.git/config')]: '[core]\n\trepositoryformatversion = 0\n',
		[join(ws, '.git/hooks/pre-commit')]: '#!/bin/sh\nexit 0\n',
		[join(ws, '.vscode/tasks.json')]: '{}\n',
	};
	for (const [path, text] of Object.entries(files)) {
		await fs.mkdir(join(path, '..'), { recursive: true });
		await fs.writeFile(path, text);
	}

	const proxyHits = /** @type {string[]} */ ([]);
	const fakeProxy = http.createServer((req, res) => {
		// A stand-in for Volt's filtering proxy: absolute-form requests, allowed.test only.
		const host = (() => { try { return new URL(req.url ?? '').hostname; } catch { return ''; } })();
		proxyHits.push(host);
		if (host === 'allowed.test') {
			res.end('via-fake-proxy allowed.test\n');
		} else {
			res.writeHead(403).end('blocked by fake proxy\n');
		}
	});
	fakeProxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
	const loopback = http.createServer((_req, res) => res.end('loopback-ok\n'));
	const otherLoopback = http.createServer((_req, res) => res.end('other-loopback-reached\n'));
	const hostSocket = net.createServer(socket => socket.end('host-socket-reached\n'));
	const otherSocket = net.createServer(socket => socket.end('other-socket-reached\n'));
	await Promise.all([
		listen(fakeProxy, PORTS.fakeProxy), listen(loopback, PORTS.loopback), listen(otherLoopback, PORTS.otherLoopback),
		listen(hostSocket, join(rig, 'host.sock')), listen(otherSocket, join(rig, 'other.sock')),
	]);

	const logs = /** @type {string[]} */ ([]);
	const manager = new SandboxManager({ info: (/** @type {string} */ m) => logs.push(m), warn: (/** @type {string} */ m) => logs.push(m) });
	const backend = new BubblewrapBackend();
	const hostEnv = { ...process.env, FAKE_SECRET_TOKEN: CANARY.secretVar, HOME: home };
	return {
		home, ws, rig, manager, backend, profiles, resolver, sandboxProxyEnv, hostEnv, proxyHits, logs,
		close: async () => {
			await manager.dispose();
			for (const server of [fakeProxy, loopback, otherLoopback, hostSocket, otherSocket]) {
				server.close();
			}
		},
	};
}

/**
 * @param {net.Server | http.Server} server
 * @param {number | string} where
 */
function listen(server, where) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		if (typeof where === 'number') {
			server.listen(where, '127.0.0.1', () => resolve(undefined));
		} else {
			server.listen(where, () => resolve(undefined));
		}
	});
}

/** @typedef {Awaited<ReturnType<typeof createContext>>} Context */

/** The `workspace` profile with changes. @param {Context} ctx @param {(p: any) => any} [change] */
function workspacePolicy(ctx, change) {
	const base = ctx.profiles.builtinProfile('workspace');
	return change ? change(structuredClone(base)) : base;
}

/** An agent-style policy: the whole filesystem readable except credentials. @param {Context} ctx */
function readAllPolicy(ctx) {
	const policy = workspacePolicy(ctx);
	return { ...policy, name: 'read-all', filesystem: { ...policy.filesystem, read: ['/'] } };
}

/**
 * Runs through the real manager.
 * @param {Context} ctx @param {string} command @param {string[]} args @param {{ policy?: any; timeoutMs?: number; terminal?: boolean }} [options]
 */
function run(ctx, command, args, options = {}) {
	return ctx.manager.run({
		command, args, policy: options.policy ?? workspacePolicy(ctx), terminal: options.terminal,
		context: { workspaceRoots: [ctx.ws], cwd: ctx.ws, hostEnv: ctx.hostEnv },
	}, { timeoutMs: options.timeoutMs ?? 30_000 });
}

/** @param {Context} ctx @param {string} script @param {{ policy?: any; timeoutMs?: number; terminal?: boolean }} [options] */
const sh = (ctx, script, options) => run(ctx, '/bin/sh', ['-c', script], options);
/** @param {Context} ctx @param {string} code @param {{ policy?: any; timeoutMs?: number; terminal?: boolean }} [options] */
const py = (ctx, code, options) => run(ctx, '/usr/bin/python3', ['-c', code], options);

/**
 * Starts a run through the manager and leaves it running (for terminate checks).
 * @param {Context} ctx @param {string} script @param {any} [policy]
 */
async function start(ctx, script, policy) {
	const prepared = await ctx.manager.prepare({
		command: '/bin/sh', args: ['-c', script], policy: policy ?? workspacePolicy(ctx),
		context: { workspaceRoots: [ctx.ws], cwd: ctx.ws, hostEnv: ctx.hostEnv },
	});
	const child = spawn(prepared.command, [...prepared.args], { env: prepared.env, cwd: prepared.cwd, stdio: ['pipe', 'pipe', 'pipe', ...prepared.extraStdio], detached: true });
	let stdout = '';
	child.stdout?.on('data', d => { stdout += d; });
	child.stdin?.end();
	const confirmation = await prepared.confirm(child);
	return { prepared, child, confirmation, stdout: () => stdout };
}

/**
 * Runs through the backend directly with a hand-adjusted resolved policy, for what the manager
 * does not expose (pointing the bridge at a fake proxy).
 * @param {Context} ctx @param {any} policy @param {string} script @param {{ proxyPort?: number; mutate?: (p: any) => any }} options
 */
async function runDirect(ctx, policy, script, options) {
	const host = await ctx.resolver.sandboxHostFacts();
	const runDir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'volt-sbx-')));
	const tmp = join(runDir, 'tmp');
	await fs.mkdir(tmp, { mode: 0o700 });
	try {
		const { policy: resolved } = await ctx.resolver.resolveSandboxPolicy(policy, { workspaceRoots: [ctx.ws], cwd: ctx.ws, hostEnv: ctx.hostEnv }, host, tmp);
		let final = options.mutate ? options.mutate(resolved) : resolved;
		if (options.proxyPort) {
			final = { ...final, env: { ...final.env, ...ctx.sandboxProxyEnv(options.proxyPort) } };
		}
		const spec = await ctx.backend.launch(final, '/bin/sh', ['-c', script], { tag: 'rigdirect', proxyPort: options.proxyPort, terminal: false, onDenial: () => undefined });
		const child = spawn(spec.command, [...spec.args], { env: spec.env, cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe', ...spec.extraStdio], detached: true });
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', d => { stdout += d; });
		child.stderr?.on('data', d => { stderr += d; });
		child.stdin?.end();
		const exited = new Promise(resolve => child.once('close', code => resolve(code)));
		const confirmation = await spec.confirm(child);
		const exitCode = await exited;
		await spec.terminate(child);
		await spec.dispose();
		return { confirmation, exitCode, stdout, stderr };
	} finally {
		await fs.rm(runDir, { recursive: true, force: true });
	}
}

/** Host processes whose command line contains `needle` (the sandbox's pid namespace is visible from the host). @param {string} needle */
function hostProcesses(needle) {
	const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
	return out.split('\n').filter(line => line.includes(needle) && !line.includes('ps -eo'));
}

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {any} result */
function summary(result) {
	const out = `${result.stdout ?? ''}${result.stderr ? ` | stderr: ${result.stderr}` : ''}`.replace(/\s+/g, ' ').trim();
	return `${result.status ?? ''}${result.error ? ` (${result.error})` : ''} ${out}`.trim().slice(0, 300);
}

/** @param {string} path */
async function readText(path) {
	return fs.readFile(path, 'utf8').catch(() => undefined);
}

// --- checks -----------------------------------------------------------------------------------

/** Syscall numbers for the in-sandbox probes (verified against the headers, see seccomp.ts). */
const NR = {
	aarch64: { unshare: 97, clone: 220, clone3: 435, io_uring_setup: 425, ptrace: 117, mount: 40, keyctl: 219, bpf: 280, perf_event_open: 241, userfaultfd: 282, setns: 268, open_by_handle_at: 265 },
	x86_64: { unshare: 272, clone: 56, clone3: 435, io_uring_setup: 425, ptrace: 101, mount: 165, keyctl: 250, bpf: 321, perf_event_open: 298, userfaultfd: 323, setns: 308, open_by_handle_at: 304 },
};

/**
 * @typedef {{ pass?: boolean; gap?: boolean; detail: string }} CheckResult
 * @type {{ name: string; claim: string; run: (ctx: Context) => Promise<CheckResult> }[]}
 */
export const CHECKS = [
	{
		name: 'probe', claim: 'the backend is available and reports its capabilities',
		run: async ctx => {
			const caps = await ctx.backend.probe();
			const partial = Object.entries(caps.enforcement).filter(([, v]) => v !== 'enforced').map(([k, v]) => `${k}=${v}`);
			return { pass: caps.available, detail: caps.available ? `available; not enforced: ${partial.join(', ') || 'none'}` : caps.diagnostics.join(' ') };
		},
	},
	{
		name: 'workspace-write', claim: 'the workspace is writable and the cwd is the workspace',
		run: async ctx => {
			const r = await sh(ctx, 'pwd; echo written > out.txt && echo ok');
			const host = await readText(join(ctx.ws, 'out.txt'));
			return { pass: r.status === 'completed' && r.stdout.includes(ctx.ws) && r.stdout.includes('ok') && host === 'written\n', detail: summary(r) };
		},
	},
	{
		name: 'outside-write-denied', claim: 'nothing outside the writable roots can be written; /tmp is private',
		run: async ctx => {
			const r = await sh(ctx, `echo x > ${ctx.home}/evil.txt; echo home=$?; echo x > /etc/evil 2>/dev/null; echo etc=$?; echo x > /tmp/volt-rig-evil && echo tmp-private-ok`);
			const leaked = [await readText(join(ctx.home, 'evil.txt')), await readText('/etc/evil'), await readText('/tmp/volt-rig-evil')].some(Boolean);
			return { pass: /home=[1-9]/.test(r.stdout) && /etc=[1-9]/.test(r.stdout) && !leaked, detail: summary(r) };
		},
	},
	{
		name: 'home-canary-unreadable', claim: 'the real home is invisible (workspace profile); credentials stay masked with readAll',
		run: async ctx => {
			const a = await sh(ctx, `cat ${ctx.home}/notes.txt ${ctx.home}/.ssh/id_rsa 2>&1; echo HOME=$HOME`);
			const b = await sh(ctx, `cat ${ctx.home}/.ssh/id_rsa 2>&1; ls -A ${ctx.home}/.ssh; echo listed`, { policy: readAllPolicy(ctx) });
			const leaked = [CANARY.ssh, CANARY.home].some(c => a.stdout.includes(c)) || b.stdout.includes(CANARY.ssh);
			return { pass: a.status === 'completed' && b.status === 'completed' && !leaked && b.stdout.includes('listed'), detail: `workspace: ${summary(a)} || readAll: ${summary(b)}` };
		},
	},
	{
		name: 'git-protected', claim: '.git/config, .git/hooks and .vscode cannot be changed, and .git cannot be moved aside (workspace and readAll)',
		run: async ctx => {
			const script = 'echo evil >> .git/config; echo config=$?; echo evil > .git/hooks/pre-commit; echo hook=$?; echo x > .git/hooks/post-checkout; echo newhook=$?; echo evil > .vscode/tasks.json; echo vscode=$?; mv .git .git-moved; echo mv=$?; mv .git/hooks .git/hooks-old; echo mvhooks=$?; echo ref > .git/ORIG_HEAD; echo gitwrite=$?';
			const details = [];
			let pass = true;
			for (const [label, policy] of /** @type {const} */ ([['workspace', workspacePolicy(ctx)], ['readAll', readAllPolicy(ctx)]])) {
				const r = await sh(ctx, script, { policy });
				const config = await readText(join(ctx.ws, '.git/config'));
				const hook = await readText(join(ctx.ws, '.git/hooks/pre-commit'));
				const tasks = await readText(join(ctx.ws, '.vscode/tasks.json'));
				const moved = await readText(join(ctx.ws, '.git-moved/HEAD'));
				pass &&= r.status === 'completed' && !config?.includes('evil') && !hook?.includes('evil') && tasks === '{}\n' && moved === undefined
					&& /mv=[1-9]/.test(r.stdout) && /mvhooks=[1-9]/.test(r.stdout) && /gitwrite=0/.test(r.stdout);
				details.push(`${label}: ${r.stdout.replace(/\s+/g, ' ').trim()}`);
			}
			return { pass, detail: details.join(' || ') };
		},
	},
	{
		name: 'env-file-masked', claim: '.env files (any depth) are unreadable and unchanged',
		run: async ctx => {
			const r = await sh(ctx, 'cat .env sub/deep/.env 2>&1; echo cat=$?; echo overwritten > .env; echo write=$?');
			const host = await readText(join(ctx.ws, '.env'));
			const pass = !r.stdout.includes(CANARY.env) && !r.stdout.includes(CANARY.deepEnv) && host === CANARY.env && /write=[1-9]/.test(r.stdout);
			return { pass, detail: summary(r) };
		},
	},
	{
		name: 'network-none', claim: 'mode none: no internet and no host loopback service',
		run: async ctx => {
			const r = await sh(ctx, `curl -sS -m 3 http://1.1.1.1/ >/dev/null 2>&1; echo internet=$?; curl -sS -m 3 http://127.0.0.1:${PORTS.loopback}/ 2>/dev/null; echo loopback=$?; node -e "fetch('http://1.1.1.1').then(() => console.log('fetch=ok'), e => console.log('fetch=fail', e.cause && e.cause.code))"`);
			return { pass: /internet=[1-9]/.test(r.stdout) && /loopback=[1-9]/.test(r.stdout) && r.stdout.includes('fetch=fail') && !r.stdout.includes('loopback-ok'), detail: summary(r) };
		},
	},
	{
		name: 'proxy-bridge', claim: 'mode proxy: only the proxy port is reachable, through the bridge (fake proxy on the host)',
		run: async ctx => {
			const before = ctx.proxyHits.length;
			const policy = { ...workspacePolicy(ctx), network: { mode: 'proxy', allow: ['allowed.test'], loopbackPorts: [], listen: false } };
			const r = await runDirect(ctx, policy, `curl -sS -m 5 http://allowed.test/hello; curl -sS -m 5 -o /dev/null -w 'denied=%{http_code}\\n' http://denied.test/; curl -sS -m 3 --noproxy '*' http://1.1.1.1/ >/dev/null 2>&1; echo direct=$?; curl -sS -m 3 --noproxy '*' http://127.0.0.1:${PORTS.loopback}/ >/dev/null 2>&1; echo loopback=$?; python3 -c "import socket; socket.socket(socket.AF_UNIX)" 2>&1 | tail -1`, { proxyPort: PORTS.fakeProxy });
			const hits = ctx.proxyHits.slice(before);
			const pass = r.confirmation.ok && r.stdout.includes('via-fake-proxy allowed.test') && r.stdout.includes('denied=403') && /direct=[1-9]/.test(r.stdout) && /loopback=[1-9]/.test(r.stdout) && hits.includes('allowed.test') && r.stdout.includes('Operation not permitted');
			return { pass, detail: `${r.confirmation.ok ? r.confirmation.detail : r.confirmation.error} | ${r.stdout.replace(/\s+/g, ' ')} ${r.stderr.slice(0, 200)}` };
		},
	},
	{
		name: 'real-proxy', claim: 'the manager\'s own proxy is reached through the bridge and blocks a host that is not allowed',
		run: async ctx => {
			const policy = { ...workspacePolicy(ctx), name: 'network', network: { mode: 'proxy', allow: ['allowed.test'], loopbackPorts: [], listen: false } };
			const r = await sh(ctx, 'curl -sS -m 5 http://blocked.test/ 2>&1; echo; echo rc=$?', { policy });
			const denied = r.denials.some(/** @param {any} d */ d => d.target.includes('blocked.test'));
			return { pass: r.status === 'completed' && r.stdout.includes('Blocked by Volt sandbox') && denied, detail: `${summary(r)} denials=${JSON.stringify(r.denials)}` };
		},
	},
	{
		name: 'loopback-ports', claim: 'loopbackPorts: the listed host port is reachable, others are not; the bridge is gone after the run',
		run: async ctx => {
			const policy = workspacePolicy(ctx, p => { p.network.loopbackPorts = [PORTS.loopback]; return p; });
			const r = await sh(ctx, `curl -sS -m 3 http://127.0.0.1:${PORTS.loopback}/; curl -sS -m 3 http://127.0.0.1:${PORTS.otherLoopback}/ 2>/dev/null; echo other=$?`, { policy });
			await sleep(100);
			const leftover = [...hostProcesses('socat'), ...hostProcesses('volt-bridge')];
			return { pass: r.stdout.includes('loopback-ok') && /other=[1-9]/.test(r.stdout) && !r.stdout.includes('other-loopback-reached') && leftover.length === 0, detail: `${summary(r)}; bridge processes left: ${leftover.length}` };
		},
	},
	{
		name: 'terminal-mode', claim: 'terminal: the session is kept (no --new-session) and TIOCSTI is still refused',
		run: async ctx => {
			const r = await py(ctx, `
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
r = libc.ioctl(0, ctypes.c_ulong(0x5412), ctypes.create_string_buffer(b'x'))
print('tiocsti', 0 if r >= 0 else ctypes.get_errno())
print('own-session', os.getsid(0) == os.getpid())
`, { terminal: true });
			return { pass: r.status === 'completed' && r.stdout.includes('tiocsti 1') && r.stdout.includes('own-session False'), detail: summary(r) };
		},
	},
	{
		name: 'af-unix-denied', claim: 'no socket granted: socket(AF_UNIX) is refused (socketpair still works) and host sockets are not visible',
		run: async ctx => {
			const r = await py(ctx, [
				'import socket, os',
				'try:\n    socket.socket(socket.AF_UNIX); print("created")\nexcept OSError as e: print("af_unix_errno", e.errno)',
				'a, b = socket.socketpair(); print("socketpair ok")',
				'print("visible", os.path.exists("/tmp/volt-rig/host.sock"))',
			].join('\n'));
			return { pass: r.stdout.includes('af_unix_errno 1') && r.stdout.includes('socketpair ok') && r.stdout.includes('visible False'), detail: summary(r) };
		},
	},
	{
		name: 'granted-socket', claim: 'a granted socket is reachable; other host sockets are not',
		run: async ctx => {
			const policy = workspacePolicy(ctx, p => { p.host.unixSockets = ['/tmp/volt-rig/host.sock']; return p; });
			const r = await py(ctx, [
				'import socket, os',
				's = socket.socket(socket.AF_UNIX); s.connect("/tmp/volt-rig/host.sock"); print(s.recv(100).decode().strip())',
				'print("other visible", os.path.exists("/tmp/volt-rig/other.sock"))',
			].join('\n'), { policy });
			return { pass: r.stdout.includes('host-socket-reached') && r.stdout.includes('other visible False'), detail: summary(r) };
		},
	},
	{
		name: 'readall-socket-refused', claim: 'granting a socket with the whole filesystem readable is refused (other sockets would be reachable)',
		run: async ctx => {
			const policy = readAllPolicy(ctx);
			const r = await sh(ctx, 'echo ran', { policy: { ...policy, host: { ...policy.host, unixSockets: ['/tmp/volt-rig/host.sock'] } } });
			return { pass: r.status === 'unavailable' && !r.stdout.includes('ran') && r.unenforced.includes('host.unixSockets'), detail: summary(r) };
		},
	},
	{
		name: 'namespaces-denied', claim: 'unshare -U, clone(CLONE_NEWUSER), setns fail; clone3 is ENOSYS',
		run: async ctx => {
			const tool = await sh(ctx, 'unshare -U true 2>&1; echo unshare=$?');
			const r = await py(ctx, `
import ctypes, platform
nr = ${JSON.stringify(NR)}[platform.machine()]
libc = ctypes.CDLL(None, use_errno=True)
def call(n, *a):
	r = libc.syscall(n, *[ctypes.c_long(x) for x in a]); return 0 if r >= 0 else ctypes.get_errno()
print('unshare', call(nr['unshare'], 0x10000000))
print('clone_newuser', call(nr['clone'], 0x10000000 | 17, 0, 0, 0, 0))
print('clone_newnet', call(nr['clone'], 0x40000000 | 17, 0, 0, 0, 0))
print('clone3', call(nr['clone3'], 0, 0))
print('setns', call(nr['setns'], 0, 0))
`);
			const pass = /unshare=[1-9]/.test(tool.stdout) && r.stdout.includes('unshare 1') && r.stdout.includes('clone_newuser 1') && r.stdout.includes('clone_newnet 1') && r.stdout.includes('clone3 38') && r.stdout.includes('setns 1');
			return { pass, detail: `${summary(tool)} | ${summary(r)}` };
		},
	},
	{
		name: 'syscalls-denied', claim: 'io_uring, ptrace, mount, keyctl, bpf, perf_event_open, userfaultfd, open_by_handle_at return EPERM',
		run: async ctx => {
			const r = await py(ctx, `
import ctypes, platform
nr = ${JSON.stringify(NR)}[platform.machine()]
libc = ctypes.CDLL(None, use_errno=True)
def call(n, *a):
	r = libc.syscall(n, *[ctypes.c_long(x) for x in a]); return 0 if r >= 0 else ctypes.get_errno()
for name in ['io_uring_setup', 'ptrace', 'mount', 'keyctl', 'bpf', 'perf_event_open', 'userfaultfd', 'open_by_handle_at']:
	print(name, call(nr[name], 0, 0, 0, 0, 0))
`);
			const lines = r.stdout.trim().split('\n');
			return { pass: lines.length === 8 && lines.every(line => line.endsWith(' 1')), detail: summary(r) };
		},
	},
	{
		name: 'tiocsti-blocked', claim: 'TIOCSTI and TIOCLINUX are refused (also with high bits set); other ioctls are not',
		run: async ctx => {
			const r = await py(ctx, `
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
def ioctl(req):
	buf = ctypes.create_string_buffer(b'x')
	r = libc.ioctl(0, ctypes.c_ulong(req), buf); return 0 if r >= 0 else ctypes.get_errno()
print('tiocsti', ioctl(0x5412))
print('tiocsti_high', ioctl(0x100005412))
print('tioclinux', ioctl(0x541C))
print('tcgets', ioctl(0x5401))
`);
			return { pass: r.stdout.includes('tiocsti 1') && r.stdout.includes('tiocsti_high 1') && r.stdout.includes('tioclinux 1') && r.stdout.includes('tcgets 25'), detail: summary(r) };
		},
	},
	{
		name: 'fork-bomb-contained', claim: 'processes: 32 stops a fork loop well before 200',
		run: async ctx => {
			const policy = workspacePolicy(ctx, p => { p.process.limits.processes = 32; return p; });
			const r = await py(ctx, `
import os, time
n = 0
try:
	for i in range(200):
		pid = os.fork()
		if pid == 0:
			time.sleep(20); os._exit(0)
		n += 1
	print('not-blocked', n)
except OSError as e:
	print('blocked-after', n, e.errno)
`, { policy });
			const m = /blocked-after (\d+)/.exec(r.stdout);
			return { pass: !!m && Number(m[1]) < 32 && r.timing.totalMs < 15_000, detail: `${summary(r)} in ${r.timing.totalMs} ms` };
		},
	},
	{
		name: 'cpu-and-file-limits', claim: 'cpuSeconds and fileSizeMB are applied inside the sandbox',
		run: async ctx => {
			const policy = workspacePolicy(ctx, p => { p.process.limits.cpuSeconds = 1; p.process.limits.fileSizeMB = 1; return p; });
			const big = await sh(ctx, 'head -c 3000000 /dev/zero > big.bin; echo rc=$?', { policy });
			const size = (await fs.stat(join(ctx.ws, 'big.bin')).catch(() => ({ size: -1 }))).size;
			const cpu = await py(ctx, 'while True: pass', { policy, timeoutMs: 20_000 });
			const pass = /rc=[1-9]/.test(big.stdout) && size <= 1024 * 1024 && !cpu.timedOut && cpu.exitCode !== 0 && cpu.timing.totalMs < 10_000;
			return { pass, detail: `file: ${summary(big)} size=${size}; cpu: exit=${cpu.exitCode} signal=${cpu.signal ?? ''} ${cpu.timing.totalMs} ms` };
		},
	},
	{
		name: 'terminate-kills-descendants', claim: 'terminate kills background children (sleep &)',
		run: async ctx => {
			const s = await start(ctx, 'sleep 1001 & sleep 1002 & echo started; wait');
			for (let i = 0; i < 100 && !s.stdout().includes('started'); i++) {
				await sleep(20);
			}
			const before = hostProcesses('sleep 100').length;
			await s.prepared.terminate(s.child);
			await s.prepared.dispose();
			await sleep(100);
			const after = hostProcesses('sleep 100');
			return { pass: s.confirmation.ok && before >= 2 && after.length === 0, detail: `confirm=${s.confirmation.ok} running before=${before} after=${after.length} ${after.join(';')}` };
		},
	},
	{
		name: 'setsid-daemon-dies', claim: 'a setsid + double-fork daemon dies when its run ends and when it is terminated',
		run: async ctx => {
			const daemon = (/** @type {string} */ tag) => `python3 -c "
import os, time
if os.fork() == 0:
	os.setsid()
	if os.fork() == 0:
		os.execvp('sleep', ['sleep', '${tag}'])
	os._exit(0)
time.sleep(0.3)
print('daemonized')
"`;
			const r = await sh(ctx, daemon('1003'));
			await sleep(100);
			const leftAfterExit = hostProcesses('sleep 1003');
			const s = await start(ctx, `${daemon('1004')}; sleep 1005`);
			for (let i = 0; i < 100 && !s.stdout().includes('daemonized'); i++) {
				await sleep(20);
			}
			const running = hostProcesses('sleep 1004').length;
			await s.prepared.terminate(s.child);
			await s.prepared.dispose();
			await sleep(100);
			const leftAfterKill = hostProcesses('sleep 100');
			return { pass: r.stdout.includes('daemonized') && leftAfterExit.length === 0 && running === 1 && leftAfterKill.length === 0, detail: `after exit: ${leftAfterExit.length}, running daemon seen: ${running}, after terminate: ${leftAfterKill.length}` };
		},
	},
	{
		name: 'seccomp-applied', claim: 'the workload runs with Seccomp 2 and NoNewPrivs 1, and no capabilities',
		run: async ctx => {
			const r = await sh(ctx, 'grep -E "^(Seccomp|Seccomp_filters|NoNewPrivs|CapEff|CapBnd):" /proc/self/status');
			const pass = /Seccomp:\s+2/.test(r.stdout) && /NoNewPrivs:\s+1/.test(r.stdout) && /CapEff:\s+0+\b/.test(r.stdout) && /CapBnd:\s+0+\b/.test(r.stdout);
			return { pass, detail: summary(r) };
		},
	},
	{
		name: 'hostname', claim: 'the sandbox has its own hostname',
		run: async ctx => {
			const r = await sh(ctx, 'cat /proc/sys/kernel/hostname');
			return { pass: r.stdout.trim() === 'volt-sandbox', detail: summary(r) };
		},
	},
	{
		name: 'no-host-processes', claim: 'ps shows only the sandbox\'s own processes',
		run: async ctx => {
			const r = await sh(ctx, 'ps -eo pid=,comm=');
			const lines = r.stdout.trim().split('\n').map(line => line.trim());
			return { pass: r.status === 'completed' && lines.length <= 4 && !lines.some(line => / node$/.test(line)) && lines.some(line => line.startsWith('1 ')), detail: lines.join(', ') };
		},
	},
	{
		name: 'env-clear', claim: 'the workload sees only the policy\'s environment; the launcher sees none',
		run: async ctx => {
			const r = await sh(ctx, 'env | sort | tr "\\n" " "');
			const policy = workspacePolicy(ctx, p => { p.env.set.LD_PRELOAD = '/nonexistent-volt.so'; return p; });
			const s = await start(ctx, 'echo "preload=$LD_PRELOAD"; sleep 1006', policy);
			for (let i = 0; i < 100 && !s.stdout().includes('preload='); i++) {
				await sleep(20);
			}
			const launcherEnv = s.child.pid ? readFileSync(`/proc/${s.child.pid}/environ`, 'utf8') : 'n/a';
			await s.prepared.terminate(s.child);
			await s.prepared.dispose();
			const pass = !r.stdout.includes(CANARY.secretVar) && r.stdout.includes('VOLT_SANDBOX=') && !r.stdout.includes('DOCKER') && s.stdout().includes('preload=/nonexistent-volt.so') && launcherEnv === '';
			return { pass, detail: `workload env: ${r.stdout.slice(0, 220)} | launcher environ bytes=${launcherEnv.length}` };
		},
	},
	{
		name: 'no-fd-leak', claim: 'the workload inherits only stdin, stdout and stderr',
		run: async ctx => {
			const r = await py(ctx, 'import os; fds = sorted(int(f) for f in os.listdir("/proc/self/fd")); print(fds)');
			const fds = JSON.parse(r.stdout.trim() || '[]');
			return { pass: JSON.stringify(fds) === '[0,1,2,3]', detail: `${r.stdout.trim()} (3 is listdir's own handle)` };
		},
	},
	{
		name: 'launch-failure-reported', claim: 'a sandbox that fails during setup is reported as failed with bubblewrap\'s error; the workload never runs',
		run: async ctx => {
			const r = await runDirect(ctx, workspacePolicy(ctx), 'echo workload-ran', { mutate: p => ({ ...p, cwd: '/nonexistent-volt-cwd' }) });
			const pass = !r.confirmation.ok && /chdir|nonexistent/i.test(r.confirmation.error) && !r.stdout.includes('workload-ran');
			return { pass, detail: r.confirmation.ok ? `confirmed: ${r.confirmation.detail}` : r.confirmation.error };
		},
	},
	{
		name: 'protect-new-gap', claim: 'reported partial: a protected path that does not exist yet can be created (filesystem.protectNew)',
		run: async ctx => {
			const r = await sh(ctx, 'mkdir -p .devcontainer && echo created');
			return { gap: r.stdout.includes('created'), pass: r.status === 'completed', detail: `${summary(r)} (bubblewrap can only mount over paths that exist at launch)` };
		},
	},
];

/**
 * @param {Context} ctx
 * @param {{ only?: string[] }} [options]
 */
export async function runChecks(ctx, options = {}) {
	const results = [];
	for (const check of CHECKS) {
		if (options.only?.length && !options.only.includes(check.name)) {
			continue;
		}
		const started = Date.now();
		/** @type {CheckResult} */
		let result;
		try {
			result = await check.run(ctx);
		} catch (err) {
			result = { pass: false, detail: `threw: ${/** @type {Error} */ (err).stack ?? err}` };
		}
		const verdict = result.gap ? 'GAP' : result.pass ? 'PASS' : 'FAIL';
		results.push({ name: check.name, claim: check.claim, verdict, ms: Date.now() - started, detail: result.detail });
	}
	return results;
}

// --- bench ------------------------------------------------------------------------------------

/** @param {number[]} values */
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Startup latency: plain `true`, the backend alone, and the manager end to end. @param {Context} ctx @param {number} n */
export async function bench(ctx, n = 20) {
	const time = async (/** @type {() => Promise<unknown>} */ fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
	const plain = [];
	for (let i = 0; i < n; i++) {
		plain.push(await time(() => new Promise(resolve => spawn('/usr/bin/true').once('close', resolve))));
	}
	const host = await ctx.resolver.sandboxHostFacts();
	const backendOnly = [];
	const bridged = [];
	for (const [list, mutate] of /** @type {const} */ ([[backendOnly, undefined], [bridged, (/** @type {any} */ p) => ({ ...p, network: { ...p.network, loopbackPorts: [PORTS.loopback] } })]])) {
		for (let i = 0; i < n; i++) {
			const runDir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'volt-sbx-')));
			const tmp = join(runDir, 'tmp');
			await fs.mkdir(tmp);
			const { policy } = await ctx.resolver.resolveSandboxPolicy(workspacePolicy(ctx), { workspaceRoots: [ctx.ws], cwd: ctx.ws, hostEnv: ctx.hostEnv }, host, tmp);
			const resolved = mutate ? mutate(policy) : policy;
			list.push(await time(async () => {
				const spec = await ctx.backend.launch(resolved, '/usr/bin/true', [], { tag: 'bench', terminal: false, onDenial: () => undefined });
				const child = spawn(spec.command, [...spec.args], { env: spec.env, cwd: spec.cwd, stdio: ['ignore', 'ignore', 'pipe', ...spec.extraStdio], detached: true });
				const exited = new Promise(resolve => child.once('close', resolve));
				const confirmation = await spec.confirm(child);
				if (!confirmation.ok) {
					throw new Error(confirmation.error);
				}
				await exited;
				await spec.terminate(child);
				await spec.dispose();
			}));
			await fs.rm(runDir, { recursive: true, force: true });
		}
	}
	const managed = [];
	for (let i = 0; i < n; i++) {
		managed.push(await time(() => run(ctx, '/usr/bin/true', [])));
	}
	return {
		n,
		plainTrueMs: median(plain),
		sandboxedTrueBackendMs: median(backendOnly),
		sandboxedTrueBridgedMs: median(bridged),
		sandboxedTrueManagerMs: median(managed),
	};
}

// --- main -------------------------------------------------------------------------------------

async function main() {
	const argv = process.argv.slice(2);
	const json = argv.includes('--json');
	const onlyIndex = argv.indexOf('--only');
	const only = onlyIndex >= 0 ? argv[onlyIndex + 1]?.split(',') : undefined;
	const ctx = await createContext();
	try {
		if (argv.includes('--probe')) {
			console.log(JSON.stringify(await ctx.backend.probe(), null, 2));
			return;
		}
		if (argv.includes('--bench')) {
			const result = await bench(ctx);
			console.log(json ? JSON.stringify(result, null, 2) : Object.entries(result).map(([k, v]) => `${k.padEnd(26)} ${typeof v === 'number' ? v.toFixed(1) : v}`).join('\n'));
			return;
		}
		const results = await runChecks(ctx, { only });
		if (json) {
			console.log(JSON.stringify(results, null, 2));
		} else {
			const width = Math.max(...results.map(r => r.name.length));
			console.log(`${'check'.padEnd(width)}  result  ms     detail`);
			for (const r of results) {
				console.log(`${r.name.padEnd(width)}  ${r.verdict.padEnd(6)}  ${String(r.ms).padEnd(5)}  ${r.detail}`);
			}
			const failed = results.filter(r => r.verdict === 'FAIL').length;
			console.log(`\n${results.length - failed}/${results.length} passed or behaved as reported${failed ? `, ${failed} FAILED` : ''}`);
			process.exitCode = failed ? 1 : 0;
		}
	} finally {
		await ctx.close();
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch(err => {
		console.error(err);
		process.exit(2);
	});
}
