/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentCustomize.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../../base/browser/dom.js';
import { IActionViewItem } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IBaseActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action, IAction } from '../../../../../base/common/actions.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { AgentCustomizationKind, AgentCustomizationScanner, AgentCustomizationScope, CONFIG_DIR_PATTERN, CONFIG_DIRS, CUSTOMIZATION_KINDS, IAgentCustomization, kindInfo, newItemLocation, safeItemName } from './agentCustomize.js';
import { createAgentTitleActionViewItem } from '../editor/agentTitleActions.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

export const AGENT_CUSTOMIZE_EDITOR_ID = 'workbench.editor.voltCustomize';
export const AGENT_CUSTOMIZE_INPUT_ID = 'workbench.input.voltCustomize';

const CustomizeIcon = registerIcon('volt-customize-editor-label-icon', Codicon.extensions, localize('voltCustomizeIcon', 'Icon of the agent Customize tab.'));

export class AgentCustomizeEditorInput extends EditorInput {

	static readonly TypeID = AGENT_CUSTOMIZE_INPUT_ID;
	static readonly EditorID = AGENT_CUSTOMIZE_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltCustomize, path: 'customize' });

	override get typeId(): string {
		return AgentCustomizeEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentCustomizeEditorInput.EditorID;
	}

	override getName(): string {
		return localize('voltCustomize.tab', "Customize");
	}

	override getIcon(): ThemeIcon {
		return CustomizeIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentCustomizeEditorInput;
	}
}

export class AgentCustomizeEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AgentCustomizeEditorInput);
	}
}

type KindFilter = AgentCustomizationKind | 'all';
type ScopeFilter = AgentCustomizationScope | 'all';

const SCOPE_LABELS: Record<ScopeFilter, string> = {
	all: localize('voltCustomize.scopeAll', "All"),
	workspace: localize('voltCustomize.scopeWorkspace', "Workspace"),
	user: localize('voltCustomize.scopeUser', "User"),
};

/**
 * The Customize tab: everything that shapes the agent (rules, skills,
 * subagents, commands, hooks, MCP servers) found in the workspace and the user
 * home, with search, filters and one-click creation of new items.
 */
export class AgentCustomizeEditor extends EditorPane {

	static readonly ID = AGENT_CUSTOMIZE_EDITOR_ID;

	private container!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private chipsEl!: HTMLElement;
	private scopeButton!: HTMLButtonElement;
	private listHost!: HTMLElement;
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private editButton!: HTMLButtonElement;
	private scroll!: ReturnType<typeof createAgentScrollable>;

	private items: IAgentCustomization[] = [];
	private query = '';
	private kind: KindFilter = 'all';
	private scope: ScopeFilter = 'all';
	private editing = false;
	private loading = false;
	private scanVersion = 0;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly watcher = this._register(new MutableDisposable());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 300));
	private readonly scanner: AgentCustomizationScanner;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IEditorService private readonly editorService: IEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AgentCustomizeEditor.ID, group, telemetryService, themeService, storageService);
		this.scanner = new AgentCustomizationScanner(fileService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-customize'));

		const top = append(this.container, $('.volt-customize-top'));
		const search = append(top, $('.volt-customize-search'));
		search.appendChild(renderIcon(Codicon.search));
		this.searchInput = append(search, $('input.volt-customize-search-input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.spellcheck = false;
		this.searchInput.placeholder = localize('voltCustomize.searchPlaceholder', "Search Rules, Skills, MCPs...");
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this._register(addDisposableListener(this.searchInput, EventType.INPUT, () => {
			this.query = this.searchInput.value.trim().toLowerCase();
			this.renderList();
		}));
		const marketplace = append(top, $('button.volt-customize-primary')) as HTMLButtonElement;
		marketplace.textContent = localize('voltCustomize.marketplace', "Browse Marketplace");
		this._register(addDisposableListener(marketplace, EventType.CLICK, () => void this.commandService.executeCommand('workbench.view.extensions')));

		const filters = append(this.container, $('.volt-customize-filters'));
		this.scopeButton = append(filters, $('button.volt-customize-chip.scope')) as HTMLButtonElement;
		this.updateScopeButton();
		this._register(addDisposableListener(this.scopeButton, EventType.CLICK, () => this.showScopeMenu()));
		append(filters, $('span.volt-customize-divider'));
		this.chipsEl = append(filters, $('.volt-customize-chips'));

		const header = append(this.container, $('.volt-customize-header'));
		const heading = append(header, $('span.volt-customize-heading'));
		append(heading, $('span')).textContent = localize('voltCustomize.installed', "Installed");
		this.countEl = append(heading, $('span.count'));
		const actions = append(header, $('span.volt-customize-header-actions'));
		this.editButton = append(actions, $('button.volt-customize-text-button')) as HTMLButtonElement;
		this.editButton.textContent = localize('voltCustomize.edit', "Edit");
		this._register(addDisposableListener(this.editButton, EventType.CLICK, () => {
			this.editing = !this.editing;
			this.editButton.textContent = this.editing ? localize('voltCustomize.done', "Done") : localize('voltCustomize.edit', "Edit");
			this.container.classList.toggle('editing', this.editing);
		}));
		const add = append(actions, $('button.volt-customize-outline-button')) as HTMLButtonElement;
		add.appendChild(renderIcon(Codicon.add));
		append(add, $('span')).textContent = localize('voltCustomize.add', "Add");
		this._register(addDisposableListener(add, EventType.CLICK, () => void this.addItem()));

		this.listEl = $('.volt-customize-list');
		this.scroll = this._register(createAgentScrollable(this.listEl));
		this.listHost = append(this.container, this.scroll.getDomNode());
		this.listHost.classList.add('volt-customize-scroll');

		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => void this.refresh()));
		this._register(this.fileService.onDidFilesChange(e => {
			const inConfigDir = (uri: URI) => CONFIG_DIR_PATTERN.test(uri.path);
			if (this.items.some(item => e.contains(item.resource)) || e.rawAdded.some(inConfigDir) || e.rawDeleted.some(inConfigDir)) {
				this.refreshScheduler.schedule();
			}
		}));
		this.renderList();
	}

	override async setInput(input: AgentCustomizeEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		await this.refresh();
		if (!options?.preserveFocus) {
			this.searchInput.focus();
		}
	}

	private async refresh(): Promise<void> {
		const version = ++this.scanVersion;
		this.loading = true;
		this.renderList();
		const folders = this.workspaceService.getWorkspace().folders.map(folder => folder.uri);
		let home: URI | undefined;
		try {
			home = await this.pathService.userHome();
		} catch {
			home = undefined;
		}
		const items = await this.scanner.scan(folders, home);
		if (version !== this.scanVersion) {
			return;
		}
		this.items = items;
		this.loading = false;
		this.watchRoots(folders, home);
		this.renderList();
	}

	/**
	 * Workspace config folders are watched recursively (small). Home folders
	 * such as ~/.cursor can be huge, so only the relevant subfolders are watched, flat.
	 */
	private watchRoots(folders: readonly URI[], home: URI | undefined): void {
		const store = new DisposableStore();
		for (const folder of folders) {
			for (const dir of CONFIG_DIRS) {
				store.add(this.fileService.watch(joinPath(folder, dir), { recursive: true, excludes: ['**/node_modules/**'] }));
			}
		}
		if (home) {
			for (const dir of CONFIG_DIRS) {
				const base = joinPath(home, dir);
				store.add(this.fileService.watch(base));
				for (const sub of ['rules', 'skills', 'agents', 'commands']) {
					store.add(this.fileService.watch(joinPath(base, sub)));
				}
			}
		}
		this.watcher.value = store;
	}

	private renderChips(): void {
		clearNode(this.chipsEl);
		const counts = new Map<KindFilter, number>();
		for (const item of this.items) {
			if (this.scope === 'all' || item.scope === this.scope) {
				counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
			}
		}
		const chips: { id: KindFilter; label: string }[] = [
			{ id: 'all', label: localize('voltCustomize.kindAll', "All") },
			...CUSTOMIZATION_KINDS.map(info => ({ id: info.kind as KindFilter, label: info.plural })),
		];
		for (const chip of chips) {
			const button = append(this.chipsEl, $('button.volt-customize-chip')) as HTMLButtonElement;
			button.classList.toggle('active', chip.id === this.kind);
			append(button, $('span')).textContent = chip.label;
			const count = chip.id === 'all' ? this.items.filter(item => this.scope === 'all' || item.scope === this.scope).length : counts.get(chip.id) ?? 0;
			if (count && chip.id !== 'all') {
				append(button, $('span.chip-count')).textContent = String(count);
			}
			this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => {
				this.kind = chip.id;
				this.renderList();
			}));
		}
	}

	private updateScopeButton(): void {
		this.scopeButton.replaceChildren(renderIcon(Codicon.globe));
		append(this.scopeButton, $('span')).textContent = SCOPE_LABELS[this.scope];
		this.scopeButton.appendChild(renderIcon(Codicon.chevronDown));
	}

	private showScopeMenu(): void {
		const actions: IAction[] = (['all', 'workspace', 'user'] as ScopeFilter[]).map(scope => {
			const action = new Action(`volt.customize.scope.${scope}`, SCOPE_LABELS[scope], undefined, true, () => {
				this.scope = scope;
				this.updateScopeButton();
				this.renderList();
			});
			action.checked = scope === this.scope;
			return action;
		});
		this.contextMenuService.showContextMenu({ getAnchor: () => this.scopeButton, getActions: () => actions });
	}

	private visibleItems(): IAgentCustomization[] {
		return this.items.filter(item =>
			(this.kind === 'all' || item.kind === this.kind)
			&& (this.scope === 'all' || item.scope === this.scope)
			&& (!this.query || `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(this.query)));
	}

	private renderList(): void {
		this.renderStore.clear();
		this.renderChips();
		clearNode(this.listEl);
		const items = this.visibleItems();
		this.countEl.textContent = String(items.length);

		if (!items.length) {
			const empty = append(this.listEl, $('.volt-customize-empty'));
			if (this.loading && !this.items.length) {
				empty.textContent = localize('voltCustomize.loading', "Looking for customizations…");
			} else if (this.query) {
				empty.textContent = localize('voltCustomize.noMatches', "Nothing matches \"{0}\".", this.query);
			} else {
				append(empty, $('span')).textContent = this.kind === 'all'
					? localize('voltCustomize.emptyAll', "No rules, skills or MCP servers yet.")
					: localize('voltCustomize.emptyKind', "No {0} yet.", kindInfo(this.kind).plural.toLowerCase());
				const hint = append(empty, $('span.hint'));
				hint.textContent = localize('voltCustomize.emptyHint', "Use Add to create one in .volt/ - .cursor/ and .claude/ folders are picked up too.");
			}
			this.scroll.scanDomNode();
			return;
		}

		for (const item of items) {
			const row = append(this.listEl, $('.volt-customize-item'));
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			const icon = append(row, $('span.icon'));
			icon.appendChild(renderIcon(kindInfo(item.kind).icon));
			const copy = append(row, $('span.copy'));
			append(copy, $('span.name')).textContent = item.name;
			const meta = append(copy, $('span.meta'));
			meta.textContent = item.description || kindInfo(item.kind).label;
			const tags = append(row, $('span.tags'));
			append(tags, $('span.tag')).textContent = kindInfo(item.kind).label;
			const source = append(tags, $('span.tag.source'));
			source.textContent = item.scope === 'user' ? localize('voltCustomize.user', "User") : item.source;
			setAgentTooltip(row, item.resource.fsPath);

			const remove = append(row, $('button.volt-customize-remove')) as HTMLButtonElement;
			remove.appendChild(renderIcon(Codicon.trash));
			setAgentTooltip(remove, localize('voltCustomize.remove', "Delete {0}", basename(item.resource)));
			this.renderStore.add(addDisposableListener(remove, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				void this.removeItem(item);
			}));

			const open = () => void this.editorService.openEditor({ resource: item.resource, options: { pinned: true } });
			this.renderStore.add(addDisposableListener(row, EventType.CLICK, e => {
				if (!remove.contains(e.target as Node)) {
					open();
				}
			}));
			this.renderStore.add(addDisposableListener(row, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			}));
		}
		this.scroll.scanDomNode();
	}

	private async addItem(): Promise<void> {
		const kind = this.kind !== 'all' ? this.kind : await this.pickKind();
		if (!kind) {
			return;
		}
		const info = kindInfo(kind);
		const folders = this.workspaceService.getWorkspace().folders;
		let base: URI | undefined;
		if (this.scope === 'user' || !folders.length) {
			base = await this.pathService.userHome();
		} else if (folders.length === 1) {
			base = folders[0].uri;
		} else {
			const pick = await this.quickInputService.pick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: localize('voltCustomize.pickFolder', "Where should the {0} live?", info.label.toLowerCase()) });
			base = pick?.folder.uri;
		}
		if (!base) {
			return;
		}

		let name = info.newItemFile('').replace(/^\//, '');
		if (info.newItemDir) {
			const raw = await this.quickInputService.input({
				prompt: localize('voltCustomize.namePrompt', "Name of the new {0}", info.label.toLowerCase()),
				placeHolder: localize('voltCustomize.namePlaceholder', "e.g. code-style"),
				validateInput: async value => safeItemName(value) ? undefined : localize('voltCustomize.nameInvalid', "Use letters, numbers, dashes or dots."),
			});
			if (raw === undefined) {
				return;
			}
			name = safeItemName(raw);
		}

		const target = newItemLocation(kind, name, base);
		if (!(await this.fileService.exists(target))) {
			await this.fileService.createFile(target, VSBuffer.fromString(info.template(name || basename(target))));
		}
		await this.editorService.openEditor({ resource: target, options: { pinned: true } });
		void this.refresh();
	}

	private async pickKind(): Promise<AgentCustomizationKind | undefined> {
		const pick = await this.quickInputService.pick(
			CUSTOMIZATION_KINDS.map(info => ({ label: info.label, iconClass: ThemeIcon.asClassName(info.icon), kind: info.kind })),
			{ placeHolder: localize('voltCustomize.pickKind', "What do you want to add?") },
		);
		return pick?.kind;
	}

	private async removeItem(item: IAgentCustomization): Promise<void> {
		const shared = this.items.filter(other => other.resource.toString() === item.resource.toString()).length;
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('voltCustomize.removeConfirm', "Delete {0}?", basename(item.resource)),
			detail: shared > 1
				? localize('voltCustomize.removeShared', "{0} entries are defined in this file; all of them go away.", shared)
				: localize('voltCustomize.removeDetail', "The file is moved to the trash."),
			primaryButton: localize({ key: 'voltCustomize.removeButton', comment: ['&& denotes a mnemonic'] }, "&&Delete"),
		});
		if (!confirmed) {
			return;
		}
		const isSkill = item.kind === 'skill' && basename(item.resource) === 'SKILL.md';
		const target = isSkill ? joinPath(item.resource, '..') : item.resource;
		await this.fileService.del(target, { recursive: isSkill, useTrash: true });
		void this.refresh();
	}

	/** The panel is narrow: let the tab bar shrink instead of overflowing. */
	override get minimumWidth(): number {
		return 120;
	}

	override getActionViewItem(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		return createAgentTitleActionViewItem(
			this.instantiationService,
			action,
			options,
			this.commandService,
			this.contextViewService,
		);
	}

	override layout(_dimension: Dimension): void {
		this.scroll.scanDomNode();
	}

	override focus(): void {
		this.searchInput.focus();
	}

	override clearInput(): void {
		this.watcher.clear();
		super.clearInput();
	}
}
