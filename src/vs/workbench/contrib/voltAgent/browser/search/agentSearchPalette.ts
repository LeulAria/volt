/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSearchPalette.css';
import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { stripIcons } from '../../../../../base/common/iconLabels.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { IMenuService, MenuId, MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions, IConfigurationRegistry, OVERRIDE_PROPERTY_REGEX } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { EditorResourceAccessor, isEditorInput } from '../../../../common/editor.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { searchFilesAndFolders } from '../../../search/browser/searchChatContext.js';
import { AgentEditorInput, OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import {
	AGENT_SEARCH_FILTER_LABELS,
	AGENT_SEARCH_FILTERS,
	AgentSearchFilter,
	agentSearchTitle,
	buildSearchSections,
	fileParentPath,
	flattenSearchItems,
	formatCompactAge,
	IAgentSearchItem,
	matchesSearchQuery,
	nextSearchFilter,
	previousSearchFilter,
	settingDisplayName,
} from './agentSearchModel.js';

interface ISearchPick extends IAgentSearchItem {
	readonly resource?: URI;
	readonly commandId?: string;
	readonly settingKey?: string;
	readonly sessionId?: string;
}

let currentPalette: AgentSearchPalette | undefined;

export function toggleAgentSearchPalette(instantiationService: IInstantiationService, anchor?: HTMLElement): void {
	if (currentPalette) {
		currentPalette.hide();
		return;
	}
	const palette = instantiationService.createInstance(AgentSearchPalette, anchor);
	currentPalette = palette;
	palette.onDidClose(() => {
		if (currentPalette === palette) {
			currentPalette = undefined;
		}
	});
}

class AgentSearchPalette extends Disposable {

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private readonly overlay: HTMLElement;
	private readonly palette: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly filtersEl: HTMLElement;
	private readonly results: HTMLElement;
	private readonly listListeners = this._register(new DisposableStore());
	private readonly filterListeners = this._register(new DisposableStore());
	private readonly searchScheduler: RunOnceScheduler;

	private filter: AgentSearchFilter = 'all';
	private selected = 0;
	private picks: ISearchPick[] = [];
	private searchCts: CancellationTokenSource | undefined;
	private closed = false;

	constructor(
		private readonly anchor: HTMLElement | undefined,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IHistoryService private readonly editorHistory: IHistoryService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILabelService private readonly labelService: ILabelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IMenuService private readonly menuService: IMenuService,
		@IModelService private readonly modelService: IModelService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
		this.searchScheduler = this._register(new RunOnceScheduler(() => void this.render(), 80));

		const container = this.layoutService.activeContainer;
		this.overlay = append(container, $('.volt-agent-search-overlay'));
		this.palette = append(this.overlay, $('.volt-agent-search-palette.show-file-icons'));
		this.palette.setAttribute('role', 'dialog');
		this.palette.setAttribute('aria-modal', 'true');
		this.palette.setAttribute('aria-label', localize('voltAgent.search.dialog', "Search"));

		this.input = append(this.palette, $('input.volt-agent-search-input')) as HTMLInputElement;
		this.input.type = 'text';
		this.input.placeholder = localize('voltAgent.search.placeholder', "Search agents, Canvas, files, actions...");
		this.input.setAttribute('aria-label', this.input.placeholder);
		this.input.spellcheck = false;
		this.input.autocomplete = 'off';

		this.filtersEl = append(this.palette, $('.volt-agent-search-filters'));
		this.filtersEl.setAttribute('role', 'tablist');
		this.renderFilters();

		this.results = append(this.palette, $('.volt-agent-search-results'));
		this.results.setAttribute('role', 'listbox');
		this.renderFooter();

		this.registerListeners();
		this.layout();
		void this.history.whenReady.then(() => {
			if (!this.closed) {
				void this.render();
			}
		});
		queueMicrotask(() => this.input.focus());
	}

	hide(): void {
		this.dispose();
	}

	override dispose(): void {
		if (!this.closed) {
			this.closed = true;
			this.searchCts?.cancel();
			this.searchCts?.dispose();
			this._onDidClose.fire();
			this.overlay.remove();
		}
		super.dispose();
	}

	private registerListeners(): void {
		const win = getWindow(this.overlay);
		this._register(addDisposableListener(this.input, 'input', () => this.searchScheduler.schedule()));
		this._register(addDisposableListener(win.document, 'mousedown', e => {
			if (!(e.target instanceof Node)) {
				return;
			}
			if (this.palette.contains(e.target) || this.anchor?.contains(e.target)) {
				return;
			}
			this.hide();
		}, true));
		this._register(addDisposableListener(win, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				event.stopPropagation();
				this.hide();
				this.anchor?.focus();
				return;
			}
			if (
				event.equals(KeyMod.CtrlCmd | KeyCode.BracketRight)
				|| event.equals(KeyMod.CtrlCmd | KeyCode.BracketLeft)
				|| event.equals(KeyCode.DownArrow)
				|| event.equals(KeyCode.UpArrow)
				|| event.equals(KeyCode.Enter)
			) {
				this.onKeyDown(event);
			}
		}, true));
		this._register(this.layoutService.onDidLayoutActiveContainer(() => this.layout()));
	}

	private onKeyDown(event: StandardKeyboardEvent): void {
		if (event.equals(KeyMod.CtrlCmd | KeyCode.BracketRight)) {
			event.preventDefault();
			event.stopPropagation();
			this.setFilter(nextSearchFilter(this.filter));
			return;
		}
		if (event.equals(KeyMod.CtrlCmd | KeyCode.BracketLeft)) {
			event.preventDefault();
			event.stopPropagation();
			this.setFilter(previousSearchFilter(this.filter));
			return;
		}
		if (event.equals(KeyCode.DownArrow)) {
			event.preventDefault();
			this.moveSelection(1);
			return;
		}
		if (event.equals(KeyCode.UpArrow)) {
			event.preventDefault();
			this.moveSelection(-1);
			return;
		}
		if (event.equals(KeyCode.Enter)) {
			event.preventDefault();
			void this.accept();
			return;
		}
	}

	private setFilter(filter: AgentSearchFilter): void {
		if (this.filter === filter) {
			return;
		}
		this.filter = filter;
		this.selected = 0;
		this.renderFilters();
		void this.render();
		this.input.focus();
	}

	private moveSelection(delta: number): void {
		if (!this.picks.length) {
			return;
		}
		this.selected = (this.selected + delta + this.picks.length) % this.picks.length;
		this.syncSelection();
	}

	private renderFilters(): void {
		this.filterListeners.clear();
		clearNode(this.filtersEl);
		for (const id of AGENT_SEARCH_FILTERS) {
			const button = append(this.filtersEl, $('button.volt-agent-search-filter')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', String(this.filter === id));
			button.classList.toggle('active', this.filter === id);
			button.textContent = AGENT_SEARCH_FILTER_LABELS[id];
			this.filterListeners.add(addDisposableListener(button, 'mousedown', e => e.preventDefault()));
			this.filterListeners.add(addDisposableListener(button, 'click', () => this.setFilter(id)));
		}
	}

	private renderFooter(): void {
		const footer = append(this.palette, $('.volt-agent-search-footer'));
		const mod = isMacintosh ? '\u2318' : 'Ctrl+';
		appendHint(footer, '\u2191\u2193', localize('voltAgent.search.select', "Select"));
		appendHint(footer, '\u21B5', localize('voltAgent.search.open', "Open"));
		const change = append(footer, $('.volt-agent-search-hint'));
		append(change, $('span.keys')).textContent = `${mod}[`;
		change.append(' or ');
		append(change, $('span.keys')).textContent = `${mod}]`;
		change.append(` ${localize('voltAgent.search.changeFilter', "Change Filter")}`);
	}

	private layout(): void {
		const win = getWindow(this.overlay);
		const editor = this.layoutService.getContainer(win, Parts.EDITOR_PART) ?? this.layoutService.activeContainer;
		const overlayRect = this.overlay.getBoundingClientRect();
		const editorRect = editor.getBoundingClientRect();
		const width = Math.min(640, Math.max(420, editorRect.width - 48));
		const top = editorRect.top - overlayRect.top + Math.max(56, Math.min(88, editorRect.height * 0.12));
		const left = editorRect.left - overlayRect.left + Math.max(0, (editorRect.width - width) / 2);
		this.palette.style.width = `${width}px`;
		this.palette.style.top = `${Math.max(24, top)}px`;
		this.palette.style.left = `${Math.max(16, left)}px`;
	}

	private async render(): Promise<void> {
		const query = this.input.value;
		const agents = this.collectAgents(query);
		const files = await this.collectFiles(query);
		if (this.closed) {
			return;
		}
		const actions = this.filter === 'actions' || (this.filter === 'all' && query.trim()) ? this.collectActions(query) : [];
		const settings = this.filter === 'settings' || (this.filter === 'all' && query.trim()) ? this.collectSettings(query) : [];
		const sections = buildSearchSections(this.filter, query, agents, files, actions, settings);
		this.picks = flattenSearchItems(sections) as ISearchPick[];
		if (this.selected >= this.picks.length) {
			this.selected = Math.max(0, this.picks.length - 1);
		}

		this.listListeners.clear();
		clearNode(this.results);

		if (!this.picks.length) {
			append(this.results, $('.volt-agent-search-empty')).textContent = localize('voltAgent.search.empty', "No results");
			return;
		}

		let index = 0;
		for (const section of sections) {
			append(this.results, $('.volt-agent-search-section-title')).textContent = section.title;
			for (const item of section.items) {
				const pickIndex = index++;
				const row = append(this.results, $('button.volt-agent-search-item')) as HTMLButtonElement;
				row.type = 'button';
				row.setAttribute('role', 'option');
				row.classList.toggle('active', pickIndex === this.selected);
				this.renderPick(row, item as ISearchPick);
				this.listListeners.add(addDisposableListener(row, 'mouseenter', () => {
					this.selected = pickIndex;
					this.syncSelection();
				}));
				this.listListeners.add(addDisposableListener(row, 'click', () => {
					this.selected = pickIndex;
					void this.accept();
				}));
			}
		}
		this.syncSelection();
	}

	private renderPick(row: HTMLButtonElement, item: ISearchPick): void {
		if (item.kind === 'agent') {
			append(row, $('span.volt-agent-search-dot'));
		} else if (item.kind === 'file' && item.resource) {
			const icon = append(row, $('span.file-icon'));
			icon.classList.add(...getIconClasses(this.modelService, this.languageService, item.resource, FileKind.FILE));
		} else if (item.kind === 'action') {
			append(row, $('span')).appendChild(renderIcon(Codicon.symbolEvent));
		} else {
			append(row, $('span')).appendChild(renderIcon(Codicon.settingsGear));
		}
		append(row, $('span.volt-agent-search-label')).textContent = item.label;
		if (item.meta || item.extra) {
			const end = append(row, $('.volt-agent-search-end'));
			if (item.meta) {
				append(end, $('span.volt-agent-search-meta')).textContent = item.meta;
			}
			if (item.extra) {
				append(end, $('span.volt-agent-search-extra')).textContent = item.extra;
			}
		}
	}

	private syncSelection(): void {
		const rows = this.results.querySelectorAll('.volt-agent-search-item');
		rows.forEach((row, index) => {
			row.classList.toggle('active', index === this.selected);
			if (index === this.selected) {
				row.setAttribute('aria-selected', 'true');
				(row as HTMLElement).scrollIntoView({ block: 'nearest' });
			} else {
				row.removeAttribute('aria-selected');
			}
		});
	}

	private collectAgents(query: string): ISearchPick[] {
		const sessions = query.trim()
			? this.history.search(query, { limit: 40 })
			: this.history.list({ limit: 20 });
		return sessions.map(session => ({
			kind: 'agent' as const,
			id: `agent:${session.id}`,
			label: agentSearchTitle(session),
			meta: session.workspaceLabel,
			extra: formatCompactAge(session.updatedAt || session.createdAt),
			sessionId: session.id,
		}));
	}

	private async collectFiles(query: string): Promise<ISearchPick[]> {
		const seen = new Set<string>();
		const out: ISearchPick[] = [];
		const add = (resource: URI, requireQueryMatch: boolean) => {
			const key = resource.toString();
			if (seen.has(key)) {
				return;
			}
			const label = basename(resource);
			const relative = this.labelService.getUriLabel(resource, { relative: true });
			if (requireQueryMatch && query.trim() && !matchesSearchQuery(query, label, relative)) {
				return;
			}
			seen.add(key);
			out.push({
				kind: 'file',
				id: `file:${key}`,
				label,
				meta: fileParentPath(relative),
				resource,
			});
		};

		for (const item of this.editorHistory.getHistory()) {
			if (isEditorInput(item) && item instanceof AgentEditorInput) {
				continue;
			}
			const resource = EditorResourceAccessor.getOriginalUri(item);
			if (!resource || resource.scheme === Schemas.untitled || resource.scheme === Schemas.voltAgent) {
				continue;
			}
			add(resource, true);
			if (out.length >= 20) {
				break;
			}
		}

		const folders = this.workspaceService.getWorkspace().folders;
		if (query.trim() && folders.length) {
			this.searchCts?.cancel();
			this.searchCts?.dispose();
			this.searchCts = new CancellationTokenSource();
			try {
				const result = await searchFilesAndFolders(folders[0].uri, query.trim(), true, this.searchCts.token, undefined, this.configurationService, this.searchService);
				for (const file of result.files) {
					add(file, false);
					if (out.length >= 20) {
						break;
					}
				}
			} catch {
				// ignore cancelled / failed search
			}
		}
		return out;
	}

	private collectActions(query: string): ISearchPick[] {
		const groups = this.menuService.getMenuActions(MenuId.CommandPalette, this.contextKeyService);
		const seen = new Set<string>();
		const out: ISearchPick[] = [];
		for (const [, actions] of groups) {
			for (const action of actions) {
				if (!(action instanceof MenuItemAction) || !action.enabled) {
					continue;
				}
				const id = action.item.id;
				if (seen.has(id)) {
					continue;
				}
				seen.add(id);
				let label = typeof action.item.title === 'string' ? action.item.title : action.item.title.value;
				label = stripIcons(label);
				const category = typeof action.item.category === 'string' ? action.item.category : action.item.category?.value;
				if (category) {
					label = `${category}: ${label}`;
				}
				if (!matchesSearchQuery(query, label, id, category ?? '')) {
					continue;
				}
				out.push({
					kind: 'action',
					id: `action:${id}`,
					label,
					meta: this.keybindingService.lookupKeybinding(id)?.getLabel() ?? undefined,
					commandId: id,
				});
				if (out.length >= 25) {
					return out;
				}
			}
		}
		return out;
	}

	private collectSettings(query: string): ISearchPick[] {
		const properties = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		const out: ISearchPick[] = [];
		for (const key of Object.keys(properties)) {
			if (OVERRIDE_PROPERTY_REGEX.test(key)) {
				continue;
			}
			const schema = properties[key];
			if (schema.included === false) {
				continue;
			}
			const description = typeof schema.description === 'string'
				? schema.description
				: typeof schema.markdownDescription === 'string' ? schema.markdownDescription : '';
			if (!matchesSearchQuery(query, key, description)) {
				continue;
			}
			out.push({
				kind: 'setting',
				id: `setting:${key}`,
				label: settingDisplayName(key, description),
				meta: key,
				settingKey: key,
			});
			if (out.length >= 25) {
				break;
			}
		}
		return out;
	}

	private async accept(): Promise<void> {
		const pick = this.picks[this.selected];
		if (!pick) {
			return;
		}
		this.hide();
		if (pick.kind === 'agent' && pick.sessionId) {
			await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, pick.sessionId);
			return;
		}
		if (pick.kind === 'file' && pick.resource) {
			await this.editorService.openEditor({ resource: pick.resource, options: { pinned: true } });
			return;
		}
		if (pick.kind === 'action' && pick.commandId) {
			await this.commandService.executeCommand(pick.commandId);
			return;
		}
		if (pick.kind === 'setting' && pick.settingKey) {
			await this.preferencesService.openSettings({ query: `@id:${pick.settingKey}` });
		}
	}
}

function appendHint(parent: HTMLElement, keys: string, label: string): void {
	const hint = append(parent, $('.volt-agent-search-hint'));
	append(hint, $('span.keys')).textContent = keys;
	hint.append(` ${label}`);
}
