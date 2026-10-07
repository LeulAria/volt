/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IVoltGitStatus, IVoltPullRequest, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { Action } from '../../../../../base/common/actions.js';
import {
	actionIncludesCommit,
	actionIncludesPr,
	actionIncludesPush,
	AgentGitAction,
	buildMenuItems,
	defaultBranchPromptCopy,
	featureBranchName,
	IAgentGitActionResult,
	IAgentGitContext,
	IAgentGitMenuItem,
	IAgentGitQuickAction,
	requiresDefaultBranchConfirmation,
	resolveQuickAction,
	summarizeResult,
} from '../../common/agentGitActions.js';
import { currentLink, isOpenState } from '../../common/agentPullRequests.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { openPullRequest } from './agentPullRequestUi.js';
import { showAgentGitCommitDialog } from './agentGitCommitDialog.js';

export const IAgentGitActionsService = createDecorator<IAgentGitActionsService>('agentGitActionsService');

export interface IAgentGitRunOptions {
	readonly message?: string;
	readonly paths?: readonly string[];
	/** Run on a new feature branch (asked for, or picked at the default branch prompt). */
	readonly featureBranch?: boolean;
	readonly skipDefaultBranchPrompt?: boolean;
}

export interface IAgentGitProgress {
	readonly label: string;
	readonly startedAt: number;
}

/** What the git controls show for a folder: where it stands, the quick action and the menu. */
export interface IAgentGitControlState {
	readonly context: IAgentGitContext;
	readonly quick: IAgentGitQuickAction;
	readonly menu: readonly IAgentGitMenuItem[];
	readonly progress?: IAgentGitProgress;
}

export interface IAgentGitActionsService {
	readonly _serviceBrand: undefined;
	/** A folder's status or progress changed. */
	readonly onDidChange: Event<string>;
	/** The controls' state for a folder, from a fresh-enough status. */
	state(folder: string, sessionId: string | undefined, force?: boolean): Promise<IAgentGitControlState>;
	/** The last state read for a folder, without reading again. */
	cachedState(folder: string): IAgentGitControlState | undefined;
	runQuick(folder: string, sessionId: string | undefined): Promise<void>;
	/** A menu entry: Commit opens the commit dialog, Push and Create PR run at once. */
	runMenu(folder: string, sessionId: string | undefined, id: IAgentGitMenuItem['id']): Promise<void>;
	run(folder: string, sessionId: string | undefined, action: AgentGitAction, options?: IAgentGitRunOptions): Promise<IAgentGitActionResult | undefined>;
}

const STATUS_TTL_MS = 3_000;
const BRANCH_PR_TTL_MS = 60_000;
const REREAD_DELAY_MS = 400;

interface ICachedState {
	readonly at: number;
	readonly state: IAgentGitControlState;
}

export class AgentGitActionsService extends Disposable implements IAgentGitActionsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly states = new Map<string, ICachedState>();
	private readonly reads = new Map<string, Promise<IAgentGitControlState>>();
	private readonly progress = new Map<string, IAgentGitProgress>();
	/** The chat that last asked about a folder, for reads the folder's own changes start. */
	private readonly sessions = new Map<string, string | undefined>();
	private readonly rereads = this._register(new DisposableMap<string>());
	/** Folders with an action under way (from the click on, prompts and dialogs included): one at a time. */
	private readonly claimed = new Set<string>();
	/** The newest read started per folder; an older one finishing later must not paint over it. */
	private readonly readSeqs = new Map<string, number>();
	/** Open pull requests by `folder|branch`, so the quick action knows whether one exists. */
	private readonly branchPrs = new Map<string, { readonly at: number; readonly pr: IVoltPullRequest | undefined }>();

	constructor(
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IFileService fileService: IFileService,
		@IHostService hostService: IHostService,
	) {
		super();
		// A pull request linked or created elsewhere changes what the quick action offers.
		// A merge, a close or a new link changes what the controls offer: look the branches up again.
		this._register(this.pullRequests.onDidChange(() => {
			this.branchPrs.clear();
			for (const folder of this.states.keys()) {
				this.rereadSoon(folder);
			}
		}));
		// Edits, commits and pushes from anywhere (the agent, a terminal, another app) show without
		// waiting on Source Control: the folder's files and its .git index and refs are watched.
		this._register(fileService.onDidFilesChange(e => {
			for (const folder of this.states.keys()) {
				if (e.affects(URI.file(folder))) {
					this.rereadSoon(folder);
				}
			}
		}));
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				for (const folder of this.states.keys()) {
					this.rereadSoon(folder);
				}
			}
		}));
	}

	/** Reads a folder again shortly; a burst of file events is one read. */
	private rereadSoon(folder: string): void {
		if (this.progress.has(folder)) {
			// The action reads it when it ends.
			return;
		}
		// Setting it again cancels the read already waiting.
		this.rereads.set(folder, disposableTimeout(() => {
			this.rereads.deleteAndDispose(folder);
			void this.state(folder, this.sessions.get(folder), true);
		}, REREAD_DELAY_MS));
	}

	cachedState(folder: string): IAgentGitControlState | undefined {
		const cached = this.states.get(folder)?.state;
		const progress = this.progress.get(folder);
		return cached && progress !== cached.progress ? this.withProgress(cached, folder) : cached;
	}

	state(folder: string, sessionId: string | undefined, force = false): Promise<IAgentGitControlState> {
		this.sessions.set(folder, sessionId);
		const cached = this.states.get(folder);
		if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) {
			return Promise.resolve(this.withProgress(cached.state, folder));
		}
		const pending = this.reads.get(folder);
		if (pending && !force) {
			return pending;
		}
		const read = this.read(folder, sessionId).finally(() => {
			if (this.reads.get(folder) === read) {
				this.reads.delete(folder);
			}
		});
		this.reads.set(folder, read);
		return read;
	}

	private withProgress(state: IAgentGitControlState, folder: string): IAgentGitControlState {
		const progress = this.progress.get(folder);
		const context = { ...state.context, busy: !!progress };
		return { context, quick: resolveQuickAction(context), menu: buildMenuItems(context), ...(progress ? { progress } : {}) };
	}

	private async read(folder: string, sessionId: string | undefined): Promise<IAgentGitControlState> {
		const seq = (this.readSeqs.get(folder) ?? 0) + 1;
		this.readSeqs.set(folder, seq);
		let status: IVoltGitStatus | undefined;
		try {
			status = await this.pullRequests.api.gitStatus(folder);
		} catch (err) {
			this.logService.trace('[volt-git] status failed for', folder, err);
		}
		const pr = status?.branch ? await this.branchPr(folder, status.branch, sessionId) : undefined;
		const hasOpenPr = !!pr && isOpenState(pr.state);
		const landed = pr && !hasOpenPr && (pr.state === 'merged' || pr.state === 'closed') && !!status?.head && pr.headRefOid === status.head
			? { number: pr.number, state: pr.state } : undefined;
		const progress = this.progress.get(folder);
		const context: IAgentGitContext = { status, hasOpenPr, busy: !!progress, ...(landed ? { landedPr: landed } : {}) };
		const state: IAgentGitControlState = { context, quick: resolveQuickAction(context), menu: buildMenuItems(context), ...(progress ? { progress } : {}) };
		if (seq !== this.readSeqs.get(folder)) {
			// A newer read started meanwhile; it says how things are now.
			return this.cachedState(folder) ?? state;
		}
		const before = this.states.get(folder)?.state;
		this.states.set(folder, { at: Date.now(), state });
		if (!before || !sameState(before, state)) {
			this._onDidChange.fire(folder);
		}
		return state;
	}

	/** The open pull request from `branch`, if any. */
	private async openPrFor(folder: string, branch: string, sessionId: string | undefined, force = false): Promise<IVoltPullRequest | undefined> {
		const pr = await this.branchPr(folder, branch, sessionId, force);
		return pr && isOpenState(pr.state) ? pr : undefined;
	}

	/**
	 * The newest pull request from `branch` in any state: the chat's linked one when it is that
	 * branch's and open, else GitHub's answer (cached for a minute).
	 */
	private async branchPr(folder: string, branch: string, sessionId: string | undefined, force = false): Promise<IVoltPullRequest | undefined> {
		const link = sessionId ? currentLink(this.pullRequests.links(sessionId)) : undefined;
		if (link?.snapshot && isOpenState(link.snapshot.state) && link.snapshot.headRefName === branch) {
			return link.snapshot;
		}
		const key = `${folder}|${branch}`;
		const cached = this.branchPrs.get(key);
		if (!force && cached && Date.now() - cached.at < BRANCH_PR_TTL_MS) {
			return cached.pr;
		}
		const repo = await this.pullRequests.repoForFolder(folder);
		if (!repo || repo.provider !== 'github') {
			return undefined;
		}
		try {
			const prs = await this.pullRequests.api.forBranch({ repo: { host: repo.host, owner: repo.owner, name: repo.name }, branch });
			const pr = prs.find(candidate => isOpenState(candidate.state)) ?? prs[0];
			this.branchPrs.set(key, { at: Date.now(), pr });
			return pr;
		} catch (err) {
			this.logService.trace('[volt-git] could not look up the pull request of', branch, err);
			return cached?.pr;
		}
	}

	/** Runs `task` unless another action holds the folder. Claimed before the first await, so two quick clicks are one run. */
	private async exclusive<T>(folder: string, task: () => Promise<T>): Promise<T | undefined> {
		if (this.claimed.has(folder) || this.progress.has(folder)) {
			this.notificationService.info(localize('voltGit.busy', "A git action is running."));
			return undefined;
		}
		this.claimed.add(folder);
		try {
			return await task();
		} finally {
			this.claimed.delete(folder);
		}
	}

	runQuick(folder: string, sessionId: string | undefined): Promise<void> {
		return this.exclusive(folder, () => this.runQuickNow(folder, sessionId)).then(() => undefined);
	}

	private async runQuickNow(folder: string, sessionId: string | undefined): Promise<void> {
		const state = await this.state(folder, sessionId, true);
		const quick = state.quick;
		if (quick.kind === 'hint') {
			if (quick.hint) {
				this.notificationService.info(quick.hint);
			}
			return;
		}
		if (quick.kind === 'pull') {
			await this.pull(folder, sessionId);
			return;
		}
		if (quick.action) {
			await this.runNow(folder, sessionId, quick.action);
		}
	}

	runMenu(folder: string, sessionId: string | undefined, id: IAgentGitMenuItem['id']): Promise<void> {
		return this.exclusive(folder, () => this.runMenuNow(folder, sessionId, id)).then(() => undefined);
	}

	private async runMenuNow(folder: string, sessionId: string | undefined, id: IAgentGitMenuItem['id']): Promise<void> {
		const state = await this.state(folder, sessionId, true);
		const item = state.menu.find(candidate => candidate.id === id);
		if (!item || item.disabled) {
			if (item?.hint) {
				this.notificationService.info(item.hint);
			}
			return;
		}
		if (id === 'push') {
			await this.runNow(folder, sessionId, 'push');
			return;
		}
		if (id === 'createPr') {
			await this.runNow(folder, sessionId, 'createPr');
			return;
		}
		const status = state.context.status;
		if (!status) {
			return;
		}
		const choice = await this.instantiationService.invokeFunction(accessor => showAgentGitCommitDialog(accessor, {
			status,
			generate: paths => this.pullRequests.generateCommitMessage(folder, sessionId, paths),
		}));
		if (!choice) {
			return;
		}
		await this.runNow(folder, sessionId, 'commit', {
			...(choice.message ? { message: choice.message } : {}),
			paths: choice.paths,
			featureBranch: choice.newBranch,
			skipDefaultBranchPrompt: true,
		});
	}

	private async pull(folder: string, sessionId: string | undefined): Promise<void> {
		this.setProgress(folder, localize('voltGit.stage.pull', "Pulling…"));
		try {
			const result = await this.pullRequests.api.pull(folder);
			this.notificationService.info(result.updated
				? localize('voltGit.pulled', "Updated {0} from {1}", result.branch, result.upstream)
				: localize('voltGit.pullUpToDate', "{0} is already up to date", result.branch));
		} catch (err) {
			this.notificationService.error(localize('voltGit.pullFailed', "Pull failed: {0}", voltPrErrorMessage(err)));
		} finally {
			this.setProgress(folder, undefined);
			await this.state(folder, sessionId, true);
		}
	}

	run(folder: string, sessionId: string | undefined, action: AgentGitAction, options: IAgentGitRunOptions = {}): Promise<IAgentGitActionResult | undefined> {
		return this.exclusive(folder, () => this.runNow(folder, sessionId, action, options));
	}

	private async runNow(folder: string, sessionId: string | undefined, action: AgentGitAction, options: IAgentGitRunOptions = {}): Promise<IAgentGitActionResult | undefined> {
		const status = (await this.state(folder, sessionId, true)).context.status;
		if (!status?.branch) {
			this.notificationService.info(localize('voltGit.detached', "Check out a branch before committing or opening a pull request."));
			return undefined;
		}
		let featureBranch = !!options.featureBranch;
		if (!options.skipDefaultBranchPrompt && !featureBranch && requiresDefaultBranchConfirmation(action, status)) {
			const copy = defaultBranchPromptCopy(action, status.branch, actionIncludesCommit(action, status));
			const { result } = await this.dialogService.prompt<'continue' | 'feature'>({
				type: Severity.Warning,
				message: copy.message,
				detail: copy.detail,
				buttons: [
					{ label: copy.continueLabel, run: () => 'continue' },
					{ label: copy.featureLabel, run: () => 'feature' },
				],
				cancelButton: true,
			});
			if (!result) {
				return undefined;
			}
			featureBranch = result === 'feature';
		}

		const includesCommit = actionIncludesCommit(action, status);
		const result: { -readonly [K in keyof IAgentGitActionResult]: IAgentGitActionResult[K] } = {};
		try {
			let message = options.message?.trim();
			if (featureBranch && !includesCommit) {
				this.setProgress(folder, localize('voltGit.stage.branch', "Creating feature branch…"));
				const subject = (await this.pullRequests.api.describeChanges({ folder }).catch(() => undefined))?.recentSubjects[0];
				const name = await this.freeBranchName(folder, subject);
				await this.pullRequests.api.checkoutNewBranch({ folder, name });
				result.branchCreated = name;
			}
			if (includesCommit) {
				// Exactly the files the user saw (renames with the path they left): not ones that appear meanwhile.
				const paths = options.paths ?? status.files.flatMap(file => file.previousPath ? [file.path, file.previousPath] : [file.path]);
				if (!message) {
					this.setProgress(folder, localize('voltGit.stage.message', "Writing commit message…"));
					message = await this.pullRequests.generateCommitMessage(folder, sessionId, paths).catch(err => {
						this.logService.warn('[volt-git] could not write a commit message', err);
						return undefined;
					}) ?? fallbackCommitMessage(status);
				}
				const newBranch = featureBranch ? await this.freeBranchName(folder, message.split('\n')[0]) : undefined;
				this.setProgress(folder, newBranch ? localize('voltGit.stage.commitOn', "Committing on {0}…", newBranch) : localize('voltGit.stage.commit', "Committing…"));
				const commit = await this.pullRequests.api.commit({ folder, message, paths, ...(newBranch ? { newBranch } : {}) });
				result.commit = { sha: commit.sha, subject: commit.subject };
				if (newBranch) {
					result.branchCreated = newBranch;
				}
			}
			if (actionIncludesPush(action)) {
				const branch = result.branchCreated ?? status.branch;
				this.setProgress(folder, status.remote ? localize('voltGit.stage.pushTo', "Pushing to {0}…", `${status.remote}/${branch}`) : localize('voltGit.stage.push', "Pushing…"));
				const pushed = await this.pullRequests.api.push({ folder });
				result.pushed = { branch: pushed.branch, remote: pushed.remote };
			}
			if (actionIncludesPr(action)) {
				this.setProgress(folder, localize('voltGit.stage.prepare', "Preparing pull request…"));
				const repo = await this.pullRequests.repoForFolder(folder, true);
				const branch = repo?.branch;
				if (!repo || repo.provider !== 'github' || !branch) {
					throw new Error(localize('voltGit.noGithub', "This repository has no GitHub remote to open a pull request on."));
				}
				const existing = await this.openPrFor(folder, branch, sessionId, true);
				if (existing) {
					if (sessionId) {
						await this.pullRequests.link(sessionId, { repo: existing.repo, number: existing.number }, 'manual');
					}
					result.pr = { number: existing.number, url: existing.url, existing: true };
				} else {
					const latest = await this.pullRequests.api.gitStatus(folder);
					// Without origin/HEAD, GitHub says which branch is the default (listed first).
					const base = latest?.defaultBranch ?? status.defaultBranch
						?? (await this.pullRequests.api.remoteBranches({ repo: { host: repo.host, owner: repo.owner, name: repo.name } }).catch(() => [] as string[]))[0]
						?? 'main';
					if (latest && !latest.isDefaultBranch && latest.aheadOfDefault === 0) {
						throw new Error(localize('voltGit.nothingForPr', "The branch has no commits that {0} does not.", base));
					}
					this.setProgress(folder, localize('voltGit.stage.prText', "Writing the pull request…"));
					const text = await this.pullRequests.generatePullRequestText(folder, base, sessionId).catch(err => {
						this.logService.warn('[volt-git] could not write the pull request', err);
						return undefined;
					});
					this.setProgress(folder, localize('voltGit.stage.prCreate', "Creating pull request…"));
					// Pushes first when the branch is not on GitHub yet, and links the new pull request to the chat.
					const pr = await this.pullRequests.create(sessionId, folder, {
						title: text?.title || result.commit?.subject || branch,
						body: text?.body ?? '',
						base,
						draft: false,
					});
					this.branchPrs.set(`${folder}|${branch}`, { at: Date.now(), pr });
					result.pr = { number: pr.number, url: pr.url, existing: false };
				}
			}
		} catch (err) {
			this.setProgress(folder, undefined);
			const done = summarizeResult(result);
			this.notificationService.error(result.commit || result.pushed
				? localize('voltGit.partFailed', "{0}, then it stopped: {1}", done.title, voltPrErrorMessage(err))
				: localize('voltGit.failed', "Git action failed: {0}", voltPrErrorMessage(err)));
			await this.state(folder, sessionId, true);
			return result;
		}
		this.setProgress(folder, undefined);
		await this.state(folder, sessionId, true);
		this.toast(folder, sessionId, result);
		return result;
	}

	private toast(folder: string, sessionId: string | undefined, result: IAgentGitActionResult): void {
		const done = summarizeResult(result);
		const actions: Action[] = [];
		if (done.next === 'viewPr' && result.pr) {
			const pr = result.pr;
			actions.push(new Action('volt.git.viewPr', localize('voltGit.viewPr', "View PR"), undefined, true, async () => {
				const repo = await this.pullRequests.repoForFolder(folder);
				if (repo) {
					await this.instantiationService.invokeFunction(accessor => openPullRequest(accessor, { kind: 'pr', repo: { host: repo.host, owner: repo.owner, name: repo.name }, number: pr.number }, sessionId));
				}
			}));
		} else if (done.next === 'push') {
			actions.push(new Action('volt.git.push', localize('voltGit.push', "Push"), undefined, true, () => this.run(folder, sessionId, 'push')));
		} else if (done.next === 'createPr') {
			const menu = this.cachedState(folder)?.menu.find(item => item.id === 'createPr');
			if (menu && !menu.disabled) {
				actions.push(new Action('volt.git.createPr', localize('voltGit.createPr', "Create PR"), undefined, true, () => this.run(folder, sessionId, 'createPr')));
			}
		}
		const message = result.branchCreated && result.pushed?.branch !== result.branchCreated
			? `${done.title} (${localize('voltGit.onBranch', "on {0}", result.branchCreated)})`
			: done.title;
		this.notificationService.notify({
			severity: Severity.Info,
			message: done.detail ? `${message}: ${done.detail}` : message,
			actions: { primary: actions },
		});
	}

	/** A feature branch name the remote does not have yet; a local clash fails the checkout with git's message. */
	private async freeBranchName(folder: string, subject: string | undefined): Promise<string> {
		const existing: string[] = [];
		try {
			const repo = await this.pullRequests.repoForFolder(folder);
			if (repo?.provider === 'github') {
				existing.push(...await this.pullRequests.api.remoteBranches({ repo: { host: repo.host, owner: repo.owner, name: repo.name } }));
			}
		} catch (err) {
			this.logService.trace('[volt-git] could not list remote branches', err);
		}
		return featureBranchName(subject, existing);
	}

	private setProgress(folder: string, label: string | undefined): void {
		if (label) {
			const previous = this.progress.get(folder);
			this.progress.set(folder, { label, startedAt: previous?.startedAt ?? Date.now() });
		} else {
			this.progress.delete(folder);
		}
		this._onDidChange.fire(folder);
	}
}

function sameState(a: IAgentGitControlState, b: IAgentGitControlState): boolean {
	const sa = a.context.status;
	const sb = b.context.status;
	return a.quick.label === b.quick.label && a.quick.disabled === b.quick.disabled && a.context.hasOpenPr === b.context.hasOpenPr
		&& sa?.branch === sb?.branch && sa?.files.length === sb?.files.length && sa?.insertions === sb?.insertions && sa?.deletions === sb?.deletions
		&& sa?.ahead === sb?.ahead && sa?.behind === sb?.behind && sa?.upstream === sb?.upstream
		&& a.menu.map(item => `${item.id}:${item.disabled}`).join() === b.menu.map(item => `${item.id}:${item.disabled}`).join();
}

/** When no model answers: the files say what changed. */
function fallbackCommitMessage(status: IVoltGitStatus): string {
	const names = status.files.slice(0, 3).map(file => file.path.split('/').pop()).filter(Boolean);
	return names.length ? `Update ${names.join(', ')}${status.files.length > 3 ? ` and ${status.files.length - 3} more` : ''}` : 'Update files';
}
