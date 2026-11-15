/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { generateUuid } from '../../../base/common/uuid.js';
import type { IResolvedSandboxPolicy } from '../../voltSandbox/common/sandboxResolved.js';
import { ACP_HOST_LINGER_MS, AcpHostFrame, acpSharedHostSource } from '../common/acpSharedHostSource.js';
import type { IVoltStdioSpawnOptions } from '../common/voltStdio.js';

/** What the stdio service does for the hosts: it owns the sandbox, the child ledger and the events. */
export interface IAcpSharedHostDelegate {
	/** The environment every child starts from (the login shell's). */
	hostEnv(): Promise<NodeJS.ProcessEnv>;
	/**
	 * What a sandboxed chat's launch resolves to: its environment (its own config overlay) and its file
	 * rules. Undefined for a chat without a sandbox. Throws as a spawn would when the sandbox refuses.
	 */
	sandboxView(options: IVoltStdioSpawnOptions): Promise<{ readonly env: Record<string, string>; readonly policy: IResolvedSandboxPolicy } | undefined>;
	/**
	 * Starts a chat's process (its Claude Code CLI) as `spawn` starts an agent: through the chat's sandbox
	 * launch when it has one, registered under the chat's id. `unset`: variables the adapter removed.
	 * `helper`: a short command (`execFile`: a sign-in probe, git), not the chat's CLI.
	 */
	startChild(id: string, options: IVoltStdioSpawnOptions, unset: readonly string[], helper: boolean): Promise<{ readonly child: ChildProcessWithoutNullStreams; readonly policy?: IResolvedSandboxPolicy }>;
	/** Stops a chat's process and everything it started (the whole sandbox). */
	stopChild(id: string, child: ChildProcess): void;
	/** Output of a chat's connection, and its end, as a process's stdout and exit. */
	data(id: string, text: string): void;
	exited(id: string, code: number | null, stderr?: string): void;
	/** A process this service started (the host itself), for the crash ledger. */
	track(child: ChildProcess, command: string): void;
	stopTree(child: ChildProcess): void;
	log(level: 'info' | 'warn', message: string): void;
}

interface IHost {
	readonly key: string;
	readonly child: ChildProcessWithoutNullStreams;
	/** Whether the adapter loaded: false when this adapter cannot be shared (another version). */
	readonly ready: Promise<boolean>;
	readonly chats: Set<string>;
	stderr: string;
	/** Set while it has no chat: it is stopped when this fires. */
	idle?: ReturnType<typeof setTimeout>;
}

interface IChat {
	readonly id: string;
	readonly host: IHost;
	readonly options: IVoltStdioSpawnOptions;
	readonly children: Map<number, ChildProcessWithoutNullStreams>;
	/** Input not yet ending in a newline. */
	pending: string;
}

/** How long a host may take to load the adapter before chats stop waiting for it. */
const HOST_READY_TIMEOUT_MS = 20_000;

/**
 * Shared ACP adapter hosts (see `acpSharedHostSource.ts`): one process serves the adapter for every
 * chat with the same launch, and each chat gets a virtual process id that the stdio service treats
 * like a process of its own (`write`, `kill`, `onData`, `onExit`, and the sandbox calls by id).
 */
export class AcpSharedHosts {

	private readonly hosts = new Map<string, IHost>();
	private readonly chats = new Map<string, IChat>();
	/** Launches whose host did not come up: their chats run on a process each, as before. */
	private readonly unusable = new Set<string>();

	constructor(private readonly delegate: IAcpSharedHostDelegate) { }

	has(id: string): boolean {
		return this.chats.has(id);
	}

	/** A live chat of a host that runs without a sandbox (its file requests are unconfined). */
	isUnconfined(id: string): boolean {
		const chat = this.chats.get(id);
		return !!chat && !chat.options.sandbox;
	}

	get hostCount(): number {
		return this.hosts.size;
	}

	/**
	 * Opens a connection for a chat on the host of its launch, starting the host when there is none.
	 * Resolves with the chat's virtual process id, or undefined when this launch cannot be shared.
	 */
	async open(options: IVoltStdioSpawnOptions, entry: string): Promise<string | undefined> {
		const key = JSON.stringify([options.command, options.args ?? [], entry, Object.entries(options.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
		if (this.unusable.has(key)) {
			return undefined;
		}
		// The sandbox is judged before anything opens: a refusal is the spawn's, typed, as before.
		const view = await this.delegate.sandboxView(options);
		let host = this.hosts.get(key);
		if (!host) {
			host = await this.start(key, options, entry);
		}
		if (!await host.ready) {
			this.unusable.add(key);
			return undefined;
		}
		if (this.hosts.get(key) !== host) {
			// It left (its last chat closed) between the check and now: once more, on a new one.
			return this.open(options, entry);
		}
		clearTimeout(host.idle);
		host.idle = undefined;
		const id = generateUuid();
		const chat: IChat = { id, host, options, children: new Map(), pending: '' };
		this.chats.set(id, chat);
		host.chats.add(id);
		this.send(host, AcpHostFrame.Open, id, JSON.stringify(view ? { sandboxed: true, env: view.env, policy: view.policy } : {}));
		return id;
	}

	private async start(key: string, options: IVoltStdioSpawnOptions, entry: string): Promise<IHost> {
		const env = { ...await this.delegate.hostEnv(), ...options.env };
		const existing = this.hosts.get(key);
		if (existing) {
			return existing;
		}
		// `node [--import <preload>] --input-type=module -e <host> <entry>`: the launch's own node and flags.
		const args = [...(options.args ?? []).filter(arg => arg !== entry), '--input-type=module', '-e', acpSharedHostSource(), entry];
		const child = spawn(options.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }) as ChildProcessWithoutNullStreams;
		this.delegate.track(child, options.command);
		let settle: (ready: boolean) => void;
		const ready = new Promise<boolean>(resolve => settle = resolve);
		const host: IHost = { key, child, ready, chats: new Set(), stderr: '' };
		this.hosts.set(key, host);
		const giveUp = setTimeout(() => settle(false), HOST_READY_TIMEOUT_MS);
		void ready.then(ok => {
			clearTimeout(giveUp);
			if (!ok) {
				this.delegate.log('warn', `[volt-acp-host] the shared agent host did not start; chats run on a process each. ${host.stderr.trim().split('\n').pop() ?? ''}`);
				this.delegate.stopTree(child);
			}
		});
		let buffered = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (data: string) => {
			const lines = (buffered + data).split('\n');
			buffered = lines.pop() ?? '';
			for (const line of lines) {
				try {
					this.onFrame(host, line, settle);
				} catch (err) {
					this.delegate.log('warn', `[volt-acp-host] bad frame: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (data: string) => host.stderr = `${host.stderr}${data}`.slice(-4_000));
		child.stdin.on('error', () => undefined);
		child.on('error', err => {
			host.stderr = `${host.stderr}${err.message}\n`;
			settle(false);
		});
		child.on('close', code => {
			settle(false);
			if (this.hosts.get(key) === host) {
				this.hosts.delete(key);
			}
			// Every chat it served ends as its own process would have: the chats resume on a new host.
			for (const id of [...host.chats]) {
				this.end(id, code, host.stderr);
			}
		});
		this.delegate.log('info', `[volt-acp-host] started pid ${child.pid} for ${entry}`);
		return host;
	}

	private send(host: IHost, kind: AcpHostFrame, id: string, payload: string): void {
		if (host.child.stdin.writable) {
			host.child.stdin.write(`${kind} ${id} ${payload}\n`);
		}
	}

	private onFrame(host: IHost, line: string, settle: (ready: boolean) => void): void {
		const a = line.indexOf(' ');
		const b = line.indexOf(' ', a + 1);
		if (a < 0 || b < 0) {
			return;
		}
		const kind = line.slice(0, a);
		const id = line.slice(a + 1, b);
		const rest = line.slice(b + 1);
		if (kind === AcpHostFrame.Ready) {
			settle(true);
			return;
		}
		if (kind === AcpHostFrame.Log) {
			this.delegate.log('info', `[volt-acp-host] ${String(JSON.parse(rest))}`);
			return;
		}
		// Only a chat of this very host: a host never speaks for another one's chats.
		const chat = this.chats.get(id);
		if (!chat || chat.host !== host) {
			return;
		}
		if (kind === AcpHostFrame.Acp) {
			this.delegate.data(id, `${rest}\n`);
			return;
		}
		if (kind === AcpHostFrame.Closed) {
			this.end(id, 0);
			return;
		}
		const space = rest.indexOf(' ');
		const n = Number(space < 0 ? rest : rest.slice(0, space));
		const payload = space < 0 ? '' : rest.slice(space + 1);
		if (kind === AcpHostFrame.Spawn) {
			void this.spawnChild(chat, n, JSON.parse(payload));
			return;
		}
		const child = chat.children.get(n);
		if (!child) {
			return;
		}
		if (kind === AcpHostFrame.In) {
			if (child.stdin.writable) {
				child.stdin.write(JSON.parse(payload) as string);
			}
		} else if (kind === AcpHostFrame.End) {
			child.stdin.end();
		} else if (kind === AcpHostFrame.Kill) {
			this.delegate.stopChild(id, child);
		}
	}

	private async spawnChild(chat: IChat, n: number, request: { command?: unknown; args?: unknown; cwd?: unknown; env?: unknown; unset?: unknown; exec?: unknown }): Promise<void> {
		const { id, host, options } = chat;
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
		const env: Record<string, string> = { ...options.env };
		for (const [key, value] of Object.entries(request.env && typeof request.env === 'object' ? request.env : {})) {
			if (typeof value === 'string') {
				env[key] = value;
			}
		}
		try {
			if (typeof request.command !== 'string' || !request.command) {
				throw new Error('no command');
			}
			const started = await this.delegate.startChild(id, {
				command: request.command,
				args: strings(request.args),
				cwd: typeof request.cwd === 'string' ? request.cwd : options.cwd,
				env,
				...(options.sandbox ? { sandbox: options.sandbox } : {}),
				context: options.context,
			}, strings(request.unset), request.exec === true);
			const child = started.child;
			if (this.chats.get(id) !== chat) {
				// The chat closed while its process started.
				this.delegate.stopChild(id, child);
				return;
			}
			chat.children.set(n, child);
			if (started.policy) {
				this.send(host, AcpHostFrame.Policy, id, JSON.stringify(started.policy));
			}
			this.send(host, AcpHostFrame.Spawned, id, `${n} ${JSON.stringify({ pid: child.pid })}`);
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (data: string) => this.send(host, AcpHostFrame.Out, id, `${n} ${JSON.stringify(data)}`));
			child.stderr.on('data', (data: string) => this.send(host, AcpHostFrame.Err, id, `${n} ${JSON.stringify(data)}`));
			child.stdin.on('error', () => undefined);
			child.on('error', err => this.delegate.log('warn', `[volt-acp-host] ${id} child: ${err.message}`));
			// 'close' waits for stdout to drain: the exit never overtakes the output.
			child.on('close', (code, signal) => {
				if (chat.children.get(n) === child) {
					chat.children.delete(n);
				}
				this.delegate.stopChild(id, child);
				this.send(host, AcpHostFrame.Exit, id, `${n} ${JSON.stringify({ code, signal })}`);
			});
		} catch (err) {
			this.send(host, AcpHostFrame.Spawned, id, `${n} ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}`);
		}
	}

	/** One or more ACP lines for the chat's connection. */
	write(id: string, data: string): void {
		const chat = this.chats.get(id);
		if (!chat) {
			throw new Error('ACP process is not writable');
		}
		const lines = (chat.pending + data).split('\n');
		chat.pending = lines.pop() ?? '';
		for (const line of lines) {
			if (line) {
				this.send(chat.host, AcpHostFrame.Acp, id, line);
			}
		}
	}

	/** Ends the chat's connection and its processes; the chat's exit is reported like a process's. */
	kill(id: string): void {
		const chat = this.chats.get(id);
		if (chat) {
			this.send(chat.host, AcpHostFrame.Close, id, '-');
			this.end(id, null);
		}
	}

	private end(id: string, code: number | null, stderr?: string): void {
		const chat = this.chats.get(id);
		if (!chat) {
			return;
		}
		this.chats.delete(id);
		chat.host.chats.delete(id);
		for (const child of chat.children.values()) {
			this.delegate.stopChild(id, child);
		}
		this.delegate.exited(id, code, stderr);
		this.stopWhenIdle(chat.host);
	}

	/**
	 * A host without chats is stopped after {@link ACP_HOST_LINGER_MS}. It leaves the map first, so a chat
	 * that opens from then on starts a new host instead of writing to one that is going.
	 */
	private stopWhenIdle(host: IHost): void {
		if (host.chats.size || host.idle || this.hosts.get(host.key) !== host) {
			return;
		}
		host.idle = setTimeout(() => {
			host.idle = undefined;
			if (host.chats.size || this.hosts.get(host.key) !== host) {
				return;
			}
			this.hosts.delete(host.key);
			// Its stdin's end is its exit (a normal one: Node writes its compile cache); then the tree, if it stays.
			host.child.stdin.end();
			setTimeout(() => this.delegate.stopTree(host.child), 1_000);
		}, ACP_HOST_LINGER_MS);
	}

	ids(): string[] {
		return [...this.chats.keys()];
	}

	dispose(): void {
		for (const id of [...this.chats.keys()]) {
			this.kill(id);
		}
		for (const host of this.hosts.values()) {
			clearTimeout(host.idle);
			this.delegate.stopTree(host.child);
		}
		this.hosts.clear();
	}
}
