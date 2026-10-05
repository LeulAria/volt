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
	/** An unused spare is stopped after this long. */
	readonly ttlMs: number;
	readonly newAlias: () => string;
	readonly now?: () => number;
	readonly onError?: (err: unknown) => void;
}

interface IPoolEntry {
	readonly request: ISpareRequest;
	readonly alias: string;
	readonly createdAt: number;
	readonly ready: Promise<IAgentSessionHandle | undefined>;
	handle?: IAgentSessionHandle;
	settled: boolean;
	/** Handed to a chat while still starting: its handle belongs to the adopter. */
	taken?: boolean;
}

export class AgentPool extends Disposable {

	private readonly entries = new Map<string, IPoolEntry>();
	private sweepTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: IAgentPoolOptions) {
		super();
		this._register({ dispose: () => this.clear() });
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** A spare for `key` exists (ready or starting). */
	has(key: string): boolean {
		return this.entries.has(key);
	}

	get size(): number {
		return this.entries.size;
	}

	/** Starts a spare for `request.key` unless one is ready or on its way. */
	ensure(request: ISpareRequest): void {
		const existing = this.entries.get(request.key);
		if (existing && (!existing.settled || (existing.handle && request.isLive(existing.handle)))) {
			return;
		}
		if (existing) {
			this.drop(request.key);
		}
		while (this.entries.size >= this.options.maxSpares) {
			const oldest = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
			if (!oldest) {
				break;
			}
			this.drop(oldest[0]);
		}
		if (this.options.maxSpares <= 0) {
			return;
		}
		const alias = this.options.newAlias();
		const entry: IPoolEntry = {
			request,
			alias,
			createdAt: this.now(),
			settled: false,
			ready: request.start(alias).then(handle => {
				entry.settled = true;
				if (!entry.taken && this.entries.get(request.key) !== entry) {
					// Dropped (cleared, evicted, replaced) while starting.
					void request.dispose(handle).catch(err => this.options.onError?.(err));
					return undefined;
				}
				entry.handle = handle;
				return handle;
			}, err => {
				entry.settled = true;
				if (this.entries.get(request.key) === entry) {
					this.entries.delete(request.key);
				}
				this.options.onError?.(err);
				return undefined;
			}),
		};
		this.entries.set(request.key, entry);
		this.scheduleSweep();
	}

	/**
	 * Hands over the spare for `key`. A spare that is still starting is awaited: it is already
	 * further along than a new cold start would be. Undefined when there is none or it failed.
	 */
	async take(key: string): Promise<IPoolSpare | undefined> {
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		this.entries.delete(key);
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

	/** Ready spares, e.g. to push a new access policy onto them. */
	readySpares(): readonly { readonly providerId: string; readonly handle: IAgentSessionHandle }[] {
		return [...this.entries.values()].flatMap(entry => entry.handle ? [{ providerId: entry.request.providerId, handle: entry.handle }] : []);
	}

	/** Stops spares past their time to live. */
	sweep(): void {
		const now = this.now();
		for (const [key, entry] of [...this.entries]) {
			if (entry.settled && (now - entry.createdAt >= this.options.ttlMs || (entry.handle && !entry.request.isLive(entry.handle)))) {
				this.drop(key);
			}
		}
		this.scheduleSweep();
	}

	clear(): void {
		for (const key of [...this.entries.keys()]) {
			this.drop(key);
		}
		if (this.sweepTimer !== undefined) {
			clearTimeout(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	private drop(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		this.entries.delete(key);
		if (entry.handle) {
			void entry.request.dispose(entry.handle).catch(err => this.options.onError?.(err));
		}
		// A spare still starting is disposed by its own start callback once it settles.
	}

	private scheduleSweep(): void {
		if (this.sweepTimer !== undefined || !this.entries.size) {
			return;
		}
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = undefined;
			this.sweep();
		}, Math.min(this.options.ttlMs, 60_000));
	}
}
