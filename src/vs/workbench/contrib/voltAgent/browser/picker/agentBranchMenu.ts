/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentBranchMenu.css';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IVoltGitBranches, IVoltGitBranchRef, IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { AgentWorktreeTarget, IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { ISCMRepository } from '../../../scm/common/scm.js';
import { INIT_TIMEOUT_MS, runGit } from '../home/agentHomeWorkspaceActions.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuPrompt, IVoltSubmenu, showVoltMenu } from '../ui/menu/voltMenu.js';

type BranchPick =
	| { readonly kind: 'ref'; readonly name: string; readonly ref: 'local' | 'remote' | 'tag' }
	| { readonly kind: 'detached'; readonly ref: string }
	| { readonly kind: 'init' }
	/** Rows that open a flyout or a prompt; never picked. */
	| { readonly kind: 'none' };

const NO_PICK: BranchPick = { kind: 'none' };
/** What `git check-ref-format --branch` refuses, checked while typing. */
export const BAD_BRANCH_NAME = /^-|\.\.|[\s~^:?*[\\]|@\{|\/$|\.lock$|^\/|\/\//;

/** Cursor's branch dropdown: rounded rows inset from the edge, names only, a check on the current one. */
const MENU_CLASS = 'volt-agent-branch-menu';
const MENU_WIDTH = 300;

export interface IAgentBranchMenuWorktree {
	/** The branch picked for the new worktree so far; none means a fresh branch from the current one. */
	readonly target: AgentWorktreeTarget | undefined;
	readonly pick: (target: AgentWorktreeTarget | undefined) => void;
}

export interface IAgentBranchMenuOptions {
	readonly anchor: HTMLElement;
	/** The checkout whose branch it switches: the project, or a chat's worktree. */
	readonly root: URI | undefined;
	/** VS Code's repository for {@link root} when it has one open: its refs stand in for Volt's git, and its git.checkout switches. */
	readonly repository?: ISCMRepository;
	/** Set in Worktree mode: picks choose the new worktree's branch and leave this checkout alone. */
	readonly worktree?: IAgentBranchMenuWorktree;
	readonly position?: 'below' | 'above';
	readonly align?: 'left' | 'right';
	/** HEAD moved: a checkout, a new branch, or `git init`. */
	readonly onDidChange?: (change: 'checkout' | 'init') => void | Promise<void>;
}

/**
 * VS Code's branch picker (the status bar's Checkout to...) as a dropdown under its trigger:
 * create a branch, create one from a ref, check out detached, then every branch, remote branch
 * and tag. The new chat's Branch pill, the changes header and the dock's branch row all open it.
 */
export function showAgentBranchMenu(accessor: ServicesAccessor, options: IAgentBranchMenuOptions): IVoltMenuHandle {
	const contextViewService = accessor.get(IContextViewService);
	const gitService = accessor.get(IVoltGitService);
	const commandService = accessor.get(ICommandService);
	const notificationService = accessor.get(INotificationService);
	const stdio = accessor.get(IVoltStdioService);
	const worktrees = accessor.get(IAgentWorktreeService);
	const runtime = accessor.get(IAgentRuntimeService);
	const { root, repository, worktree } = options;
	const repoRoot = root?.scheme === 'file' ? root.fsPath : undefined;
	/** The checked-out branch, as of the last load. */
	let head: string | undefined;

	/**
	 * Asked in the menu's search field, as VS Code asks after Create new branch. For a worktree
	 * the name is kept for the first send, which makes the branch along with the checkout.
	 */
	const branchPrompt = (repoRoot: string, existing: ReadonlySet<string>, from?: IVoltGitBranchRef): IVoltMenuPrompt => ({
		placeholder: from
			? localize('voltAgent.branchNameFrom', "Branch name (from {0})", from.name)
			: localize('voltAgent.branchName', "Branch name"),
		hint: worktree
			? from
				? localize('voltAgent.worktreeBranchFromHint', "Press Enter to give the worktree a new branch from {0}", from.name)
				: localize('voltAgent.worktreeBranchHint', "Press Enter to give the worktree a new branch")
			: from
				? localize('voltAgent.branchFromHint', "Press Enter to create the branch from {0} and switch to it", from.name)
				: localize('voltAgent.branchHint', "Press Enter to create the branch and switch to it"),
		useQuery: !from,
		validate: value => BAD_BRANCH_NAME.test(value)
			? localize('voltAgent.badBranchName', "Not a valid branch name")
			: existing.has(value) ? localize('voltAgent.branchExists', "A branch named {0} already exists", value) : undefined,
		onSubmit: async name => {
			if (worktree) {
				worktree.pick({ kind: 'new', name, from: from?.ref });
				return;
			}
			await gitService.createBranch({ repoRoot, name, from: from?.ref });
			await options.onDidChange?.('checkout');
		},
	});

	const pick = async (data: BranchPick): Promise<void> => {
		if (!root) {
			return;
		}
		try {
			if (data.kind === 'init') {
				if (!repoRoot) {
					return;
				}
				// The agent window has no git extension, so git runs in the user's shell, as Start from scratch does.
				const result = await runGit(stdio, repoRoot, ['init'], INIT_TIMEOUT_MS);
				if (result.exitCode !== 0) {
					throw new Error(result.timedOut
						? localize('voltAgent.initTimedOut', "git init did not finish in time")
						: result.stderr.trim() || localize('voltAgent.initFailed', "git init failed"));
				}
				await options.onDidChange?.('init');
				return;
			}
			if (worktree) {
				// The current branch means the default: a fresh branch from it.
				if (data.kind === 'ref') {
					worktree.pick(data.ref === 'local'
						? data.name === head ? undefined : { kind: 'branch', name: data.name }
						: { kind: data.ref, name: data.name });
				}
				return;
			}
			if (data.kind === 'detached') {
				await gitService.checkout({ repoRoot: root.fsPath, ref: data.ref, kind: 'detached' });
				await options.onDidChange?.('checkout');
				return;
			}
			if (data.kind !== 'ref' || (data.ref === 'local' && data.name === head)) {
				return;
			}
			// Git checks a branch out in one place: a chat worktree holding it moves to a branch of its own first.
			const local = data.ref === 'local' ? data.name : data.ref === 'remote' ? data.name.slice(data.name.indexOf('/') + 1) : undefined;
			const released = local ? await worktrees.releaseBranch(root.fsPath, local) : undefined;
			if (released?.sessionId) {
				runtime.rememberWorktree(released.sessionId, released.path, released.branch);
			}
			if (repository?.provider.rootUri && data.ref !== 'remote') {
				// The git extension's checkout: same errors and dirty-tree handling as the SCM view.
				await commandService.executeCommand('git.checkout', repository.provider.rootUri, data.ref === 'tag' ? `refs/tags/${data.name}` : data.name);
			} else {
				await gitService.checkout({ repoRoot: root.fsPath, ref: data.name, kind: data.ref });
			}
			await options.onDidChange?.('checkout');
			if (released && local) {
				notificationService.info(localize('voltAgent.branchReleased', "{0} was checked out in a chat's worktree. That worktree is now on {1}, with its changes unstaged.", local, released.branch));
			}
		} catch (err) {
			notificationService.error(err instanceof Error ? err.message : String(err));
		}
	};

	return showVoltMenu<BranchPick>(contextViewService, {
		anchor: options.anchor,
		position: options.position,
		align: options.align,
		className: MENU_CLASS,
		ariaLabel: localize('voltAgent.branchMenu', "Branches"),
		search: {
			placeholder: worktree
				? localize('voltAgent.searchWorktreeBranches', "Search branches for the worktree...")
				: localize('voltAgent.searchBranchesShort', "Search branches..."),
		},
		width: MENU_WIDTH,
		sections: async () => {
			const branches = await loadBranches(gitService, repoRoot, repository);
			if (!branches || (!branches.head && !branches.detached && !branches.local.length)) {
				// Git that cannot run is not a folder without a repository: say so instead of offering git init.
				const gitError = repoRoot ? await gitService.resolveRepo(repoRoot).then(() => undefined, (error: unknown) => toErrorMessage(error)) : undefined;
				if (gitError) {
					return [{ id: 'none', items: [{ id: 'gitFailed', label: localize('voltAgent.gitFailed', "Git could not run"), icon: Codicon.warning, tooltip: gitError, disabled: true, data: NO_PICK }] }];
				}
				return repoRoot
					? [{ id: 'none', items: [{ id: 'init', label: localize('voltAgent.initRepository', "Initialize Repository"), icon: Codicon.repo, tooltip: localize('voltAgent.noRepository', "No git repository"), data: { kind: 'init' } }] }]
					: [];
			}
			head = branches.head;
			const target = worktree?.target;
			const existing = new Set(branches.local);
			const ofKind = (kind: IVoltGitBranchRef['kind']) => branches.refs.filter(ref => ref.kind === kind);
			// The checked-out branch first, then the rest by latest commit.
			const local = [...ofKind('local')].sort((a, b) => Number(b.name === head) - Number(a.name === head));
			const isPicked = (ref: IVoltGitBranchRef) => target
				? target.kind !== 'new' && target.name === ref.name && (target.kind === 'branch' ? ref.kind === 'local' : target.kind === ref.kind)
				: ref.kind === 'local' && ref.name === head;
			const checkout = (ref: IVoltGitBranchRef) => refItem(ref, { kind: 'ref', name: ref.name, ref: ref.kind }, isPicked(ref));
			const newTarget: IVoltMenuItem<BranchPick>[] = target?.kind === 'new'
				? [{ id: 'new-target', label: target.name, detail: localize('voltAgent.worktreeNewBranchDetail', "new branch for the worktree"), checked: true, data: NO_PICK }]
				: [];
			const hasRefs = branches.refs.length > 0;
			const actions: IVoltMenuItem<BranchPick>[] = repoRoot ? [
				// Before the first commit a new branch has nothing to start from, except in this checkout.
				worktree && branches.unborn ? {
					id: 'needsCommit',
					label: localize('voltAgent.worktreeNeedsCommitShort', "Make a first commit to use a worktree"),
					icon: Codicon.warning,
					alwaysShow: true,
					disabled: true,
					data: NO_PICK,
				} : {
					id: 'create',
					label: localize('voltAgent.createBranch', "Create new branch..."),
					icon: Codicon.add,
					alwaysShow: true,
					prompt: branchPrompt(repoRoot, existing),
					data: NO_PICK,
				},
				...hasRefs ? [{
					id: 'createFrom',
					label: localize('voltAgent.createBranchFrom', "Create new branch from..."),
					icon: Codicon.add,
					submenu: refMenu(branches.refs, localize('voltAgent.createBranchFromPlaceholder', "Select a ref to create the branch from"), ref => refItem(ref, NO_PICK, false, branchPrompt(repoRoot, existing, ref))),
					data: NO_PICK,
				} satisfies IVoltMenuItem<BranchPick>] : [],
				// A worktree needs a branch; detached checkouts stay a This Mac thing.
				...worktree || !hasRefs ? [] : [{
					id: 'detached',
					label: localize('voltAgent.checkoutDetached', "Checkout detached..."),
					icon: Codicon.debugDisconnect,
					submenu: refMenu(branches.refs, localize('voltAgent.checkoutDetachedPlaceholder', "Select a ref to checkout in detached mode"), ref => refItem(ref, { kind: 'detached', ref: ref.ref })),
					data: NO_PICK,
				} satisfies IVoltMenuItem<BranchPick>],
			] : [];
			const current: IVoltMenuItem<BranchPick>[] = !head && branches.detached
				? [{ id: 'detached-head', label: localize('voltAgent.detached', "{0} (detached)", branches.detached), checked: !target, disabled: true, data: NO_PICK }]
				// A branch with no commits has no ref, so it is not among the rest.
				: head && branches.unborn
					? [{ id: 'unborn-head', label: head, detail: localize('voltAgent.noCommitsYet', "no commits yet"), checked: !target, disabled: true, data: NO_PICK }]
					: [];
			return [
				{ id: 'actions', items: actions },
				{ id: 'local', title: localize('voltAgent.branches', "Branches"), items: [...newTarget, ...current, ...local.map(checkout)] },
				{ id: 'remote', title: localize('voltAgent.remoteBranches', "Remote branches"), items: ofKind('remote').map(checkout) },
				{ id: 'tags', title: localize('voltAgent.tags', "Tags"), items: ofKind('tag').map(checkout) },
			];
		},
		emptyMessage: localize('voltAgent.noBranches', "No matching branches"),
		onPick: item => pick(item.data),
	});
}

/** Volt's git (with each ref's latest commit), else the SCM view's refs for a checkout it cannot reach. */
async function loadBranches(gitService: IVoltGitService, repoRoot: string | undefined, repository: ISCMRepository | undefined): Promise<IVoltGitBranches | undefined> {
	if (repoRoot) {
		const branches = await gitService.listBranches({ repoRoot }).catch(() => undefined);
		if (branches && (branches.head || branches.detached || branches.refs.length)) {
			return branches;
		}
	}
	const history = repository?.provider.historyProvider.get();
	const refs = await history?.provideHistoryItemRefs().catch(() => undefined);
	if (!history || !refs) {
		return undefined;
	}
	const all: IVoltGitBranchRef[] = [];
	for (const ref of refs) {
		const kind = ref.id.startsWith('refs/heads/') ? 'local'
			: ref.id.startsWith('refs/remotes/') && !ref.id.endsWith('/HEAD') ? 'remote'
				: ref.id.startsWith('refs/tags/') ? 'tag' : undefined;
		if (kind) {
			all.push({ kind, name: ref.name, ref: ref.id, subject: '', author: '', date: 0 });
		}
	}
	const names = (kind: IVoltGitBranchRef['kind']) => all.filter(ref => ref.kind === kind).map(ref => ref.name);
	const current = history.historyItemRef.get();
	const head = current?.name?.replace(/^refs\/heads\//, '');
	return {
		head,
		unborn: !!head && !current?.revision,
		detached: !head && current?.revision ? current.revision.slice(0, 7) : undefined,
		local: names('local'),
		remote: names('remote'),
		tags: names('tag'),
		refs: all,
	};
}

/** A branch, remote branch or tag: just its name, as in Cursor. Its latest commit is in the tooltip. */
function refItem(ref: IVoltGitBranchRef, data: BranchPick, checked = false, prompt?: IVoltMenuPrompt): IVoltMenuItem<BranchPick> {
	const commit = [ref.author, ref.subject].filter(Boolean).join(' • ');
	return {
		id: `${ref.kind}:${ref.name}`,
		label: ref.name,
		tooltip: [ref.name, commit, ref.date ? fromNow(ref.date, true, true) : undefined].filter(Boolean).join('\n'),
		checked,
		prompt,
		data,
	};
}

/** Every ref, grouped like the main list, for Create new branch from and Checkout detached. */
function refMenu(refs: readonly IVoltGitBranchRef[], placeholder: string, item: (ref: IVoltGitBranchRef) => IVoltMenuItem<BranchPick>): IVoltSubmenu<BranchPick> {
	const group = (id: string, title: string, kind: IVoltGitBranchRef['kind']) => ({ id, title, items: refs.filter(ref => ref.kind === kind).map(item) });
	return {
		search: { placeholder },
		width: MENU_WIDTH,
		className: MENU_CLASS,
		emptyMessage: localize('voltAgent.noRefs', "No matching refs"),
		sections: [
			group('local', localize('voltAgent.branches', "Branches"), 'local'),
			group('remote', localize('voltAgent.remoteBranches', "Remote branches"), 'remote'),
			group('tags', localize('voltAgent.tags', "Tags"), 'tag'),
		],
	};
}
