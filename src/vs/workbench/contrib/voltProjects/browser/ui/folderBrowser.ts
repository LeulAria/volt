/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox, MessageType } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { List } from '../../../../../base/browser/ui/list/listWidget.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IMatch, matchesFuzzy } from '../../../../../base/common/filters.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { defaultInputBoxStyles, getListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IVoltFsBrowseService, IVoltFsEntry, IVoltFsListing, IVoltQuickAccessRoot } from '../../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { breadcrumbParts, browseDirectory, browseLeaf, BrowseGeneration, ensureTrailingSeparator, hasTrailingSeparator, parentDirectory, tildify, untildify } from '../../common/browsePath.js';
import { rankFolders } from '../../common/folderSearch.js';

export interface IFolderBrowserOptions {
	/** Absolute folder to start in. */
	readonly initialPath?: string;
	/** Paths already added as projects, for the "Added" badge. */
	readonly addedPaths: () => ReadonlySet<string>;
	/** Known folders (projects, recents) that search offers before the disk scan answers. */
	readonly knownFolders: () => readonly { readonly name: string; readonly path: string }[];
	/** ⌘⏎, or Enter on the current folder: the caller adds or picks it. */
	readonly onAccept: (path: string) => void;
}

type Row =
	| { readonly kind: 'up'; readonly id: string; readonly path: string }
	| { readonly kind: 'folder'; readonly id: string; readonly entry: IVoltFsEntry; readonly matches?: IMatch[]; readonly added: boolean; readonly location?: string }
	| { readonly kind: 'message'; readonly id: string; readonly text: string; readonly error?: boolean };

const ROW_HEIGHT = 30;
/** Listings survive closing the dialog, so it paints at once next time; every open still re-reads. */
const listingCache = new Map<string, IVoltFsListing>();
let cachedHome: string | undefined;

/**
 * The in-app folder picker behind "Open from This PC" and "Clone into". Built like T3 Code's:
 * the path field is where you are and what you filter by (`~/code/ap`), a trailing separator
 * enters a folder, and ⌘K searches every folder under your home. Listings come from the main
 * process in one call per folder, are painted from cache, and are always re-read.
 */
export class FolderBrowser extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidChangeTarget = this._register(new Emitter<string | undefined>());
	/** The folder "Add" would use: the focused row, else the folder being shown. */
	readonly onDidChangeTarget = this._onDidChangeTarget.event;

	private readonly rail: HTMLElement;
	private readonly crumbs: HTMLElement;
	private readonly input: InputBox;
	private readonly modeChip: HTMLElement;
	private readonly newFolderHost: HTMLElement;
	private readonly listHost: HTMLElement;
	private readonly list: List<Row>;
	private readonly generation = new BrowseGeneration();
	private readonly newFolderStore = this._register(new DisposableStore());
	private readonly searchScheduler: RunOnceScheduler;
	private readonly prefetchScheduler: RunOnceScheduler;

	private home = cachedHome ?? '';
	/** Absolute, with a trailing separator. */
	private dir = '';
	private listing: IVoltFsListing | undefined;
	private rows: Row[] = [];
	private showHidden: boolean;
	private searching = false;
	private searchId: string | undefined;
	private searchResults: IVoltFsEntry[] = [];
	private searchDone = true;
	private roots: IVoltQuickAccessRoot[] = [];
	private newFolderRequested = false;

	constructor(
		container: HTMLElement,
		private readonly options: IFolderBrowserOptions,
		@IVoltFsBrowseService private readonly fsBrowse: IVoltFsBrowseService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.showHidden = this.configurationService.getValue<boolean>('volt.projects.showHiddenFolders') === true;
		this.element = append(container, $('.volt-folder-browser'));
		this.rail = append(this.element, $('.volt-folder-rail'));
		this.rail.setAttribute('role', 'navigation');
		this.rail.setAttribute('aria-label', localize('voltFolders.quickAccess', "Quick access"));
		const main = append(this.element, $('.volt-folder-main'));

		const top = append(main, $('.volt-folder-top'));
		this.crumbs = append(top, $('.volt-folder-crumbs'));
		const newFolder = append(top, $('button.volt-folder-tool')) as HTMLButtonElement;
		newFolder.type = 'button';
		newFolder.appendChild(renderIcon(Codicon.newFolder));
		newFolder.title = localize('voltFolders.newFolderTitle', "New folder (⌘N)");
		newFolder.setAttribute('aria-label', localize('voltFolders.newFolder', "New folder"));
		this._register(addDisposableListener(newFolder, 'click', e => {
			EventHelper.stop(e, true);
			this.startNewFolder();
		}));
		const refresh = append(top, $('button.volt-folder-tool')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.appendChild(renderIcon(Codicon.refresh));
		refresh.title = localize('voltFolders.refresh', "Refresh");
		refresh.setAttribute('aria-label', refresh.title);
		this._register(addDisposableListener(refresh, 'click', e => {
			EventHelper.stop(e, true);
			void this.load(this.dir, true);
		}));

		const inputRow = append(main, $('.volt-folder-input'));
		this.modeChip = append(inputRow, $('span.volt-folder-mode'));
		this.input = this._register(new InputBox(inputRow, undefined, {
			placeholder: localize('voltFolders.placeholder', "Type a path, or filter this folder"),
			ariaLabel: localize('voltFolders.pathAria', "Folder path"),
			tooltip: '',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this.input.inputElement.spellcheck = false;
		this.input.inputElement.setAttribute('role', 'combobox');
		this.input.inputElement.setAttribute('aria-expanded', 'true');
		const hint = append(inputRow, $('span.volt-folder-hint'));
		hint.textContent = localize('voltFolders.searchHint', "⌘K search all");
		this.newFolderHost = append(main, $('.volt-folder-new.hidden'));

		this.listHost = append(main, $('.volt-folder-list'));
		this.list = this._register(new List<Row>('VoltFolderBrowser', this.listHost, new RowDelegate(), [new FolderRenderer(), new UpRenderer(), new MessageRenderer()], {
			identityProvider: { getId: row => row.id },
			multipleSelectionSupport: false,
			keyboardSupport: false,
			mouseSupport: true,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltFolders.listAria', "Folders"),
				getRole: row => row.kind === 'message' ? 'presentation' : 'option',
				getAriaLabel: row => row.kind === 'folder' ? `${row.entry.name}${row.entry.gitRepo ? ', git' : ''}${row.added ? ', added' : ''}` : row.kind === 'up' ? localize('voltFolders.up', "Parent folder") : row.text,
			},
		}));
		this.list.style(getListStyles({ listBackground: 'transparent', listFocusOutline: 'transparent', listInactiveFocusOutline: 'transparent' }));
		this.input.inputElement.setAttribute('aria-controls', this.list.getHTMLElement().id);
		this._register(addDisposableListener(this.listHost, 'mousedown', e => {
			// Keep typing in the path field while clicking rows.
			if (e.detail < 2) {
				e.preventDefault();
			}
		}));
		this._register(this.list.onDidChangeFocus(() => this.fireTarget()));
		this._register(this.list.onMouseClick(e => {
			if (e.index === undefined) {
				return;
			}
			const row = this.rows[e.index];
			if (row?.kind === 'up') {
				this.setPath(row.path);
			} else if (row?.kind === 'folder') {
				this.list.setFocus([e.index]);
			}
		}));
		this._register(this.list.onMouseDblClick(e => {
			const row = e.index !== undefined ? this.rows[e.index] : undefined;
			if (row?.kind === 'folder') {
				this.enter(row.entry.path);
			}
		}));

		this.searchScheduler = this._register(new RunOnceScheduler(() => this.runSearch(), 120));
		this.prefetchScheduler = this._register(new RunOnceScheduler(() => this.prefetch(), 150));
		this._register(this.fsBrowse.onDidFindFolders(e => {
			if (e.requestId !== this.searchId) {
				return;
			}
			this.searchResults.push(...e.entries);
			this.searchDone = e.done;
			this.renderRows();
		}));
		this._register(toDisposable(() => {
			if (this.searchId) {
				void this.fsBrowse.cancelFind(this.searchId);
			}
		}));
		this._register(this.input.onDidChange(() => this.onInput()));
		this._register(addDisposableListener(this.input.inputElement, 'keydown', e => this.onKeyDown(e)));
		// Re-read when the user comes back from Finder or a terminal, where folders may have changed.
		this._register(addDisposableListener(getWindow(this.element), 'focus', () => void this.load(this.dir, true)));
		this._register(this.observeSize());

		void this.init();
	}

	get target(): string | undefined {
		const row = this.focusedRow();
		if (row?.kind === 'folder') {
			return row.entry.path;
		}
		return this.searching ? undefined : this.dir ? stripTrailing(this.dir) : undefined;
	}

	get currentFolder(): string {
		return stripTrailing(this.dir);
	}

	focus(): void {
		this.input.focus();
	}

	setShowHidden(show: boolean): void {
		if (this.showHidden !== show) {
			this.showHidden = show;
			void this.load(this.dir, true);
		}
	}

	/** Opens the inline "new folder" field once the first folder is listed. */
	requestNewFolder(): void {
		if (this.dir) {
			this.startNewFolder();
		} else {
			this.newFolderRequested = true;
		}
	}

	get hiddenShown(): boolean {
		return this.showHidden;
	}

	toggleSearch(): void {
		this.searching = !this.searching;
		this.element.classList.toggle('searching', this.searching);
		this.modeChip.textContent = this.searching ? localize('voltFolders.searchAll', "Search all folders") : '';
		this.input.setPlaceHolder(this.searching ? localize('voltFolders.searchPlaceholder', "Folder name, e.g. api") : localize('voltFolders.placeholder', "Type a path, or filter this folder"));
		if (this.searching) {
			this.input.value = browseLeaf(this.input.value);
			this.runSearch();
		} else {
			if (this.searchId) {
				void this.fsBrowse.cancelFind(this.searchId);
				this.searchId = undefined;
			}
			this.input.value = this.display(this.dir);
			this.renderRows();
		}
		this.input.focus();
	}

	private async init(): Promise<void> {
		const [home, roots] = await Promise.all([
			this.home ? Promise.resolve(this.home) : this.fsBrowse.home(),
			this.fsBrowse.quickAccess().catch(() => [] as IVoltQuickAccessRoot[]),
		]);
		if (this._store.isDisposed) {
			return;
		}
		this.home = cachedHome = home;
		this.roots = roots;
		this.renderRail();
		const start = this.options.initialPath || roots.find(root => root.id === 'code')?.path || home;
		this.setPath(ensureTrailingSeparator(start));
		if (this.newFolderRequested) {
			this.newFolderRequested = false;
			this.startNewFolder();
		}
	}

	/** Shows `path` (a folder path, `~` allowed) in the field and lists it. */
	private setPath(path: string): void {
		this.input.value = this.display(untildify(path, this.home));
		this.input.focus();
		const end = this.input.value.length;
		this.input.inputElement.setSelectionRange(end, end);
	}

	private enter(path: string): void {
		if (this.searching) {
			this.searching = true;
			this.toggleSearch();
		}
		this.setPath(ensureTrailingSeparator(path));
	}

	private display(absolute: string): string {
		return tildify(absolute, this.home);
	}

	private onInput(): void {
		if (this.searching) {
			this.searchScheduler.schedule();
			return;
		}
		const value = this.input.value;
		const dir = ensureTrailingSeparator(untildify(browseDirectory(value), this.home));
		if (dir && dir !== this.dir) {
			void this.load(dir, false);
		} else {
			this.renderRows();
		}
	}

	private async load(dir: string, force: boolean): Promise<void> {
		if (!dir) {
			return;
		}
		const generation = this.generation.next();
		const key = `${this.showHidden ? 'h' : ''}:${dir}`;
		const changed = dir !== this.dir;
		this.dir = dir;
		this.renderCrumbs();
		this.renderRailSelection();
		const cached = listingCache.get(key);
		if (cached && (changed || !this.listing)) {
			this.listing = cached;
			this.renderRows(true);
		} else if (changed) {
			this.listing = undefined;
			this.renderRows(true);
		}
		const fresh = await this.fsBrowse.list(dir, { showHidden: this.showHidden, dirsOnly: true }).catch((): IVoltFsListing => ({ path: dir, entries: [], truncated: false, error: 'notFound' }));
		if (!this.generation.isCurrent(generation) || this._store.isDisposed) {
			return;
		}
		if (!fresh.error) {
			listingCache.set(key, fresh);
		}
		const same = !force && this.listing && sameListing(this.listing, fresh);
		this.listing = fresh;
		if (!same) {
			this.renderRows(changed);
		}
	}

	private renderRows(resetFocus = false): void {
		const previous = this.focusedRow();
		const rows: Row[] = [];
		const added = this.options.addedPaths();
		if (this.searching) {
			const query = this.input.value.trim();
			if (!query) {
				rows.push({ kind: 'message', id: 'hint', text: localize('voltFolders.searchEmpty', "Type part of a folder name to search your home folder.") });
			} else {
				const known = this.options.knownFolders().map((folder): IVoltFsEntry => ({ name: folder.name, path: folder.path, kind: 'dir', hidden: false }));
				const byPath = new Map<string, IVoltFsEntry>();
				for (const entry of [...known, ...this.searchResults]) {
					if (!byPath.has(entry.path) || entry.gitRepo) {
						byPath.set(entry.path, entry);
					}
				}
				const ranked = rankFolders([...byPath.values()], query, { projects: added, recents: known.map(folder => folder.path) }).slice(0, 200);
				for (const entry of ranked) {
					rows.push({ kind: 'folder', id: `s:${entry.path}`, entry, matches: matchesFuzzy(query, entry.name, true) ?? undefined, added: added.has(entry.path), location: this.display(parentOf(entry.path)) });
				}
				if (!ranked.length) {
					rows.push({ kind: 'message', id: 'searching', text: this.searchDone ? localize('voltFolders.noMatches', "No folders match \"{0}\"", query) : localize('voltFolders.searching', "Searching...") });
				} else if (!this.searchDone) {
					rows.push({ kind: 'message', id: 'searching', text: localize('voltFolders.searchingMore', "Searching...") });
				}
			}
		} else {
			const parent = parentDirectory(this.dir);
			const leaf = browseLeaf(this.input.value);
			if (parent && !leaf) {
				rows.push({ kind: 'up', id: 'up', path: parent });
			}
			if (!this.listing) {
				rows.push({ kind: 'message', id: 'loading', text: localize('voltFolders.loading', "Loading...") });
			} else if (this.listing.error) {
				rows.push({ kind: 'message', id: 'error', error: true, text: listErrorText(this.listing.error) });
			} else {
				const prefix: Row[] = [];
				const fuzzy: Row[] = [];
				const lowerLeaf = leaf.toLowerCase();
				for (const entry of this.listing.entries) {
					if (entry.hidden && !this.showHidden && !leaf.startsWith('.')) {
						continue;
					}
					if (!leaf) {
						prefix.push({ kind: 'folder', id: entry.path, entry, added: added.has(entry.path) });
						continue;
					}
					const matches = matchesFuzzy(leaf, entry.name, true);
					if (!matches) {
						continue;
					}
					(entry.name.toLowerCase().startsWith(lowerLeaf) ? prefix : fuzzy).push({ kind: 'folder', id: entry.path, entry, matches, added: added.has(entry.path) });
				}
				rows.push(...prefix, ...fuzzy);
				if (!prefix.length && !fuzzy.length) {
					rows.push({ kind: 'message', id: 'empty', text: leaf ? localize('voltFolders.noMatch', "No folder named \"{0}\" here", leaf) : localize('voltFolders.empty', "No folders here") });
				}
			}
		}
		this.rows = rows;
		this.list.splice(0, this.list.length, rows);
		// Keep the focused folder across refreshes; a typed filter focuses its best match.
		let focus = !resetFocus && previous ? rows.findIndex(row => row.id === previous.id) : -1;
		if (focus < 0 && (this.searching || browseLeaf(this.input.value))) {
			focus = rows.findIndex(row => row.kind === 'folder');
		}
		this.list.setFocus(focus >= 0 ? [focus] : []);
		if (focus >= 0) {
			this.list.reveal(focus);
		} else if (resetFocus) {
			this.list.scrollTop = 0;
		}
		this.fireTarget();
	}

	private focusedRow(): Row | undefined {
		const index = this.list.getFocus()[0];
		return index === undefined ? undefined : this.rows[index];
	}

	private fireTarget(): void {
		const row = this.focusedRow();
		if (row?.kind === 'folder') {
			this.input.inputElement.setAttribute('aria-activedescendant', this.list.getElementID(this.list.getFocus()[0]));
			this.prefetchScheduler.schedule();
		} else {
			this.input.inputElement.removeAttribute('aria-activedescendant');
		}
		this._onDidChangeTarget.fire(this.target);
	}

	/** Reads the focused folder ahead, so entering it paints at once. */
	private prefetch(): void {
		const row = this.focusedRow();
		if (row?.kind !== 'folder') {
			return;
		}
		const dir = ensureTrailingSeparator(row.entry.path);
		const key = `${this.showHidden ? 'h' : ''}:${dir}`;
		if (!listingCache.has(key)) {
			void this.fsBrowse.list(dir, { showHidden: this.showHidden, dirsOnly: true }).then(listing => {
				if (!listing.error) {
					listingCache.set(key, listing);
				}
			}, () => undefined);
		}
	}

	private moveFocus(delta: number): void {
		const count = this.rows.length;
		if (!count) {
			return;
		}
		let index = this.list.getFocus()[0] ?? (delta > 0 ? -1 : count);
		for (let step = 0; step < count; step++) {
			index += delta;
			if (index < 0 || index >= count) {
				return;
			}
			if (this.rows[index].kind !== 'message') {
				this.list.setFocus([index]);
				this.list.reveal(index);
				return;
			}
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(e);
		const row = this.focusedRow();
		const caretAtEnd = this.input.inputElement.selectionStart === this.input.value.length;
		if (event.equals(KeyCode.DownArrow)) {
			this.moveFocus(1);
		} else if (event.equals(KeyCode.UpArrow)) {
			this.moveFocus(-1);
		} else if (event.equals(KeyCode.PageDown)) {
			this.moveFocus(10);
		} else if (event.equals(KeyCode.PageUp)) {
			this.moveFocus(-10);
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.Enter)) {
			const target = this.target;
			if (target) {
				this.options.onAccept(target);
			}
		} else if (event.equals(KeyCode.Enter) || (event.equals(KeyCode.RightArrow) && caretAtEnd && row?.kind === 'folder')) {
			if (row?.kind === 'folder') {
				this.enter(row.entry.path);
			} else if (row?.kind === 'up') {
				this.setPath(row.path);
			} else if (!this.searching && event.equals(KeyCode.Enter) && this.dir) {
				// Nothing focused: Enter takes the folder being shown.
				this.options.onAccept(stripTrailing(this.dir));
			} else {
				return;
			}
		} else if (event.equals(KeyCode.Tab) && row?.kind === 'folder' && !this.searching) {
			this.enter(row.entry.path);
		} else if (event.equals(KeyMod.Alt | KeyCode.UpArrow) || event.equals(KeyMod.CtrlCmd | KeyCode.UpArrow)) {
			const parent = parentDirectory(this.dir);
			if (parent) {
				this.setPath(parent);
			}
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyK)) {
			this.toggleSearch();
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyL)) {
			this.input.select();
		} else if (event.equals(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Period)) {
			this.setShowHidden(!this.showHidden);
		} else if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyN)) {
			this.startNewFolder();
		} else if (event.equals(KeyCode.Escape)) {
			if (this.searching) {
				this.toggleSearch();
			} else if (browseLeaf(this.input.value)) {
				this.input.value = this.display(this.dir);
			} else {
				// Let the dialog close.
				return;
			}
		} else {
			return;
		}
		EventHelper.stop(e, true);
	}

	private runSearch(): void {
		if (this.searchId) {
			void this.fsBrowse.cancelFind(this.searchId);
		}
		this.searchResults = [];
		const query = this.input.value.trim();
		if (!query) {
			this.searchId = undefined;
			this.searchDone = true;
			this.renderRows(true);
			return;
		}
		const id = this.searchId = generateUuid();
		this.searchDone = false;
		this.renderRows(true);
		const roots = this.configurationService.getValue<string[]>('volt.projects.deepSearchRoots');
		const maxDepth = this.configurationService.getValue<number>('volt.projects.deepSearchMaxDepth');
		void this.fsBrowse.findFolders(id, query, Array.isArray(roots) && roots.length ? roots : ['~'], { maxDepth: typeof maxDepth === 'number' ? maxDepth : undefined }).catch(() => {
			if (this.searchId === id) {
				this.searchDone = true;
				this.renderRows();
			}
		});
	}

	private startNewFolder(): void {
		if (this.searching || !this.dir) {
			return;
		}
		this.newFolderStore.clear();
		clearNode(this.newFolderHost);
		this.newFolderHost.classList.remove('hidden');
		this.newFolderHost.appendChild(renderIcon(Codicon.newFolder));
		const input = this.newFolderStore.add(new InputBox(this.newFolderHost, undefined, {
			placeholder: localize('voltFolders.newFolderName', "New folder name, then Enter"),
			ariaLabel: localize('voltFolders.newFolder', "New folder"),
			tooltip: '',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		const stop = () => {
			this.newFolderStore.clear();
			clearNode(this.newFolderHost);
			this.newFolderHost.classList.add('hidden');
			this.input.focus();
		};
		this.newFolderStore.add(addDisposableListener(input.inputElement, 'keydown', async e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Escape)) {
				EventHelper.stop(e, true);
				stop();
			} else if (event.equals(KeyCode.Enter)) {
				EventHelper.stop(e, true);
				const name = input.value.trim();
				if (!name) {
					return;
				}
				try {
					const created = await this.fsBrowse.mkdir(this.dir, name);
					stop();
					listingCache.delete(`${this.showHidden ? 'h' : ''}:${this.dir}`);
					await this.load(this.dir, true);
					const index = this.rows.findIndex(row => row.kind === 'folder' && row.entry.path === created);
					if (index >= 0) {
						this.list.setFocus([index]);
						this.list.reveal(index);
					}
				} catch (err) {
					input.showMessage({ content: err instanceof Error ? err.message : String(err), type: MessageType.ERROR });
				}
			}
		}));
		input.focus();
	}

	private renderCrumbs(): void {
		clearNode(this.crumbs);
		const parts = breadcrumbParts(this.display(this.dir));
		parts.forEach((part, index) => {
			if (index > 0) {
				this.crumbs.appendChild(renderIcon(Codicon.chevronRight)).classList.add('volt-folder-crumb-sep');
			}
			const crumb = append(this.crumbs, $('button.volt-folder-crumb')) as HTMLButtonElement;
			crumb.type = 'button';
			crumb.textContent = part.label;
			crumb.classList.toggle('current', index === parts.length - 1);
			crumb.addEventListener('click', e => {
				EventHelper.stop(e, true);
				this.setPath(part.path);
			});
		});
		this.crumbs.scrollLeft = this.crumbs.scrollWidth;
	}

	private renderRail(): void {
		clearNode(this.rail);
		const section = (title: string) => append(this.rail, $('.volt-folder-rail-title')).textContent = title;
		section(localize('voltFolders.quickAccessTitle', "Quick access"));
		for (const root of this.roots.filter(root => root.id !== 'volume')) {
			this.railItem(root.label, root.path, railIcon(root.id));
		}
		const known = this.options.knownFolders().slice(0, 6);
		if (known.length) {
			section(localize('voltFolders.recent', "Recent"));
			for (const folder of known) {
				this.railItem(folder.name, folder.path, Codicon.history);
			}
		}
		const volumes = this.roots.filter(root => root.id === 'volume');
		if (volumes.length) {
			section(localize('voltFolders.volumes', "Locations"));
			for (const root of volumes) {
				this.railItem(root.label, root.path, Codicon.server);
			}
		}
		this.renderRailSelection();
	}

	private railItem(label: string, path: string, icon: ThemeIcon): void {
		const item = append(this.rail, $('button.volt-folder-rail-item')) as HTMLButtonElement;
		item.type = 'button';
		item.dataset.path = ensureTrailingSeparator(path);
		item.title = this.display(path);
		item.appendChild(renderIcon(icon));
		append(item, $('span.label')).textContent = label;
		item.addEventListener('click', e => {
			EventHelper.stop(e, true);
			this.enter(path);
		});
	}

	private renderRailSelection(): void {
		for (const item of this.rail.querySelectorAll<HTMLElement>('.volt-folder-rail-item')) {
			item.classList.toggle('selected', item.dataset.path === this.dir);
		}
	}

	private observeSize() {
		const win = getWindow(this.element);
		const observer = new win.ResizeObserver(() => this.list.layout(this.listHost.clientHeight, this.listHost.clientWidth));
		observer.observe(this.listHost);
		return toDisposable(() => observer.disconnect());
	}
}

function stripTrailing(path: string): string {
	return path.length > 1 && hasTrailingSeparator(path) && !/^[a-zA-Z]:[\\/]$/.test(path) ? path.slice(0, -1) : path;
}

function parentOf(path: string): string {
	return stripTrailing(parentDirectory(ensureTrailingSeparator(path)) ?? path);
}

function sameListing(a: IVoltFsListing, b: IVoltFsListing): boolean {
	if (a.error !== b.error || a.entries.length !== b.entries.length) {
		return false;
	}
	return a.entries.every((entry, i) => entry.path === b.entries[i].path && entry.gitRepo === b.entries[i].gitRepo);
}

function listErrorText(error: NonNullable<IVoltFsListing['error']>): string {
	switch (error) {
		case 'noAccess': return localize('voltFolders.noAccess', "No access to this folder");
		case 'notDirectory': return localize('voltFolders.notDirectory', "Not a folder");
		case 'timeout': return localize('voltFolders.timeout', "This location is not responding");
		default: return localize('voltFolders.notFound', "Folder not found");
	}
}

function railIcon(id: IVoltQuickAccessRoot['id']): ThemeIcon {
	switch (id) {
		case 'home': return Codicon.home;
		case 'desktop': return Codicon.deviceDesktop;
		case 'documents': return Codicon.book;
		case 'downloads': return Codicon.cloudDownload;
		case 'code': return Codicon.code;
		default: return Codicon.server;
	}
}

class RowDelegate implements IListVirtualDelegate<Row> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(row: Row): string {
		return row.kind;
	}
}

interface IFolderTemplate {
	readonly icon: HTMLElement;
	readonly label: HighlightedLabel;
	readonly location: HTMLElement;
	readonly badges: HTMLElement;
	readonly time: HTMLElement;
}

class FolderRenderer implements IListRenderer<Row, IFolderTemplate> {
	readonly templateId = 'folder';

	renderTemplate(container: HTMLElement): IFolderTemplate {
		const row = append(container, $('.volt-folder-row'));
		const icon = append(row, $('span.volt-folder-icon'));
		const label = new HighlightedLabel(append(row, $('span.volt-folder-name')));
		const location = append(row, $('span.volt-folder-location'));
		const badges = append(row, $('span.volt-folder-badges'));
		const time = append(row, $('span.volt-folder-time'));
		return { icon, label, location, badges, time };
	}

	renderElement(row: Row, _index: number, template: IFolderTemplate): void {
		if (row.kind !== 'folder') {
			return;
		}
		const entry = row.entry;
		clearNode(template.icon);
		template.icon.appendChild(renderIcon(entry.gitRepo ? Codicon.repo : entry.symlink ? Codicon.fileSymlinkDirectory : Codicon.folder));
		template.label.set(entry.name, row.matches);
		template.location.textContent = row.location ?? '';
		clearNode(template.badges);
		if (entry.gitRepo) {
			append(template.badges, $('span.volt-folder-badge')).textContent = 'git';
		}
		if (row.added) {
			append(template.badges, $('span.volt-folder-badge.added')).textContent = localize('voltFolders.added', "Added");
		}
		template.time.textContent = entry.mtime ? fromNow(entry.mtime, true) : '';
	}

	disposeTemplate(): void { }
}

class UpRenderer implements IListRenderer<Row, HTMLElement> {
	readonly templateId = 'up';

	renderTemplate(container: HTMLElement): HTMLElement {
		const row = append(container, $('.volt-folder-row.up'));
		append(row, $('span.volt-folder-icon')).appendChild(renderIcon(Codicon.arrowUp));
		append(row, $('span.volt-folder-name')).textContent = '..';
		return row;
	}

	renderElement(): void { }

	disposeTemplate(): void { }
}

class MessageRenderer implements IListRenderer<Row, HTMLElement> {
	readonly templateId = 'message';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-folder-row.message'));
	}

	renderElement(row: Row, _index: number, element: HTMLElement): void {
		element.textContent = row.kind === 'message' ? row.text : '';
		element.classList.toggle('error', row.kind === 'message' && !!row.error);
	}

	disposeTemplate(): void { }
}
