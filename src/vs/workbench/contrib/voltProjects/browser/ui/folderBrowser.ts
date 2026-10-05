/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox, MessageType } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer, TreeMouseEventTarget } from '../../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isCancellationError, onUnexpectedError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IMatch, matchesFuzzy } from '../../../../../base/common/filters.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IVoltFsBrowseService, IVoltFsEntry, IVoltFsListing, IVoltQuickAccessRoot } from '../../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { browseDirectory, browseLeaf, BrowseGeneration, ensureTrailingSeparator, hasTrailingSeparator, parentDirectory, tildify, untildify } from '../../common/browsePath.js';
import { rankFolders } from '../../common/folderSearch.js';

export interface IFolderBrowserOptions {
	/** Absolute folder to start in. */
	readonly initialPath?: string;
	/** Paths already added as projects, for the "Added" badge. */
	readonly addedPaths: () => ReadonlySet<string>;
	/** Known folders (projects, recents) that search offers before the disk scan answers. */
	readonly knownFolders: () => readonly { readonly name: string; readonly path: string }[];
	/** Enter (or ⌘⏎): the caller adds or picks the focused folder, else the one shown. */
	readonly onAccept: (path: string) => void;
	/** The accept button's label. Defaults to "Add". */
	readonly acceptLabel?: string;
	/** What Escape does here, for the footer hint. Defaults to "Close". */
	readonly escapeLabel?: string;
}

interface IFolderRow { readonly kind: 'folder'; readonly id: string; readonly entry: IVoltFsEntry; readonly matches?: IMatch[]; readonly added: boolean; readonly location?: string }
type Row =
	| IFolderRow
	| { readonly kind: 'message'; readonly id: string; readonly text: string; readonly error?: boolean };

/** The tree's input: its children are the rows of the folder shown (or the search results). */
const TREE_ROOT = { kind: 'root' } as const;
type TreeRoot = typeof TREE_ROOT;

const ROW_HEIGHT = 32;
/** Registered by the desktop files contribution; the footer link hides without it. */
const REVEAL_IN_OS_COMMAND_ID = 'revealFileInOS';
/** Listings survive closing the dialog, so it paints at once next time; every open still re-reads. */
const listingCache = new Map<string, IVoltFsListing>();
let cachedHome: string | undefined;

/**
 * The in-app folder picker behind "Open from This PC" and "Clone into". Built like T3 Code's:
 * the path field is where you are and what you filter by (`~/code/ap`), a trailing separator
 * enters a folder, Backspace on an empty filter goes up, and ⌘K searches every folder under
 * your home. The folders are a workbench tree driven from the path field: ↑↓ move, → expands a
 * folder in place, ← collapses it or goes to its parent, Enter adds the focused folder, and Tab
 * (or a double click) goes into it. Listings come from the main process in one call per folder,
 * are painted from cache, and are always re-read.
 */
export class FolderBrowser extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidChangeTarget = this._register(new Emitter<string | undefined>());
	/** The folder "Add" would use: the focused row, else the folder being shown. */
	readonly onDidChangeTarget = this._onDidChangeTarget.event;

	private readonly input: InputBox;
	private readonly modeChip: HTMLElement;
	private readonly acceptButton: HTMLButtonElement;
	private readonly acceptLabel: HTMLElement;
	private acceptHint: HTMLElement | undefined;
	private readonly section: HTMLElement;
	private readonly newFolderHost: HTMLElement;
	private readonly listHost: HTMLElement;
	private readonly tree: WorkbenchAsyncDataTree<TreeRoot, Row>;
	/** Only the latest refresh of the tree's top rows moves the focus. */
	private renderGeneration = 0;
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
	private newFolderRequested = false;

	constructor(
		container: HTMLElement,
		private readonly options: IFolderBrowserOptions,
		@IVoltFsBrowseService private readonly fsBrowse: IVoltFsBrowseService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.showHidden = this.configurationService.getValue<boolean>('volt.projects.showHiddenFolders') === true;
		this.element = append(container, $('.volt-folder-browser'));

		const head = append(this.element, $('.volt-folder-head'));
		const back = append(head, $('button.volt-folder-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.arrowLeft));
		back.title = localize('voltFolders.parent', "Parent folder");
		back.setAttribute('aria-label', back.title);
		this._register(addDisposableListener(back, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(back, 'click', e => {
			EventHelper.stop(e, true);
			this.goUp();
		}));
		this.modeChip = append(head, $('span.volt-folder-mode'));
		this.input = this._register(new InputBox(head, undefined, {
			placeholder: localize('voltFolders.placeholder', "Type a path, or filter this folder"),
			ariaLabel: localize('voltFolders.pathAria', "Folder path"),
			tooltip: '',
			inputBoxStyles: { ...defaultInputBoxStyles, inputBackground: 'transparent', inputBorder: 'transparent' },
		}));
		this.input.inputElement.spellcheck = false;
		this.input.inputElement.setAttribute('role', 'combobox');
		this.input.inputElement.setAttribute('aria-expanded', 'true');
		this.acceptButton = append(head, $('button.volt-folder-accept')) as HTMLButtonElement;
		this.acceptButton.type = 'button';
		this.acceptLabel = append(this.acceptButton, $('span.label'));
		this.acceptLabel.textContent = this.options.acceptLabel ?? localize('voltFolders.add', "Add");
		append(this.acceptButton, $('span.volt-folder-kbd')).textContent = 'Enter';
		this._register(addDisposableListener(this.acceptButton, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(this.acceptButton, 'click', e => {
			EventHelper.stop(e, true);
			this.accept();
		}));
		this.newFolderHost = append(this.element, $('.volt-folder-new.hidden'));

		this.section = append(this.element, $('.volt-folder-section'));
		this.listHost = append(this.element, $('.volt-folder-list'));
		const dataSource: IAsyncDataSource<TreeRoot, Row> = {
			hasChildren: element => element === TREE_ROOT || (element.kind === 'folder' && this.mayHaveSubfolders(element.entry.path)),
			getChildren: element => element === TREE_ROOT ? this.rows : element.kind === 'folder' ? this.subfolders(element) : [],
		};
		this.tree = this._register(instantiationService.createInstance(WorkbenchAsyncDataTree<TreeRoot, Row>, 'VoltFolderBrowser', this.listHost, new RowDelegate(), [new FolderRenderer(), new MessageRenderer()], dataSource, {
			identityProvider: { getId: row => row.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			// A click focuses a folder (Enter adds it); the twistie or → expands it, a double click goes into it.
			expandOnlyOnTwistieClick: true,
			expandOnDoubleClick: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltFolders.listAria', "Folders"),
				getRole: row => row.kind === 'message' ? 'presentation' : 'treeitem',
				getAriaLabel: row => row.kind === 'folder' ? `${row.entry.name}${row.entry.gitRepo ? ', git' : ''}${row.added ? ', added' : ''}` : row.text,
			},
			overrideStyles: { listBackground: 'transparent', listFocusOutline: 'transparent', listInactiveFocusOutline: 'transparent' },
		}));
		// Sticky parent rows are not worth their backdrop layer in a picker over the agent window.
		this.tree.updateOptions({ enableStickyScroll: false });
		void this.tree.setInput(TREE_ROOT);
		this.input.inputElement.setAttribute('aria-controls', this.tree.getHTMLElement().id);
		this._register(addDisposableListener(this.listHost, 'mousedown', e => {
			// Keep typing in the path field while clicking rows.
			if (e.detail < 2) {
				e.preventDefault();
			}
		}));
		// The path field drives the tree, so keys always land there.
		this._register(this.tree.onDidFocus(() => this.input.focus()));
		this._register(this.tree.onDidChangeFocus(e => {
			// A click on a message row focuses nothing. Keys step over messages themselves (settleFocus).
			if (e.elements[0]?.kind === 'message' && e.browserEvent) {
				this.tree.setFocus([]);
				return;
			}
			this.fireTarget();
		}));
		this._register(this.tree.onMouseDblClick(e => {
			if (e.element?.kind === 'folder' && e.target !== TreeMouseEventTarget.Twistie) {
				this.enter(e.element.entry.path);
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
		this.renderFooter();

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

	setAcceptLabel(label: string): void {
		this.acceptLabel.textContent = label;
		if (this.acceptHint) {
			this.acceptHint.textContent = label;
		}
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

	toggleSearch(): void {
		this.searching = !this.searching;
		this.element.classList.toggle('searching', this.searching);
		this.renderSection();
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

	private goUp(): void {
		if (this.searching) {
			this.toggleSearch();
		}
		const parent = parentDirectory(this.dir);
		if (parent) {
			this.setPath(parent);
		}
	}

	private accept(): void {
		const target = this.target;
		if (target) {
			this.options.onAccept(target);
		}
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
			const leaf = browseLeaf(this.input.value);
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
		const generation = ++this.renderGeneration;
		// The top rows are new; a folder still listed keeps its node, so it stays expanded and focused.
		this.tree.updateChildren(TREE_ROOT, false).then(() => {
			if (generation !== this.renderGeneration || this._store.isDisposed) {
				return;
			}
			// A typed filter focuses its best match when the focused folder is gone or the folder changed.
			if (resetFocus || !this.focusedRow()) {
				const best = this.searching || browseLeaf(this.input.value) ? rows.find(row => row.kind === 'folder') : undefined;
				this.tree.setFocus(best ? [best] : []);
				if (best) {
					this.tree.reveal(best);
				} else if (resetFocus) {
					this.tree.scrollTop = 0;
				}
			}
			this.fireTarget();
		}, err => {
			if (!isCancellationError(err)) {
				onUnexpectedError(err);
			}
		});
	}

	private focusedRow(): Row | undefined {
		return this.tree.getFocus()[0] ?? undefined;
	}

	private fireTarget(): void {
		const row = this.focusedRow();
		const rowElement = row?.kind === 'folder' ? this.tree.getHTMLElement().querySelector<HTMLElement>('.monaco-list-row.focused') : null;
		if (rowElement?.id) {
			this.input.inputElement.setAttribute('aria-activedescendant', rowElement.id);
		} else {
			this.input.inputElement.removeAttribute('aria-activedescendant');
		}
		if (row?.kind === 'folder') {
			this.prefetchScheduler.schedule();
		}
		const target = this.target;
		this.acceptButton.disabled = !target;
		this._onDidChangeTarget.fire(target);
	}

	private cacheKey(dir: string): string {
		return `${this.showHidden ? 'h' : ''}:${dir}`;
	}

	/** Reads the focused folder ahead, so expanding or entering it paints at once. */
	private prefetch(): void {
		const row = this.focusedRow();
		if (row?.kind !== 'folder') {
			return;
		}
		const dir = ensureTrailingSeparator(row.entry.path);
		const key = this.cacheKey(dir);
		if (!listingCache.has(key)) {
			void this.fsBrowse.list(dir, { showHidden: this.showHidden, dirsOnly: true }).then(listing => {
				if (!listing.error) {
					listingCache.set(key, listing);
				}
			}, () => undefined);
		}
	}

	/** False once a read of the folder found no subfolders, so it shows no twistie. */
	private mayHaveSubfolders(path: string): boolean {
		const listing = listingCache.get(this.cacheKey(ensureTrailingSeparator(path)));
		return !listing || listing.entries.some(entry => this.showHidden || !entry.hidden);
	}

	/** An expanded folder's children: painted from cache when there is one, and always re-read. */
	private subfolders(parent: IFolderRow): Iterable<Row> | Promise<Iterable<Row>> {
		const dir = ensureTrailingSeparator(parent.entry.path);
		const key = this.cacheKey(dir);
		const cached = listingCache.get(key);
		const fresh = this.fsBrowse.list(dir, { showHidden: this.showHidden, dirsOnly: true }).catch((): IVoltFsListing => ({ path: dir, entries: [], truncated: false, error: 'notFound' }));
		if (!cached) {
			return fresh.then(listing => {
				if (!listing.error) {
					listingCache.set(key, listing);
				}
				return this.childRows(parent, listing);
			});
		}
		void fresh.then(listing => {
			if (listing.error || sameListing(cached, listing) || this._store.isDisposed) {
				return;
			}
			listingCache.set(key, listing);
			if (this.tree.hasNode(parent)) {
				this.tree.updateChildren(parent, false).catch(() => undefined);
			}
		});
		return this.childRows(parent, cached);
	}

	private childRows(parent: IFolderRow, listing: IVoltFsListing): Row[] {
		if (listing.error) {
			return [{ kind: 'message', id: `${parent.id}#error`, error: true, text: listErrorText(listing.error) }];
		}
		const added = this.options.addedPaths();
		const rows: Row[] = listing.entries
			.filter(entry => this.showHidden || !entry.hidden)
			.map(entry => ({ kind: 'folder', id: `${parent.id}/${entry.name}`, entry, added: added.has(entry.path) }));
		return rows.length ? rows : [{ kind: 'message', id: `${parent.id}#empty`, text: localize('voltFolders.noSubfolders', "No folders inside") }];
	}

	/** Moves the focus over folder rows, skipping messages; stays put at either end. */
	private moveFocus(delta: 1 | -1, page = false): void {
		const start = this.focusedRow();
		if (!start) {
			if (delta > 0) {
				this.tree.focusFirst();
			} else {
				this.tree.focusLast();
			}
		} else if (page) {
			void (delta > 0 ? this.tree.focusNextPage() : this.tree.focusPreviousPage()).then(() => this.settleFocus(delta, start));
			return;
		} else if (delta > 0) {
			this.tree.focusNext();
		} else {
			this.tree.focusPrevious();
		}
		this.settleFocus(delta, start);
	}

	/** After a move landed on a message, steps on to the next folder, or goes back to `start`. */
	private settleFocus(delta: 1 | -1, start: Row | undefined): void {
		let focused = this.tree.getFocus()[0];
		for (let steps = 0; focused?.kind === 'message' && steps < 50; steps++) {
			const before = focused;
			if (delta > 0) {
				this.tree.focusNext();
			} else {
				this.tree.focusPrevious();
			}
			focused = this.tree.getFocus()[0];
			if (focused === before) {
				break;
			}
		}
		if (focused?.kind !== 'folder') {
			this.tree.setFocus(start && this.tree.hasNode(start) ? [start] : []);
			focused = this.tree.getFocus()[0];
		}
		if (focused) {
			this.tree.reveal(focused);
		}
	}

	/** →: expands a folder in place; on an expanded one, steps into its first subfolder. */
	private expandOrStepIn(row: IFolderRow): void {
		if (this.tree.isCollapsible(row) && this.tree.isCollapsed(row)) {
			void this.tree.expand(row).catch(onUnexpectedError);
		} else if (this.tree.isCollapsible(row)) {
			this.tree.focusNext();
			const child = this.focusedRow();
			if (child?.kind === 'folder' && this.tree.getParentElement(child) === row) {
				this.tree.reveal(child);
			} else {
				// No subfolder to step into ("No folders inside"): stay on the folder.
				this.tree.setFocus([row]);
			}
		}
	}

	/** ←: collapses an expanded folder, or goes to the folder it sits in. False on a top row, so the caret moves. */
	private collapseOrStepOut(row: IFolderRow): boolean {
		if (this.tree.isCollapsible(row) && !this.tree.isCollapsed(row)) {
			this.tree.collapse(row);
			return true;
		}
		const parent = this.tree.getParentElement(row);
		if (parent.kind === 'folder') {
			this.tree.setFocus([parent]);
			this.tree.reveal(parent);
			return true;
		}
		return false;
	}

	private onKeyDown(e: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(e);
		const row = this.focusedRow();
		const caretAtEnd = this.input.inputElement.selectionStart === this.input.value.length && this.input.inputElement.selectionEnd === this.input.value.length;
		if (event.equals(KeyCode.DownArrow)) {
			this.moveFocus(1);
		} else if (event.equals(KeyCode.UpArrow)) {
			this.moveFocus(-1);
		} else if (event.equals(KeyCode.PageDown)) {
			this.moveFocus(1, true);
		} else if (event.equals(KeyCode.PageUp)) {
			this.moveFocus(-1, true);
		} else if (event.equals(KeyCode.RightArrow) && caretAtEnd && row?.kind === 'folder') {
			this.expandOrStepIn(row);
		} else if (event.equals(KeyCode.LeftArrow) && caretAtEnd && row?.kind === 'folder') {
			if (!this.collapseOrStepOut(row)) {
				return;
			}
		} else if (event.equals(KeyCode.Enter) || event.equals(KeyMod.CtrlCmd | KeyCode.Enter)) {
			// The focused folder, else the folder being shown.
			if (!this.target) {
				return;
			}
			this.accept();
		} else if (event.equals(KeyCode.Tab) && row?.kind === 'folder') {
			this.enter(row.entry.path);
		} else if (event.equals(KeyMod.Alt | KeyCode.UpArrow) || event.equals(KeyMod.CtrlCmd | KeyCode.UpArrow)) {
			this.goUp();
		} else if (event.equals(KeyCode.Backspace) && !this.searching && caretAtEnd && !browseLeaf(this.input.value) && parentDirectory(this.dir)) {
			// An empty filter: Backspace goes up a folder instead of eating the separator.
			EventHelper.stop(e, true);
			this.goUp();
			return;
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
					listingCache.delete(this.cacheKey(this.dir));
					await this.load(this.dir, true);
					await this.tree.updateChildren(TREE_ROOT, false);
					const row = this.rows.find(candidate => candidate.kind === 'folder' && candidate.entry.path === created);
					if (row) {
						this.tree.setFocus([row]);
						this.tree.reveal(row);
					}
				} catch (err) {
					input.showMessage({ content: err instanceof Error ? err.message : String(err), type: MessageType.ERROR });
				}
			}
		}));
		input.focus();
	}

	private renderSection(): void {
		this.section.textContent = this.searching ? localize('voltFolders.allFolders', "All folders") : localize('voltFolders.directories', "Directories");
	}

	private renderFooter(): void {
		const footer = append(this.element, $('.volt-folder-foot'));
		const hint = (keys: string[], label: string) => {
			const item = append(footer, $('span.volt-folder-foot-hint'));
			for (const key of keys) {
				append(item, $('span.volt-folder-kbd')).textContent = key;
			}
			const text = append(item, $('span.label'));
			text.textContent = label;
			return text;
		};
		hint(['\u2191', '\u2193'], localize('voltFolders.navigate', "Navigate"));
		hint(['\u2190', '\u2192'], localize('voltFolders.expand', "Expand"));
		this.acceptHint = hint(['Enter'], this.acceptLabel.textContent || localize('voltFolders.add', "Add"));
		hint([isMacintosh ? '\u232b' : 'Backspace'], localize('voltFolders.back', "Back"));
		hint(['Esc'], this.options.escapeLabel ?? localize('voltFolders.close', "Close"));
		if (CommandsRegistry.getCommand(REVEAL_IN_OS_COMMAND_ID)) {
			const reveal = append(footer, $('button.volt-folder-reveal')) as HTMLButtonElement;
			reveal.type = 'button';
			reveal.textContent = isMacintosh ? localize('voltFolders.openInFinder', "Open in Finder") : isWindows ? localize('voltFolders.openInExplorer', "Open in File Explorer") : localize('voltFolders.openInFiles', "Open in File Manager");
			this._register(addDisposableListener(reveal, 'mousedown', e => e.preventDefault()));
			this._register(addDisposableListener(reveal, 'click', e => {
				EventHelper.stop(e, true);
				const path = this.target ?? (this.dir ? stripTrailing(this.dir) : undefined);
				if (path) {
					void this.commandService.executeCommand(REVEAL_IN_OS_COMMAND_ID, URI.file(path));
				}
			}));
		}
		this.renderSection();
	}

	private observeSize() {
		const win = getWindow(this.element);
		const observer = new win.ResizeObserver(() => this.tree.layout(this.listHost.clientHeight, this.listHost.clientWidth));
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
}

class FolderRenderer implements ITreeRenderer<Row, void, IFolderTemplate> {
	readonly templateId = 'folder';

	renderTemplate(container: HTMLElement): IFolderTemplate {
		const row = append(container, $('.volt-folder-row'));
		const icon = append(row, $('span.volt-folder-icon'));
		const label = new HighlightedLabel(append(row, $('span.volt-folder-name')));
		const location = append(row, $('span.volt-folder-location'));
		const badges = append(row, $('span.volt-folder-badges'));
		return { icon, label, location, badges };
	}

	renderElement(node: ITreeNode<Row, void>, _index: number, template: IFolderTemplate): void {
		const row = node.element;
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
	}

	disposeTemplate(): void { }
}

class MessageRenderer implements ITreeRenderer<Row, void, HTMLElement> {
	readonly templateId = 'message';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-folder-row.message'));
	}

	renderElement(node: ITreeNode<Row, void>, _index: number, element: HTMLElement): void {
		const row = node.element;
		element.textContent = row.kind === 'message' ? row.text : '';
		element.classList.toggle('error', row.kind === 'message' && !!row.error);
	}

	disposeTemplate(): void { }
}
