/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentChangesEditor.css';
import { $, addDisposableListener, append, Dimension } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { MultiDiffEditorWidget } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { IResourceLabel, IWorkbenchUIElementFactory } from '../../../../../editor/browser/widget/multiDiffEditor/workbenchUIElementFactory.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ResourceLabel } from '../../../../browser/labels.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { COPY_PATH_COMMAND_ID } from '../../../files/browser/fileConstants.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { AGENT_EDITOR_ID } from '../editor/agentEditorInput.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentChangesScope, IAgentSessionChangeStats } from './agentSessionChanges.js';
import { getAgentChangesSourceUri, IAgentSessionChangesService } from './agentSessionChangesService.js';

export const AGENT_CHANGES_EDITOR_ID = 'workbench.editor.voltAgentChanges';
export const AGENT_CHANGES_INPUT_ID = 'workbench.input.voltAgentChanges';
export const OPEN_AGENT_CHANGES_COMMAND_ID = 'workbench.action.voltAgent.openChanges';

const ChangesIcon = registerIcon('volt-agent-changes-editor-label-icon', Codicon.diffMultiple, localize('voltAgentChangesIcon', 'Icon of the agent changes review tab.'));

const SCOPE_ORDER: AgentChangesScope[] = ['lastTurn', 'uncommitted', 'staged', 'unstaged'];

export function agentChangesScopeLabel(scope: AgentChangesScope): string {
	switch (scope) {
		case 'lastTurn':
			return localize('voltAgent.changes.lastTurn', "Last Agent Turn");
		case 'staged':
			return localize('voltAgent.changes.staged', "Staged");
		case 'unstaged':
			return localize('voltAgent.changes.unstaged', "Unstaged");
		default:
			return localize('voltAgent.changes.uncommitted', "Uncommitted");
	}
}

export async function openAgentChanges(
	instantiationService: IInstantiationService,
	editorService: IEditorService,
	editorGroupsService: IEditorGroupsService,
	sessionId: string,
	scope: AgentChangesScope = 'uncommitted',
): Promise<void> {
	const existing = editorService.editors.find((editor): editor is AgentChangesEditorInput =>
		editor instanceof AgentChangesEditorInput && editor.sessionId === sessionId);
	if (existing) {
		existing.setScope(scope);
		await editorService.openEditor(existing, { pinned: true, revealIfOpened: true });
		return;
	}
	const input = instantiationService.createInstance(AgentChangesEditorInput, sessionId, scope);
	const target = editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)
		.find(group => group.activeEditorPane?.getId() !== AGENT_EDITOR_ID)
		?? editorGroupsService.activeGroup;
	await editorService.openEditor(input, { pinned: true, revealIfOpened: true }, target);
}

export class AgentChangesEditorInput extends EditorInput {

	static readonly TypeID = AGENT_CHANGES_INPUT_ID;
	static readonly EditorID = AGENT_CHANGES_EDITOR_ID;

	private readonly _onDidChangeScope = this._register(new Emitter<void>());
	readonly onDidChangeScope = this._onDidChangeScope.event;

	private _scope: AgentChangesScope;
	private _resource: URI;

	constructor(
		readonly sessionId: string,
		scope: AgentChangesScope = 'uncommitted',
	) {
		super();
		this._scope = scope;
		this._resource = getAgentChangesSourceUri(sessionId, scope);
	}

	get scope(): AgentChangesScope {
		return this._scope;
	}

	override get resource(): URI {
		return this._resource;
	}

	override get typeId(): string {
		return AgentChangesEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentChangesEditorInput.EditorID;
	}

	override getName(): string {
		return agentChangesScopeLabel(this._scope);
	}

	override getIcon(): ThemeIcon {
		return ChangesIcon;
	}

	setScope(scope: AgentChangesScope): void {
		if (this._scope === scope) {
			return;
		}
		this._scope = scope;
		this._resource = getAgentChangesSourceUri(this.sessionId, scope);
		this._onDidChangeLabel.fire();
		this._onDidChangeScope.fire();
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other)
			|| (other instanceof AgentChangesEditorInput && other.sessionId === this.sessionId);
	}
}

export class AgentChangesEditorInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof AgentChangesEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof AgentChangesEditorInput)) {
			return undefined;
		}
		return JSON.stringify({ sessionId: editor.sessionId, scope: editor.scope });
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serialized) as { sessionId?: string; scope?: AgentChangesScope };
			if (!data.sessionId) {
				return undefined;
			}
			return instantiationService.createInstance(AgentChangesEditorInput, data.sessionId, data.scope ?? 'uncommitted');
		} catch {
			return undefined;
		}
	}
}

export class AgentChangesEditor extends EditorPane {

	static readonly ID = AGENT_CHANGES_EDITOR_ID;

	private container!: HTMLElement;
	private headerEl!: HTMLElement;
	private scopeButton!: HTMLButtonElement;
	private scopeStatsEl!: HTMLElement;
	private scopeLabelEl!: HTMLElement;
	private commitButton!: HTMLButtonElement;
	private bodyEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private widgetHost!: HTMLElement;
	private widget!: MultiDiffEditorWidget;
	private readonly multiInput = this._register(new MutableDisposable<MultiDiffEditorInput>());
	private readonly inputStore = this._register(new DisposableStore());
	private readonly emptyStore = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	private refreshGen = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super(AgentChangesEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-agent-changes-editor'));
		this.headerEl = append(this.container, $('.volt-agent-changes-header'));
		this.scopeButton = append(this.headerEl, $('button.volt-agent-changes-scope')) as HTMLButtonElement;
		this.scopeButton.type = 'button';
		this.scopeStatsEl = append(this.scopeButton, $('span.volt-agent-changes-scope-stats'));
		this.scopeLabelEl = append(this.scopeButton, $('span.volt-agent-changes-scope-label'));
		append(this.scopeButton, renderIcon(Codicon.chevronDown)).classList.add('volt-agent-changes-scope-chevron');
		this.commitButton = append(this.headerEl, $('button.volt-agent-changes-commit')) as HTMLButtonElement;
		this.commitButton.type = 'button';
		append(this.commitButton, $('span')).textContent = localize('voltAgent.commitAndPush', "Commit & Push");
		this._register(addDisposableListener(this.scopeButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showScopeMenu();
		}));
		this._register(addDisposableListener(this.commitButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showCommitMenu();
		}));

		this.bodyEl = append(this.container, $('.volt-agent-changes-body'));
		this.emptyEl = append(this.bodyEl, $('.volt-agent-changes-empty'));
		this.widgetHost = append(this.bodyEl, $('.volt-agent-changes-widget'));
		this.widget = this._register(this.instantiationService.createInstance(
			MultiDiffEditorWidget,
			this.widgetHost,
			this.instantiationService.createInstance(AgentChangesResourceLabelFactory),
		));
		this._register(this.widget.onDidChangeActiveControl(() => this.applyActiveEditorChrome()));
	}

	override async setInput(input: AgentChangesEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.bindInput(input);
		await this.refreshWidget(input);
		if (token.isCancellationRequested) {
			return;
		}
		this.renderHeader(input);
		this.renderEmpty(input);
		this.layoutWidget();
	}

	override clearInput(): void {
		this.inputStore.clear();
		this.multiInput.clear();
		this.widget.setViewModel(undefined);
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.container.style.height = `${dimension.height}px`;
		this.layoutWidget();
	}

	private bindInput(input: AgentChangesEditorInput): void {
		this.inputStore.clear();
		this.inputStore.add(input.onDidChangeScope(() => void this.onScopeChanged(input)));
		this.inputStore.add(this.changesService.onDidChange(sessionId => {
			if (sessionId && sessionId !== input.sessionId) {
				return;
			}
			this.renderHeader(input);
			this.renderEmpty(input);
		}));
	}

	private async onScopeChanged(input: AgentChangesEditorInput): Promise<void> {
		await this.refreshWidget(input);
		this.renderHeader(input);
		this.renderEmpty(input);
		this.layoutWidget();
	}

	private async refreshWidget(input: AgentChangesEditorInput): Promise<void> {
		const gen = ++this.refreshGen;
		const next = MultiDiffEditorInput.fromResourceMultiDiffEditorInput({
			multiDiffSource: getAgentChangesSourceUri(input.sessionId, input.scope),
			label: agentChangesScopeLabel(input.scope),
			isTransient: true,
		}, this.instantiationService);
		const viewModel = await next.getViewModel();
		if (gen !== this.refreshGen) {
			next.dispose();
			return;
		}
		this.multiInput.value = next;
		this.widget.setViewModel(viewModel);
		this.applyActiveEditorChrome();
	}

	private applyActiveEditorChrome(): void {
		const control = this.widget.getActiveControl();
		if (!control) {
			return;
		}
		const chrome = { renderLineHighlight: 'none' as const, renderLineHighlightOnlyWhenFocus: false };
		control.updateOptions(chrome);
		control.getOriginalEditor().updateOptions(chrome);
		control.getModifiedEditor().updateOptions(chrome);
	}

	private renderHeader(input: AgentChangesEditorInput): void {
		const stats = this.changesService.getStats(input.sessionId, input.scope);
		this.scopeStatsEl.replaceChildren();
		if (stats.additions > 0) {
			append(this.scopeStatsEl, $('span.add')).textContent = `+${stats.additions}`;
		}
		if (stats.deletions > 0) {
			append(this.scopeStatsEl, $('span.del')).textContent = `-${stats.deletions}`;
		}
		this.scopeStatsEl.classList.toggle('hidden', stats.additions <= 0 && stats.deletions <= 0);
		this.scopeLabelEl.textContent = stats.files > 0 && (stats.additions > 0 || stats.deletions > 0)
			? ''
			: agentChangesScopeLabel(input.scope);
		this.scopeButton.setAttribute('aria-label', agentChangesScopeLabel(input.scope));
	}

	private renderEmpty(input: AgentChangesEditorInput): void {
		const stats = this.changesService.getStats(input.sessionId, input.scope);
		const empty = stats.files === 0;
		this.emptyEl.classList.toggle('hidden', !empty);
		this.widgetHost.classList.toggle('hidden', empty);
		if (!empty) {
			this.emptyStore.clear();
			return;
		}
		this.emptyStore.clear();
		this.emptyEl.replaceChildren();
		const title = append(this.emptyEl, $('.volt-agent-changes-empty-title'));
		title.textContent = localize('voltAgent.changes.noneInScope', "No {0} changes", agentChangesScopeLabel(input.scope).toLowerCase());
		const overview = this.changesService.getOverview(input.sessionId);
		const rows: Array<{ scope: AgentChangesScope; label: string; stats: IAgentSessionChangeStats; icon: ThemeIcon }> = [
			{ scope: 'uncommitted', label: localize('voltAgent.changes.filesChanged', "Files Changed"), stats: overview.filesChanged, icon: Codicon.file },
			{ scope: 'lastTurn', label: localize('voltAgent.changes.lastTurn', "Last Agent Turn"), stats: overview.lastTurn, icon: Codicon.history },
			{ scope: 'unstaged', label: localize('voltAgent.changes.unstaged', "Unstaged"), stats: overview.unstaged, icon: Codicon.diff },
			{ scope: 'staged', label: localize('voltAgent.changes.staged', "Staged"), stats: overview.staged, icon: Codicon.gitCommit },
		];
		const list = append(this.emptyEl, $('.volt-agent-changes-empty-list'));
		for (const row of rows) {
			if (row.scope === input.scope || (row.stats.files <= 0 && row.stats.additions <= 0 && row.stats.deletions <= 0)) {
				continue;
			}
			const button = append(list, $('button.volt-agent-changes-empty-row')) as HTMLButtonElement;
			button.type = 'button';
			append(button, renderIcon(row.icon)).classList.add('volt-agent-changes-empty-icon');
			append(button, $('span.volt-agent-changes-empty-row-label')).textContent = row.stats.files && row.scope === 'uncommitted'
				? localize('voltAgent.changes.filesChangedCount', "{0} Files Changed", row.stats.files)
				: row.label;
			const stat = append(button, $('span.volt-agent-changes-empty-row-stats'));
			if (row.stats.additions > 0) {
				append(stat, $('span.add')).textContent = `+${row.stats.additions}`;
			}
			if (row.stats.deletions > 0) {
				append(stat, $('span.del')).textContent = `-${row.stats.deletions}`;
			}
			this.emptyStore.add(addDisposableListener(button, 'click', () => input.setScope(row.scope)));
		}
	}

	private layoutWidget(): void {
		if (!this.dimension) {
			return;
		}
		const height = Math.max(0, this.dimension.height - this.headerEl.offsetHeight);
		this.bodyEl.style.height = `${height}px`;
		this.widget.layout(new Dimension(this.dimension.width, height));
	}

	private showScopeMenu(): void {
		const input = this.input;
		if (!(input instanceof AgentChangesEditorInput)) {
			return;
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.scopeButton,
			getActions: () => SCOPE_ORDER.map(scope => {
				const stats = this.changesService.getStats(input.sessionId, scope);
				const label = formatScopeAction(scope, stats);
				return new Action(`volt.agent.changes.scope.${scope}`, label, input.scope === scope ? 'checked' : undefined, true, () => {
					input.setScope(scope);
				});
			}),
		});
	}

	private showCommitMenu(): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.commitButton,
			getActions: () => [
				new Action('volt.agent.commit', localize('voltAgent.commit', "Commit"), undefined, true, () => this.commandService.executeCommand('git.commitAll')),
				new Action('volt.agent.commitPush', localize('voltAgent.commitAndPush', "Commit & Push"), undefined, true, async () => {
					await this.commandService.executeCommand('git.commitAll');
					await this.commandService.executeCommand('git.push');
				}),
				new Action('volt.agent.push', localize('voltAgent.push', "Push"), undefined, true, () => this.commandService.executeCommand('git.push')),
			],
		});
	}
}

function formatScopeAction(scope: AgentChangesScope, stats: IAgentSessionChangeStats): string {
	const label = agentChangesScopeLabel(scope);
	const parts: string[] = [];
	if (stats.additions > 0) {
		parts.push(`+${stats.additions}`);
	}
	if (stats.deletions > 0) {
		parts.push(`-${stats.deletions}`);
	}
	return parts.length ? `${label}  ${parts.join(' ')}` : label;
}

class AgentChangesResourceLabelFactory implements IWorkbenchUIElementFactory {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) { }

	createResourceLabel(element: HTMLElement): IResourceLabel {
		const label = this.instantiationService.createInstance(ResourceLabel, element, {});
		let currentUri: URI | undefined;
		element.classList.add('volt-agent-changes-file-label');
		setAgentTooltip(element, localize('voltAgent.copyPath', "Copy Path"));
		const fileUri = () => currentUri?.scheme === Schemas.voltAgentSnapshot
			? URI.file(currentUri.path)
			: currentUri;
		element.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (!currentUri) {
				return;
			}
			void this.commandService.executeCommand('multiDiffEditor.goToFile', fileUri() ?? currentUri);
		});
		element.addEventListener('contextmenu', event => {
			event.preventDefault();
			event.stopPropagation();
			const uri = fileUri();
			if (uri) {
				void this.commandService.executeCommand(COPY_PATH_COMMAND_ID, uri);
			}
		});
		return {
			setUri: (uri, options = {}) => {
				currentUri = uri;
				if (!uri) {
					label.element.clear();
					element.removeAttribute('title');
					return;
				}
				label.element.setFile(uri, { strikethrough: options.strikethrough });
			},
			dispose: () => label.dispose(),
		};
	}
}
