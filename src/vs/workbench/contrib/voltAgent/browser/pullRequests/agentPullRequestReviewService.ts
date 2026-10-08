/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltPullRequestService } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IAgentOrchestratorService, IOrchPrompt } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { resolveRunModelRef } from '../../../../services/voltRuntime/common/models/modelAccess.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import {
	AutoReviewMode,
	buildFixPrompt,
	buildReviewPrompt,
	IPrReviewRecord,
	IRawReviewFinding,
	IReviewFinding,
	isAutoReviewMode,
	mergeReviewFindings,
	parseReviewOutput,
	reviewSeverityLabel,
	REVIEW_FINDINGS_PATH,
	shouldAutoReview,
} from '../../common/agentPrReview.js';
import { isOpenState } from '../../common/agentPullRequests.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';

export const IAgentPrReviewService = createDecorator<IAgentPrReviewService>('agentPrReviewService');

export const AGENT_PR_AUTO_REVIEW_SETTING = 'volt.pullRequests.autoReview';
export const AGENT_PR_REVIEW_MODEL_SETTING = 'volt.pullRequests.reviewModel';
export const AGENT_PR_POST_REVIEW_COMMENTS_SETTING = 'volt.pullRequests.postReviewComments';

/** A review is abandoned after this long; the chat is left for the user to look at. */
const REVIEW_TIMEOUT_MS = 20 * 60_000;
/** A review still waiting on an approval after this long fails: nobody is there to answer it. */
const REVIEW_APPROVAL_WAIT_MS = 30_000;
const SAVE_DELAY_MS = 400;
const STORE_VERSION = 1;

interface IStoreFile {
	readonly version: number;
	readonly reviews: Record<string, IPrReviewRecord>;
}

export interface IAgentPrReviewService {
	readonly _serviceBrand: undefined;
	/** A pull request's review changed (started, finished, a finding dismissed). */
	readonly onDidChange: Event<string>;
	readonly whenReady: Promise<void>;
	/** The review kept for a pull request (by key), if any. */
	record(key: string): IPrReviewRecord | undefined;
	/** Reviews the pull request's current head now (the "Review now" button). */
	reviewNow(key: string): Promise<void>;
	/** Sends a finding to the chat that owns the pull request, as a new turn. */
	fixInChat(key: string, finding: IReviewFinding): Promise<void>;
	/** Dismissed findings stay out of the open list, also after later reviews. */
	setDismissed(key: string, id: string, dismissed: boolean): void;
	/** Posts the open findings as one review with a comment on each line (only when the setting allows it). */
	postFindings(key: string): Promise<void>;
}

/**
 * Bugbot-style review: when a pull request's head changes (the PR watcher sees it), a hidden
 * subagent chat reviews the head in its own worktree and writes its findings; Volt merges them with
 * the earlier review, keeps them, and removes the worktree. The chat is pinned under the chat the
 * pull request is linked to, so it never shows in the sidebar.
 */
export class AgentPullRequestReviewService extends Disposable implements IAgentPrReviewService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	readonly whenReady: Promise<void>;

	private readonly storeFile: URI;
	private reviews = new Map<string, IPrReviewRecord>();
	private readonly running = new Set<string>();
	private readonly saveScheduler = this._register(new RunOnceScheduler(() => void this.save(), SAVE_DELAY_MS));

	constructor(
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IVoltPullRequestService private readonly api: IVoltPullRequestService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.storeFile = joinPath(environmentService.userRoamingDataHome, 'voltPullRequests', 'reviews.json');
		this.whenReady = this.load();
		this._register(this.pullRequests.onDidChangePullRequest(key => void this.maybeReview(key)));
		// Every sync and link change lands here, so a new head is seen even when no snapshot event was fired for it.
		this._register(this.pullRequests.onDidChange(chats => {
			for (const chat of chats) {
				for (const link of this.pullRequests.links(chat)) {
					void this.maybeReview(link.key);
				}
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_PR_AUTO_REVIEW_SETTING)) {
				void this.maybeReviewAll();
			}
		}));
		void this.whenReady.then(() => this.maybeReviewAll());
	}

	//#region Store

	private async load(): Promise<void> {
		try {
			const raw = (await this.fileService.readFile(this.storeFile)).value.toString();
			const stored = JSON.parse(raw) as IStoreFile;
			this.reviews = new Map(Object.entries(stored.reviews ?? {}));
		} catch {
			this.reviews = new Map();
		}
		// A review still marked running was cut off by a restart: it is failed, and starts again on its head.
		for (const [key, record] of this.reviews) {
			if (record.state === 'running') {
				this.reviews.set(key, { ...record, state: 'failed', error: 'Volt restarted before the review finished.', endedAt: Date.now() });
			}
		}
	}

	private async save(): Promise<void> {
		const store: IStoreFile = { version: STORE_VERSION, reviews: Object.fromEntries(this.reviews) };
		try {
			await this.fileService.writeFile(this.storeFile, VSBuffer.fromString(JSON.stringify(store, undefined, '\t')));
		} catch (err) {
			this.logService.warn('[volt pull requests] could not save reviews', err);
		}
	}

	private put(key: string, record: IPrReviewRecord): void {
		this.reviews.set(key, record);
		this.saveScheduler.schedule();
		this._onDidChange.fire(key);
	}

	record(key: string): IPrReviewRecord | undefined {
		return this.reviews.get(key);
	}

	setDismissed(key: string, id: string, dismissed: boolean): void {
		const record = this.reviews.get(key);
		if (!record) {
			return;
		}
		const findings = record.findings.map(finding => finding.id === id ? { ...finding, state: dismissed ? 'dismissed' as const : 'open' as const } : finding);
		this.put(key, { ...record, findings });
	}

	//#region Triggers

	private autoReviewMode(): AutoReviewMode {
		const value = this.configurationService.getValue<unknown>(AGENT_PR_AUTO_REVIEW_SETTING);
		return isAutoReviewMode(value) ? value : 'off';
	}

	private async maybeReviewAll(): Promise<void> {
		await this.whenReady;
		for (const key of this.reviews.keys()) {
			void this.maybeReview(key);
		}
	}

	/** The PR watcher calls this on every sync; the head decides whether anything runs. */
	private async maybeReview(key: string): Promise<void> {
		const mode = this.autoReviewMode();
		if (mode === 'off') {
			return;
		}
		await this.whenReady;
		const snapshot = this.pullRequests.snapshot(key);
		if (!snapshot) {
			return;
		}
		const login = (await this.api.accounts(snapshot.repo.host).catch(() => []))
			.find(account => account.login)?.login;
		const isMine = !!login && snapshot.author.login.toLowerCase() === login.toLowerCase();
		const headSha = snapshot.headRefOid || undefined;
		if (!shouldAutoReview(mode, { isOpen: isOpenState(snapshot.state), isMine, headSha }, this.reviews.get(key))) {
			return;
		}
		await this.review(key, headSha!);
	}

	async reviewNow(key: string): Promise<void> {
		const headSha = this.pullRequests.snapshot(key)?.headRefOid;
		if (headSha) {
			await this.review(key, headSha);
		}
	}

	//#region Review

	private async review(key: string, headSha: string): Promise<void> {
		if (this.running.has(key)) {
			return;
		}
		const parent = this.pullRequests.sessionsFor(key)[0];
		const folder = parent ? this.pullRequests.folderFor(parent) : undefined;
		if (!parent || !folder) {
			// Nothing to review in: the pull request is not linked to a chat in a project.
			return;
		}
		const snapshot = this.pullRequests.snapshot(key);
		if (!snapshot) {
			return;
		}
		const previous = this.reviews.get(key);
		const startedAt = Date.now();
		// The review model setting, else the chat's own model, else the last one the user picked.
		const model = resolveRunModelRef({
			explicit: this.configurationService.getValue<string>(AGENT_PR_REVIEW_MODEL_SETTING) || undefined,
			chat: this.orchestrator.getThread(parent)?.modelRef,
			lastUsed: this.runtime.getActiveCatalogRef(),
		}, this.runtime.listCatalog());
		if (!model) {
			this.put(key, { key, headSha, state: 'failed', startedAt, endedAt: startedAt, findings: previous?.findings ?? [], error: 'No model is set for the review. Pick one in Volt Settings → Pull requests, or in the chat.' });
			return;
		}
		this.running.add(key);
		this.put(key, { key, headSha, state: 'running', startedAt, model, findings: previous?.findings ?? [] });

		let worktreePath: string | undefined;
		let worktreeBranch: string | undefined;
		try {
			// Unique per run: an earlier run that was cut off may still hold its branch.
			const name = `volt-review/${snapshot.number}-${headSha.slice(0, 7)}-${startedAt.toString(36)}`;
			const created = await this.worktrees.create(folder, { kind: 'new', name, from: headSha });
			worktreePath = created.path;
			worktreeBranch = created.branch;

			const diff = await this.worktrees.git(worktreePath, ['diff', '--no-color', `origin/${snapshot.baseRefName}...HEAD`]);
			if (diff.exitCode !== 0) {
				throw new Error(diff.stderr.trim() || 'Could not read the pull request diff.');
			}
			const rules = await this.readRules(worktreePath);
			const prompt = buildReviewPrompt({ title: snapshot.title, base: snapshot.baseRefName, head: snapshot.headRefName, diff: diff.stdout, rules });

			const reviewChat = generateUuid();
			const binding = this.sessionContext.bindingFor(parent);
			if (binding) {
				this.sessionContext.bindSession(reviewChat, binding.projectId);
			}
			this.history.pinSessionParent(reviewChat, parent, { subagent: true });
			this.history.open(reviewChat).setMeta({ worktreePath, worktreeBranch, ...(model ? { model } : {}) });
			await this.orchestrator.dispatch({ type: 'thread.upsert', threadId: reviewChat, title: `Review #${snapshot.number}`, ...(model ? { modelRef: model } : {}), parentId: parent });
			const turnId = generateUuid();
			const outcome = await this.runTurn(reviewChat, turnId, { text: prompt, ...(model ? { modelRef: model } : {}) });
			if (outcome.outcome !== 'done') {
				throw new Error(outcome.error ?? `The review ended as ${outcome.outcome}.`);
			}
			// The findings file wins; otherwise the JSON block in the reply (agents often answer without writing files).
			const raw = (await this.readFindings(worktreePath)) ?? parseReviewOutput(await this.replyOf(reviewChat, turnId) ?? '');
			if (!raw) {
				throw new Error('The review did not return its findings as JSON.');
			}
			const findings = mergeReviewFindings(previous?.findings ?? [], raw, headSha);
			this.put(key, { key, headSha, state: 'done', startedAt, endedAt: Date.now(), model, findings });
		} catch (err) {
			this.logService.warn(`[volt pull requests] review of #${snapshot.number} failed`, err);
			this.put(key, { key, headSha, state: 'failed', startedAt, endedAt: Date.now(), model, error: err instanceof Error ? err.message : String(err), findings: previous?.findings ?? [] });
		} finally {
			this.running.delete(key);
			if (worktreePath && worktreeBranch) {
				await this.worktrees.remove(folder, worktreePath, worktreeBranch, { deleteBranch: true, force: true, ownsBranch: true }).catch(err => this.logService.warn('[volt pull requests] could not remove the review worktree', err));
			}
		}
	}

	private async readRules(worktreePath: string): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(joinPath(URI.file(worktreePath), '.volt', 'review.md'))).value.toString();
		} catch {
			return undefined;
		}
	}

	/** The final reply of a turn, from the chat's transcript. */
	private async replyOf(threadId: string, turnId: string): Promise<string | undefined> {
		const transcript = await this.history.open(threadId).load().catch(() => undefined);
		return transcript?.turns.find(turn => turn.id === turnId)?.assistant?.text;
	}

	private async readFindings(worktreePath: string): Promise<IRawReviewFinding[] | undefined> {
		try {
			const text = (await this.fileService.readFile(joinPath(URI.file(worktreePath), REVIEW_FINDINGS_PATH))).value.toString();
			return parseReviewOutput(text);
		} catch {
			return undefined;
		}
	}

	/** Submits the review prompt and waits for its turn to settle (or time out). */
	private runTurn(threadId: string, turnId: string, prompt: IOrchPrompt): Promise<{ readonly outcome: string; readonly error?: string }> {
		return new Promise(resolve => {
			let settled = false;
			const settle = (value: { readonly outcome: string; readonly error?: string }) => {
				if (!settled) {
					settled = true;
					listener.dispose();
					clearTimeout(timer);
					clearTimeout(approvalTimer);
					resolve(value);
				}
			};
			// A review only reads, so an approval it asks for is never answered: it fails instead of waiting.
			let approvalTimer: ReturnType<typeof setTimeout> | undefined;
			const check = (): void => {
				const thread = this.orchestrator.getThread(threadId);
				const last = thread?.last;
				if (last && last.turnId === turnId) {
					settle({ outcome: last.outcome, error: last.error });
					return;
				}
				const approvalPending = !!thread?.inputs.some(input => input.kind === 'approval');
				if (approvalPending && !approvalTimer) {
					approvalTimer = setTimeout(() => {
						void this.orchestrator.cancel(threadId).catch(() => undefined);
						settle({ outcome: 'failed', error: 'The review asked for an approval, which a review does not get. Review again to retry.' });
					}, REVIEW_APPROVAL_WAIT_MS);
				} else if (!approvalPending && approvalTimer) {
					clearTimeout(approvalTimer);
					approvalTimer = undefined;
				}
			};
			const listener = this.orchestrator.onDidChange(() => check());
			const timer = setTimeout(() => settle({ outcome: 'timeout', error: 'The review took too long.' }), REVIEW_TIMEOUT_MS);
			this.orchestrator.submit(threadId, prompt, 'auto', turnId).then(result => {
				if (result.outcome === 'rejected') {
					settle({ outcome: 'failed', error: result.reason ?? 'The review chat did not take the prompt.' });
				} else {
					check();
				}
			}, err => settle({ outcome: 'failed', error: err instanceof Error ? err.message : String(err) }));
		});
	}

	//#region Post

	async postFindings(key: string): Promise<void> {
		if (this.configurationService.getValue<boolean>(AGENT_PR_POST_REVIEW_COMMENTS_SETTING) !== true) {
			throw new Error(`Turn on ${AGENT_PR_POST_REVIEW_COMMENTS_SETTING} to post review comments.`);
		}
		const record = this.reviews.get(key);
		const snapshot = this.pullRequests.snapshot(key);
		if (!record || !snapshot) {
			throw new Error('Review the pull request first.');
		}
		const open = record.findings.filter(finding => finding.state === 'open');
		if (!open.length) {
			return;
		}
		await this.api.postReview({
			repo: snapshot.repo,
			number: snapshot.number,
			body: `Volt review of ${record.headSha.slice(0, 7)}: ${open.length} ${open.length === 1 ? 'finding' : 'findings'}.`,
			comments: open.map(finding => ({
				path: finding.file,
				line: finding.line,
				body: `**${reviewSeverityLabel(finding.severity)}: ${finding.title}**\n\n${finding.explanation}${finding.suggestion ? `\n\nSuggested fix: ${finding.suggestion}` : ''}`,
			})),
			headOid: record.headSha,
		});
	}

	//#region Fix

	async fixInChat(key: string, finding: IReviewFinding): Promise<void> {
		const chat = this.pullRequests.sessionsFor(key)[0];
		if (!chat) {
			throw new Error('Link the pull request to a chat to fix its findings there.');
		}
		// The PR chat's model, else the model that reviewed the pull request.
		const modelRef = resolveRunModelRef({
			chat: this.orchestrator.getThread(chat)?.modelRef ?? this.record(key)?.model,
			lastUsed: this.runtime.getActiveCatalogRef(),
		}, this.runtime.listCatalog());
		if (!modelRef) {
			throw new Error('No model is set for this chat. Pick one in the composer, then fix the finding again.');
		}
		await this.orchestrator.submit(chat, { text: buildFixPrompt(finding), modelRef }, 'auto');
	}
}
