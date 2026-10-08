/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stacked branches: each branch sits on a parent branch (the bottom one on the trunk), and each
 * one's pull request targets its parent. Volt records the parent in git config, as git-town and
 * Graphite do, together with the parent commit the branch was last built on:
 *
 *   branch.<name>.volt-parent      the parent branch
 *   branch.<name>.volt-parent-oid  the parent's tip when the branch was made or last restacked
 *
 * The recorded commit is what makes a restack exact. After the parent is amended or squash-merged
 * its old commits are no longer its ancestors, so a plain `git rebase <parent>` replays them into
 * the child; `git rebase --onto <parent> <recorded commit>` moves only the child's own commits.
 *
 * Everything here is pure (planned from what git reported), so every rule is unit tested; the
 * main process runs the plan (`node/voltPrStackGit.ts`).
 */

export const STACK_PARENT_KEY = 'volt-parent';
export const STACK_PARENT_OID_KEY = 'volt-parent-oid';

/** A local branch as git reported it. */
export interface IVoltStackBranchState {
	readonly name: string;
	readonly oid: string;
	/** The recorded parent branch. */
	readonly parent?: string;
	/** The parent's tip this branch was last built on. */
	readonly parentOid?: string;
	/** The branch on the remote (`refs/remotes/<remote>/<name>`), when it is there. */
	readonly remoteOid?: string;
	/** The work tree it is checked out in. */
	readonly worktree?: string;
}

/** One layer of a stack, bottom first. */
export interface IVoltStackLayer {
	readonly branch: string;
	/** The parent branch; the trunk for the bottom layer. */
	readonly parent: string;
	readonly oid: string;
	readonly parentOid?: string;
	readonly remoteOid?: string;
	readonly worktree?: string;
	/** The work tree it is checked out in has uncommitted changes (a restack there would stop). */
	readonly dirty?: boolean;
	/** The parent's current tip is not in this branch: it was amended, rebased, or got new commits. */
	readonly needsRestack: boolean;
	/** Commits this layer has over its parent. */
	readonly ahead: number;
	/** The remote has this branch at another commit than the local one. */
	readonly unpushed: boolean;
	/** A rebase stopped on conflicts in its work tree and is waiting there. */
	readonly rebaseInProgress?: boolean;
}

export interface IVoltStack {
	/** The trunk the bottom layer sits on (`main`). */
	readonly trunk: string;
	/** The remote the branches are pushed to (`origin`). */
	readonly remote?: string;
	/** Bottom first. Empty when the branch is not in a stack. */
	readonly layers: readonly IVoltStackLayer[];
	/** The branch that was asked about (the checked out one by default). */
	readonly current?: string;
}

/** Is this the trunk itself (or a branch that cannot be stacked on)? */
export function isStackTrunk(branch: string, trunk: string): boolean {
	return branch === trunk;
}

/**
 * The stack `branch` is in, bottom first: its recorded parents down to the trunk, then upwards
 * while each layer has exactly one child (a fork ends the walk; its branches are separate stacks
 * that share the layers below). A loop in the records, or a parent that no longer exists, ends the
 * walk down there.
 */
export function stackOrder(branches: ReadonlyMap<string, IVoltStackBranchState>, branch: string, trunk: string): string[] {
	if (!branches.has(branch) || isStackTrunk(branch, trunk)) {
		return [];
	}
	const down: string[] = [branch];
	const seen = new Set<string>(down);
	let cursor = branches.get(branch);
	while (cursor?.parent && !isStackTrunk(cursor.parent, trunk) && branches.has(cursor.parent) && !seen.has(cursor.parent)) {
		down.unshift(cursor.parent);
		seen.add(cursor.parent);
		cursor = branches.get(cursor.parent);
	}
	const children = childrenOf(branches);
	let top = branch;
	for (; ;) {
		const next = (children.get(top) ?? []).filter(child => !seen.has(child));
		if (next.length !== 1) {
			break;
		}
		top = next[0];
		down.push(top);
		seen.add(top);
	}
	// A branch with no parent recorded and nothing on top of it is not a stack.
	if (down.length === 1 && !branches.get(branch)?.parent && !(children.get(branch)?.length)) {
		return [];
	}
	return down;
}

/** Branches by the parent they record. */
export function childrenOf(branches: ReadonlyMap<string, IVoltStackBranchState>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const state of branches.values()) {
		if (state.parent) {
			const list = out.get(state.parent) ?? [];
			list.push(state.name);
			out.set(state.parent, list);
		}
	}
	for (const list of out.values()) {
		list.sort();
	}
	return out;
}

/** Every branch stacked on `branch`, directly or not, nearest first. */
export function descendantsOf(branches: ReadonlyMap<string, IVoltStackBranchState>, branch: string): string[] {
	const children = childrenOf(branches);
	const out: string[] = [];
	const queue = [...children.get(branch) ?? []];
	const seen = new Set<string>([branch]);
	while (queue.length) {
		const next = queue.shift()!;
		if (seen.has(next)) {
			continue;
		}
		seen.add(next);
		out.push(next);
		queue.push(...children.get(next) ?? []);
	}
	return out;
}

/** One rebase of a restack: `git rebase --onto <onto> <upstream> <branch>`. */
export interface IVoltRestackStep {
	readonly branch: string;
	/** The parent branch whose current tip the layer moves onto (`<remote>/<trunk>` for the trunk). */
	readonly onto: string;
	/** The commit the layer's own commits start after: the recorded parent commit, else the fork point. */
	readonly upstream: string;
}

/**
 * Rebases run together: one `git rebase --update-refs` of the top branch moves the layers below it
 * too. A group of one is a plain rebase.
 */
export interface IVoltRestackGroup {
	readonly steps: readonly IVoltRestackStep[];
}

export interface IVoltRestackLayerInput {
	readonly branch: string;
	readonly parent: string;
	readonly oid: string;
	/** The recorded parent commit, only when it is in the branch (a stale record is dropped). */
	readonly parentOid?: string;
	/** `git merge-base <parent> <branch>`, for layers with no recorded parent commit. */
	readonly forkPoint?: string;
	/** The parent's current tip is already in the branch. */
	readonly upToDate: boolean;
	readonly worktree?: string;
}

export interface IVoltRestackPlanOptions {
	/** Restack only these layers (and what they need below them stays as it is). Default: all. */
	readonly only?: readonly string[];
	/** The ref the bottom layer moves onto when its parent is the trunk (`origin/main`). */
	readonly trunkRef: string;
	readonly trunk: string;
	/** Move the bottom layer onto the trunk's latest commit too (after a parent merged, or on request). */
	readonly syncTrunk?: boolean;
}

/**
 * Which layers move and how, bottom first. A layer moves when its parent's tip is not in it, or when
 * the layer below it moved in this restack. Its own commits are the ones after the recorded parent
 * commit (the fork point when nothing was recorded). The bottom layer only moves onto the trunk when
 * asked (`syncTrunk`): following the trunk is a sync, not a restack.
 */
export function planRestack(layers: readonly IVoltRestackLayerInput[], options: IVoltRestackPlanOptions): IVoltRestackStep[] {
	const only = options.only ? new Set(options.only) : undefined;
	const moved = new Set<string>();
	const steps: IVoltRestackStep[] = [];
	for (const layer of layers) {
		const onTrunk = isStackTrunk(layer.parent, options.trunk);
		const parentMoved = moved.has(layer.parent);
		const stale = onTrunk ? !!options.syncTrunk && !layer.upToDate : !layer.upToDate;
		if (!parentMoved && !stale) {
			continue;
		}
		if (only && !only.has(layer.branch) && !parentMoved) {
			continue;
		}
		// A layer already on its parent's tip starts right after it (the fork point is that tip). One
		// whose parent was rewritten starts after the commit it was built on, which only the record knows.
		const upstream = layer.upToDate ? layer.forkPoint ?? layer.parentOid : layer.parentOid ?? layer.forkPoint;
		if (!upstream) {
			// No idea where its own commits start: rebasing could replay the parent's. Stop the climb here.
			break;
		}
		steps.push({ branch: layer.branch, onto: onTrunk ? options.trunkRef : layer.parent, upstream });
		moved.add(layer.branch);
	}
	return steps;
}

/**
 * Joins consecutive steps into one `--update-refs` rebase where git does exactly what the cascade
 * would: the upper layer sits right on the lower one's current tip (its recorded parent commit is
 * that tip), and the lower branch is not checked out anywhere (git leaves checked out branches
 * alone in `--update-refs`). `otherRefsInRange` names steps whose commits other local branches point
 * into; those would be moved too, so they rebase on their own.
 */
export function groupRestackSteps(steps: readonly IVoltRestackStep[], layers: ReadonlyMap<string, Pick<IVoltRestackLayerInput, 'oid' | 'parentOid' | 'worktree'>>, otherRefsInRange: ReadonlySet<string> = new Set()): IVoltRestackGroup[] {
	const groups: IVoltRestackStep[][] = [];
	for (const step of steps) {
		const current = groups.at(-1);
		const below = current?.at(-1);
		const lower = below ? layers.get(below.branch) : undefined;
		const self = layers.get(step.branch);
		const joins = !!below && !!lower && !!self
			&& step.onto === below.branch
			&& step.upstream === lower.oid
			&& !lower.worktree
			&& !otherRefsInRange.has(below.branch)
			&& !otherRefsInRange.has(step.branch);
		if (joins) {
			current!.push(step);
		} else {
			groups.push([step]);
		}
	}
	return groups.map(group => ({ steps: group }));
}

/**
 * After `merged` landed: its children now sit on its parent (the trunk for the bottom layer), their
 * pull requests target that, and they restack onto it from the commit they were built on (so a
 * squash merge's copies of the parent's commits are not replayed).
 */
export function retargetAfterMerge(branches: ReadonlyMap<string, IVoltStackBranchState>, merged: string, trunk: string): { readonly branch: string; readonly from: string; readonly to: string }[] {
	const state = branches.get(merged);
	const to = state?.parent && branches.has(state.parent) && !isStackTrunk(state.parent, trunk) ? state.parent : trunk;
	return (childrenOf(branches).get(merged) ?? []).map(branch => ({ branch, from: merged, to }));
}

/** A branch name for the next layer from a title or a word: `volt/stack-<slug>`. */
export function stackBranchName(text: string, taken: ReadonlySet<string> = new Set(), prefix = 'volt/'): string {
	const slug = text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'layer';
	let name = `${prefix}${slug}`;
	for (let n = 2; taken.has(name); n++) {
		name = `${prefix}${slug}-${n}`;
	}
	return name;
}

/** `branch.<name>.volt-parent <parent>` lines of `git config --get-regexp`. */
export function parseStackConfig(text: string): Map<string, { parent?: string; parentOid?: string }> {
	const out = new Map<string, { parent?: string; parentOid?: string }>();
	for (const line of text.split('\n')) {
		const match = /^branch\.(.+)\.(volt-parent|volt-parent-oid)\s+(.+)$/.exec(line.trim());
		if (!match) {
			continue;
		}
		const entry = out.get(match[1]) ?? {};
		if (match[2] === STACK_PARENT_KEY) {
			entry.parent = match[3].trim();
		} else if (/^[0-9a-f]{7,64}$/i.test(match[3].trim())) {
			entry.parentOid = match[3].trim().toLowerCase();
		}
		out.set(match[1], entry);
	}
	return out;
}

/** What a restack did, for the views and the agent. */
export interface IVoltRestackResult {
	/** Layers that moved, bottom first, with the commit before and after. */
	readonly restacked: readonly { readonly branch: string; readonly from: string; readonly to: string; readonly pushed: boolean }[];
	/** Layers that were already on their parent. */
	readonly upToDate: readonly string[];
	/** Where it stopped, when it did. */
	readonly stopped?: IVoltRestackStop;
	/** Pushes the remote refused (someone else pushed): the local branch is restacked, the remote is not. */
	readonly pushFailures: readonly { readonly branch: string; readonly message: string }[];
}

export interface IVoltRestackStop {
	readonly branch: string;
	readonly reason: 'conflict' | 'dirty' | 'failed';
	readonly message: string;
	/** Conflicting files, when a rebase stopped on them. */
	readonly files: readonly string[];
	/** The work tree the rebase waits in (`git rebase --continue` there), when it was left running. */
	readonly worktree?: string;
	/** The rebase that stopped, to run again by hand when it was aborted. */
	readonly command: string;
}

/** The message an agent gets to finish a restack that stopped. */
export function buildRestackConflictPrompt(stop: IVoltRestackStop, stackBranches: readonly string[]): string {
	const lines = [
		`[Volt] Restacking the stack ${stackBranches.join(' → ')} stopped at ${stop.branch}: ${stop.message}`,
	];
	if (stop.reason === 'conflict' && stop.worktree) {
		lines.push(
			`The rebase is waiting in ${stop.worktree}${stop.files.length ? ` with conflicts in ${stop.files.join(', ')}` : ''}.`,
			'Resolve each conflict keeping both sides\' intent, `git add` the files, and run `git rebase --continue` (repeat until it finishes). Do not abort it.',
			'Then call restack_stack again: it moves the layers above onto the result and pushes them with a lease.',
		);
	} else if (stop.reason === 'conflict') {
		lines.push(
			`Volt undid its attempt. Redo it in a checkout of ${stop.branch}: \`${stop.command}\`${stop.files.length ? ` (it conflicts in ${stop.files.join(', ')})` : ''}.`,
			'Resolve the conflicts, `git add` them, `git rebase --continue` until it finishes, then call restack_stack again to move the layers above and push.',
		);
	} else if (stop.reason === 'dirty') {
		lines.push(`Commit or stash the uncommitted changes in ${stop.worktree ?? 'its checkout'} first, then call restack_stack again.`);
	} else {
		lines.push(`Run \`${stop.command}\` yourself to see what git says, fix it, then call restack_stack again.`);
	}
	return lines.join('\n');
}
