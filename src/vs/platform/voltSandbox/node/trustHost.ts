/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { SubjectKey } from '../common/principals.js';
import { ITrustChange, ITrustCommitResult, ITrustHistoryEntry, ITrustState, mergeTrustHistory, TRUST_HISTORY_PARSERS, TrustHistorySource, trustChangeRefusal } from '../common/trust.js';
import { GrantStore } from './grantStore.js';

/**
 * The grant store on an execution host (spec P4): opened on first use, watched so another Volt
 * process's commits reach this one's brokers, and the files the Access page's history comes from
 * (`~/.volt/trust`, denied to every sandbox by the credential floor):
 *
 * - `grants.json`: the grant store (C2);
 * - `decisions/decisions.log`: the Authority's decision log (C2, G.11);
 * - `audit/network.log`: the network broker's audit log (C3);
 * - `audit/brokers.log`: the files, secrets, git and terminals brokers' audit log (P3; targets are salted hashes).
 */

export const DEFAULT_TRUST_DIR = join(homedir(), '.volt', 'trust');

/** How much of the end of each log the history reads. */
const HISTORY_TAIL_BYTES = 256 * 1024;

export class TrustHost extends Disposable {

	private opened: Promise<GrantStore> | undefined;
	private readonly listener = this._register(new MutableDisposable());
	private readonly watcher = this._register(new MutableDisposable());
	private readonly _onDidChange = this._register(new Emitter<{ readonly epoch: number; readonly narrowed: boolean }>());
	readonly onDidChange = this._onDidChange.event;

	constructor(readonly dir = DEFAULT_TRUST_DIR, private readonly options: { readonly watch?: boolean } = {}) {
		super();
	}

	get storePath(): string {
		return join(this.dir, 'grants.json');
	}

	/** The store, opened (and watched) once. */
	store(): Promise<GrantStore> {
		this.opened ??= GrantStore.open(this.storePath).then(store => {
			if (this._store.isDisposed) {
				store.dispose();
				throw new Error('the trust host is disposed');
			}
			this._register(store);
			this.listener.value = store.onDidChange(event => this._onDidChange.fire({ epoch: event.epoch, narrowed: event.narrowed }));
			if (this.options.watch !== false) {
				this.watcher.value = store.watch();
			}
			return store;
		});
		return this.opened;
	}

	async state(): Promise<ITrustState> {
		const store = await this.store();
		await store.reload();
		const data = store.data;
		return { epoch: data.epoch, status: store.status, readOnly: store.readOnly, notes: store.notes, grants: data.grants, refusals: data.refusals };
	}

	/** A window's change: user grants only (see `trustChangeRefusal`), applied on the latest epoch. */
	async commit(change: ITrustChange): Promise<ITrustCommitResult> {
		const refusal = trustChangeRefusal(change);
		if (refusal) {
			throw new Error(refusal);
		}
		const store = await this.store();
		const before = store.epoch;
		const epoch = await store.update(change);
		return { epoch, changed: epoch !== before };
	}

	/** The newest `limit` entries of the decision log and the audit logs (and one rotation of each), newest first. */
	async history(limit: number, subject?: SubjectKey): Promise<ITrustHistoryEntry[]> {
		const files: readonly [TrustHistorySource, string][] = [
			['decision', join(this.dir, 'decisions', 'decisions.log')],
			['decision', join(this.dir, 'decisions', 'decisions.1.log')],
			['network', join(this.dir, 'audit', 'network.log')],
			['network', join(this.dir, 'audit', 'network.log.1')],
			['broker', join(this.dir, 'audit', 'brokers.log')],
			['broker', join(this.dir, 'audit', 'brokers.1.log')],
		];
		const lists = await Promise.all(files.map(async ([source, file]) => {
			const parse = TRUST_HISTORY_PARSERS[source];
			const lines = (await tail(file, HISTORY_TAIL_BYTES)).split('\n');
			const out: ITrustHistoryEntry[] = [];
			for (const line of lines) {
				const entry = line.trim() ? parse(line) : undefined;
				if (entry && (!subject || entry.subject === subject)) {
					out.push(entry);
				}
			}
			return out;
		}));
		return mergeTrustHistory(lists, limit);
	}
}

/** The last `bytes` of `file` from a line start; empty when it can't be read. */
async function tail(file: string, bytes: number): Promise<string> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, 'r');
		const { size } = await handle.stat();
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.toString('utf8');
		return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
	} catch {
		return '';
	} finally {
		await handle?.close().catch(() => undefined);
	}
}
