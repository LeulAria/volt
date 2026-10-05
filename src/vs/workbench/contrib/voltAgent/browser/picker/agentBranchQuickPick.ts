/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../../base/common/date.js';
import { match } from '../../../../../base/common/glob.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IVoltGitBranchRef, IVoltGitBranches, IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { INIT_TIMEOUT_MS, runGit } from '../home/agentHomeWorkspaceActions.js';
import { BAD_BRANCH_NAME } from '../home/agentLandingChrome.js';

interface ICommandItem extends IQuickPickItem {
	readonly command: 'create' | 'createFrom' | 'detached' | 'init';
}

interface IRefItem extends IQuickPickItem {
	readonly ref: IVoltGitBranchRef;
}

type BranchItem = ICommandItem | IRefItem;

export interface IAgentBranchQuickPickOptions {
	/** The checkout to switch: the project, or the chat's own worktree. */
	readonly repoRoot: string;
	/** HEAD moved: a checkout, a new branch or a new repository. */
	readonly onDidCheckout?: () => void;
}

/**
 * The git extension's Checkout to... picker (what the status bar branch opens), for the agent
 * window, which runs without the git extension: Volt's git lists the refs and switches.
 */
export async function showAgentBranchQuickPick(accessor: ServicesAccessor, options: IAgentBranchQuickPickOptions): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const gitService = accessor.get(IVoltGitService);
	const notificationService = accessor.get(INotificationService);
	const configurationService = accessor.get(IConfigurationService);
	const stdio = accessor.get(IVoltStdioService);
	const { repoRoot } = options;

	const store = new DisposableStore();
	const picker = store.add(quickInputService.createQuickPick<BranchItem>({ useSeparators: true }));
	picker.busy = true;
	picker.sortByLabel = false;
	picker.matchOnDetail = false;
	picker.placeholder = localize('voltAgent.branchPick.placeholder', "Select a branch or tag to checkout");
	picker.show();

	const branches = await gitService.listBranches({ repoRoot }).catch(() => undefined);
	const isRepo = !!branches && (!!branches.head || !!branches.detached || branches.refs.length > 0);
	const hasRefs = !!branches?.refs.length;
	const commands: ICommandItem[] = !isRepo
		? [{ command: 'init', label: `$(repo) ${localize('voltAgent.branchPick.init', "Initialize Repository")}`, alwaysShow: true }]
		: [
			{ command: 'create', label: `$(plus) ${localize('voltAgent.branchPick.create', "Create new branch...")}`, alwaysShow: true },
			// Before the first commit there is nothing to branch from or detach at.
			...hasRefs ? [
				{ command: 'createFrom', label: `$(plus) ${localize('voltAgent.branchPick.createFrom', "Create new branch from...")}`, alwaysShow: true } satisfies ICommandItem,
				{ command: 'detached', label: `$(debug-disconnect) ${localize('voltAgent.branchPick.detached', "Checkout detached...")}`, alwaysShow: true } satisfies ICommandItem,
			] : [],
		];
	const isProtected = protectedBranchMatcher(configurationService, repoRoot);
	const refs = branches ? refItems(branches.refs, ['local', 'remote', 'tag'], isProtected) : [];

	// As in the git extension: commands first, and after the matches once there is a filter.
	const update = () => {
		picker.items = !picker.value
			? [...commands, ...refs]
			: refs.length ? [...refs, { type: 'separator' }, ...commands] : commands;
	};
	update();
	picker.busy = false;

	const choice = await new Promise<BranchItem | undefined>(resolve => {
		store.add(picker.onDidAccept(() => resolve(picker.activeItems[0])));
		store.add(picker.onDidHide(() => resolve(undefined)));
		store.add(picker.onDidChangeValue(update));
	});
	const typed = picker.value.trim();
	store.dispose();
	if (!choice) {
		return;
	}

	const existing = new Set(branches?.local);
	const promptName = async (from?: IVoltGitBranchRef): Promise<string | undefined> => {
		// The git extension takes a typed filter as the name without asking again.
		if (!from && typed && !validateBranchName(typed, existing)) {
			return typed;
		}
		const name = await quickInputService.input({
			placeHolder: localize('voltAgent.branchPick.namePlaceholder', "Branch name"),
			prompt: from
				? localize('voltAgent.branchPick.namePromptFrom', "Please provide a new branch name (from {0})", from.name)
				: localize('voltAgent.branchPick.namePrompt', "Please provide a new branch name"),
			value: from ? undefined : typed,
			validateInput: async value => validateBranchName(value.trim(), existing),
		});
		return name?.trim() || undefined;
	};

	try {
		if ('ref' in choice) {
			if (choice.ref.kind === 'local' && choice.ref.name === branches?.head) {
				return;
			}
			await gitService.checkout({ repoRoot, ref: choice.ref.name, kind: choice.ref.kind });
		} else if (choice.command === 'init') {
			const result = await runGit(stdio, repoRoot, ['init'], INIT_TIMEOUT_MS);
			if (result.exitCode !== 0) {
				throw new Error(result.timedOut
					? localize('voltAgent.initTimedOut', "git init did not finish in time")
					: result.stderr.trim() || localize('voltAgent.initFailed', "git init failed"));
			}
		} else if (choice.command === 'create') {
			const name = await promptName();
			if (!name) {
				return;
			}
			await gitService.createBranch({ repoRoot, name });
		} else if (choice.command === 'createFrom') {
			const from = await pickRef(quickInputService, refItems(branches?.refs ?? [], ['local', 'remote', 'tag'], isProtected), localize('voltAgent.branchPick.fromPlaceholder', "Select a ref to create the branch from"));
			const name = from && await promptName(from);
			if (!from || !name) {
				return;
			}
			await gitService.createBranch({ repoRoot, name, from: from.ref });
		} else {
			// No tags, as in the git extension: checking one out is detached already.
			const ref = await pickRef(quickInputService, refItems(branches?.refs ?? [], ['local', 'remote'], isProtected), localize('voltAgent.branchPick.detachedPlaceholder', "Select a branch to checkout in detached mode"));
			if (!ref) {
				return;
			}
			await gitService.checkout({ repoRoot, ref: ref.ref, kind: 'detached' });
		}
		options.onDidCheckout?.();
	} catch (err) {
		notificationService.error(err instanceof Error ? err.message : String(err));
	}
}

async function pickRef(quickInputService: IQuickInputService, items: (IRefItem | IQuickPickSeparator)[], placeHolder: string): Promise<IVoltGitBranchRef | undefined> {
	const choice = await quickInputService.pick(items, { placeHolder, matchOnDetail: false });
	return choice?.ref;
}

function validateBranchName(name: string, existing: ReadonlySet<string>): string | undefined {
	if (!name) {
		return localize('voltAgent.branchPick.nameRequired', "Please provide a branch name");
	}
	if (BAD_BRANCH_NAME.test(name)) {
		return localize('voltAgent.badBranchName', "Not a valid branch name");
	}
	return existing.has(name) ? localize('voltAgent.branchExists', "A branch named {0} already exists", name) : undefined;
}

/** `git.branchProtection`, which puts a lock on branches like `main` in the git extension's picker. */
function protectedBranchMatcher(configurationService: IConfigurationService, repoRoot: string): (name: string) => boolean {
	const setting = configurationService.getValue<unknown>('git.branchProtection', { resource: URI.file(repoRoot) });
	const globs = Array.isArray(setting) ? setting.filter((glob): glob is string => typeof glob === 'string' && !!glob.trim()) : [];
	return name => globs.some(glob => match(glob.trim(), name));
}

const SECTION_LABELS: Record<IVoltGitBranchRef['kind'], string> = {
	local: localize('voltAgent.branchPick.branches', "branches"),
	remote: localize('voltAgent.branchPick.remoteBranches', "remote branches"),
	tag: localize('voltAgent.branchPick.tags', "tags"),
};

/** A section per kind, each ref with its latest commit, as the git extension lists them. */
function refItems(refs: IVoltGitBranches['refs'], kinds: readonly IVoltGitBranchRef['kind'][], isProtected: (name: string) => boolean): (IRefItem | IQuickPickSeparator)[] {
	const items: (IRefItem | IQuickPickSeparator)[] = [];
	for (const kind of kinds) {
		const ofKind = refs.filter(ref => ref.kind === kind);
		if (!ofKind.length) {
			continue;
		}
		items.push({ type: 'separator', label: SECTION_LABELS[kind] });
		for (const ref of ofKind) {
			const icon = kind === 'remote' ? 'cloud' : kind === 'tag' ? 'tag' : isProtected(ref.name) ? 'lock' : 'git-branch';
			const description = [
				typeof ref.behind === 'number' && typeof ref.ahead === 'number' ? `${ref.behind}↓ ${ref.ahead}↑` : undefined,
				ref.date ? fromNow(ref.date, true, true) : undefined,
			].filter(Boolean).join('$(circle-small-filled)');
			items.push({
				ref,
				label: `$(${icon}) ${ref.name}`,
				description: description || undefined,
				detail: ref.author && ref.subject ? `${ref.author}$(circle-small-filled)${ref.subject}` : ref.subject || undefined,
			});
		}
	}
	return items;
}
