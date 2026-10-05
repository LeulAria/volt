/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
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
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { SHOW_AGENT_SCM_COMMAND_ID } from '../workspace/agentSurfaceHost.js';
import { agentChangesScopeLabel } from './agentChangesEditor.js';
import { AgentChangesScope, agentScopeTurnId } from './agentSessionChanges.js';
import { getAgentChangesSourceUri, IAgentSessionChangesService } from './agentSessionChangesService.js';
import { findAgentScmRepository } from './agentScmRepository.js';

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

function hasStats(stats: { additions: number; deletions: number }): boolean {
	return stats.additions > 0 || stats.deletions > 0;
}

/**
 * The bar above a chat's changes in the tools, as Cursor draws it: the scope (with its line
 * counts) and a menu of the others and recent commits, the branch, and Commit & Push, which
 * opens Source Control.
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

	constructor(
		private readonly input: MultiDiffEditorInput,
		private readonly group: IEditorGroup,
		private readonly target: AgentChangesHeaderTarget,
		@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISCMService private readonly scmService: ISCMService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
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
			const root = this.repository?.provider.rootUri;
			void this.commandService.executeCommand('git.checkout', root);
		}));
		this._register(addDisposableListener(commit, 'click', e => {
			EventHelper.stop(e, true);
			void this.commandService.executeCommand(SHOW_AGENT_SCM_COMMAND_ID);
		}));

		this._register(changesService.onDidChange(sessionId => {
			if (sessionId === target.sessionId) {
				this.renderScope();
			}
		}));
		this._register(scmService.onDidAddRepository(() => this.trackRepository()));
		this._register(scmService.onDidRemoveRepository(() => this.trackRepository()));
		this.renderScope();
		this.trackRepository();
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
		const scopes = current && !MENU_SCOPES.includes(current) ? [current, ...MENU_SCOPES] : MENU_SCOPES;
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
