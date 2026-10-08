/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import {
	IVoltRestackLayerInput,
	IVoltRestackResult,
	IVoltRestackStep,
	IVoltStack,
	IVoltStackBranchState,
	IVoltStackLayer,
	isStackTrunk,
	parseStackConfig,
	planRestack,
	retargetAfterMerge,
	STACK_PARENT_KEY,
	STACK_PARENT_OID_KEY,
	stackOrder,
} from '../common/voltPrStacks.js';

export interface IStackGitResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs git in `cwd`; resolves with the exit code instead of throwing. */
export type StackGit = (args: readonly string[], cwd: string) => Promise<IStackGitResult>;

export interface IStackContext {
	readonly git: StackGit;
	/** The work tree the stack is read from (any checkout of the repository). */
	readonly root: string;
	readonly trunk: string;
	readonly remote?: string;
}

export interface IRestackOptions {
	readonly only?: readonly string[];
	readonly syncTrunk?: boolean;
}

function trunkRefOf(context: IStackContext): string {
	return context.remote ? `${context.remote}/${context.trunk}` : context.trunk;
}

async function revParse(context: IStackContext, cwd: string, rev: string): Promise<string | undefined> {
	const result = await context.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], cwd);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

async function isAncestor(context: IStackContext, ancestor: string, descendant: string): Promise<boolean> {
	return (await context.git(['merge-base', '--is-ancestor', ancestor, descendant], context.root)).code === 0;
}

function parseRefs(text: string, remote: string | undefined) {
	const local = new Map<string, string>();
	const remoteOids = new Map<string, string>();
	const remotePrefix = remote ? `refs/remotes/${remote}/` : undefined;
	for (const line of text.split('\n')) {
		const [ref, oid] = line.split('\t');
		if (!ref || !oid) {
			continue;
		}
		if (ref.startsWith('refs/heads/')) {
			local.set(ref.slice('refs/heads/'.length), oid);
		} else if (remotePrefix && ref.startsWith(remotePrefix)) {
			remoteOids.set(ref.slice(remotePrefix.length), oid);
		}
	}
	return { local, remoteOids };
}

function worktreesByBranch(text: string): Map<string, string> {
	const out = new Map<string, string>();
	let worktree: string | undefined;
	for (const line of text.split('\n')) {
		if (line.startsWith('worktree ')) {
			worktree = line.slice('worktree '.length);
		} else if (line.startsWith('branch refs/heads/') && worktree) {
			out.set(line.slice('branch refs/heads/'.length), worktree);
		}
	}
	return out;
}

/** Every local branch with the stack records git config holds for it. */
export async function readBranchStates(context: IStackContext): Promise<Map<string, IVoltStackBranchState>> {
	const [refs, config, worktrees] = await Promise.all([
		context.git(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', ...(context.remote ? [`refs/remotes/${context.remote}`] : [])], context.root),
		context.git(['config', '--get-regexp', `^branch\\..*\\.${STACK_PARENT_KEY}`], context.root),
		context.git(['worktree', 'list', '--porcelain'], context.root),
	]);
	const { local, remoteOids } = parseRefs(refs.stdout, context.remote);
	const records = parseStackConfig(config.stdout);
	const checkouts = worktreesByBranch(worktrees.stdout);
	const branches = new Map<string, IVoltStackBranchState>();
	for (const [name, oid] of local) {
		const record = records.get(name);
		branches.set(name, {
			name,
			oid,
			parent: record?.parent,
			parentOid: record?.parentOid,
			remoteOid: remoteOids.get(name),
			worktree: checkouts.get(name),
		});
	}
	return branches;
}

async function tipOf(context: IStackContext, branches: ReadonlyMap<string, IVoltStackBranchState>, name: string): Promise<string | undefined> {
	if (isStackTrunk(name, context.trunk)) {
		return revParse(context, context.root, trunkRefOf(context));
	}
	return branches.get(name)?.oid ?? revParse(context, context.root, name);
}

async function isDirty(context: IStackContext, worktree: string): Promise<boolean> {
	return (await context.git(['status', '--porcelain', '--untracked-files=no'], worktree)).stdout.trim() !== '';
}

async function isRebasing(context: IStackContext, worktree: string): Promise<boolean> {
	for (const name of ['rebase-merge', 'rebase-apply']) {
		const result = await context.git(['rev-parse', '--git-path', name], worktree);
		const path = result.stdout.trim();
		if (result.code === 0 && path && existsSync(path.startsWith('/') ? path : join(worktree, path))) {
			return true;
		}
	}
	return false;
}

/** The layers of the stack `current` is in, bottom first, as the views show them. */
export async function readStack(context: IStackContext, current: string | undefined, branches?: ReadonlyMap<string, IVoltStackBranchState>): Promise<IVoltStack> {
	const states = branches ?? await readBranchStates(context);
	const order = current ? stackOrder(states, current, context.trunk) : [];
	const layers: IVoltStackLayer[] = [];
	for (const branch of order) {
		const state = states.get(branch)!;
		const parent = state.parent ?? context.trunk;
		const parentTip = await tipOf(context, states, parent);
		const needsRestack = !parentTip || !(await isAncestor(context, parentTip, state.oid));
		const ahead = parentTip ? Number((await context.git(['rev-list', '--count', `${parentTip}..${state.oid}`], context.root)).stdout.trim()) || 0 : 0;
		layers.push({
			branch,
			parent,
			oid: state.oid,
			parentOid: state.parentOid,
			remoteOid: state.remoteOid,
			worktree: state.worktree,
			dirty: state.worktree ? await isDirty(context, state.worktree) : undefined,
			needsRestack,
			ahead,
			unpushed: state.remoteOid !== undefined && state.remoteOid !== state.oid,
			rebaseInProgress: state.worktree ? await isRebasing(context, state.worktree) : undefined,
		});
	}
	return { trunk: context.trunk, remote: context.remote, layers, current };
}

/** Records `branch` on top of `parent`, built on the parent's current tip. Called after the branch is created. */
export async function recordParent(context: IStackContext, branch: string, parent: string, parentOid: string): Promise<void> {
	await context.git(['config', `branch.${branch}.${STACK_PARENT_KEY}`, parent], context.root);
	await context.git(['config', `branch.${branch}.${STACK_PARENT_OID_KEY}`, parentOid], context.root);
}

async function recordParentOid(context: IStackContext, branch: string, parentOid: string): Promise<void> {
	await context.git(['config', `branch.${branch}.${STACK_PARENT_OID_KEY}`, parentOid], context.root);
}

/**
 * Moves the layers of the stack `current` is in onto their parents, bottom first. Each layer is one
 * `git rebase --onto <parent> <recorded parent commit>`, run in its checkout or, when it has none,
 * in a temporary detached worktree that never touches the user's checkouts. Conflicts stop the run:
 * in a checkout the rebase is left waiting there; a temporary one is aborted.
 */
export async function restackStack(context: IStackContext, current: string, options: IRestackOptions = {}): Promise<IVoltRestackResult> {
	const branches = await readBranchStates(context);
	const stack = await readStack(context, current, branches);
	const trunkRef = trunkRefOf(context);
	const inputs: IVoltRestackLayerInput[] = [];
	for (const layer of stack.layers) {
		const parentTip = await tipOf(context, branches, layer.parent);
		const state = branches.get(layer.branch)!;
		const forkPoint = parentTip ? (await context.git(['merge-base', parentTip, state.oid], context.root)).stdout.trim() || undefined : undefined;
		const recorded = state.parentOid && await isAncestor(context, state.parentOid, state.oid) ? state.parentOid : undefined;
		inputs.push({
			branch: layer.branch,
			parent: layer.parent,
			oid: state.oid,
			parentOid: recorded,
			forkPoint,
			upToDate: !layer.needsRestack,
			worktree: layer.worktree,
		});
	}
	const plan = planRestack(inputs, { only: options.only, trunkRef, trunk: context.trunk, syncTrunk: options.syncTrunk });
	const upToDate = stack.layers.filter(layer => !plan.some(step => step.branch === layer.branch)).map(layer => layer.branch);
	if (!plan.length) {
		return { restacked: [], upToDate, pushFailures: [] };
	}
	for (const step of plan) {
		const worktree = branches.get(step.branch)?.worktree;
		if (worktree && await isDirty(context, worktree)) {
			return { restacked: [], upToDate, pushFailures: [], stopped: { branch: step.branch, reason: 'dirty', message: `${step.branch} has uncommitted changes.`, files: [], worktree, command: '' } };
		}
	}
	return runPlan(context, plan, branches, upToDate);
}

async function runPlan(context: IStackContext, plan: readonly IVoltRestackStep[], branches: ReadonlyMap<string, IVoltStackBranchState>, upToDate: string[]): Promise<IVoltRestackResult> {
	const restacked: { branch: string; from: string; to: string }[] = [];
	const stop = async (step: IVoltRestackStep, message: string, files: readonly string[], worktree: string | undefined, args: readonly string[]): Promise<IVoltRestackResult> => {
		const pushed = await pushRestacked(context, restacked, branches);
		return {
			restacked: pushed.restacked,
			upToDate,
			pushFailures: pushed.pushFailures,
			stopped: { branch: step.branch, reason: files.length ? 'conflict' : 'failed', message, files, worktree, command: `git ${args.join(' ')}` },
		};
	};
	for (const step of plan) {
		const state = branches.get(step.branch)!;
		const onto = await revParse(context, context.root, step.onto);
		if (!onto) {
			return stop(step, `${step.onto} does not exist.`, [], undefined, []);
		}
		const args = ['rebase', '--onto', onto, step.upstream];
		if (state.worktree) {
			const result = await context.git(args, state.worktree);
			if (result.code !== 0) {
				return stop(step, failure(result.stderr, result.stdout), await conflictedFiles(context, state.worktree), state.worktree, args);
			}
		} else {
			const scratch = mkdtempSync(join(tmpdir(), 'volt-restack-'));
			const path = join(scratch, 'wt');
			try {
				const added = await context.git(['worktree', 'add', '--detach', '--quiet', path, state.oid], context.root);
				if (added.code !== 0) {
					return stop(step, failure(added.stderr, added.stdout), [], undefined, args);
				}
				const result = await context.git(args, path);
				if (result.code !== 0) {
					const files = await conflictedFiles(context, path);
					await context.git(['rebase', '--abort'], path);
					return stop(step, failure(result.stderr, result.stdout), files, undefined, args);
				}
				const newTip = (await revParse(context, path, 'HEAD'))!;
				await context.git(['update-ref', `refs/heads/${step.branch}`, newTip, state.oid], context.root);
			} finally {
				await context.git(['worktree', 'remove', '--force', path], context.root);
				rmSync(scratch, { recursive: true, force: true });
			}
		}
		const newTip = (await revParse(context, context.root, `refs/heads/${step.branch}`))!;
		await recordParentOid(context, step.branch, onto);
		restacked.push({ branch: step.branch, from: state.oid, to: newTip });
	}
	const pushed = await pushRestacked(context, restacked, branches);
	return { restacked: pushed.restacked, upToDate, pushFailures: pushed.pushFailures };
}

/** Pushes each moved layer that the remote has, with a lease on the commit it had (someone else's push stays). */
async function pushRestacked(context: IStackContext, restacked: readonly { branch: string; from: string; to: string }[], branches: ReadonlyMap<string, IVoltStackBranchState>): Promise<{ restacked: IVoltRestackResult['restacked'][number][]; pushFailures: IVoltRestackResult['pushFailures'][number][] }> {
	const out: { branch: string; from: string; to: string; pushed: boolean }[] = [];
	const pushFailures: { branch: string; message: string }[] = [];
	for (const layer of restacked) {
		const expected = branches.get(layer.branch)?.remoteOid;
		let pushed = false;
		if (context.remote && expected) {
			const result = await context.git(['push', `--force-with-lease=refs/heads/${layer.branch}:${expected}`, context.remote, `${layer.to}:refs/heads/${layer.branch}`], context.root);
			pushed = result.code === 0;
			if (!pushed) {
				pushFailures.push({ branch: layer.branch, message: failure(result.stderr, result.stdout) });
			}
		}
		out.push({ ...layer, pushed });
	}
	return { restacked: out, pushFailures };
}

async function conflictedFiles(context: IStackContext, cwd: string): Promise<string[]> {
	const result = await context.git(['diff', '--name-only', '--diff-filter=U'], cwd);
	return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

function failure(stderr: string, stdout: string): string {
	return (stderr || stdout).trim().split('\n').slice(-3).join(' ') || 'git rebase failed';
}

/**
 * Retargets the children of `merged` after its pull request landed: they sit on its parent (the
 * trunk for the bottom layer) from now on. Returns the children, which the caller restacks.
 */
export async function retargetChildren(context: IStackContext, merged: string): Promise<{ branch: string; from: string; to: string }[]> {
	const branches = await readBranchStates(context);
	const moves = retargetAfterMerge(branches, merged, context.trunk);
	for (const move of moves) {
		await context.git(['config', `branch.${move.branch}.${STACK_PARENT_KEY}`, move.to], context.root);
	}
	return moves;
}
