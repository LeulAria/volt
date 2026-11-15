/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One ACP adapter process for several chats (Claude Code's `claude-agent-acp`).
 *
 * Every chat used to start its own adapter: a Node process of about 77 MB that only relays between
 * Volt and the chat's Claude Code CLI. This is the program of a shared one, the "host". It loads the
 * adapter once and serves one ACP connection per chat over in-memory streams, each with the adapter's
 * own agent object, as if it had its own process. Volt's stdio service (`acpSharedHosts.ts`) owns
 * the host and gives each chat a virtual process id, so the rest of Volt sees a process per chat.
 *
 * What keeps the chats apart, with the adapter outside every chat's sandbox:
 * - **The host starts no process.** `child_process` is replaced before the adapter and the Agent SDK
 *   load. A spawn made in a chat's context (the CLI, `claude auth status`) is sent to the stdio
 *   service, which starts it through that chat's own sandbox launch, exactly as it started the
 *   chat's adapter before; its stdio is relayed here. A spawn outside a chat's context, and every
 *   synchronous or shell spawn, is refused.
 * - **Each chat has its own environment and folder.** `process.env` and `process.cwd()` read those of the
 *   chat whose code is running (the async context), which for a sandboxed chat is its sandbox launch's
 *   environment (its own `CLAUDE_CONFIG_DIR` overlay). Chats whose spawn environment differs
 *   (another account's config folder) get different hosts.
 * - **The host's own file access follows the chat's sandbox policy.** `fs` calls made in a sandboxed
 *   chat's context are checked against that chat's resolved policy ({@link ACP_HOST_POLICY_CHECK_SOURCE});
 *   after startup, a call outside any chat's context may only read.
 *
 * Lines on the host's stdin and stdout are `<kind> <chat> <payload>`; see {@link AcpHostFrame}.
 * The program is a string because it runs in the user's `node`, which cannot load Volt's modules.
 */

/** Frame kinds, as the first word of a line. `n` numbers a chat's child processes. */
export const enum AcpHostFrame {
	/** host → service, once: the adapter loaded and chats can open. Payload: `{}`. */
	Ready = 'ready',
	/** service → host: a chat's connection. Payload: `{ cwd?, sandboxed?, env?, policy? }` (`env`, `policy`: a sandboxed chat's). */
	Open = 'open',
	/** Both ways: one ACP JSON-RPC line of the chat. */
	Acp = 'acp',
	/** service → host: end the chat's connection. host → service `closed` when it is gone. */
	Close = 'close',
	Closed = 'closed',
	/** service → host: the chat's resolved sandbox policy (changes when its CLI is launched). */
	Policy = 'policy',
	/** host → service: start a process for the chat. Payload: `<n> { command, args, cwd, env, unset, exec }`. */
	Spawn = 'spawn',
	/** service → host: `<n> { pid }` or `<n> { error }`. */
	Spawned = 'spawned',
	/** host → service: stdin data (`<n> "<text>"`), stdin end (`<n>`), kill (`<n> <signal>`). */
	In = 'in',
	End = 'end',
	Kill = 'kill',
	/** service → host: stdout / stderr data (`<n> "<text>"`), exit (`<n> { code, signal }`). */
	Out = 'out',
	Err = 'err',
	Exit = 'exit',
	/** host → service: a line for Volt's log (`- "<text>"`). */
	Log = 'log',
}

/** The stdio service stops a host this long after its last chat closed: an idle host is 77 MB nobody uses. */
export const ACP_HOST_LINGER_MS = 2_000;

/**
 * JavaScript source of `voltAllows(policy, path, access)`: whether a sandboxed chat's resolved policy
 * lets the host read or write `path` for it. Reads follow `resolvedPolicyAllows` exactly; `meta` (stat)
 * and `list` (a folder's names) are what the OS sandbox adds to reads: metadata of any path that is not
 * denied, and the folders of the policy's `list`. Writes are
 * a subset of it (no write into any git folder, no lock-file siblings of `writeFiles`): the adapter
 * writes only its sessions' files. `sandboxPolicyHostCheck.test.ts` holds both to the real function.
 */
export const ACP_HOST_POLICY_CHECK_SOURCE = String.raw`
function voltAllows(policy, path, access) {
	if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').some(segment => segment === '..')) {
		return false;
	}
	const fold = policy.platform === 'darwin' ? s => s.toLowerCase() : s => s;
	const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
	const fp = fold(p);
	const inside = (root, exact) => root === '/' || p === root || (!exact && p.startsWith(root + '/'));
	const insideFolded = root => { const f = fold(root); return root === '/' || fp === f || fp.startsWith(f + '/'); };
	const matches = pattern => {
		if (!insideFolded(pattern.root) || fp === fold(pattern.root)) {
			return false;
		}
		const parts = p.slice(pattern.root === '/' ? 1 : pattern.root.length + 1).split('/').map(fold);
		const names = pattern.names.map(fold);
		for (let i = 0; i + names.length <= parts.length; i++) {
			if (names.every((name, j) => parts[i + j] === name)) {
				return true;
			}
		}
		return false;
	};
	if ((policy.deny || []).some(insideFolded) || (policy.denyPatterns || []).some(matches)) {
		return false;
	}
	if ((policy.isolated || []).some(entry => insideFolded(entry.root) && !inside(entry.keep))) {
		return false;
	}
	if (access === 'meta') {
		// The OS sandbox lets a workload stat any path it is not denied (file-read-metadata).
		return true;
	}
	if (access === 'list' && (policy.list || []).some(dir => inside(dir, true))) {
		return true;
	}
	if (access === 'read' || access === 'list') {
		return !!policy.readAll || (policy.read || []).some(root => inside(root)) || (policy.write || []).some(root => inside(root)) || (policy.writeFiles || []).some(file => inside(file, true));
	}
	if ((policy.protect || []).some(insideFolded) || (policy.protectPatterns || []).some(matches)) {
		return false;
	}
	// Nothing in a git folder: one named .git at any depth, or a folder the policy names as one.
	if (fp.split('/').some(part => part === '.git') || (policy.gitDirs || []).some(dir => !dir.anyDepth && insideFolded(dir.root))) {
		return false;
	}
	return (policy.write || []).some(root => inside(root)) || (policy.writeFiles || []).some(file => p === file);
}
`;

/**
 * The host program (an ES module for `node --input-type=module -e`). Its last argument is the
 * adapter's entry file (`dist/index.js`, or the `.bin` link to it).
 */
export function acpSharedHostSource(): string {
	return HOST_SOURCE.replace('/*POLICY_CHECK*/', () => ACP_HOST_POLICY_CHECK_SOURCE);
}

const HOST_SOURCE = String.raw`
import { AsyncLocalStorage } from 'node:async_hooks';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/*POLICY_CHECK*/

const chats = new Map();
const context = new AsyncLocalStorage();
const realEnv = process.env;
const startEnv = { ...realEnv };
let sealed = false;

const send = (kind, chat, payload) => { process.stdout.write(kind + ' ' + chat + ' ' + payload + '\n'); };
const log = text => send('log', '-', JSON.stringify(String(text)));

// --- each chat's own environment ------------------------------------------------------------------

const envNow = () => context.getStore()?.env ?? realEnv;
process.env = new Proxy({}, {
	get: (_, key) => envNow()[key],
	set: (_, key, value) => { envNow()[key] = String(value); return true; },
	has: (_, key) => key in envNow(),
	deleteProperty: (_, key) => { delete envNow()[key]; return true; },
	ownKeys: () => Reflect.ownKeys(envNow()),
	getOwnPropertyDescriptor: (_, key) => {
		const env = envNow();
		return key in env ? { value: env[key], writable: true, enumerable: true, configurable: true } : undefined;
	},
	defineProperty: (_, key, descriptor) => { envNow()[key] = String(descriptor.value); return true; },
});

// The adapter process used to start in the folder of its chat: process.cwd() is the running one.
const realCwd = process.cwd.bind(process);
process.cwd = () => context.getStore()?.cwd ?? realCwd();

// --- no process is started here -------------------------------------------------------------------

class RelayedChild extends EventEmitter {
	constructor(chat, n, command, args) {
		super();
		this.chat = chat;
		this.n = n;
		this.pid = undefined;
		this.exitCode = null;
		this.signalCode = null;
		this.killed = false;
		this.connected = false;
		this.spawnfile = command;
		this.spawnargs = [command, ...args];
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		// What is written or asked before the service has started the process waits for it.
		this.waiting = [];
		this.stdin = new Writable({
			decodeStrings: false,
			write: (chunk, encoding, done) => {
				if (this.exitCode === null && this.signalCode === null) {
					this.tell('in', n + ' ' + JSON.stringify(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
				}
				done();
			},
			final: done => { this.tell('end', String(n)); done(); },
		});
		this.stdin.on('error', () => undefined);
		this.stdio = [this.stdin, this.stdout, this.stderr];
	}
	tell(kind, payload) {
		if (this.waiting) { this.waiting.push([kind, payload]); } else { send(kind, this.chat.id, payload); }
	}
	started(pid) {
		this.pid = pid;
		const waiting = this.waiting || [];
		this.waiting = undefined;
		for (const [kind, payload] of waiting) { send(kind, this.chat.id, payload); }
		this.emit('spawn');
	}
	kill(signal) {
		if (this.exitCode !== null || this.signalCode !== null) {
			return false;
		}
		this.tell('kill', this.n + ' ' + (typeof signal === 'string' ? signal : 'SIGTERM'));
		this.killed = true;
		return true;
	}
	ref() { }
	unref() { }
	ended(code, signal) {
		if (this.exitCode !== null || this.signalCode !== null) {
			return;
		}
		this.exitCode = signal ? null : (code ?? 0);
		this.signalCode = signal ?? null;
		this.chat.children.delete(this.n);
		this.stdout.end();
		this.stderr.end();
		this.emit('exit', signal ? null : this.exitCode, this.signalCode);
		setImmediate(() => context.run(this.chat, () => this.emit('close', signal ? null : this.exitCode, this.signalCode)));
	}
}

function refused(what) {
	const error = new Error('Volt: the shared agent host does not start processes (' + what + ')');
	error.code = 'EPERM';
	return error;
}

function relayedSpawn(command, args, options) {
	if (!Array.isArray(args)) {
		options = args;
		args = [];
	}
	options = options || {};
	const chat = context.getStore();
	if (!chat || chat.closed || options.shell || options.detached) {
		log('refused spawn of ' + command + (chat ? '' : ' outside a chat'));
		const child = new RelayedChild({ id: '-', children: new Map() }, 0, String(command), args);
		setImmediate(() => { child.emit('error', refused('spawn ' + command)); });
		return child;
	}
	const n = ++chat.spawned;
	const child = new RelayedChild(chat, n, String(command), args);
	chat.children.set(n, child);
	const given = options.env || process.env;
	const env = {};
	for (const key of Object.keys(given)) {
		if (given[key] !== undefined && chat.base[key] !== String(given[key])) {
			env[key] = String(given[key]);
		}
	}
	const unset = Object.keys(chat.base).filter(key => given[key] === undefined);
	send('spawn', chat.id, n + ' ' + JSON.stringify({ command: String(command), args: args.map(String), cwd: options.cwd ? String(options.cwd) : undefined, env, unset, exec: options.voltExec === true }));
	if (options.signal) {
		const abort = () => child.kill(options.killSignal || 'SIGTERM');
		if (options.signal.aborted) { abort(); } else { options.signal.addEventListener('abort', abort, { once: true }); }
	}
	return child;
}

function relayedExecFile(file, args, options, callback) {
	if (typeof args === 'function') { callback = args; args = []; options = {}; }
	else if (!Array.isArray(args)) { callback = options; options = args; args = []; }
	if (typeof options === 'function') { callback = options; options = {}; }
	options = options || {};
	const child = relayedSpawn(file, args, { cwd: options.cwd, env: options.env, signal: options.signal, voltExec: true });
	let stdout = '';
	let stderr = '';
	let done = false;
	let timer;
	const finish = (error, code, signal) => {
		if (done) { return; }
		done = true;
		clearTimeout(timer);
		if (!error && (code !== 0 || signal)) {
			error = new Error('Command failed: ' + file + ' ' + args.join(' ') + '\n' + stderr);
			error.code = code;
			error.signal = signal;
			error.killed = child.killed;
		}
		if (error) { error.stdout = stdout; error.stderr = stderr; }
		callback?.(error || null, stdout, stderr);
	};
	child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
	child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
	child.on('error', error => finish(error));
	child.on('close', (code, signal) => finish(undefined, code, signal));
	if (options.timeout > 0) {
		timer = setTimeout(() => child.kill(options.killSignal || 'SIGTERM'), options.timeout);
	}
	child.stdin.end();
	return child;
}
relayedExecFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
	relayedExecFile(file, Array.isArray(args) ? args : [], Array.isArray(args) ? options : args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});

childProcess.spawn = relayedSpawn;
childProcess.execFile = relayedExecFile;
for (const name of ['exec', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
	childProcess[name] = () => { log('refused ' + name); throw refused(name); };
}

// --- file access follows the chat's sandbox policy ------------------------------------------------

const realpathSync = fs.realpathSync.native;
function nearestReal(path) {
	const rest = [];
	let current = path;
	for (let i = 0; i < 64 && current && current !== '/'; i++) {
		try {
			return [realpathSync(current), ...rest].join('/').replace(/\/{2,}/g, '/');
		} catch {
			rest.unshift(current.slice(current.lastIndexOf('/') + 1));
			current = dirname(current);
		}
	}
	return path;
}
function pathOf(value) {
	if (typeof value === 'string') { return value; }
	if (value instanceof URL) { return fileURLToPath(value); }
	if (value instanceof Uint8Array) { return Buffer.from(value).toString('utf8'); }
	return undefined;
}
/** An error when the running chat's policy (or, outside a chat after startup, the host's own rule) refuses. */
function fileRefusal(value, access) {
	const chat = context.getStore();
	const policy = chat ? chat.policy : undefined;
	if (chat ? !chat.sandboxed : !sealed) {
		return undefined;
	}
	const given = pathOf(value);
	if (given === undefined) {
		return undefined;
	}
	const path = resolvePath(given);
	const allowed = chat
		? !!policy && voltAllows(policy, path, access) && voltAllows(policy, nearestReal(path), access)
		: access !== 'write';
	if (allowed) {
		return undefined;
	}
	log('refused ' + access + ' of ' + path + (chat ? ' for ' + chat.id : ' outside a chat'));
	const error = new Error('EACCES: permission denied (Volt sandbox), ' + access + ' ' + path);
	error.code = 'EACCES';
	error.errno = -13;
	error.path = path;
	return error;
}
const WRITE_FLAGS = /[wa+]/;
const openAccess = flags => typeof flags === 'number' ? ((flags & 3) !== 0 || (flags & (fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 ? 'write' : 'read') : WRITE_FLAGS.test(String(flags ?? 'r')) ? 'write' : 'read';
/** name -> the access each leading path argument needs. */
const GUARDED = {
	access: ['meta'], exists: ['meta'], lstat: ['meta'], stat: ['meta'], statfs: ['meta'], readlink: ['meta'], realpath: ['meta'],
	readdir: ['list'], opendir: ['list'], readFile: ['read'], createReadStream: ['read'], watch: ['read'], watchFile: ['read'], openAsBlob: ['read'],
	appendFile: ['write'], chmod: ['write'], chown: ['write'], lchmod: ['write'], lchown: ['write'], lutimes: ['write'], utimes: ['write'],
	mkdir: ['write'], mkdtemp: ['write'], rm: ['write'], rmdir: ['write'], truncate: ['write'], unlink: ['write'], writeFile: ['write'], createWriteStream: ['write'],
	copyFile: ['read', 'write'], cp: ['read', 'write'], rename: ['write', 'write'], link: ['read', 'write'], symlink: [undefined, 'write'],
	open: ['open'],
};
function refusalFor(name, args) {
	const roles = GUARDED[name];
	for (let i = 0; i < roles.length; i++) {
		const role = roles[i] === 'open' ? openAccess(args[1]) : roles[i];
		const error = role && fileRefusal(args[i], role);
		if (error) { return error; }
	}
	return undefined;
}
function guard(target, name, kind) {
	const original = target[name];
	if (typeof original !== 'function') { return; }
	const base = name.endsWith('Sync') ? name.slice(0, -4) : name;
	const wrapped = function (...args) {
		const error = refusalFor(base, args);
		if (!error) { return original.apply(this, args); }
		if (kind === 'promise') { return Promise.reject(error); }
		if (kind === 'sync' || base === 'createReadStream' || base === 'createWriteStream' || base === 'watch' || base === 'watchFile') {
			if (base === 'exists') { return false; }
			throw error;
		}
		const callback = args[args.length - 1];
		if (typeof callback === 'function') { setImmediate(() => base === 'exists' ? callback(false) : callback(error)); }
		return undefined;
	};
	Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
	target[name] = wrapped;
	if (typeof original.native === 'function') {
		// realpath.native and realpathSync.native: the same check.
		const holder = { native: original.native };
		guardNamed(holder, 'native', base, kind);
		wrapped.native = holder.native;
	}
}
function guardNamed(target, name, base, kind) {
	const original = target[name];
	target[name] = function (...args) {
		const error = refusalFor(base, args);
		if (!error) { return original.apply(this, args); }
		if (kind === 'sync') { throw error; }
		const callback = args[args.length - 1];
		if (typeof callback === 'function') { setImmediate(() => callback(error)); }
		return undefined;
	};
}
for (const name of Object.keys(GUARDED)) {
	guard(fs, name, 'callback');
	guard(fs, name + 'Sync', 'sync');
	guard(fs.promises, name, 'promise');
}
syncBuiltinESMExports();

// --- the adapter, once ----------------------------------------------------------------------------

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
process.on('unhandledRejection', reason => { console.error('Unhandled Rejection:', reason); });
// An adapter process of its own died with its chat. Here the chat whose code threw ends (its connection
// closes, as a crashed adapter's would); the other chats keep theirs.
process.on('uncaughtException', error => {
	const chat = context.getStore();
	log('uncaught exception' + (chat ? ' in chat ' + chat.id : '') + ': ' + (error?.stack || error));
	if (chat) { closeChat(chat.id); }
});

const entry = realpathSync(process.argv[process.argv.length - 1]);
const dist = dirname(entry);
const adapterUrl = name => pathToFileURL(join(dist, name)).href;
let router;
let protocols;
let ndJsonStream;
let webStreams;
try {
	const serve = await import(adapterUrl('serve.js'));
	webStreams = await import(adapterUrl('utils.js'));
	const sdk = await import(pathToFileURL(createRequire(join(dist, 'serve.js')).resolve('@agentclientprotocol/sdk/experimental/v2')).href);
	router = serve.acpProtocolRouter;
	protocols = typeof serve.acpProtocolsFromEnv === 'function' ? serve.acpProtocolsFromEnv(realEnv.CLAUDE_AGENT_ACP_PROTOCOL) : 'auto';
	ndJsonStream = sdk.ndJsonStream;
	if (typeof router !== 'function' || typeof ndJsonStream !== 'function' || typeof webStreams.nodeToWebWritable !== 'function' || typeof webStreams.nodeToWebReadable !== 'function') {
		throw new Error('this adapter version cannot serve several connections');
	}
	// The managed-policy tier's variables, as the adapter's own entry applies them (best effort there too).
	const managed = await import(adapterUrl('managed-policy.js')).catch(() => undefined);
	await managed?.applyManagedPolicyEnv?.(undefined, realEnv);
} catch (error) {
	process.stderr.write('[volt] shared agent host cannot start: ' + (error?.stack || error) + '\n');
	process.exit(64);
}
const managedEnv = {};
for (const key of Object.keys(realEnv)) {
	if (startEnv[key] !== realEnv[key]) { managedEnv[key] = realEnv[key]; }
}

function openChat(id, options) {
	if (chats.has(id)) { return; }
	const chat = {
		id,
		// A sandboxed chat sees its sandbox launch's environment; any other the host's own.
		env: options.env ? { ...options.env, ...managedEnv } : undefined,
		base: options.env ? options.env : startEnv,
		cwd: typeof options.cwd === 'string' && options.cwd ? options.cwd : undefined,
		sandboxed: !!options.sandboxed,
		policy: options.policy,
		children: new Map(),
		spawned: 0,
		closed: false,
		input: new PassThrough(),
		output: new PassThrough(),
		agent: undefined,
		pending: '',
	};
	chats.set(id, chat);
	chat.output.setEncoding('utf8').on('data', data => {
		const lines = (chat.pending + data).split('\n');
		chat.pending = lines.pop();
		for (const line of lines) {
			if (line) { send('acp', id, line); }
		}
	});
	context.run(chat, () => {
		try {
			const onAgent = agent => { chat.agent = agent; };
			const connection = router(undefined, onAgent, protocols, { onV2Agent: onAgent }).connect(ndJsonStream(webStreams.nodeToWebWritable(chat.output), webStreams.nodeToWebReadable(chat.input)));
			Promise.resolve(connection?.closed).then(() => closeChat(id), () => closeChat(id));
		} catch (error) {
			log('chat ' + id + ' could not open: ' + (error?.stack || error));
			closeChat(id);
		}
	});
}

function closeChat(id) {
	const chat = chats.get(id);
	if (!chat || chat.closed) { return; }
	chat.closed = true;
	chats.delete(id);
	context.run(chat, () => {
		Promise.resolve().then(() => chat.agent?.dispose?.()).catch(error => log('chat ' + id + ' cleanup: ' + error)).finally(() => {
			for (const child of [...chat.children.values()]) { child.kill('SIGTERM'); }
			chat.input.end();
			send('closed', id, '-');
		});
	});
}

function onFrame(line) {
	const a = line.indexOf(' ');
	const b = line.indexOf(' ', a + 1);
	if (a < 0 || b < 0) { return; }
	const kind = line.slice(0, a);
	const id = line.slice(a + 1, b);
	const rest = line.slice(b + 1);
	if (kind === 'open') {
		openChat(id, JSON.parse(rest));
		return;
	}
	const chat = chats.get(id);
	if (!chat) { return; }
	if (kind === 'acp') {
		context.run(chat, () => chat.input.write(rest + '\n'));
	} else if (kind === 'close') {
		closeChat(id);
	} else if (kind === 'policy') {
		chat.policy = JSON.parse(rest);
	} else {
		const space = rest.indexOf(' ');
		const child = chat.children.get(Number(space < 0 ? rest : rest.slice(0, space)));
		const payload = space < 0 ? undefined : JSON.parse(rest.slice(space + 1));
		if (!child) { return; }
		context.run(chat, () => {
			if (kind === 'out') { child.stdout.write(payload); }
			else if (kind === 'err') { child.stderr.write(payload); }
			else if (kind === 'spawned') {
				if (payload.error) { child.emit('error', Object.assign(new Error(payload.error), { code: payload.code || 'ENOENT' })); child.ended(-2, null); }
				else { child.started(payload.pid); }
			}
			else if (kind === 'exit') { child.ended(payload.code, payload.signal); }
		});
	}
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
	const lines = (buffered + data).split('\n');
	buffered = lines.pop();
	for (const line of lines) {
		try { onFrame(line); } catch (error) { log('frame failed: ' + (error?.stack || error)); }
	}
});
// Volt is gone: nothing here may outlive it.
process.stdin.on('end', () => process.exit(0));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	process.on(signal, () => process.exit(0));
}
sealed = true;
send('ready', '-', '{}');
`;
