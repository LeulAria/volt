/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAgentSessionHandle } from '../common/providers.js';

/**
 * Warm spare ACP sessions. A cursor-agent cold start costs about 5.5 s before the first prompt
 * (spawn, `initialize`, `session/new`) plus up to 2 s per config write, and a new chat pays all of
 * it. The pool keeps one fully set-up session per (provider, profile, model, options, folder) so a
 * new chat adopts a ready agent instead, and the spare is replaced in the background later.
 *
 * A spare is started under an alias session id (its host MCP server URL carries the alias); the
 * runtime maps the alias to the chat that adopts it.
 *
 * A burst ({@link IAgentPoolEnsureOptions.count} > 1) keeps several spares of one key for a short
 * while: subagents that start together (one delegate_task call with three tasks) each adopt one
 * instead of three cold starts on the critical path.
 */

export interface ISpareRequest {
	/** Same key, same kind of agent: provider, profile, catalog ref, resolved options, cwd. */
	readonly key: string;
	readonly providerId: string;
	/** Starts a fully set-up agent session bound to `alias` (access policy applied). */
	start(alias: string): Promise<IAgentSessionHandle>;
	dispose(handle: IAgentSessionHandle): Promise<void>;
	isLive(handle: IAgentSessionHandle): boolean;
}

export interface IPoolSpare {
	readonly key: string;
	readonly alias: string;
	readonly providerId: string;
	readonly handle: IAgentSessionHandle;
	/** Ms the adopter waited for a spare that was still starting; 0 when it was ready. */
	readonly waitedMs: number;
}

export interface IAgentPoolOptions {
	/** Spare processes kept across all keys; the oldest goes first. */
	readonly maxSpares: number;
	/** Extra room for a burst (see {@link IAgentPoolEnsureOptions.count}) on top of `maxSpares`. */
	readonly maxBurst?: number;
	/** An unused spare is stopped after this long. */
	readonly ttlMs: number;
	readonly newAlias: () => string;
	readonly now?: () => number;
	readonly onError?: (err: unknown) => void;
}

export interface IAgentPoolEnsureOptions {
	/** Spares wanted for this key (ready or starting); more than one is a burst. Default 1. */
	readonly count?: number;
	/** Time to live of the spares this call starts; default the pool's. */
	readonly ttlMs?: number;
	/** Part of a burst that spans keys (spares of one kind, and one of another): uses the burst room even for one spare. */
	readonly burst?: boolean;
}

interface IPoolEntry {
	readonly request: ISpareRequest;
	readonly alias: string;
	readonly createdAt: number;
	readonly ttlMs: number;
	readonly ready: Promise<IAgentSessionHandle | undefined>;
	handle?: IAgentSessionHandle;
	settled: boolean;
	/** Handed to a chat while still starting: its handle belongs to the adopter. */
	taken?: boolean;
}

export class AgentPool extends Disposable {

	/** Per key, oldest first. */
	private readonly entries = new Map<string, IPoolEntry[]>();
	private sweepTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: IAgentPoolOptions) {
		super();
		this._register({ dispose: () => this.clear() });
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private list(key: string): readonly IPoolEntry[] {
		return this.entries.get(key) ?? [];
	}

	/** A spare for `key` exists (ready or starting). */
	has(key: string): boolean {
		return this.list(key).length > 0;
	}

	/** A spare for `key` is up and can take a prompt now (not one still starting). */
	isReady(key: string): boolean {
		return this.list(key).some(entry => !!entry.handle && entry.request.isLive(entry.handle));
	}

	get size(): number {
		let size = 0;
		for (const list of this.entries.values()) {
			size += list.length;
		}
		return size;
	}

	/** Starts spares for `request.key` until `count` (default 1) are ready or on their way. */
	ensure(request: ISpareRequest, options?: IAgentPoolEnsureOptions): void {
		if (this.options.maxSpares <= 0) {
			return;
		}
		const count = Math.max(1, options?.count ?? 1);
		const cap = this.options.maxSpares + (count > 1 || options?.burst ? this.options.maxBurst ?? 0 : 0);
		for (const entry of this.list(request.key)) {
			if (entry.settled && !(entry.handle && request.isLive(entry.handle))) {
				this.drop(entry);
			}
		}
		for (let missing = count - this.list(request.key).length; missing > 0; missing--) {
			while (this.size >= cap) {
				// The oldest spare of another key goes first; this key's own are what was asked for.
				const oldest = [...this.entries.entries()].filter(([key]) => key !== request.key).flatMap(([, list]) => list).sort((a, b) => a.createdAt - b.createdAt)[0];
				if (!oldest) {
					break;
				}
				this.drop(oldest);
			}
			if (this.size >= cap) {
				break;
			}
			this.start(request, options?.ttlMs ?? this.options.ttlMs);
		}
		this.scheduleSweep();
	}

	private start(request: ISpareRequest, ttlMs: number): void {
		const alias = this.options.newAlias();
		const entry: IPoolEntry = {
			request,
			alias,
			createdAt: this.now(),
			ttlMs,
			settled: false,
			ready: request.start(alias).then(handle => {
				entry.settled = true;
				if (!entry.taken && !this.list(request.key).includes(entry)) {
					// Dropped (cleared, evicted, replaced) while starting.
					void request.dispose(handle).catch(err => this.options.onError?.(err));
					return undefined;
				}
				entry.handle = handle;
				return handle;
			}, err => {
				entry.settled = true;
				this.remove(entry);
				this.options.onError?.(err);
				return undefined;
			}),
		};
		this.entries.set(request.key, [...this.list(request.key), entry]);
	}

	/**
	 * Hands over a spare for `key`: a ready one first, else the oldest still starting, which is
	 * awaited (it is already further along than a new cold start would be). Undefined when there is
	 * none or it failed.
	 */
	async take(key: string): Promise<IPoolSpare | undefined> {
		const list = this.list(key);
		const entry = list.find(candidate => !!candidate.handle && candidate.request.isLive(candidate.handle)) ?? list.find(candidate => !candidate.settled) ?? list[0];
		if (!entry) {
			return undefined;
		}
		this.remove(entry);
		entry.taken = true;
		const started = this.now();
		const wasReady = entry.settled;
		const handle = entry.handle ?? await entry.ready.then(() => entry.handle);
		if (!handle) {
			return undefined;
		}
		if (!entry.request.isLive(handle)) {
			void entry.request.dispose(handle).catch(err => this.options.onError?.(err));
			return undefined;
		}
		return { key, alias: entry.alias, providerId: entry.request.providerId, handle, waitedMs: wasReady ? 0 : Math.max(0, this.now() - started) };
	}

	/** Stops the spares of `key`, ready or still starting. */
	discard(key: string): void {
		for (const entry of [...this.list(key)]) {
			this.drop(entry);
		}
	}

	/** Ready spares, e.g. to push a new access policy onto them. */
	readySpares(): readonly { readonly providerId: string; readonly handle: IAgentSessionHandle }[] {
		return [...this.entries.values()].flat().flatMap(entry => entry.handle ? [{ providerId: entry.request.providerId, handle: entry.handle }] : []);
	}

	/** Stops spares past their time to live. */
	sweep(): void {
		const now = this.now();
		for (const entry of [...this.entries.values()].flat()) {
			if (entry.settled && (now - entry.createdAt >= entry.ttlMs || (entry.handle && !entry.request.isLive(entry.handle)))) {
				this.drop(entry);
			}
		}
		this.scheduleSweep();
	}

	clear(): void {
		for (const entry of [...this.entries.values()].flat()) {
			this.drop(entry);
		}
		if (this.sweepTimer !== undefined) {
			clearTimeout(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	private remove(entry: IPoolEntry): void {
		const rest = this.list(entry.request.key).filter(candidate => candidate !== entry);
		if (rest.length) {
			this.entries.set(entry.request.key, rest);
		} else {
			this.entries.delete(entry.request.key);
		}
	}

	private drop(entry: IPoolEntry): void {
		if (!this.list(entry.request.key).includes(entry)) {
			return;
		}
		this.remove(entry);
		if (entry.handle) {
			void entry.request.dispose(entry.handle).catch(err => this.options.onError?.(err));
		}
		// A spare still starting is disposed by its own start callback once it settles.
	}

	private scheduleSweep(): void {
		if (this.sweepTimer !== undefined || !this.entries.size) {
			return;
		}
		const ttl = Math.min(...[...this.entries.values()].flat().map(entry => entry.ttlMs));
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = undefined;
			this.sweep();
		}, Math.min(ttl, 60_000));
	}
}
