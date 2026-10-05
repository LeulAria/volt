/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './voltMenu.css';
import { $, addDisposableListener, append, clearNode, EventHelper, getDomNodePagePosition, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { HighlightedLabel } from '../../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputBox.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../../base/browser/ui/list/list.js';
import { List } from '../../../../../../base/browser/ui/list/listWidget.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IMatch, matchesFuzzy } from '../../../../../../base/common/filters.js';
import { KeyCode, KeyMod } from '../../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { defaultInputBoxStyles, getListStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';

export interface IVoltMenuItem<T> {
	readonly id: string;
	readonly label: string;
	/** Muted text after the label, e.g. a path. Ellipsized at the start. */
	readonly description?: string;
	/** Muted text after the label, e.g. a commit subject. Ellipsized at the end, never searched. */
	readonly detail?: string;
	/** Muted second line under the label, e.g. a turn's prompt. Makes the row taller. */
	readonly subtitle?: string;
	/** Line counts after the label, green and red as in a diff. Zero counts are left out. */
	readonly stats?: { readonly additions: number; readonly deletions: number };
	readonly icon?: ThemeIcon | (() => HTMLElement);
	/** Spins the icon (clone in progress). */
	readonly busy?: boolean;
	readonly checked?: boolean;
	readonly disabled?: boolean;
	/** Right-aligned hint such as "⌘⌥A". */
	readonly keybinding?: string;
	/** Right-aligned glyph, e.g. an arrow for items that leave the menu. */
	readonly trailingIcon?: ThemeIcon;
	readonly tooltip?: string;
	/** Also searched, never shown. */
	readonly keywords?: string;
	/** Opens a flyout beside the row on hover, → or Enter. */
	readonly submenu?: IVoltSubmenu<T>;
	/** Picking it turns the root menu's search field into this prompt instead of closing. */
	readonly prompt?: IVoltMenuPrompt;
	/** Stays listed while searching, whatever the query. */
	readonly alwaysShow?: boolean;
	readonly data: T;
}

export interface IVoltMenuSection<T> {
	readonly id: string;
	/** A muted header above the items. Every section after the first gets a divider. */
	readonly title?: string;
	readonly items: readonly IVoltMenuItem<T>[];
	/** Shows only the header until clicked; search always expands it. */
	readonly collapsed?: boolean;
	/** Only listed while the user is searching. */
	readonly searchOnly?: boolean;
	/** Shown in place of items when the section is empty. */
	readonly emptyMessage?: string;
}

/**
 * A value asked for in the search field, as VS Code's quick input does after "Create new
 * branch...": Enter submits, Escape goes back to the list.
 */
export interface IVoltMenuPrompt {
	readonly placeholder: string;
	/** Shown under the field while the value is valid. */
	readonly hint?: string;
	/** Start from what was typed in the search. */
	readonly useQuery?: boolean;
	readonly validate?: (value: string) => string | undefined;
	/** A rejection's message is shown and the menu stays open; otherwise the menu closes. */
	readonly onSubmit: (value: string) => Promise<void>;
}

export type VoltMenuSections<T> = readonly IVoltMenuSection<T>[] | ((query: string, token: CancellationToken) => Promise<readonly IVoltMenuSection<T>[]> | readonly IVoltMenuSection<T>[]);

export interface IVoltMenuSearch {
	readonly placeholder: string;
	readonly ariaLabel?: string;
	/** Show the magnifier in front of the field. Defaults to false, like the other menus. */
	readonly icon?: boolean;
	/** The sections function filters by the query; otherwise sections load once and filter locally. */
	readonly remote?: boolean;
}

/** The content of a flyout. Picks go to the root menu's `onPick`. */
export interface IVoltSubmenu<T> {
	readonly search?: IVoltMenuSearch;
	readonly sections: VoltMenuSections<T>;
	readonly footer?: readonly IVoltMenuItem<T>[];
	readonly width?: number;
	readonly emptyMessage?: string;
}

export interface IVoltMenuOptions<T> extends IVoltSubmenu<T> {
	readonly anchor: HTMLElement;
	/** Preferred side; flips when there is no room. */
	readonly position?: 'below' | 'above';
	readonly align?: 'left' | 'right';
	/** Space between the menu and the anchor, on whichever side the menu lands. */
	readonly gap?: number;
	readonly className?: string;
	readonly ariaLabel: string;
	readonly onPick: (item: IVoltMenuItem<T>) => void | Promise<void>;
	readonly onHide?: () => void;
}

export interface IVoltMenuHandle extends IDisposable {
	/** Re-reads the sections, e.g. after async data arrived. */
	refresh(): void;
}

type Row<T> =
	| { readonly kind: 'header'; readonly id: string; readonly title: string; readonly collapsible: boolean; readonly collapsed: boolean }
	| { readonly kind: 'item'; readonly id: string; readonly item: IVoltMenuItem<T>; readonly matches?: IMatch[] }
	| { readonly kind: 'separator'; readonly id: string }
	| { readonly kind: 'message'; readonly id: string; readonly text: string; readonly error?: boolean };

const ROW_HEIGHT = 30;
const TWO_LINE_ROW_HEIGHT = 46;
const HEADER_HEIGHT = 22;
const SEPARATOR_HEIGHT = 1;
const MAX_LIST_HEIGHT = 360;
const ASYNC_DEBOUNCE_MS = 80;
/** Long enough to cross into a flyout diagonally without it closing. */
const FLYOUT_DELAY_MS = 120;

/** The menu open right now, so clicking its trigger again closes it. */
let openMenu: { readonly anchor: HTMLElement; readonly hide: () => void } | undefined;

/**
 * A Cursor-style dropdown anchored to a trigger: a search field, sections with dividers, a check
 * on the current item, flyout submenus, and full keyboard support. Rows are virtualized, so long
 * lists (branches, recents) stay fast.
 */
export function showVoltMenu<T>(contextViewService: IContextViewService, options: IVoltMenuOptions<T>): IVoltMenuHandle {
	if (openMenu?.anchor === options.anchor) {
		openMenu.hide();
		return { refresh: () => { }, dispose: () => { } };
	}
	let widget: VoltMenuWidget<T> | undefined;
	let hidden = false;
	const hide = () => {
		if (!hidden) {
			hidden = true;
			contextViewService.hideContextView();
		}
	};
	contextViewService.showContextView({
		getAnchor: () => {
			if (options.gap === undefined) {
				return options.anchor;
			}
			// Grow the anchor by the gap so the menu keeps its distance whichever side it lands on.
			const page = getDomNodePagePosition(options.anchor);
			return { x: page.left, y: page.top - options.gap, width: page.width, height: page.height + options.gap * 2 };
		},
		anchorAlignment: options.align === 'right' ? AnchorAlignment.RIGHT : AnchorAlignment.LEFT,
		anchorPosition: options.position === 'above' ? AnchorPosition.ABOVE : AnchorPosition.BELOW,
		canRelayout: true,
		render: container => {
			const store = new DisposableStore();
			// The context view only reports events inside itself, so watch the page for a press
			// anywhere else. The trigger toggles the menu on its own click.
			store.add(addDisposableListener(getWindow(options.anchor).document, 'mousedown', e => {
				if (!(e.target instanceof Node) || contextViewService.getContextViewElement().contains(e.target) || options.anchor.contains(e.target)) {
					return;
				}
				hide();
			}, true));
			options.anchor.classList.add('open');
			options.anchor.setAttribute('aria-expanded', 'true');
			openMenu = { anchor: options.anchor, hide };
			store.add(toDisposable(() => {
				options.anchor.classList.remove('open');
				options.anchor.setAttribute('aria-expanded', 'false');
				if (openMenu?.anchor === options.anchor) {
					openMenu = undefined;
				}
			}));
			const host = append(container, $('.volt-menu-host'));
			if (options.gap !== undefined) {
				host.style.marginTop = '0';
			}
			store.add(toDisposable(() => host.remove()));
			widget = store.add(new VoltMenuWidget<T>(host, options, {
				hide,
				relayout: () => contextViewService.layout(),
				pick: item => options.onPick(item),
				className: options.className,
				ariaLabel: options.ariaLabel,
			}));
			return store;
		},
		onHide: () => {
			hidden = true;
			widget = undefined;
			options.onHide?.();
		},
	});
	return {
		refresh: () => widget?.refresh(),
		dispose: hide,
	};
}

interface IWidgetContext<T> {
	readonly hide: () => void;
	readonly relayout: () => void;
	readonly pick: (item: IVoltMenuItem<T>) => void | Promise<void>;
	readonly className?: string;
	readonly ariaLabel: string;
	/** Set on flyouts: closes this flyout and returns focus to the parent row. */
	readonly back?: () => void;
	/** Set on flyouts: the root menu asks for a prompt's value in its own search field. */
	readonly prompt?: (prompt: IVoltMenuPrompt) => void;
	/** Set on hover-opened flyouts: no row is highlighted until the pointer or keyboard enters. */
	readonly idle?: boolean;
}

class VoltMenuWidget<T> extends Disposable {

	readonly root: HTMLElement;
	private readonly input: InputBox | undefined;
	private readonly listHost: HTMLElement;
	private readonly list: List<Row<T>>;
	private readonly footerHost: HTMLElement;
	private readonly footerRows: { readonly item: IVoltMenuItem<T>; readonly element: HTMLElement }[] = [];
	private readonly expanded = new Set<string>();
	private readonly flyout = this._register(new MutableDisposable<DisposableStore>());
	private flyoutWidget: VoltMenuWidget<T> | undefined;
	private flyoutItem: IVoltMenuItem<T> | undefined;
	private flyoutTimer: ReturnType<typeof setTimeout> | undefined;
	private rows: Row<T>[] = [];
	private sections: readonly IVoltMenuSection<T>[] = [];
	/** Navigable positions: list rows first, then footer rows. */
	private active = -1;
	private idle: boolean;
	private loadCts: CancellationTokenSource | undefined;
	private loadTimer: ReturnType<typeof setTimeout> | undefined;
	private busy = false;
	private prompting: { readonly prompt: IVoltMenuPrompt; error?: string; submitting: boolean } | undefined;

	constructor(
		private readonly host: HTMLElement,
		private readonly options: IVoltSubmenu<T>,
		private readonly context: IWidgetContext<T>,
	) {
		super();
		this.idle = !!context.idle;
		this.root = append(host, $('.volt-menu'));
		if (context.className) {
			this.root.classList.add(...context.className.split(' '));
		}
		this.root.style.width = `${options.width ?? 300}px`;
		this.root.tabIndex = -1;
		this.root.setAttribute('role', 'dialog');
		this.root.setAttribute('aria-label', context.ariaLabel);
		this._register(toDisposable(() => {
			if (this.flyoutTimer) {
				clearTimeout(this.flyoutTimer);
			}
			this.loadCts?.dispose(true);
			if (this.loadTimer) {
				clearTimeout(this.loadTimer);
			}
			this.root.remove();
		}));

		if (options.search) {
			const searchRow = append(this.root, $('.volt-menu-search'));
			if (options.search.icon) {
				searchRow.appendChild(renderIcon(Codicon.search)).classList.add('volt-menu-search-icon');
			}
			this.input = this._register(new InputBox(searchRow, undefined, {
				placeholder: options.search.placeholder,
				ariaLabel: options.search.ariaLabel ?? options.search.placeholder,
				tooltip: '',
				inputBoxStyles: { ...defaultInputBoxStyles, inputBackground: 'transparent', inputBorder: 'transparent' },
			}));
			this.input.inputElement.setAttribute('role', 'combobox');
			this.input.inputElement.setAttribute('aria-expanded', 'true');
			this._register(this.input.onDidChange(() => {
				if (this.prompting) {
					this.prompting.error = undefined;
					this.renderPrompt();
					return;
				}
				this.closeFlyout();
				if (options.search?.remote) {
					this.load();
				} else {
					this.render();
				}
			}));
		}

		this.listHost = append(this.root, $('.volt-menu-list'));
		this.list = this._register(new List<Row<T>>('VoltMenu', this.listHost, new RowDelegate<T>(), [
			new HeaderRenderer<T>(),
			new ItemRenderer<T>(),
			new SeparatorRenderer<T>(),
			new MessageRenderer<T>(),
		], {
			identityProvider: { getId: row => row.id },
			multipleSelectionSupport: false,
			keyboardSupport: false,
			mouseSupport: true,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: true,
			setRowLineHeight: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => context.ariaLabel,
				getWidgetRole: () => 'listbox',
				getRole: row => row.kind === 'item' ? 'option' : 'presentation',
				getAriaLabel: row => row.kind === 'item'
					? [row.item.label, row.item.description, row.item.checked ? localize('voltMenu.current', "current") : undefined].filter(Boolean).join(', ')
					: row.kind === 'header' ? row.title : row.kind === 'message' ? row.text : null,
			},
		}));
		this.list.style(getListStyles({
			listBackground: 'transparent',
			listFocusBackground: 'transparent',
			listActiveSelectionBackground: 'transparent',
			listInactiveSelectionBackground: 'transparent',
			listFocusAndSelectionBackground: 'transparent',
			listHoverBackground: 'transparent',
			listFocusOutline: 'transparent',
			listInactiveFocusOutline: 'transparent',
			listFocusAndSelectionOutline: 'transparent',
		}));
		// Rows that move under a still pointer (typing filters the list) also fire mouse events;
		// only a pointer that moved picks the active row, so the search keeps its best match.
		let pointer: string | undefined;
		this._register(this.list.onMouseMove(e => {
			const point = `${e.browserEvent.clientX},${e.browserEvent.clientY}`;
			if (point === pointer) {
				return;
			}
			pointer = point;
			if (e.index !== undefined && e.index !== this.active && this.isNavigable(e.index)) {
				this.idle = false;
				this.setActive(e.index, false);
				this.hoverFlyout();
			}
		}));
		this._register(this.list.onMouseClick(e => {
			if (e.index === undefined) {
				return;
			}
			const row = this.rows[e.index];
			if (row?.kind === 'header' && row.collapsible) {
				this.toggleSection(row.id);
			} else if (row?.kind === 'item') {
				void this.pick(row.item);
			}
		}));
		// Clicking a row must not pull focus out of the search field.
		this._register(addDisposableListener(this.listHost, 'mousedown', e => e.preventDefault()));

		this.footerHost = append(this.root, $('.volt-menu-footer'));
		this.renderFooter();

		this._register(addDisposableListener(this.root, 'keydown', e => this.onKeyDown(e)));

		this.load(true);
		scheduleAtNextAnimationFrame(getWindow(this.root), () => this.focus());
	}

	focus(): void {
		if (this.idle) {
			this.idle = false;
			if (this.active < 0) {
				this.setActive(this.firstNavigable(), true);
			}
		}
		(this.input?.inputElement ?? this.root).focus();
	}

	refresh(): void {
		this.load(true);
	}

	private get query(): string {
		return this.input?.value.trim() ?? '';
	}

	private load(immediate = false): void {
		this.loadCts?.dispose(true);
		if (this.loadTimer) {
			clearTimeout(this.loadTimer);
			this.loadTimer = undefined;
		}
		const source = this.options.sections;
		if (typeof source !== 'function') {
			this.sections = source;
			this.render();
			return;
		}
		const cts = this.loadCts = new CancellationTokenSource();
		const run = async () => {
			const result = source(this.options.search?.remote ? this.query : '', cts.token);
			if (Array.isArray(result)) {
				this.sections = result;
				this.render();
				return;
			}
			this.busy = true;
			if (!this.sections.length) {
				this.render();
			}
			try {
				const sections = await result;
				if (!cts.token.isCancellationRequested) {
					this.sections = sections;
				}
			} finally {
				if (!cts.token.isCancellationRequested) {
					this.busy = false;
					this.render();
				}
			}
		};
		if (immediate) {
			void run();
		} else {
			this.loadTimer = setTimeout(() => void run(), ASYNC_DEBOUNCE_MS);
		}
	}

	private render(): void {
		if (this.prompting) {
			// Sections that finish loading while a prompt is up wait for it to end.
			this.renderPrompt();
			return;
		}
		const query = this.query;
		const filterLocally = !this.options.search?.remote;
		const rows: Row<T>[] = [];
		for (const section of this.sections) {
			if (section.searchOnly && !query) {
				continue;
			}
			const items: Row<T>[] = [];
			for (const item of section.items) {
				if (!query || !filterLocally) {
					items.push({ kind: 'item', id: `${section.id}:${item.id}`, item });
					continue;
				}
				if (item.alwaysShow) {
					items.push({ kind: 'item', id: `${section.id}:${item.id}`, item });
					continue;
				}
				// Flyout rows are ways in, not results; they stay out of a search.
				if (item.submenu) {
					continue;
				}
				const matches = matchesFuzzy(query, item.label, true);
				if (matches || matchesFuzzy(query, item.description ?? '', true) || matchesFuzzy(query, item.keywords ?? '', true)) {
					items.push({ kind: 'item', id: `${section.id}:${item.id}`, item, matches: matches ?? undefined });
				}
			}
			if (!items.length && (query || !section.emptyMessage)) {
				continue;
			}
			const collapsible = !!section.collapsed && !query;
			const collapsed = collapsible && !this.expanded.has(section.id);
			if (rows.length) {
				rows.push({ kind: 'separator', id: `${section.id}:sep` });
			}
			if (section.title) {
				rows.push({ kind: 'header', id: section.id, title: section.title, collapsible, collapsed });
			}
			if (collapsed) {
				continue;
			}
			if (!items.length && section.emptyMessage) {
				rows.push({ kind: 'message', id: `${section.id}:empty`, text: section.emptyMessage });
			}
			rows.push(...items);
		}
		if (!rows.length) {
			const text = this.busy
				? localize('voltMenu.loading', "Loading...")
				: this.options.emptyMessage ?? localize('voltMenu.noResults', "No results");
			rows.push({ kind: 'message', id: 'empty', text });
		}
		const previous = this.active >= 0 && this.active < this.rows.length ? this.rows[this.active]?.id : undefined;
		this.showRows(rows);
		// Keep the same row active across refreshes; otherwise start on the checked row or the first one.
		let next = previous && !query ? rows.findIndex(row => row.id === previous && row.kind === 'item') : -1;
		if (next < 0 && !query && !this.idle) {
			next = rows.findIndex(row => row.kind === 'item' && row.item.checked);
		}
		if (next < 0 && query) {
			// Enter should take the best match, not an action that is always listed.
			next = rows.findIndex((row, index) => row.kind === 'item' && !row.item.alwaysShow && this.isNavigable(index));
		}
		if (next < 0 && !this.idle) {
			next = this.firstNavigable();
		}
		this.setActive(next, true);
		scheduleAtNextAnimationFrame(getWindow(this.root), () => this.context.relayout());
	}

	private showRows(rows: Row<T>[]): void {
		this.rows = rows;
		this.list.splice(0, this.list.length, rows);
		const height = Math.min(MAX_LIST_HEIGHT, rows.reduce((sum, row) => sum + rowHeight(row), 0));
		this.listHost.style.height = `${height}px`;
		this.list.layout(height);
	}

	private renderFooter(): void {
		clearNode(this.footerHost);
		this.footerRows.length = 0;
		const footer = this.options.footer ?? [];
		this.footerHost.classList.toggle('hidden', !footer.length);
		for (const item of footer) {
			const element = append(this.footerHost, $('.volt-menu-row.volt-menu-item'));
			element.setAttribute('role', 'button');
			renderItem(element, item, undefined);
			element.classList.toggle('disabled', !!item.disabled);
			this._register(addDisposableListener(element, 'mouseenter', () => {
				this.setActive(this.rows.length + this.footerRows.findIndex(row => row.element === element), false);
				this.hoverFlyout();
			}));
			this._register(addDisposableListener(element, 'mousedown', e => EventHelper.stop(e, true)));
			this._register(addDisposableListener(element, 'click', e => {
				EventHelper.stop(e, true);
				void this.pick(item);
			}));
			this.footerRows.push({ item, element });
		}
	}

	private isNavigable(index: number): boolean {
		if (index < this.rows.length) {
			const row = this.rows[index];
			return row?.kind === 'item' && !row.item.disabled;
		}
		const footer = this.footerRows[index - this.rows.length];
		return !!footer && !footer.item.disabled;
	}

	private firstNavigable(): number {
		const total = this.rows.length + this.footerRows.length;
		for (let i = 0; i < total; i++) {
			if (this.isNavigable(i)) {
				return i;
			}
		}
		return -1;
	}

	private setActive(index: number, reveal: boolean): void {
		this.active = index;
		const inList = index >= 0 && index < this.rows.length;
		this.list.setFocus(inList ? [index] : []);
		if (inList && reveal) {
			this.list.reveal(index);
		}
		this.footerRows.forEach((row, i) => row.element.classList.toggle('active', index === this.rows.length + i));
		const activeId = inList ? this.list.getElementID(index) : undefined;
		if (this.input) {
			if (activeId) {
				this.input.inputElement.setAttribute('aria-activedescendant', activeId);
			} else {
				this.input.inputElement.removeAttribute('aria-activedescendant');
			}
		}
	}

	private move(delta: number): void {
		const total = this.rows.length + this.footerRows.length;
		if (!total) {
			return;
		}
		let index = this.active;
		for (let step = 0; step < total; step++) {
			index = index < 0 ? (delta > 0 ? 0 : total - 1) : (index + delta + total) % total;
			if (this.isNavigable(index)) {
				this.setActive(index, true);
				this.closeFlyout();
				return;
			}
		}
	}

	private activeItem(): IVoltMenuItem<T> | undefined {
		if (this.active < 0) {
			return undefined;
		}
		if (this.active < this.rows.length) {
			const row = this.rows[this.active];
			return row?.kind === 'item' ? row.item : undefined;
		}
		return this.footerRows[this.active - this.rows.length]?.item;
	}

	private activeElement(): HTMLElement | undefined {
		if (this.active >= this.rows.length) {
			return this.footerRows[this.active - this.rows.length]?.element;
		}
		return this.list.getHTMLElement().querySelector<HTMLElement>(`.monaco-list-row[data-index="${this.active}"]`) ?? undefined;
	}

	private onKeyDown(e: KeyboardEvent): void {
		// Keys typed in a flyout are the flyout's.
		if (!this.root.contains(e.target as Node)) {
			return;
		}
		const event = new StandardKeyboardEvent(e);
		if (this.prompting) {
			if (event.keyCode === KeyCode.Enter) {
				void this.submitPrompt();
			} else if (event.keyCode === KeyCode.Escape) {
				this.endPrompt();
			} else {
				return;
			}
			EventHelper.stop(e, true);
			return;
		}
		switch (event.keyCode) {
			case KeyCode.DownArrow:
				this.move(1);
				break;
			case KeyCode.UpArrow:
				this.move(-1);
				break;
			case KeyCode.PageDown:
				for (let i = 0; i < 8; i++) {
					this.move(1);
				}
				break;
			case KeyCode.PageUp:
				for (let i = 0; i < 8; i++) {
					this.move(-1);
				}
				break;
			case KeyCode.RightArrow: {
				const item = this.activeItem();
				const caretAtEnd = !this.input || this.input.inputElement.selectionStart === this.input.value.length;
				if (!item?.submenu || !caretAtEnd) {
					return;
				}
				this.openFlyout(item, true);
				break;
			}
			case KeyCode.LeftArrow:
				if (!this.context.back || (this.input && this.input.value)) {
					return;
				}
				this.context.back();
				break;
			case KeyCode.Enter: {
				const item = this.activeItem();
				if (item) {
					void this.pick(item);
				}
				break;
			}
			case KeyCode.Escape:
				if (this.input?.value) {
					this.input.value = '';
				} else if (this.context.back) {
					this.context.back();
				} else {
					this.context.hide();
				}
				break;
			case KeyCode.Tab:
				this.move(event.shiftKey ? -1 : 1);
				break;
			default:
				if (event.equals(KeyMod.CtrlCmd | KeyCode.KeyF) && this.input) {
					this.input.focus();
					this.input.select();
					break;
				}
				return;
		}
		EventHelper.stop(e, true);
	}

	private toggleSection(id: string): void {
		if (this.expanded.has(id)) {
			this.expanded.delete(id);
		} else {
			this.expanded.add(id);
		}
		this.render();
	}

	private async pick(item: IVoltMenuItem<T>): Promise<void> {
		if (item.disabled) {
			return;
		}
		if (item.submenu) {
			this.openFlyout(item, true);
			return;
		}
		if (item.prompt) {
			if (this.context.prompt) {
				this.context.prompt(item.prompt);
			} else {
				this.startPrompt(item.prompt);
			}
			return;
		}
		this.context.hide();
		await this.context.pick(item);
	}

	// ---- Flyouts --------------------------------------------------------------------------

	/** Hovering a row opens its flyout (or closes another one) after a short pause. */
	private hoverFlyout(): void {
		if (this.flyoutTimer) {
			clearTimeout(this.flyoutTimer);
		}
		const item = this.activeItem();
		if (item === this.flyoutItem) {
			return;
		}
		this.flyoutTimer = setTimeout(() => {
			this.flyoutTimer = undefined;
			if (item?.submenu) {
				this.openFlyout(item, false);
			} else {
				this.closeFlyout();
			}
		}, FLYOUT_DELAY_MS);
	}

	private openFlyout(item: IVoltMenuItem<T>, focus: boolean): void {
		const submenu = item.submenu;
		const row = this.activeElement();
		if (!submenu || !row) {
			return;
		}
		if (this.flyoutItem === item && this.flyoutWidget) {
			if (focus) {
				this.flyoutWidget.focus();
			}
			return;
		}
		this.closeFlyout();
		this.flyoutItem = item;
		row.classList.add('flyout-open');
		const store = new DisposableStore();
		const host = append(this.host, $('.volt-menu-flyout'));
		store.add(toDisposable(() => {
			host.remove();
			row.classList.remove('flyout-open');
			this.flyoutWidget = undefined;
		}));
		const widget = store.add(new VoltMenuWidget<T>(host, submenu, {
			hide: this.context.hide,
			relayout: () => this.placeFlyout(host, row),
			pick: this.context.pick,
			ariaLabel: item.label,
			idle: !focus,
			back: () => {
				this.closeFlyout();
				this.focus();
			},
			prompt: prompt => {
				this.closeFlyout();
				this.startPrompt(prompt);
			},
		}));
		this.flyoutWidget = widget;
		this.flyout.value = store;
		this.placeFlyout(host, row);
		if (!focus) {
			// A hover-opened flyout leaves focus in this menu's search field.
			scheduleAtNextAnimationFrame(getWindow(this.root), () => this.focus());
		}
	}

	private closeFlyout(): void {
		if (this.flyoutTimer) {
			clearTimeout(this.flyoutTimer);
			this.flyoutTimer = undefined;
		}
		this.flyoutItem = undefined;
		this.flyout.clear();
	}

	/** Beside the row, overlapping this menu slightly; flipped to the left, or over the menu, when the window is too narrow. */
	private placeFlyout(host: HTMLElement, row: HTMLElement): void {
		const hostRect = this.host.getBoundingClientRect();
		const menuRect = this.root.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const menu = host.firstElementChild;
		const width = isHTMLElement(menu) ? menu.offsetWidth : 0;
		const height = isHTMLElement(menu) ? menu.offsetHeight : 0;
		const win = getWindow(this.root);
		// Right of the menu, else left of it; with no room on either side, inside the window over the menu.
		const right = menuRect.right - 4;
		let left = right;
		if (right + width > win.innerWidth - 8) {
			left = menuRect.left - width + 4 >= 8 ? menuRect.left - width + 4 : Math.max(8, win.innerWidth - 8 - width);
		}
		const top = Math.max(8, Math.min(rowRect.top - 1, win.innerHeight - height - 8));
		host.style.left = `${left - hostRect.left}px`;
		host.style.top = `${top - hostRect.top}px`;
	}

	// ---- Prompt ---------------------------------------------------------------------------

	private startPrompt(prompt: IVoltMenuPrompt): void {
		const input = this.input;
		if (!input) {
			return;
		}
		this.closeFlyout();
		const initial = prompt.useQuery ? this.query : '';
		this.prompting = { prompt, submitting: false };
		this.root.classList.add('prompting');
		this.footerHost.classList.add('hidden');
		input.setPlaceHolder(prompt.placeholder);
		input.inputElement.setAttribute('aria-label', prompt.placeholder);
		input.value = initial;
		this.renderPrompt();
		input.focus();
	}

	private renderPrompt(): void {
		const prompting = this.prompting;
		if (!prompting) {
			return;
		}
		const value = this.input?.value.trim() ?? '';
		const problem = prompting.error ?? (value ? prompting.prompt.validate?.(value) : undefined);
		const text = problem
			?? (prompting.submitting ? localize('voltMenu.working', "Working...") : undefined)
			?? prompting.prompt.hint
			?? localize('voltMenu.promptHint', "Press Enter to confirm or Escape to cancel");
		this.showRows([{ kind: 'message', id: 'prompt', text, error: !!problem }]);
		this.setActive(-1, false);
		scheduleAtNextAnimationFrame(getWindow(this.root), () => this.context.relayout());
	}

	private async submitPrompt(): Promise<void> {
		const prompting = this.prompting;
		const value = this.input?.value.trim() ?? '';
		if (!prompting || prompting.submitting || !value || prompting.prompt.validate?.(value)) {
			return;
		}
		prompting.submitting = true;
		this.renderPrompt();
		try {
			await prompting.prompt.onSubmit(value);
		} catch (err) {
			if (this.prompting === prompting) {
				prompting.submitting = false;
				prompting.error = err instanceof Error ? err.message : String(err);
				this.renderPrompt();
			}
			return;
		}
		this.context.hide();
	}

	private endPrompt(): void {
		const input = this.input;
		if (!this.prompting || !input) {
			return;
		}
		this.prompting = undefined;
		this.root.classList.remove('prompting');
		this.footerHost.classList.toggle('hidden', !this.footerRows.length);
		const placeholder = this.options.search?.placeholder ?? '';
		input.setPlaceHolder(placeholder);
		input.inputElement.setAttribute('aria-label', this.options.search?.ariaLabel ?? placeholder);
		input.value = '';
		this.render();
	}
}

function rowHeight<T>(row: Row<T>): number {
	switch (row.kind) {
		case 'header': return HEADER_HEIGHT;
		case 'separator': return SEPARATOR_HEIGHT;
		case 'item': return row.item.subtitle ? TWO_LINE_ROW_HEIGHT : ROW_HEIGHT;
		default: return ROW_HEIGHT;
	}
}

class RowDelegate<T> implements IListVirtualDelegate<Row<T>> {
	getHeight(row: Row<T>): number {
		return rowHeight(row);
	}
	getTemplateId(row: Row<T>): string {
		return row.kind;
	}
}

class ItemRenderer<T> implements IListRenderer<Row<T>, HTMLElement> {
	readonly templateId = 'item';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-row.volt-menu-item'));
	}

	renderElement(row: Row<T>, _index: number, element: HTMLElement): void {
		if (row.kind !== 'item') {
			return;
		}
		clearNode(element);
		element.classList.toggle('disabled', !!row.item.disabled);
		element.classList.toggle('checked', !!row.item.checked);
		renderItem(element, row.item, row.matches);
	}

	disposeTemplate(): void { }
}

function renderItem<T>(host: HTMLElement, item: IVoltMenuItem<T>, matches: IMatch[] | undefined): void {
	const icon = append(host, $('span.volt-menu-icon'));
	if (item.busy) {
		icon.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
	} else if (typeof item.icon === 'function') {
		icon.appendChild(item.icon());
	} else if (item.icon) {
		icon.appendChild(renderIcon(item.icon));
	} else {
		icon.classList.add('empty');
	}
	host.classList.toggle('two-line', !!item.subtitle);
	// Two-line rows stack the label line over the subtitle; one-line rows lay it out in the row.
	const text = item.subtitle ? append(host, $('span.volt-menu-text')) : undefined;
	const line = text ? append(text, $('span.volt-menu-line')) : host;
	const label = new HighlightedLabel(append(line, $('span.volt-menu-label')));
	label.set(item.label, matches);
	if (item.description) {
		// Marked left-to-right so a path keeps its slashes in place while it ellipsizes on the left.
		append(line, $('span.volt-menu-description')).textContent = `\u200e${item.description}\u200e`;
	}
	if (item.stats && (item.stats.additions > 0 || item.stats.deletions > 0)) {
		const stats = append(line, $('span.volt-menu-stats'));
		if (item.stats.additions > 0) {
			append(stats, $('span.add')).textContent = `+${item.stats.additions}`;
		}
		if (item.stats.deletions > 0) {
			append(stats, $('span.del')).textContent = `-${item.stats.deletions}`;
		}
	}
	if (item.detail) {
		append(line, $('span.volt-menu-detail')).textContent = item.detail;
	}
	if (text) {
		append(text, $('span.volt-menu-subtitle')).textContent = item.subtitle!;
	} else {
		append(host, $('span.volt-menu-spacer'));
	}
	if (item.keybinding) {
		append(host, $('span.volt-menu-keybinding')).textContent = item.keybinding;
	}
	const trailing = item.submenu ? Codicon.chevronRight : item.checked ? Codicon.check : item.trailingIcon;
	if (trailing) {
		append(host, $('span.volt-menu-trailing')).appendChild(renderIcon(trailing));
	}
	host.title = item.tooltip ?? '';
}

class HeaderRenderer<T> implements IListRenderer<Row<T>, HTMLElement> {
	readonly templateId = 'header';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-header'));
	}

	renderElement(row: Row<T>, _index: number, element: HTMLElement): void {
		if (row.kind !== 'header') {
			return;
		}
		clearNode(element);
		append(element, $('span.title')).textContent = row.title;
		element.classList.toggle('collapsible', row.collapsible);
		if (row.collapsible) {
			element.appendChild(renderIcon(row.collapsed ? Codicon.chevronRight : Codicon.chevronDown)).classList.add('chevron');
		}
	}

	disposeTemplate(): void { }
}

class SeparatorRenderer<T> implements IListRenderer<Row<T>, HTMLElement> {
	readonly templateId = 'separator';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-separator'));
	}

	renderElement(): void { }

	disposeTemplate(): void { }
}

class MessageRenderer<T> implements IListRenderer<Row<T>, HTMLElement> {
	readonly templateId = 'message';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-menu-message'));
	}

	renderElement(row: Row<T>, _index: number, element: HTMLElement): void {
		element.textContent = row.kind === 'message' ? row.text : '';
		element.title = element.textContent;
		element.classList.toggle('error', row.kind === 'message' && !!row.error);
	}

	disposeTemplate(): void { }
}
