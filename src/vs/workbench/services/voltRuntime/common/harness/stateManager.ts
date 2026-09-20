/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * State manager. Snapshots, checkpoints, and mutation transactions - the pieces the recovery
 * controller names when it says `rollback`.
 *
 * This is a *ledger*, not a git client. The runtime applies a rollback by walking the
 * ledger backwards and restoring file contents it already captured. Git checkpoints are a
 * separate, optional durability layer the runtime may attach as `kind: 'git'`.
 */

export type MutationKind = 'edit' | 'create' | 'delete';

export interface IFileSnapshot {
	readonly path: string;
	readonly content: string;
	readonly existed: boolean;
}

export interface IMutation {
	readonly id: string;
	readonly path: string;
	readonly kind: MutationKind;
	readonly before?: IFileSnapshot;
	readonly after?: IFileSnapshot;
	readonly at: number;
	readonly step: number;
}

export interface ICheckpoint {
	readonly id: string;
	readonly label: string;
	readonly at: number;
	readonly step: number;
	readonly kind: 'memory' | 'git';
	readonly mutationId: string;
	readonly ref?: string;
}

export interface ITransaction {
	readonly id: string;
	readonly open: boolean;
	readonly mutationIds: readonly string[];
}

export interface IRollbackResult {
	readonly checkpointId: string;
	readonly restored: readonly IFileSnapshot[];
	readonly dropped: readonly IMutation[];
}

export class StateManager {

	private readonly mutations: IMutation[] = [];
	private readonly checkpoints: ICheckpoint[] = [];
	private readonly transactions: ITransaction[] = [];
	private readonly locks = new Map<string, string>();
	private seq = 0;

	snapshot(path: string, content: string | undefined): IFileSnapshot {
		return { path, content: content ?? '', existed: content !== undefined };
	}

	record(step: number, path: string, kind: MutationKind, before?: IFileSnapshot, after?: IFileSnapshot, now = Date.now()): IMutation {
		const mutation: IMutation = {
			id: `u${++this.seq}`,
			path,
			kind,
			...(before ? { before } : {}),
			...(after ? { after } : {}),
			at: now,
			step,
		};
		this.mutations.push(mutation);
		const open = this.transactions.find(item => item.open);
		if (open) {
			this.transactions[this.transactions.indexOf(open)] = {
				...open,
				mutationIds: [...open.mutationIds, mutation.id],
			};
		}
		return mutation;
	}

	checkpoint(label: string, step: number, kind: 'memory' | 'git' = 'memory', ref?: string, now = Date.now()): ICheckpoint {
		const last = this.mutations[this.mutations.length - 1];
		const point: ICheckpoint = {
			id: `cp${this.checkpoints.length + 1}`,
			label,
			at: now,
			step,
			kind,
			mutationId: last?.id ?? 'u0',
			...(ref ? { ref } : {}),
		};
		this.checkpoints.push(point);
		return point;
	}

	beginTransaction(): ITransaction {
		const open = this.transactions.find(item => item.open);
		if (open) {
			return open;
		}
		const tx: ITransaction = { id: `tx${this.transactions.length + 1}`, open: true, mutationIds: [] };
		this.transactions.push(tx);
		return tx;
	}

	commitTransaction(id: string): ITransaction | undefined {
		return this.closeTransaction(id, true);
	}

	abortTransaction(id: string): IRollbackResult | undefined {
		const tx = this.transactions.find(item => item.id === id && item.open);
		if (!tx) {
			return undefined;
		}
		this.closeTransaction(id, false);
		const dropped = this.mutations.filter(item => tx.mutationIds.includes(item.id));
		const restored = this.restore(dropped);
		this.drop(new Set(tx.mutationIds));
		return { checkpointId: id, restored, dropped };
	}

	/**
	 * Restore every mutation after the named checkpoint. The checkpoint itself stays; the
	 * work that followed it is what gets undone.
	 */
	rollback(checkpointId: string): IRollbackResult | undefined {
		const point = this.checkpoints.find(item => item.id === checkpointId);
		if (!point) {
			return undefined;
		}
		const index = this.mutations.findIndex(item => item.id === point.mutationId);
		const dropped = this.mutations.slice(index + 1);
		const restored = this.restore(dropped);
		this.drop(new Set(dropped.map(item => item.id)));
		return { checkpointId, restored, dropped };
	}

	latestCheckpoint(): ICheckpoint | undefined {
		return this.checkpoints[this.checkpoints.length - 1];
	}

	changedPaths(): string[] {
		return [...new Set(this.mutations.map(item => item.path))];
	}

	allMutations(): readonly IMutation[] {
		return this.mutations;
	}

	allCheckpoints(): readonly ICheckpoint[] {
		return this.checkpoints;
	}

	canRollback(): boolean {
		return this.checkpoints.length > 0 && this.mutations.length > 0;
	}

	lock(path: string, owner: string): boolean {
		const key = path.replace(/\\/g, '/');
		const held = this.locks.get(key);
		if (held && held !== owner) {
			return false;
		}
		this.locks.set(key, owner);
		return true;
	}

	unlock(path: string, owner: string): boolean {
		const key = path.replace(/\\/g, '/');
		if (this.locks.get(key) !== owner) {
			return false;
		}
		this.locks.delete(key);
		return true;
	}

	lockedBy(path: string): string | undefined {
		return this.locks.get(path.replace(/\\/g, '/'));
	}

	changeset(): readonly { readonly path: string; readonly kind: MutationKind }[] {
		const latest = new Map<string, MutationKind>();
		for (const item of this.mutations) {
			latest.set(item.path, item.kind);
		}
		return [...latest].map(([path, kind]) => ({ path, kind }));
	}

	private restore(dropped: readonly IMutation[]): IFileSnapshot[] {
		const latest = new Map<string, IFileSnapshot>();
		for (const item of dropped) {
			if (item.before) {
				latest.set(item.path, item.before);
			} else if (item.kind === 'create') {
				latest.set(item.path, { path: item.path, content: '', existed: false });
			}
		}
		return [...latest.values()];
	}

	private drop(ids: ReadonlySet<string>): void {
		for (let i = this.mutations.length - 1; i >= 0; i--) {
			if (ids.has(this.mutations[i].id)) {
				this.mutations.splice(i, 1);
			}
		}
	}

	private closeTransaction(id: string, commit: boolean): ITransaction | undefined {
		const index = this.transactions.findIndex(item => item.id === id);
		if (index < 0) {
			return undefined;
		}
		const closed: ITransaction = { ...this.transactions[index], open: false, mutationIds: commit ? this.transactions[index].mutationIds : [] };
		this.transactions[index] = { ...this.transactions[index], open: false };
		return closed;
	}
}
