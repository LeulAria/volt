/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { isAbsolute, normalize, sep } from '../../../base/common/path.js';
import { BrokerError, brokerEvaluate, ByteBudget, contextChain, IBroker, IBrokerAudit, IBrokerAuthority, IBrokerCallers } from '../../voltSandbox/common/broker.js';
import { ICallContext, IPrincipal, isFirstPartySubject } from '../../voltSandbox/common/principals.js';
import { GIT_BROKER_ENV, GIT_BROKER_LIMITS, gitBrokerCommand, GitBrokerArgsError, gitRemoteTarget, IGitBrokerCommand } from '../common/gitBroker.js';
import { IHostGitResult } from '../common/hostGit.js';
import { BuildEntryGuard, buildEntryGuard } from './buildEntryGuard.js';
import { IHostGitOptions, runHostGit } from './hostGit.js';

/**
 * The git broker (spec I.5, INV-16): git for plugins, through HostGit, behind the principal and its
 * capabilities.
 *
 * `run {repo, args, input?}`:
 *   1 the caller is a principal this host knows (the registry built the context);
 *   2 `repo` is the top of a work tree inside the folders core recorded for the principal (and for
 *     everyone it acts for); a planted `commondir`, `gitdir` or `alternates` is HostGit's refusal;
 *   3 `args` pass {@link gitBrokerCommand} (no global options, no option that runs a program or
 *     reaches a file elsewhere, only listed commands), which also gives the capability: `git.read`,
 *     `git.write`, or `git.push` on the remote's URL (`github.com/acme/app`), so a grant for one
 *     remote never covers another; a remote must be one the repository names, over https, ssh or
 *     git, or a local repository inside the principal's folders;
 *   4 the Authority decides (`evaluate`, with the chain);
 *   5 while the build-entry guard holds an unreviewed change to the repository's git config, hooks
 *     or attributes (which name programs git runs), nothing runs for a plugin;
 *   6 git runs with no hooks, no editor, pager or askpass, and capped output and time.
 */

export interface IGitScope {
	/** The principal's workspace folders, as real paths. */
	readonly roots: readonly string[];
	/** Where its repositories keep their common `.git` when that is outside a root (linked worktrees). */
	readonly gitRoots?: readonly string[];
	readonly platform: string;
}

export interface IGitBrokerOptions {
	readonly authority: IBrokerAuthority;
	readonly callers: IBrokerCallers;
	readonly audit: IBrokerAudit;
	/** Core's record of where a principal may run git (never the caller's say); undefined: nowhere. */
	readonly scope: (principal: IPrincipal) => IGitScope | undefined;
	readonly hostGit?: IHostGitOptions;
	/** Default: the shared guard under `~/.volt/trust`. */
	readonly guard?: BuildEntryGuard;
	readonly now?: () => number;
}

export interface IGitBrokerResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function fold(platform: string): boolean {
	return platform === 'darwin' || platform === 'win32';
}

function inside(path: string, root: string, caseInsensitive: boolean): boolean {
	const p = caseInsensitive ? normalize(path).toLowerCase() : normalize(path);
	const r = caseInsensitive ? normalize(root).toLowerCase() : normalize(root);
	return r !== sep && (p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`));
}

export class GitBroker implements IBroker {

	readonly id = 'git';
	private readonly running = new Map<string, number>();
	private readonly calls: ByteBudget;
	private readonly now: () => number;

	constructor(private readonly options: IGitBrokerOptions) {
		this.now = options.now ?? Date.now;
		this.calls = new ByteBudget(600, 60_000, this.now);
	}

	async handle(context: ICallContext, method: string, args: unknown): Promise<unknown> {
		if (method === 'run') {
			return this.run(context, args);
		}
		throw new BrokerError('invalid', `the git broker has no method ${String(method)}`);
	}

	run(context: ICallContext, args: unknown): Promise<IGitBrokerResult> {
		return this.audited(context, args, async () => {
			if (!args || typeof args !== 'object' || Array.isArray(args)) {
				throw new BrokerError('invalid', 'the arguments must be an object');
			}
			const input = args as Record<string, unknown>;
			let command: IGitBrokerCommand;
			try {
				command = gitBrokerCommand(input.args);
			} catch (err) {
				throw new BrokerError('invalid', err instanceof GitBrokerArgsError ? err.message : String(err));
			}
			if (input.input !== undefined && (typeof input.input !== 'string' || input.input.length > GIT_BROKER_LIMITS.input)) {
				throw new BrokerError('invalid', `input must be text of at most ${GIT_BROKER_LIMITS.input} characters`);
			}
			const scope = this.options.scope(context.principal);
			if (!scope) {
				throw new BrokerError('denied', 'this principal has no folders it may run git in');
			}
			const repo = await this.repository(context, scope, input.repo);
			const target = command.remote ? await this.remoteTarget(context, scope, repo, command) : repo;
			brokerEvaluate(this.options.authority, { capability: command.capability, target }, context);
			const guard = this.guard;
			const unreviewed = (await guard.changes(repo)).filter(change => change.group === 'git');
			if (unreviewed.length) {
				throw new BrokerError('denied', `git config, hooks or attributes changed in ${repo} while a sandboxed writer worked there (${unreviewed.map(change => change.path).slice(0, 3).join(', ')}); the user reviews them before git runs there for an extension`);
			}
			if (command.capability !== 'git.read' && !isFirstPartySubject(context.principal.subject)) {
				// It changes the work tree: what it writes to files that run code is shown before Volt runs them (I.6).
				await guard.snapshot(repo);
			}
			return this.limited(context.principal.id, async () => {
				const result = await this.git(repo, scope, [...command.args], typeof input.input === 'string' ? input.input : undefined);
				if (result.refused) {
					throw new BrokerError('denied', result.error ?? 'HostGit refused the repository');
				}
				if (result.error && result.exitCode === null) {
					throw new BrokerError('io', result.error);
				}
				return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
			});
		});
	}

	/** `repo` as the real path of a work tree's top folder inside the principal's (and its callers') folders. */
	private async repository(context: ICallContext, scope: IGitScope, raw: unknown): Promise<string> {
		if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\0')) {
			throw new BrokerError('invalid', 'repo must be an absolute path');
		}
		const real = await fs.realpath(raw).catch(() => undefined);
		if (!real) {
			throw new BrokerError('io', `${raw} does not exist`);
		}
		for (const [who, theirs] of [[context.principal, scope] as const, ...context.onBehalfOf.map(caller => [caller, this.options.scope(caller)] as const)]) {
			if (!theirs || !await this.within(real, theirs.roots, theirs.platform)) {
				throw new BrokerError('denied', who === context.principal ? `${raw} is outside the folders this principal may run git in` : `${raw} is outside the folders of ${who.subject}, on whose behalf this runs`);
			}
		}
		const top = await this.git(real, scope, ['rev-parse', '--show-toplevel']);
		if (top.refused) {
			throw new BrokerError('denied', top.error ?? 'HostGit refused the repository');
		}
		const toplevel = top.exitCode === 0 ? await fs.realpath(top.stdout.trim()).catch(() => undefined) : undefined;
		if (!toplevel || normalize(toplevel) !== normalize(real)) {
			throw new BrokerError('invalid', `${raw} is not the top folder of a git work tree`);
		}
		return real;
	}

	/** The push or fetch target: the URL(s) the named remote resolves to, each allowed and the same target. */
	private async remoteTarget(context: ICallContext, scope: IGitScope, repo: string, command: IGitBrokerCommand): Promise<string> {
		const urls = await this.git(repo, scope, ['remote', 'get-url', ...(command.capability === 'git.push' ? ['--push'] : []), '--all', command.remote!]);
		if (urls.refused) {
			throw new BrokerError('denied', urls.error ?? 'HostGit refused the repository');
		}
		const list = urls.exitCode === 0 ? urls.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
		if (!list.length) {
			throw new BrokerError('invalid', `${command.remote} is not a remote of ${repo}`);
		}
		const targets = new Set<string>();
		for (const url of list) {
			const remote = gitRemoteTarget(url);
			if (!remote) {
				throw new BrokerError('denied', `${command.remote} uses a transport the git broker never runs`);
			}
			if (remote.local !== undefined) {
				const real = await fs.realpath(remote.local).catch(() => undefined);
				if (!real || !await this.within(real, scope.roots, scope.platform)) {
					throw new BrokerError('denied', `${command.remote} is a repository outside the folders this principal may reach`);
				}
				targets.add(`file:${real}`);
			} else {
				targets.add(remote.target);
			}
		}
		if (targets.size !== 1) {
			throw new BrokerError('denied', `${command.remote} names more than one repository; push to each by its own remote`);
		}
		return [...targets][0];
	}

	private async within(path: string, roots: readonly string[], platform: string): Promise<boolean> {
		const real = await Promise.all(roots.filter(root => isAbsolute(root)).map(root => fs.realpath(root).catch(() => undefined)));
		return real.some(root => !!root && inside(path, root, fold(platform)));
	}

	private get guard(): BuildEntryGuard {
		return this.options.guard ?? this.options.hostGit?.guard ?? buildEntryGuard();
	}

	private async git(cwd: string, scope: IGitScope, args: string[], input?: string): Promise<IHostGitResult> {
		const expectedRoots = [...scope.roots, ...scope.gitRoots ?? []];
		return runHostGit({ cwd, args, env: { ...GIT_BROKER_ENV }, hooks: 'none', expectedRoots, timeoutMs: GIT_BROKER_LIMITS.timeoutMs, maxBytes: GIT_BROKER_LIMITS.outputBytes, ...(input !== undefined ? { input } : {}) }, { ...this.options.hostGit, guard: this.guard });
	}

	private async limited<T>(principal: string, run: () => Promise<T>): Promise<T> {
		const now = this.running.get(principal) ?? 0;
		if (now >= GIT_BROKER_LIMITS.concurrent) {
			throw new BrokerError('limit', `${GIT_BROKER_LIMITS.concurrent} git commands are running for this principal already`);
		}
		this.running.set(principal, now + 1);
		try {
			return await run();
		} finally {
			const left = (this.running.get(principal) ?? 1) - 1;
			if (left > 0) {
				this.running.set(principal, left);
			} else {
				this.running.delete(principal);
			}
		}
	}

	private async audited<T>(context: ICallContext, args: unknown, run: () => Promise<T>): Promise<T> {
		const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
		const sub = Array.isArray(input.args) && typeof input.args[0] === 'string' ? input.args[0].slice(0, 32) : '?';
		const target = typeof input.repo === 'string' ? `${input.repo} ${sub}` : undefined;
		const base = { ts: this.now(), broker: this.id, method: `run:${sub}`, principal: context.principal.id, subject: context.principal.subject, chain: contextChain(context), epoch: this.options.authority.epoch, ...(target ? { target } : {}) };
		try {
			if (!this.options.callers.verify(context)) {
				throw new BrokerError('unauthenticated', 'the call does not come from a principal this host knows');
			}
			if (!this.calls.take(context.principal.id, 1)) {
				throw new BrokerError('limit', 'more than 600 git calls in the last minute');
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
