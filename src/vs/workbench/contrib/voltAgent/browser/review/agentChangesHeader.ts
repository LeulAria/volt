/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { isEqual, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IMultiDiffEditorHeader } from '../../../multiDiffEditor/browser/multiDiffEditor.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { ScmHistoryItemResolver } from '../../../multiDiffEditor/browser/scmMultiDiffSourceResolver.js';
import { getHistoryItemEditorTitle } from '../../../scm/browser/util.js';
import { ISCMHistoryItem } from '../../../scm/common/history.js';
import { ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { showAgentBranchMenu } from '../picker/agentBranchMenu.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { voltButtonClasses } from '../chrome/voltButton.js';
import { SHOW_AGENT_SCM_COMMAND_ID } from '../../common/agentGitActions.js';
import { AgentChangesScope, IAgentChangesTurn, agentScopeTurnId } from './agentSessionChanges.js';
import { getAgentChangesSourceUri, IAgentSessionChangesService } from './agentSessionChangesService.js';
import { findAgentScmRepository } from './agentScmRepository.js';
import { IAgentEditsService } from './agentEditsService.js';
import { AgentGitActionsControl } from '../pullRequests/agentGitActionsControl.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';

const HEADER_HEIGHT = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Git branch outline at a 1.5px stroke; a codicon's stroke is fixed by its font. */
function createGitBranchIcon(doc: Document): SVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.classList.add('volt-agent-changes-commit-icon');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.5');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const [cx, cy] of [[6, 5], [6, 19], [18, 7]]) {
		const circle = doc.createElementNS(SVG_NS, 'circle');
		circle.setAttribute('cx', String(cx));
		circle.setAttribute('cy', String(cy));
		circle.setAttribute('r', '2.25');
		svg.appendChild(circle);
	}
	const path = doc.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', 'M6 7.25v9.5M18 9.25a6 6 0 0 1-6 6H6');
	svg.appendChild(path);
	return svg;
}
const COMMIT_LIMIT = 30;

/** What a changes diff shows: a scope of the chat's changes, or a commit picked from its header. */
export type AgentChangesHeaderTarget =
	| { readonly kind: 'scope'; readonly sessionId: string; readonly scope: AgentChangesScope }
	| { readonly kind: 'commit'; readonly sessionId: string; readonly commit: ISCMHistoryItem };

/** Commit diffs opened from a header, so they get the header too. */
const commitInputs = new WeakMap<MultiDiffEditorInput, AgentChangesHeaderTarget>();

export function getAgentCommitDiffTarget(input: MultiDiffEditorInput): AgentChangesHeaderTarget | undefined {
	return commitInputs.get(input);
}

type ScopePick = { readonly kind: 'scope'; readonly scope: AgentChangesScope } | { readonly kind: 'commit'; readonly commit: ISCMHistoryItem } | { readonly kind: 'none' };

const MENU_SCOPES: readonly AgentChangesScope[] = ['lastTurn', 'uncommitted', 'staged', 'unstaged'];

function scopeIcon(scope: AgentChangesScope): ThemeIcon {
	switch (scope) {
		case 'lastTurn': return Codicon.gitCompare;
		case 'uncommitted': return Codicon.diffMultiple;
		case 'staged': return Codicon.diffAdded;
		case 'unstaged': return Codicon.diffModified;
		case 'pending': return Codicon.edit;
		default: return Codicon.history;
	}
}

/** What Find Issues reviews: the chat's changes in a scope, one commit, or the branch against its base. */
export type AgentFindIssuesTarget =
	| { readonly kind: 'changes'; readonly scope: AgentChangesScope; readonly files: readonly string[] }
	| { readonly kind: 'commit'; readonly id: string; readonly subject: string }
	| { readonly kind: 'base'; readonly base: string };

/**
 * The review prompt Find Issues sends to the chat (in Ask mode, so it reports and does not edit):
 * Cursor's Find Issues, done by the chat's own agent, which already knows why it made the changes.
 */
export function findIssuesPrompt(target: AgentFindIssuesTarget, instructions?: string): string {
	const lines: string[] = [];
	switch (target.kind) {
		case 'changes': {
			const what = target.scope === 'pending' ? 'the changes still waiting for Keep or Undo'
				: target.scope === 'lastTurn' ? 'the changes from your last turn'
					: target.scope === 'staged' ? 'the staged changes (`git diff --cached`)'
						: target.scope === 'unstaged' ? 'the unstaged changes (`git diff`)'
							: 'the uncommitted changes in this chat';
			lines.push(`Find issues in ${what}.`);
			if (target.files.length) {
				lines.push('', 'Files:', ...target.files.slice(0, 50).map(file => `- ${file}`));
				if (target.files.length > 50) {
					lines.push(`- and ${target.files.length - 50} more (see \`git status\`)`);
				}
			}
			break;
		}
		case 'commit':
			lines.push(`Find issues in commit ${target.id.slice(0, 12)} ("${target.subject}"); read it with \`git show ${target.id}\`.`);
			break;
		case 'base':
			lines.push(`Find issues in this branch's changes against ${target.base}; read them with \`git diff ${target.base}...HEAD\` plus any uncommitted changes.`);
			break;
	}
	lines.push(
		'',
		'Read the full diff and enough of the surrounding code to judge it. Look for bugs, regressions, unhandled edge cases, broken callers, security problems, and missing or wrong tests. Do not edit any files.',
		'',
		'Report each issue as: severity (high, medium, low), `file:line`, what goes wrong and when, and the fix in one line. Most severe first. If you find nothing worth fixing, say "No issues found." and stop.',
	);
	const extra = instructions?.trim();
	if (extra) {
		lines.push('', `Also: ${extra}`);
	}
	return lines.join('\n');
}

function hasStats(stats: { additions: number; deletions: number }): boolean {
	return stats.additions > 0 || stats.deletions > 0;
}

/**
 * The bar above a chat's changes in the tools, as Cursor draws it: the scope (with its line
 * counts) and a menu of the others and recent commits, the branch, Undo All and Keep All while
 * the agent's edits wait for review, and the chat's git action (Commit & Push and the rest under
 * its chevron), or Commit & Push to Source Control where git actions are not available.
 */
export class AgentChangesHeader extends Disposable implements IMultiDiffEditorHeader {

	readonly element: HTMLElement;
	readonly height = HEADER_HEIGHT;

	private readonly scopeButton: HTMLButtonElement;
	private readonly scopeIcon: HTMLElement;
	private readonly scopeLabel: HTMLElement;
	private readonly scopeStats: HTMLElement;
	private readonly branchButton: HTMLButtonElement;
	private readonly branchLabel: HTMLElement;
	private repository: ISCMRepository | undefined;
	private readonly branchWatch = this._register(new MutableDisposable());
	private readonly findIssuesButton: HTMLButtonElement;
	private readonly findIssuesChevron: HTMLButtonElement;
	private readonly undoAllButton: HTMLButtonElement;
	private readonly keepAllButton: HTMLButtonElement;
	private resolving = false;

	constructor(
		private readonly input: MultiDiffEditorInput,
		private readonly group: IEditorGroup,
		private readonly target: AgentChangesHeaderTarget,
		@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService,
		@IAgentEditsService private readonly edits: IAgentEditsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISCMService private readonly scmService: ISCMService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.element = $('.volt-agent-changes-header');
		this._register({ dispose: () => this.element.remove() });

		this.scopeButton = append(this.element, $('button.volt-agent-changes-scope')) as HTMLButtonElement;
		this.scopeButton.type = 'button';
		this.scopeIcon = append(this.scopeButton, $('span.volt-agent-changes-scope-icon'));
		this.scopeLabel = append(this.scopeButton, $('span.volt-agent-changes-scope-label'));
		this.scopeStats = append(this.scopeButton, $('span.volt-agent-changes-scope-stats'));
		append(this.scopeButton, renderIcon(Codicon.chevronDown)).classList.add('volt-agent-changes-chevron');

		this.branchButton = append(this.element, $('button.volt-agent-changes-branch')) as HTMLButtonElement;
		this.branchButton.type = 'button';
		this.branchLabel = append(this.branchButton, $('span.volt-agent-changes-branch-label'));
		append(this.branchButton, renderIcon(Codicon.chevronDown)).classList.add('volt-agent-changes-chevron');

		append(this.element, $('.volt-agent-changes-header-spacer'));

		// The composer's Undo All / Keep All, here too: the whole review without going back to the chat.
		this.undoAllButton = this.resolveButton(localize('voltAgent.changes.undoAll', "Undo All"), () => this.edits.undoAll(target.sessionId));
		this.keepAllButton = this.resolveButton(localize('voltAgent.changes.keepAll', "Keep All"), () => this.edits.keepAll(target.sessionId));

		// Find Issues: the chat's agent reviews what this tab shows; the chevron picks another target.
		const find = append(this.element, $('.volt-agent-changes-find'));
		this.findIssuesButton = append(find, $('button.volt-agent-changes-find-main')) as HTMLButtonElement;
		this.findIssuesButton.type = 'button';
		this.findIssuesButton.textContent = localize('voltAgent.changes.findIssues', "Find Issues");
		this.findIssuesButton.title = localize('voltAgent.changes.findIssuesTitle', "Have the chat's agent review these changes for bugs, without editing");
		this.findIssuesChevron = append(find, $('button.volt-agent-changes-find-chevron')) as HTMLButtonElement;
		this.findIssuesChevron.type = 'button';
		this.findIssuesChevron.setAttribute('aria-label', localize('voltAgent.changes.findIssuesOptions', "Find Issues Options"));
		this.findIssuesChevron.appendChild(renderIcon(Codicon.chevronDown));
		this._register(addDisposableListener(this.findIssuesButton, 'click', e => {
			EventHelper.stop(e, true);
			void this.findIssues(this.shownTarget());
		}));
		this._register(addDisposableListener(this.findIssuesChevron, 'click', e => {
			EventHelper.stop(e, true);
			this.showFindIssuesMenu();
		}));

		// The composer's Commit chip, as a split button: it runs the next step, its chevron the others.
		const git = this._register(instantiationService.createInstance(AgentGitActionsControl, this.element, {
			look: 'header',
			target: () => {
				const folder = (sessionContext.rootFor(target.sessionId) ?? workspaceContextService.getWorkspace().folders[0]?.uri)?.fsPath;
				return { sessionId: target.sessionId, ...(folder ? { folder } : {}) };
			},
			onDidChangeVisibility: visible => commit.classList.toggle('hidden', visible),
		}));
		const commit = append(this.element, $('button.volt-agent-changes-commit')) as HTMLButtonElement;
		commit.type = 'button';
		commit.appendChild(createGitBranchIcon(commit.ownerDocument));
		append(commit, $('span')).textContent = localize('voltAgent.changes.commitAndPush', "Commit & Push");

		this._register(addDisposableListener(this.scopeButton, 'click', e => {
			EventHelper.stop(e, true);
			this.showScopeMenu();
		}));
		this._register(addDisposableListener(this.branchButton, 'click', e => {
			EventHelper.stop(e, true);
			// The same dropdown as the new chat's Branch pill, under the button, not the quick pick up top.
			const repository = this.repository;
			this.instantiationService.invokeFunction(showAgentBranchMenu, { anchor: this.branchButton, root: repository?.provider.rootUri, repository });
		}));
		this._register(addDisposableListener(commit, 'click', e => {
			EventHelper.stop(e, true);
			void this.commandService.executeCommand(SHOW_AGENT_SCM_COMMAND_ID);
		}));

		this._register(changesService.onDidChange(sessionId => {
			if (sessionId === target.sessionId) {
				this.renderScope();
				void git.refresh();
			}
		}));
		void git.refresh();
		this._register(this.edits.onDidChange(() => this.renderResolve()));
		this._register(scmService.onDidAddRepository(() => this.trackRepository()));
		this._register(scmService.onDidRemoveRepository(() => this.trackRepository()));
		this.renderScope();
		this.renderResolve();
		this.trackRepository();
	}

	/** What this tab shows, as a Find Issues target. */
	private shownTarget(): AgentFindIssuesTarget {
		const target = this.target;
		if (target.kind === 'commit') {
			return { kind: 'commit', id: target.commit.id, subject: target.commit.subject };
		}
		const files = target.scope === 'pending'
			? this.edits.getPendingFiles(target.sessionId).map(file => this.workspaceRelative(file.uri))
			: target.scope === 'lastTurn' || target.scope === 'uncommitted'
				? this.changesService.getFiles(target.sessionId, target.scope).map(file => file.path)
				: [];
		return { kind: 'changes', scope: target.scope, files };
	}

	private workspaceRelative(uri: URI): string {
		const root = this.sessionContext.rootFor(this.target.sessionId) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
		return (root && relativePath(root, uri)) ?? uri.fsPath;
	}

	private showFindIssuesMenu(): void {
		type Pick = { readonly kind: 'run'; readonly target: AgentFindIssuesTarget } | { readonly kind: 'instructions' };
		const shown = this.shownTarget();
		const items: IVoltMenuItem<Pick>[] = [{
			id: 'shown',
			label: shown.kind === 'commit'
				? localize('voltAgent.changes.findInCommit', "This Commit")
				: this.scopeName(shown.kind === 'changes' ? shown.scope : 'uncommitted'),
			icon: shown.kind === 'commit' ? Codicon.gitCommit : scopeIcon(shown.kind === 'changes' ? shown.scope : 'uncommitted'),
			data: { kind: 'run', target: shown },
		}];
		const base = this.repository?.provider.historyProvider.get()?.historyItemBaseRef.get()?.name;
		if (base) {
			items.push({
				id: 'base',
				label: localize('voltAgent.changes.findAgainstBase', "Diff Against {0}", base),
				icon: Codicon.gitCompare,
				data: { kind: 'run', target: { kind: 'base', base } },
			});
		}
		showVoltMenu<Pick>(this.contextViewService, {
			anchor: this.findIssuesChevron,
			align: 'right',
			ariaLabel: localize('voltAgent.changes.findIssuesOptions', "Find Issues Options"),
			width: 260,
			sections: [
				{ id: 'targets', title: localize('voltAgent.changes.findIssuesIn', "Find Issues In"), items },
				{ id: 'more', items: [{ id: 'instructions', label: localize('voltAgent.changes.findWithInstructions', "With Instructions"), icon: Codicon.edit, data: { kind: 'instructions' } }] },
			],
			onPick: item => {
				const pick = item.data;
				if (pick.kind === 'run') {
					void this.findIssues(pick.target);
					return;
				}
				void this.quickInputService.input({
					prompt: localize('voltAgent.changes.findInstructionsPrompt', "What should the review focus on?"),
					placeHolder: localize('voltAgent.changes.findInstructionsPlaceholder', "e.g. Check the error handling and the new API's callers"),
				}).then(instructions => {
					if (instructions !== undefined) {
						void this.findIssues(shown, instructions);
					}
				});
			},
		});
	}

	/** Sends the review to the chat in Ask mode: queued behind a running turn, at once otherwise. */
	private async findIssues(target: AgentFindIssuesTarget, instructions?: string): Promise<void> {
		const text = findIssuesPrompt(target, instructions);
		const display = localize('voltAgent.changes.findIssuesDisplay', "Find issues in these changes");
		try {
			const result = await this.orchestrator.submit(this.target.sessionId, {
				text,
				display: { text: instructions?.trim() ? `${display}: ${instructions.trim()}` : display },
				mode: 'Ask',
			}, 'auto');
			if (result.outcome === 'rejected') {
				this.notificationService.warn(localize('voltAgent.changes.findIssuesRejected', "The chat did not take the review: {0}", result.reason ?? ''));
			}
		} catch (err) {
			this.notificationService.warn(localize('voltAgent.changes.findIssuesFailed', "Could not start Find Issues: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private resolveButton(label: string, run: () => Promise<void>): HTMLButtonElement {
		const button = append(this.element, $('button.volt-agent-changes-resolve')) as HTMLButtonElement;
		button.classList.add(...voltButtonClasses('ghost'));
		button.type = 'button';
		button.textContent = label;
		this._register(addDisposableListener(button, 'click', async e => {
			EventHelper.stop(e, true);
			if (this.resolving) {
				return;
			}
			this.resolving = true;
			this.renderResolve();
			try {
				await run();
			} finally {
				this.resolving = false;
				this.renderResolve();
			}
		}));
		return button;
	}

	/** Undo All and Keep All while the chat has edits waiting for Keep or Undo. */
	private renderResolve(): void {
		const pending = this.edits.getPendingFiles(this.target.sessionId).length > 0;
		for (const button of [this.undoAllButton, this.keepAllButton]) {
			button.classList.toggle('hidden', !pending);
			button.disabled = this.resolving;
		}
	}

	private trackRepository(): void {
		const root = this.sessionContext.rootFor(this.target.sessionId) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
		const repository = root ? findAgentScmRepository(this.scmService, this.uriIdentityService, root) : undefined;
		if (repository === this.repository && repository) {
			return;
		}
		this.repository = repository;
		this.branchWatch.value = autorun(reader => {
			const name = repository?.provider.historyProvider.read(reader)?.historyItemRef.read(reader)?.name;
			this.branchLabel.textContent = name ?? '';
			this.branchButton.classList.toggle('hidden', !name);
		});
	}

	private renderScope(): void {
		const target = this.target;
		let icon: ThemeIcon;
		let label: string;
		let stats: { additions: number; deletions: number };
		if (target.kind === 'scope') {
			icon = scopeIcon(target.scope);
			label = this.scopeName(target.scope);
			stats = this.changesService.getStats(target.sessionId, target.scope);
		} else {
			icon = Codicon.gitCommit;
			label = target.commit.subject;
			stats = { additions: target.commit.statistics?.insertions ?? 0, deletions: target.commit.statistics?.deletions ?? 0 };
		}
		this.scopeIcon.replaceChildren(renderIcon(icon));
		this.scopeLabel.textContent = label;
		this.scopeButton.title = label;
		this.scopeStats.replaceChildren();
		if (stats.additions > 0) {
			append(this.scopeStats, $('span.add')).textContent = `+${stats.additions}`;
		}
		if (stats.deletions > 0) {
			append(this.scopeStats, $('span.del')).textContent = `-${stats.deletions}`;
		}
		this.scopeStats.classList.toggle('hidden', !hasStats(stats));
	}

	private scopeName(scope: AgentChangesScope): string {
		const turnId = agentScopeTurnId(scope);
		const turn = turnId ? this.changesService.getTurns(this.target.sessionId).find(candidate => candidate.turnId === turnId) : undefined;
		return agentChangesScopeLabel(scope, turn);
	}

	private showScopeMenu(): void {
		const { sessionId } = this.target;
		const current = this.target.kind === 'scope' ? this.target.scope : undefined;
		// Pending Changes leads while the agent's edits wait for Keep or Undo (Cursor's "N Pending Changes").
		const base = this.edits.getPendingFiles(sessionId).length > 0 ? ['pending' as AgentChangesScope, ...MENU_SCOPES] : MENU_SCOPES;
		const scopes = current && !base.includes(current) ? [current, ...base] : base;
		const items: IVoltMenuItem<ScopePick>[] = scopes.map(scope => ({
			id: scope,
			label: this.scopeName(scope),
			icon: scopeIcon(scope),
			stats: this.changesService.getStats(sessionId, scope),
			checked: scope === current,
			data: { kind: 'scope', scope },
		}));
		const provider = this.repository?.provider;
		if (provider?.historyProvider.get()) {
			items.push({
				id: 'commits',
				label: localize('voltAgent.changes.commits', "Commits"),
				icon: Codicon.gitCommit,
				data: { kind: 'none' },
				submenu: {
					width: 360,
					emptyMessage: localize('voltAgent.changes.noCommits', "No commits"),
					sections: async () => [{ id: 'commits', items: await this.commitItems() }],
				},
			});
		}
		showVoltMenu<ScopePick>(this.contextViewService, {
			anchor: this.scopeButton,
			ariaLabel: localize('voltAgent.changes.scopeMenu', "Changes to show"),
			width: 300,
			sections: [{ id: 'scopes', items }] satisfies IVoltMenuSection<ScopePick>[],
			onPick: item => this.pick(item.data),
		});
	}

	private async commitItems(): Promise<IVoltMenuItem<ScopePick>[]> {
		const history = this.repository?.provider.historyProvider.get();
		const ref = history?.historyItemRef.get();
		if (!history || !ref) {
			return [];
		}
		const commits = await history.provideHistoryItems({ historyItemRefs: [ref.id], limit: COMMIT_LIMIT }) ?? [];
		const shown = this.target.kind === 'commit' ? this.target.commit.id : undefined;
		return commits.map(commit => ({
			id: commit.id,
			label: commit.subject,
			description: commit.displayId ?? commit.id.slice(0, 7),
			stats: commit.statistics ? { additions: commit.statistics.insertions, deletions: commit.statistics.deletions } : undefined,
			checked: commit.id === shown,
			data: { kind: 'commit', commit },
		}));
	}

	/** Shows `pick` in place of this diff, in the same tab position. */
	private async pick(pick: ScopePick): Promise<void> {
		let next: MultiDiffEditorInput;
		if (pick.kind === 'scope') {
			if (this.target.kind === 'scope' && this.target.scope === pick.scope) {
				return;
			}
			next = MultiDiffEditorInput.fromResourceMultiDiffEditorInput({
				multiDiffSource: getAgentChangesSourceUri(this.target.sessionId, pick.scope),
				label: this.scopeName(pick.scope),
			}, this.instantiationService);
		} else if (pick.kind === 'commit' && this.repository) {
			if (this.target.kind === 'commit' && this.target.commit.id === pick.commit.id) {
				return;
			}
			next = MultiDiffEditorInput.fromResourceMultiDiffEditorInput({
				multiDiffSource: ScmHistoryItemResolver.getMultiDiffSourceUri(this.repository.provider, pick.commit),
				label: getHistoryItemEditorTitle(pick.commit),
			}, this.instantiationService);
			commitInputs.set(next, { kind: 'commit', sessionId: this.target.sessionId, commit: pick.commit });
		} else {
			return;
		}
		const existing = this.group.editors.find(editor => editor !== this.input && editor instanceof MultiDiffEditorInput && isEqual(editor.resource, next.resource));
		if (existing) {
			next.dispose();
			await this.group.openEditor(existing, { pinned: true });
			await this.group.closeEditor(this.input, { preserveFocus: true });
			return;
		}
		await this.group.replaceEditors([{ editor: this.input, replacement: next, options: { pinned: true } }]);
	}
}

export function agentChangesScopeLabel(scope: AgentChangesScope, turn?: IAgentChangesTurn): string {
	switch (scope) {
		case 'pending':
			return localize('voltAgent.changes.pending', "Pending Changes");
		case 'lastTurn':
			return localize('voltAgent.changes.lastTurn', "Last Agent Turn");
		case 'staged':
			return localize('voltAgent.changes.staged', "Staged");
		case 'unstaged':
			return localize('voltAgent.changes.unstaged', "Unstaged");
		case 'uncommitted':
			return localize('voltAgent.changes.uncommitted', "Uncommitted");
		default:
			return turn
				? localize('voltAgent.changes.turnNumber', "Turn {0}", turn.number)
				: localize('voltAgent.changes.turn', "Turn");
	}
}
