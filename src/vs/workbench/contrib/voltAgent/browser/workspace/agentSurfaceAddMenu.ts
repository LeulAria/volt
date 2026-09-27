/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, relativePath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor } from '../../../../common/editor.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { searchFilesAndFolders } from '../../../search/browser/searchChatContext.js';
import { createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { agentSurfaceMenuItems, createSurfaceStrokeIcon, IAgentSurfaceMenuItem, type AgentSurfaceMenuActionId } from './agentSurfaceMenu.js';

const MAX_FILE_RESULTS = 20;
const SEARCH_DEBOUNCE_MS = 80;

export interface IAgentSurfaceAddMenuBrowserTab {
	readonly id: string;
	readonly title: string;
	readonly url: string;
}

/** What the + popover needs from the tools pane that owns it. */
export interface IAgentSurfaceAddMenuHost {
	/** Folder the file search runs in. */
	readonly root: URI | undefined;
	readonly browserTabs: readonly IAgentSurfaceAddMenuBrowserTab[];
	runAction(id: AgentSurfaceMenuActionId): void;
	openFile(resource: URI): void;
	openBrowser(url: string): void;
	focusSurface(id: string): void;
}

/** Typed text worth offering as a page: a scheme, localhost, a host:port, or a dotted host. No spaces. */
export function looksLikeUrl(value: string): boolean {
	const text = value.trim();
	if (!text || /\s/.test(text)) {
		return false;
	}
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
		|| /^localhost(:\d+)?(\/|$)/i.test(text)
		|| /^[\w-]+(\.[\w-]+)*:\d+(\/|$)/.test(text)
		|| (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(text) && !/\.(ts|tsx|js|jsx|json|md|css|html?|py|rs|go|java|c|h|cpp)$/i.test(text));
}

interface IRow {
	readonly element: HTMLElement;
	readonly run: () => void;
}

/**
 * The + popover of the tools tabs. Empty: what can open here. Typing: matching
 * actions, a Browser section, then Files, like Quick Open (files only, no `>`
 * commands). The pick opens as a tab in the tools pane.
 */
export class AgentSurfaceAddMenu extends Disposable {

	private visible = false;
	private anchor: HTMLElement | undefined;

	constructor(
		private readonly host: IAgentSurfaceAddMenuHost,
		private readonly onDidHide: () => void,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ISearchService private readonly searchService: ISearchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHistoryService private readonly historyService: IHistoryService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
	}

	get isVisible(): boolean {
		return this.visible;
	}

	show(anchor: HTMLElement): void {
		if (this.visible) {
			return;
		}
		this.visible = true;
		this.anchor = anchor;
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			// Opens toward the right of the +; the context view flips it left when the window edge is closer.
			anchorAlignment: AnchorAlignment.LEFT,
			render: container => this.render(container),
			onHide: () => {
				this.visible = false;
				this.onDidHide();
			},
		});
	}

	hide(): void {
		if (this.visible) {
			this.contextViewService.hideContextView();
		}
	}

	override dispose(): void {
		this.hide();
		super.dispose();
	}

	private render(container: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const anchor = this.anchor!;
		container.classList.add('volt-agent-home-filter-menu-host');
		const menu = append(container, $('.volt-agent-home-filter-menu.volt-agent-surface-add-menu.show-file-icons'));
		const searchRow = append(menu, $('.volt-agent-surface-add-search'));
		searchRow.appendChild(createHomeSearchIcon());
		const search = append(searchRow, $('input')) as HTMLInputElement;
		search.type = 'text';
		search.spellcheck = false;
		search.placeholder = localize('voltAgent.surfaceMenu.search', "Open any file, URL, ...");
		const list = append(menu, $('.volt-agent-surface-add-list'));
		list.setAttribute('role', 'listbox');

		let rows: IRow[] = [];
		let selected = 0;
		let generation = 0;
		const searchCts = store.add(new MutableCts());
		let debounce: ReturnType<typeof setTimeout> | undefined;
		store.add(toDisposable(() => clearTimeout(debounce)));

		const select = (index: number) => {
			if (!rows.length) {
				return;
			}
			selected = (index + rows.length) % rows.length;
			rows.forEach((row, i) => row.element.classList.toggle('selected', i === selected));
			rows[selected].element.scrollIntoView({ block: 'nearest' });
		};
		const pick = (row: IRow | undefined) => {
			if (!row) {
				return;
			}
			this.hide();
			row.run();
		};
		const addRow = (element: HTMLElement, run: () => void) => {
			const row: IRow = { element, run };
			const index = rows.length;
			rows.push(row);
			store.add(addDisposableListener(element, 'mousemove', () => {
				if (selected !== index) {
					select(index);
				}
			}));
			store.add(addDisposableListener(element, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				pick(row);
			}));
		};

		const paint = (query: string, files: readonly URI[] | undefined) => {
			rows = [];
			list.replaceChildren();
			const q = query.trim().toLowerCase();
			const actions = agentSurfaceMenuItems().filter(action => !q || action.label.toLowerCase().includes(q) || action.id.toLowerCase().includes(q));
			for (const action of actions) {
				addRow(this.actionRow(list, action), () => this.host.runAction(action.id));
			}
			if (q) {
				const tabs = this.host.browserTabs.filter(tab => tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q));
				const url = looksLikeUrl(query) ? query.trim() : undefined;
				if (url || tabs.length) {
					this.section(list, localize('voltAgent.surfaceMenu.browserSection', "Browser"), rows.length > 0);
					if (url) {
						addRow(this.row(list, Codicon.globe, localize('voltAgent.surfaceMenu.openUrl', "Open {0}", url)), () => this.host.openBrowser(url));
					}
					for (const tab of tabs) {
						addRow(this.row(list, Codicon.globe, tab.title, tab.url), () => this.host.focusSurface(tab.id));
					}
				}
				const shown = this.fileMatches(q, files);
				if (shown.length || files === undefined) {
					this.section(list, localize('voltAgent.surfaceMenu.filesSection', "Files"), rows.length > 0);
				}
				for (const resource of shown) {
					addRow(this.fileRow(list, resource), () => this.host.openFile(resource));
				}
				if (files === undefined) {
					append(list, $('.volt-agent-surface-add-empty')).textContent = localize('voltAgent.surfaceMenu.searching', "Searching...");
				} else if (!rows.length) {
					append(list, $('.volt-agent-surface-add-empty')).textContent = localize('voltAgent.surfaceMenu.noResults', "No matching files");
				}
			}
			selected = 0;
			select(0);
			this.contextViewService.layout();
		};

		const update = () => {
			const query = search.value;
			const current = ++generation;
			clearTimeout(debounce);
			if (!query.trim()) {
				searchCts.cancel();
				paint(query, []);
				return;
			}
			paint(query, undefined);
			debounce = setTimeout(() => {
				void this.searchFiles(query.trim(), searchCts.next()).then(files => {
					if (current === generation && this.visible) {
						paint(query, files);
					}
				});
			}, SEARCH_DEBOUNCE_MS);
		};

		store.add(addDisposableListener(search, 'input', update));
		store.add(addDisposableListener(search, 'keydown', e => {
			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					select(selected + 1);
					return;
				case 'ArrowUp':
					e.preventDefault();
					select(selected - 1);
					return;
				case 'Enter':
					e.preventDefault();
					pick(rows[selected]);
					return;
				case 'Escape':
					e.preventDefault();
					this.hide();
					return;
			}
		}));
		const doc = getWindow(anchor).document;
		store.add(addDisposableListener(doc, 'mousedown', e => {
			if (!(e.target instanceof Node)) {
				return;
			}
			if (this.contextViewService.getContextViewElement().contains(e.target) || anchor.contains(e.target)) {
				return;
			}
			this.hide();
		}, true));

		paint('', []);
		setTimeout(() => search.focus(), 0);
		return store;
	}

	/** Recent files first, then the workspace search; each file once. */
	private fileMatches(query: string, searched: readonly URI[] | undefined): URI[] {
		const out: URI[] = [];
		const seen = new Set<string>();
		const add = (resource: URI) => {
			const key = resource.toString();
			if (!seen.has(key) && out.length < MAX_FILE_RESULTS) {
				seen.add(key);
				out.push(resource);
			}
		};
		for (const item of this.historyService.getHistory()) {
			const resource = EditorResourceAccessor.getOriginalUri(item);
			if (resource && basename(resource).toLowerCase().includes(query)) {
				add(resource);
			}
		}
		for (const resource of searched ?? []) {
			add(resource);
		}
		return out;
	}

	private async searchFiles(query: string, cts: CancellationTokenSource): Promise<URI[]> {
		const root = this.host.root ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return [];
		}
		try {
			const result = await searchFilesAndFolders(root, query, true, cts.token, undefined, this.configurationService, this.searchService);
			return result.files;
		} catch {
			return [];
		}
	}

	private section(list: HTMLElement, label: string, separated: boolean): void {
		if (separated) {
			append(list, $('.volt-agent-home-filter-sep'));
		}
		append(list, $('.volt-agent-home-filter-heading')).textContent = label;
	}

	private row(list: HTMLElement, icon: ThemeIcon, label: string, detail?: string): HTMLElement {
		const row = append(list, $('.volt-agent-home-filter-row.volt-agent-surface-add-row'));
		row.setAttribute('role', 'option');
		append(row, $('span.leading')).appendChild(renderIcon(icon));
		this.appendText(row, label, detail);
		return row;
	}

	private actionRow(list: HTMLElement, action: IAgentSurfaceMenuItem): HTMLElement {
		const row = append(list, $('.volt-agent-home-filter-row.volt-agent-surface-add-row'));
		row.setAttribute('role', 'option');
		const leading = append(row, $('span.leading'));
		if (action.svgPath) {
			leading.appendChild(createSurfaceStrokeIcon(leading.ownerDocument, action.svgPath));
		} else {
			leading.appendChild(renderIcon(action.icon));
		}
		append(row, $('span.label')).textContent = action.label;
		const shortcut = action.keybindingCommand ? this.keybindingService.lookupKeybinding(action.keybindingCommand)?.getLabel() : undefined;
		if (shortcut) {
			append(row, $('span.trailing')).textContent = shortcut;
		}
		return row;
	}

	private fileRow(list: HTMLElement, resource: URI): HTMLElement {
		const row = append(list, $('.volt-agent-home-filter-row.volt-agent-surface-add-row.file'));
		row.setAttribute('role', 'option');
		const icon = append(append(row, $('span.leading')), $('span.file-icon-glyph'));
		icon.classList.add(...getIconClasses(this.modelService, this.languageService, resource, FileKind.FILE));
		const root = this.host.root ?? this.workspaceContextService.getWorkspaceFolder(resource)?.uri;
		const folder = dirname(resource);
		const detail = (root && relativePath(root, folder)) ?? folder.fsPath;
		this.appendText(row, basename(resource), detail || undefined);
		return row;
	}

	private appendText(row: HTMLElement, label: string, detail: string | undefined): void {
		const text = append(row, $('span.text'));
		append(text, $('span.label')).textContent = label;
		if (detail) {
			append(text, $('span.detail')).textContent = detail;
		}
	}
}

/** One running search at a time; starting the next cancels the last. */
class MutableCts implements IDisposable {
	private current: CancellationTokenSource | undefined;

	next(): CancellationTokenSource {
		this.cancel();
		this.current = new CancellationTokenSource();
		return this.current;
	}

	cancel(): void {
		this.current?.dispose(true);
		this.current = undefined;
	}

	dispose(): void {
		this.cancel();
	}
}
