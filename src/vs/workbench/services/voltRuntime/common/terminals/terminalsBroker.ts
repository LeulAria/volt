/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { posix } from '../../../../../base/common/path.js';
import { BrokerError, brokerEvaluate, ByteBudget, contextChain, IBroker, IBrokerAudit, IBrokerAuthority, IBrokerCallers } from '../../../../../platform/voltSandbox/common/broker.js';
import { ICallContext, IPrincipal, isChatSubject, subjectChatId, SubjectKey } from '../../../../../platform/voltSandbox/common/principals.js';
import { isPathInside, IVoltSandboxRequest } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IChatExec } from '../execContext.js';
import { IAgentTerminalInfo, ManagedTerminals } from './managedTerminals.js';

/**
 * The terminals broker (spec I.7): terminals for principals, never wider than the caller.
 *
 * - `run` (`terminals.run`) starts the command under the **caller's** principal: a chat's in the
 *   chat's own sandbox with its rules (N.1 #10); anyone else's (a plugin's, a feature's) always in
 *   a sandbox scoped to the folders core recorded for it, writable only when the Authority gives it
 *   `files.write`, with its network limited to the hosts core recorded. A plugin acting for a chat
 *   gets the narrower of the two on every dimension (level, network, hosts, folders). A principal
 *   that is not a chat never gets an unsandboxed terminal.
 * - `read` (`terminals.read`) covers the caller's own terminals; a chat's terminal the caller does
 *   not act for needs `agents.read:other` on that chat. The user's own terminals (and Volt's) stay
 *   outside: never readable through the broker.
 * - `send` and `stop` only on the caller's own terminals; a revoked principal's terminals stop.
 * - Every call is audited; the command is the redacted target.
 */

export const TERMINALS_BROKER_LIMITS = Object.freeze({
	/** Live terminals one principal started. */
	live: 8,
	callsPerMinute: 600,
	commandLength: 8192,
	sendLength: 16 * 1024,
	readChars: 64 * 1024,
});

/** Where a principal that is not a chat may run commands, as core recorded it (never the caller's say). */
export interface ITerminalsScope {
	/** Its workspace folders, as real paths. */
	readonly roots: readonly string[];
	/** Hosts its `net.connect` grants name (the sandbox's network is otherwise off). */
	readonly allowedDomains?: readonly string[];
}

export type ITerminalsBrokerHost = Pick<ManagedTerminals, 'start' | 'stop' | 'managed' | 'list'>;

export interface ITerminalsBrokerOptions {
	readonly authority: IBrokerAuthority;
	readonly callers: IBrokerCallers;
	readonly audit: IBrokerAudit;
	readonly terminals: ITerminalsBrokerHost;
	/** A chat's processes as the runtime records them: its sandbox with its rules; undefined: Volt knows no such chat. */
	readonly chatExec: (chatId: string) => IChatExec | undefined;
	readonly scope: (principal: IPrincipal) => ITerminalsScope | undefined;
	readonly now?: () => number;
}

interface IStarted {
	readonly subject: SubjectKey;
	readonly principalId: string;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new BrokerError('invalid', 'the arguments must be an object');
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number, optional = false): string | undefined {
	if (value === undefined && optional) {
		return undefined;
	}
	if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || value.includes('\0')) {
		throw new BrokerError('invalid', `${name} must be text of at most ${max} characters`);
	}
	return value;
}

function normalized(path: string): string {
	return posix.normalize(path.replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
}

/** The narrower of two sandboxes on every dimension, or undefined when they share no folder. */
export function narrowerSandbox(a: IVoltSandboxRequest, b: IVoltSandboxRequest): IVoltSandboxRequest | undefined {
	const inBoth = (path: string, roots: readonly string[]) => roots.some(root => isPathInside(normalized(path), normalized(root)));
	const roots = [...new Set([...a.workspaceRoots.filter(root => inBoth(root, b.workspaceRoots)), ...b.workspaceRoots.filter(root => inBoth(root, a.workspaceRoots))])];
	if (!roots.length) {
		return undefined;
	}
	const extra = (a.extraWritableRoots ?? []).filter(root => inBoth(root, b.extraWritableRoots ?? []));
	const domains = (a.allowedDomains ?? []).filter(domain => (b.allowedDomains ?? []).includes(domain));
	return {
		level: a.level === 'read-only' || b.level === 'read-only' ? 'read-only' : 'workspace-write',
		network: a.network && b.network,
		providerId: '',
		workspaceRoots: roots,
		...(extra.length ? { extraWritableRoots: extra } : {}),
		...(domains.length ? { allowedDomains: domains } : {}),
	};
}

export class TerminalsBroker implements IBroker, IDisposable {

	readonly id = 'terminals';
	/** Terminals this broker started, and for whom. */
	private readonly started = new Map<string, IStarted>();
	private readonly calls: ByteBudget;
	private readonly now: () => number;
	private readonly revocation: IDisposable;

	constructor(private readonly options: ITerminalsBrokerOptions) {
		this.now = options.now ?? Date.now;
		this.calls = new ByteBudget(TERMINALS_BROKER_LIMITS.callsPerMinute, 60_000, this.now);
		this.revocation = options.callers.onDidRevoke?.(principal => this.revokePrincipal(principal.id)) ?? toDisposable(() => { });
	}

	dispose(): void {
		this.revocation.dispose();
	}

	async handle(context: ICallContext, method: string, args: unknown): Promise<unknown> {
		switch (method) {
			case 'run': return this.run(context, args);
			case 'list': return this.list(context);
			case 'read': return this.read(context, args);
			case 'send': return this.send(context, args);
			case 'stop': return this.stop(context, args);
		}
		throw new BrokerError('invalid', `the terminals broker has no method ${String(method)}`);
	}

	run(context: ICallContext, args: unknown): Promise<IAgentTerminalInfo> {
		return this.audited(context, 'run', args, async () => {
			const input = record(args);
			const command = text(input.command, 'command', TERMINALS_BROKER_LIMITS.commandLength)!.trim();
			const label = text(input.label, 'label', 200, true);
			const readyPattern = text(input.readyPattern, 'readyPattern', 500, true);
			const requestedCwd = text(input.cwd, 'cwd', 4096, true);
			brokerEvaluate(this.options.authority, { capability: 'terminals.run', target: command }, context);
			const live = [...this.started.entries()].filter(([id, owner]) => owner.principalId === context.principal.id && this.isLive(id)).length;
			if (live >= TERMINALS_BROKER_LIMITS.live) {
				throw new BrokerError('limit', `${TERMINALS_BROKER_LIMITS.live} terminals are running for this principal already: stop one first`);
			}
			const { owner, exec } = this.execFor(context);
			const roots = exec.sandbox?.workspaceRoots ?? [];
			const cwd = requestedCwd ?? roots[0];
			if (requestedCwd !== undefined && (!posix.isAbsolute(normalized(requestedCwd)) || (exec.sandbox && !roots.some(root => isPathInside(normalized(requestedCwd), normalized(root)))))) {
				throw new BrokerError('denied', `${requestedCwd} is outside the folders this terminal may run in`);
			}
			const info = await this.options.terminals.start(owner, { command, ...(label ? { label } : {}), ...(cwd ? { cwd } : {}), ...(readyPattern ? { readyPattern } : {}), exec });
			this.started.set(info.id, { subject: context.principal.subject, principalId: context.principal.id });
			return info;
		});
	}

	/** The caller's own terminals (those it started; for a chat, every terminal of the chat). */
	list(context: ICallContext): Promise<readonly IAgentTerminalInfo[]> {
		return this.audited(context, 'list', undefined, async () => {
			brokerEvaluate(this.options.authority, { capability: 'terminals.read' }, context);
			const chat = subjectChatId(context.principal.subject);
			const out: IAgentTerminalInfo[] = [];
			for (const [id, owner] of this.started) {
				const terminal = this.options.terminals.managed(id);
				if (terminal && owner.subject === context.principal.subject) {
					out.push(terminal.info());
				}
			}
			if (chat) {
				for (const info of this.chatTerminals(chat)) {
					if (!out.some(known => known.id === info.id)) {
						out.push(info);
					}
				}
			}
			return out;
		});
	}

	read(context: ICallContext, args: unknown): Promise<{ readonly text: string; readonly offset: number; readonly info: IAgentTerminalInfo }> {
		return this.audited(context, 'read', args, async () => {
			const input = record(args);
			const terminal = this.terminal(input.id);
			const owner = this.ownerOf(terminal.id);
			const chain = [...context.onBehalfOf.map(caller => caller.subject), context.principal.subject];
			if (!owner || owner === 'user' || owner === 'volt') {
				// The user's own terminals and Volt's stay outside, by design (I.7).
				throw new BrokerError('handle', 'not a terminal this caller may read');
			}
			if (owner === context.principal.subject || (isChatSubject(owner) && chain.includes(owner))) {
				brokerEvaluate(this.options.authority, { capability: 'terminals.read', target: terminal.id }, context);
			} else if (isChatSubject(owner)) {
				brokerEvaluate(this.options.authority, { capability: 'terminals.read', target: terminal.id }, context);
				brokerEvaluate(this.options.authority, { capability: 'agents.read:other', target: owner }, context);
			} else {
				throw new BrokerError('handle', 'not a terminal this caller may read');
			}
			const offset = input.offset === undefined ? undefined : typeof input.offset === 'number' && Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : -1;
			if (offset === -1) {
				throw new BrokerError('invalid', 'offset must be a whole number');
			}
			const all = offset === undefined ? terminal.log.tail(TERMINALS_BROKER_LIMITS.readChars) : terminal.log.since(offset);
			return { text: all.length > TERMINALS_BROKER_LIMITS.readChars ? all.slice(0, TERMINALS_BROKER_LIMITS.readChars) : all, offset: terminal.log.total, info: terminal.info() };
		});
	}

	send(context: ICallContext, args: unknown): Promise<void> {
		return this.audited(context, 'send', args, async () => {
			const input = record(args);
			const terminal = this.own(context, input.id);
			const value = text(input.text, 'text', TERMINALS_BROKER_LIMITS.sendLength)!;
			brokerEvaluate(this.options.authority, { capability: 'terminals.run', target: terminal.id }, context);
			if (!terminal.process || !this.isLive(terminal.id)) {
				throw new BrokerError('io', `${terminal.id} is not running`);
			}
			await terminal.process.sendText(value, input.enter !== false);
		});
	}

	stop(context: ICallContext, args: unknown): Promise<void> {
		return this.audited(context, 'stop', args, async () => {
			const terminal = this.own(context, record(args).id);
			brokerEvaluate(this.options.authority, { capability: 'terminals.run', target: terminal.id }, context);
			await this.options.terminals.stop(terminal.id);
		});
	}

	/** A revoked principal's terminals stop now (F.9). */
	revokePrincipal(principalId: string): void {
		for (const [id, owner] of [...this.started]) {
			if (owner.principalId === principalId) {
				void this.options.terminals.stop(id).catch(() => undefined);
			}
		}
	}

	// --- who a terminal runs for ----------------------------------------------------------------

	/**
	 * The chat whose terminals list shows it, and how it runs: a chat's in its own sandbox; anyone
	 * else's sandboxed to its scope, and to the narrower of that and the chat it acts for.
	 */
	private execFor(context: ICallContext): { readonly owner: string; readonly exec: IChatExec } {
		const principal = context.principal;
		const chatCaller = [...context.onBehalfOf].reverse().find(caller => isChatSubject(caller.subject));
		const callerChat = chatCaller ? this.chatExecOf(chatCaller.subject) : undefined;
		if (isChatSubject(principal.subject)) {
			const exec = this.chatExecOf(principal.subject);
			if (callerChat?.sandbox && exec.sandbox) {
				const narrower = narrowerSandbox(exec.sandbox, callerChat.sandbox);
				if (!narrower) {
					throw new BrokerError('denied', 'the chats in this call share no folder to run in');
				}
				return { owner: subjectChatId(principal.subject)!, exec: { context: exec.context, sandbox: narrower } };
			}
			return { owner: subjectChatId(principal.subject)!, exec: callerChat?.sandbox ? callerChat : exec };
		}
		const scope = this.options.scope(principal);
		if (!scope?.roots.length) {
			throw new BrokerError('denied', 'this principal has no folders it may run commands in');
		}
		const writable = scope.roots.every(root => this.options.authority.evaluate({ capability: 'files.write', target: root, surface: 'broker' }, context).allow);
		let sandbox: IVoltSandboxRequest | undefined = {
			level: writable ? 'workspace-write' : 'read-only',
			network: false,
			providerId: '',
			workspaceRoots: [...scope.roots],
			...(scope.allowedDomains?.length ? { allowedDomains: [...scope.allowedDomains] } : {}),
		};
		if (callerChat?.sandbox) {
			sandbox = narrowerSandbox(sandbox, callerChat.sandbox);
			if (!sandbox) {
				throw new BrokerError('denied', `this principal and the chat it acts for share no folder to run in`);
			}
		}
		const onBehalfOf = chatCaller ? subjectChatId(chatCaller.subject) : undefined;
		return {
			owner: onBehalfOf ?? principal.subject,
			exec: { context: { principal: 'volt', reason: 'terminal', sandboxed: true, ...(onBehalfOf ? { onBehalfOf } : {}) }, sandbox },
		};
	}

	private chatExecOf(subject: SubjectKey): IChatExec {
		const exec = this.options.chatExec(subjectChatId(subject)!);
		if (!exec) {
			throw new BrokerError('denied', `Volt has no record of ${subject}`);
		}
		return exec;
	}

	private terminal(id: unknown) {
		const terminal = typeof id === 'string' && id.length <= 128 ? this.options.terminals.managed(id) : undefined;
		if (!terminal) {
			throw new BrokerError('handle', 'not a terminal this caller may read');
		}
		return terminal;
	}

	/** Who a terminal is for: the principal that started it through the broker, else the chat or user its process runs for. */
	private ownerOf(id: string): SubjectKey | 'volt' | undefined {
		const started = this.started.get(id);
		if (started) {
			return started.subject;
		}
		const principal = this.options.terminals.managed(id)?.exec?.context.principal;
		return principal === undefined ? 'user' : principal;
	}

	private own(context: ICallContext, id: unknown) {
		const terminal = this.terminal(id);
		const owner = this.ownerOf(terminal.id);
		if (owner !== context.principal.subject) {
			throw new BrokerError('handle', 'not a terminal of this caller');
		}
		return terminal;
	}

	private chatTerminals(chatId: string): IAgentTerminalInfo[] {
		const out: IAgentTerminalInfo[] = [];
		for (const info of this.options.terminals.list(chatId)) {
			if (this.ownerOf(info.id) === `chat:${chatId}`) {
				out.push(info);
			}
		}
		return out;
	}

	private isLive(id: string): boolean {
		const status = this.options.terminals.managed(id)?.status;
		return status === 'starting' || status === 'running' || status === 'ready' || status === 'attention' || status === 'stopping';
	}

	private async audited<T>(context: ICallContext, method: string, args: unknown, run: () => Promise<T>): Promise<T> {
		const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
		const target = typeof input.command === 'string' ? input.command.slice(0, 256) : typeof input.id === 'string' ? input.id.slice(0, 128) : undefined;
		const base = { ts: this.now(), broker: this.id, method, principal: context.principal.id, subject: context.principal.subject, chain: contextChain(context), epoch: this.options.authority.epoch, ...(target ? { target } : {}) };
		try {
			if (!this.options.callers.verify(context)) {
				throw new BrokerError('unauthenticated', 'the call does not come from a principal this host knows');
			}
			if (!this.calls.take(context.principal.id, 1)) {
				throw new BrokerError('limit', `more than ${TERMINALS_BROKER_LIMITS.callsPerMinute} terminal calls in the last minute`);
			}
			const result = await run();
			this.options.audit.record({ ...base, decision: 'allow' });
			return result;
		} catch (err) {
			const error = err instanceof BrokerError ? err : new BrokerError('io', err instanceof Error ? err.message : String(err));
			this.options.audit.record({ ...base, decision: 'deny', code: error.code, ...(error.decision?.deniedBy ? { deniedBy: error.decision.deniedBy } : {}) });
			throw error;
		}
	}
}
