/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Isolated worktrees / sandboxes. This is the *allocation* model, not a git client: the
 * runtime creates the directory. What this module guarantees is that two workers never
 * receive the same tree, that a released tree can be reused, and that a mission which
 * asked for isolation cannot silently fall back to the live workspace.
 */

export type WorktreeKind = 'workspace' | 'worktree' | 'sandbox';

export interface IWorktree {
	readonly id: string;
	readonly workerId: string;
	readonly kind: WorktreeKind;
	readonly path: string;
	readonly parent?: string;
	readonly createdAt: number;
}

export class WorktreeAllocator {

	private readonly trees = new Map<string, IWorktree>();
	private readonly free: IWorktree[] = [];
	private seq = 0;

	constructor(private readonly root: string, private readonly kind: WorktreeKind = 'worktree') { }

	allocate(workerId: string, now = Date.now()): IWorktree {
		const recycled = this.free.pop();
		if (recycled) {
			const next: IWorktree = { ...recycled, workerId, createdAt: now };
			this.trees.set(next.id, next);
			return next;
		}
		const id = `wt${++this.seq}`;
		const tree: IWorktree = {
			id,
			workerId,
			kind: this.kind,
			path: joinPath(this.root, id),
			parent: this.root,
			createdAt: now,
		};
		this.trees.set(id, tree);
		return tree;
	}

	release(id: string): IWorktree | undefined {
		const tree = this.trees.get(id);
		if (!tree) {
			return undefined;
		}
		this.trees.delete(id);
		this.free.push(tree);
		return tree;
	}

	heldBy(workerId: string): IWorktree | undefined {
		return [...this.trees.values()].find(tree => tree.workerId === workerId);
	}

	all(): readonly IWorktree[] {
		return [...this.trees.values()];
	}

	/** Isolation was requested but the only tree is the live workspace - that is a bug. */
	isIsolated(): boolean {
		return this.kind !== 'workspace';
	}
}

function joinPath(root: string, child: string): string {
	if (!root) {
		return child;
	}
	return root.endsWith('/') || root.endsWith('\\') ? `${root}${child}` : `${root}/${child}`;
}
