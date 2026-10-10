/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSlashMenu.css';
import { $, addDisposableListener, append, getDomNodePagePosition, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition, IAnchor } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IMatch, matchesFuzzy } from '../../../../../base/common/filters.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { VOLT_BUILTIN_COMMANDS, VOLT_BUILTIN_SKILLS } from '../../../../services/voltRuntime/common/skills/voltBuiltinSkills.js';
import { IAgentCustomizeService, IAgentSlashItem } from '../customize/agentCustomizeService.js';
import { createSlashIcon, renderSkillCard } from './agentSkillHoverCard.js';

/** Space between the composer and the menu. */
const ANCHOR_GAP = 6;
/** Width when there is no composer to line up with (menu at the cursor). */
const CURSOR_MENU_WIDTH = 420;
const ROW_HEIGHT = 29;
/** Vertical padding inside the menu, above the first and below the last row. */
const LIST_PADDING = 6;
/** Nine and a half rows: the half row says there is more below. */
const MAX_LIST_HEIGHT = Math.round(ROW_HEIGHT * 9.5) + LIST_PADDING;
const CARD_GAP = 8;
const EDGE = 8;
/** Characters kept before a description match, after the "...". */
const SNIPPET_LEAD = 22;

/** One row of the menu: the entry, and what to draw for it. */
export interface IAgentSlashMenuRow {
	readonly item: IAgentSlashItem;
	readonly nameMatches?: readonly IMatch[];
	/** The dimmed text after the name: the summary, or a snippet of the description around a match. */
	readonly summary: string;
	readonly summaryMatches?: readonly IMatch[];
}

function builtinOrder(item: IAgentSlashItem): number {
	if (!item.builtin) {
		return Number.MAX_SAFE_INTEGER;
	}
	if (item.type === 'builtin-command') {
		return VOLT_BUILTIN_COMMANDS.findIndex(command => command.id === item.command);
	}
	const index = VOLT_BUILTIN_SKILLS.findIndex(skill => skill.name === item.name);
	return VOLT_BUILTIN_COMMANDS.length + (index < 0 ? 0 : index);
}

/** Every case-insensitive occurrence of each word in `text`, merged and in order. */
function occurrences(text: string, words: readonly string[]): IMatch[] {
	const lower = text.toLowerCase();
	const found: IMatch[] = [];
	for (const word of words) {
		if (!word) {
			continue;
		}
		let from = 0;
		while (from <= lower.length - word.length) {
			const index = lower.indexOf(word, from);
			if (index < 0) {
				break;
			}
			found.push({ start: index, end: index + word.length });
			from = index + word.length;
		}
	}
	found.sort((a, b) => a.start - b.start);
	const merged: IMatch[] = [];
	for (const match of found) {
		const last = merged[merged.length - 1];
		if (last && match.start <= last.end) {
			merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, match.end) };
		} else {
			merged.push(match);
		}
	}
	return merged;
}

/**
 * Filters and orders the entries for `query`: exact and prefix name matches first, then names
 * containing it, then fuzzy name matches, then entries whose description mentions every word of
 * it. Within a tier, Volt's built-ins come first in their own order, then the rest by name.
 * `summaryOf` lets the composer replace a summary (the `/model` row shows the current model).
 */
export function rankSlashItems(items: readonly IAgentSlashItem[], query: string, summaryOf: (item: IAgentSlashItem) => string = item => item.summary): IAgentSlashMenuRow[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return [...items]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(item => ({ item, summary: summaryOf(item) }));
	}
	const words = q.split(/[-_\s/]+/).filter(Boolean);
	const scored: { row: IAgentSlashMenuRow; tier: number }[] = [];
	for (const item of items) {
		const name = item.name.toLowerCase();
		let tier = -1;
		let nameMatches: IMatch[] | undefined;
		const index = name.indexOf(q);
		if (name === q) {
			tier = 6;
		} else if (index === 0) {
			tier = 5;
		} else if (index > 0 && /[-_.]/.test(name.charAt(index - 1))) {
			// At a word start inside the name: `model` in `multi-model-review`.
			tier = 4;
		} else if (index > 0) {
			tier = 3;
		}
		if (tier >= 0) {
			nameMatches = [{ start: index, end: index + q.length }];
		} else {
			const fuzzy = matchesFuzzy(q, item.name, false);
			if (fuzzy) {
				tier = 2;
				nameMatches = fuzzy;
			}
		}
		const summary = summaryOf(item);
		if (tier >= 0) {
			const summaryMatches = occurrences(summary, [q]);
			scored.push({ row: { item, nameMatches, summary, summaryMatches: summaryMatches.length ? summaryMatches : undefined }, tier });
			continue;
		}
		const description = item.description || summary;
		const lower = description.toLowerCase();
		if (!words.length || !words.every(word => lower.includes(word))) {
			continue;
		}
		const matches = occurrences(description, words);
		const first = matches[0]?.start ?? 0;
		// A match deep in a long description: show the words around it, like Cursor's "...g tasks, debugging".
		const cut = first > SNIPPET_LEAD + 8 ? first - SNIPPET_LEAD : 0;
		const prefix = cut ? '...' : '';
		const snippet = `${prefix}${description.slice(cut)}`;
		const shift = prefix.length - cut;
		scored.push({
			row: {
				item,
				summary: snippet,
				summaryMatches: matches.map(match => ({ start: match.start + shift, end: match.end + shift })).filter(match => match.start >= prefix.length),
			},
			tier: 1,
		});
	}
	return scored
		.sort((a, b) => b.tier - a.tier
			|| builtinOrder(a.row.item) - builtinOrder(b.row.item)
			|| a.row.item.name.localeCompare(b.row.item.name))
		.map(entry => entry.row);
}

/** Writes `text` into `element` with the matched ranges wrapped in `.highlight`. */
function renderHighlighted(element: HTMLElement, text: string, matches: readonly IMatch[] | undefined): void {
	element.replaceChildren();
	if (!matches?.length) {
		element.textContent = text;
		return;
	}
	let cursor = 0;
	for (const match of matches) {
		const start = Math.max(cursor, Math.min(match.start, text.length));
		const end = Math.min(text.length, match.end);
		if (end <= start) {
			continue;
		}
		if (start > cursor) {
			element.appendChild(element.ownerDocument.createTextNode(text.slice(cursor, start)));
		}
		append(element, $('span.highlight')).textContent = text.slice(start, end);
		cursor = end;
	}
	if (cursor < text.length) {
		element.appendChild(element.ownerDocument.createTextNode(text.slice(cursor)));
	}
}

export interface IAgentSlashMenuOptions {
	/** The composer box; the menu spans its width. Absent: the menu opens at the cursor. */
	readonly anchor: () => HTMLElement | undefined;
	readonly cursor: () => IAnchor;
	/** A row was picked. `asMode`: Alt+Enter, keep it on for every message. */
	readonly pick: (item: IAgentSlashItem, asMode: boolean) => void;
	readonly onDidHide: () => void;
}

interface IMenuView {
	readonly host: HTMLElement;
	readonly menu: HTMLElement;
	readonly list: HTMLElement;
	readonly card: HTMLElement;
	readonly width: number;
	rowElements: HTMLElement[];
}

/**
 * The `/` menu of the agent composer: skills, commands, subagents and rules, with Volt's built-in
 * commands and skills, under or over the composer like Cursor's. It never takes focus: the query
 * is the text typed after `/`, and the editor forwards Up / Down / Enter / Escape here. The card
 * beside the menu describes the focused entry.
 */
export class AgentSlashMenu extends Disposable {

	private visible = false;
	private rows: readonly IAgentSlashMenuRow[] = [];
	private focusedIndex = -1;
	private view: IMenuView | undefined;
	/** Plugin logos by plugin id once read; `null` while reading. */
	private readonly logos = new Map<string, string | undefined | null>();

	constructor(
		private readonly options: IAgentSlashMenuOptions,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
	) {
		super();
	}

	get isVisible(): boolean {
		return this.visible;
	}

	/** A press on a row moved focus into the menu. */
	get containsFocus(): boolean {
		const host = this.view?.host;
		return !!host && host.contains(host.ownerDocument.activeElement);
	}

	get hasSelection(): boolean {
		return this.focusedIndex >= 0 && this.focusedIndex < this.rows.length;
	}

	focusedItem(): IAgentSlashItem | undefined {
		return this.hasSelection ? this.rows[this.focusedIndex].item : undefined;
	}

	show(rows: readonly IAgentSlashMenuRow[]): void {
		const sameEntries = rows.length === this.rows.length && rows.every((row, index) => row.item.id === this.rows[index].item.id);
		const focusedId = this.focusedItem()?.id;
		this.rows = rows;
		this.focusedIndex = rows.length ? (sameEntries && focusedId ? Math.max(0, rows.findIndex(row => row.item.id === focusedId)) : 0) : -1;
		this.loadLogos();
		if (this.visible) {
			this.renderRows(true);
			this.contextViewService.layout();
			this.updateCard();
			return;
		}
		this.visible = true;
		this.contextViewService.showContextView({
			getAnchor: () => this.getAnchor(),
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.BELOW,
			render: container => this.render(container),
			onHide: () => {
				const wasVisible = this.visible;
				this.visible = false;
				this.view = undefined;
				if (wasVisible) {
					this.options.onDidHide();
				}
			},
		});
	}

	hide(): void {
		if (this.visible) {
			this.visible = false;
			this.view = undefined;
			this.contextViewService.hideContextView();
		}
	}

	move(delta: number): void {
		if (!this.rows.length) {
			return;
		}
		const count = this.rows.length;
		const next = this.focusedIndex < 0 ? (delta > 0 ? 0 : count - 1) : (this.focusedIndex + delta + count) % count;
		this.setFocus(next, true);
	}

	accept(asMode: boolean): void {
		const item = this.focusedItem();
		if (item) {
			this.options.pick(item, asMode && item.canUseAsMode);
		}
	}

	override dispose(): void {
		this.hide();
		super.dispose();
	}

	private getAnchor(): IAnchor {
		const element = this.options.anchor();
		if (!element?.isConnected) {
			return this.options.cursor();
		}
		const page = getDomNodePagePosition(element);
		// Grow the anchor by the gap so the menu keeps its distance whichever side the context view picks.
		return { x: page.left, y: page.top - ANCHOR_GAP, width: page.width, height: page.height + ANCHOR_GAP * 2 };
	}

	private render(container: HTMLElement): IDisposable {
		const store = new DisposableStore();
		const anchor = this.options.anchor();
		const width = anchor?.isConnected ? anchor.getBoundingClientRect().width : CURSOR_MENU_WIDTH;
		const host = append(container, $('.volt-agent-slash-host'));
		host.style.width = `${width}px`;
		const menu = append(host, $('.volt-agent-slash-menu'));
		menu.setAttribute('role', 'listbox');
		menu.setAttribute('aria-label', localize('voltAgent.slash.menu', "Skills and commands"));
		const list = append(menu, $('.volt-agent-slash-list'));
		const card = append(host, $('.volt-skill-card.side'));
		card.hidden = true;
		card.setAttribute('aria-hidden', 'true');
		this.view = { host, menu, list, card, width, rowElements: [] };

		// The composer keeps focus: nothing in the menu may take it on press.
		store.add(addDisposableListener(host, 'mousedown', e => e.preventDefault()));
		store.add(addDisposableListener(getWindow(container).document, 'mousedown', e => {
			if (!(e.target instanceof Node) || host.contains(e.target) || anchor?.contains(e.target)) {
				return;
			}
			this.hide();
		}, true));
		store.add(addDisposableListener(list, 'mousemove', e => {
			const row = isHTMLElement(e.target) ? e.target.closest<HTMLElement>('.volt-slash-row') : null;
			const index = row ? Number(row.dataset.index) : -1;
			if (index >= 0 && index !== this.focusedIndex) {
				this.setFocus(index, false);
			}
		}));
		store.add(addDisposableListener(list, 'click', e => {
			const row = isHTMLElement(e.target) ? e.target.closest<HTMLElement>('.volt-slash-row') : null;
			const index = row ? Number(row.dataset.index) : -1;
			const item = index >= 0 ? this.rows[index]?.item : undefined;
			if (item) {
				this.options.pick(item, e.altKey && item.canUseAsMode);
			}
		}));
		store.add(addDisposableListener(list, 'scroll', () => this.updateCard()));
		store.add(toDisposable(() => host.remove()));

		this.renderRows(true);
		// After the context view has placed the menu: the card goes beside the focused row.
		const frame = getWindow(container).requestAnimationFrame(() => this.updateCard());
		store.add(toDisposable(() => getWindow(container).cancelAnimationFrame(frame)));
		return store;
	}

	private renderRows(reveal: boolean): void {
		const view = this.view;
		if (!view) {
			return;
		}
		const document = view.list.ownerDocument;
		view.list.replaceChildren();
		view.rowElements = this.rows.map((row, index) => {
			const element = append(view.list, $('.volt-slash-row'));
			element.dataset.index = String(index);
			element.setAttribute('role', 'option');
			element.setAttribute('aria-label', [row.item.name, row.summary].filter(Boolean).join(', '));
			element.appendChild(createSlashIcon(row.item, this.logoFor(row.item), document));
			renderHighlighted(append(element, $('span.volt-slash-name')), row.item.name, row.nameMatches);
			if (row.summary) {
				renderHighlighted(append(element, $('span.volt-slash-summary')), row.summary, row.summaryMatches);
			}
			if (row.item.canUseAsMode) {
				const hint = append(element, $('span.volt-slash-hint'));
				hint.textContent = isMacintosh
					// allow-any-unicode-next-line
					? localize('voltAgent.slash.useAsModeMac', "⌥⏎ to Use as Mode")
					: localize('voltAgent.slash.useAsMode', "Alt+Enter to Use as Mode");
			}
			return element;
		});
		const height = Math.min(MAX_LIST_HEIGHT, this.rows.length * ROW_HEIGHT + LIST_PADDING);
		view.list.style.maxHeight = `${height}px`;
		this.applyFocus(reveal);
	}

	private setFocus(index: number, reveal: boolean): void {
		this.focusedIndex = index;
		this.applyFocus(reveal);
		this.updateCard();
	}

	private applyFocus(reveal: boolean): void {
		const view = this.view;
		if (!view) {
			return;
		}
		view.rowElements.forEach((element, index) => {
			const focused = index === this.focusedIndex;
			element.classList.toggle('focused', focused);
			element.setAttribute('aria-selected', String(focused));
		});
		const focused = view.rowElements[this.focusedIndex];
		if (!reveal || !focused) {
			return;
		}
		const top = focused.offsetTop;
		const bottom = top + focused.offsetHeight;
		if (top - LIST_PADDING / 2 < view.list.scrollTop) {
			view.list.scrollTop = Math.max(0, top - LIST_PADDING / 2);
		} else if (bottom + LIST_PADDING / 2 > view.list.scrollTop + view.list.clientHeight) {
			view.list.scrollTop = bottom + LIST_PADDING / 2 - view.list.clientHeight;
		}
	}

	/**
	 * Places the card beside the focused row. With the menu under the composer the card's bottom
	 * lines up with the row (it grows upward, toward the composer); over it, its top does.
	 */
	private updateCard(): void {
		const view = this.view;
		if (!view) {
			return;
		}
		const card = view.card;
		const row = this.rows[this.focusedIndex];
		const rowElement = view.rowElements[this.focusedIndex];
		if (!row || !rowElement) {
			card.hidden = true;
			return;
		}
		renderSkillCard(card, row.item, this.logoFor(row.item), 'side');
		card.hidden = false;
		const window = getWindow(card);
		const hostBox = view.host.getBoundingClientRect();
		const listBox = view.list.getBoundingClientRect();
		const rowBox = rowElement.getBoundingClientRect();
		const cardWidth = card.offsetWidth;
		const cardHeight = card.offsetHeight;
		let left: number;
		if (hostBox.right + CARD_GAP + cardWidth <= window.innerWidth - EDGE) {
			left = hostBox.width + CARD_GAP;
		} else if (hostBox.left - CARD_GAP - cardWidth >= EDGE) {
			left = -(cardWidth + CARD_GAP);
		} else {
			card.hidden = true;
			return;
		}
		// The row as seen through the list's scroll.
		const rowTop = Math.max(rowBox.top, listBox.top);
		const rowBottom = Math.min(rowBox.bottom, listBox.bottom);
		const anchor = this.options.anchor();
		const below = !anchor?.isConnected || hostBox.top >= anchor.getBoundingClientRect().top;
		let top = below ? rowBottom - cardHeight : rowTop;
		top = Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - cardHeight));
		card.style.left = `${Math.round(left)}px`;
		card.style.top = `${Math.round(top - hostBox.top)}px`;
	}

	private logoFor(item: IAgentSlashItem): string | undefined {
		return item.plugin ? this.logos.get(item.plugin.id) ?? undefined : undefined;
	}

	private loadLogos(): void {
		for (const { item } of this.rows) {
			const plugin = item.plugin;
			if (!plugin?.logo || this.logos.has(plugin.id)) {
				continue;
			}
			this.logos.set(plugin.id, null);
			void this.customize.pluginLogo(plugin).then(logo => {
				this.logos.set(plugin.id, logo);
				if (logo && this.visible) {
					this.renderRows(false);
					this.updateCard();
				}
			}, () => this.logos.set(plugin.id, undefined));
		}
	}
}
