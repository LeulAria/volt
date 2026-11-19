/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, isHTMLElement, isHTMLInputElement } from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltDropdown, IVoltDropdown, IVoltDropdownOptions } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { IVoltMenuSection, showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { IHttpKeyValue } from '../common/httpCollection.js';

/** On every menu the client opens: its corners are 3px, like its dropdowns. */
export const HTTP_MENU_CLASS = 'volt-http-menu';

/** Volt's dropdown as the HTTP client draws it: a 3px-cornered trigger and menu. */
export function createHttpDropdown<T extends string>(parent: HTMLElement, contextViewService: IContextViewService, options: IVoltDropdownOptions<T>, store: DisposableStore): IVoltDropdown<T> {
	return createVoltDropdown(parent, contextViewService, { ...options, menuClassName: HTTP_MENU_CLASS }, store);
}

/**
 * A row's or a tab's actions in Volt's own menu (not the system's): the separators between the
 * actions become the menu's dividers. `anchor` is the button that opened it, or where the pointer was.
 */
export function showHttpActionMenu(contextViewService: IContextViewService, anchor: HTMLElement | { readonly x: number; readonly y: number }, within: HTMLElement, actions: readonly IAction[], ariaLabel: string): IDisposable {
	const sections: IVoltMenuSection<IAction>[] = [];
	let items: { id: string; label: string; data: IAction; disabled?: boolean; className?: string }[] = [];
	const flush = () => {
		if (items.length) {
			sections.push({ id: `section${sections.length}`, items });
			items = [];
		}
	};
	for (const action of actions) {
		if (action instanceof Separator) {
			flush();
		} else {
			items.push({ id: action.id, label: action.label, data: action, ...(action.enabled ? {} : { disabled: true }), ...(/delete/i.test(action.id) ? { className: 'volt-http-menu-danger' } : {}) });
		}
	}
	flush();
	let point: HTMLElement | undefined;
	let target: HTMLElement;
	if (isHTMLElement(anchor)) {
		target = anchor;
	} else {
		// A right click has no button to hang the menu from: a 1px box where the pointer was stands in.
		point = target = append(within.ownerDocument.body, $('.volt-http-point-anchor'));
		point.style.left = `${anchor.x}px`;
		point.style.top = `${anchor.y}px`;
	}
	const menu = showVoltMenu<IAction>(contextViewService, {
		anchor: target,
		className: HTTP_MENU_CLASS,
		align: 'left',
		width: 200,
		ariaLabel,
		sections,
		onPick: item => void item.data.run(),
		onHide: () => point?.remove(),
	});
	return { dispose: () => { menu.dispose(); point?.remove(); } };
}

/** The variables in reach of a field, for colouring `{{names}}` and telling their values on hover. */
export type HttpVariableLookup = (() => ReadonlyMap<string, { readonly value: string; readonly source: string }> | undefined) & {
	/** Gives a variable a new value where it is defined; false when nothing defines it. Absent where values cannot be edited. */
	readonly update?: (name: string, value: string) => Promise<boolean>;
};

const DYNAMIC_VARIABLE = /^\$(?:guid|uuid|random\.uuid|timestamp|isoTimestamp|randomInt)\b/;
/** The built-in names offered after `{{` beside the project's own variables. */
const DYNAMIC_NAMES = ['$guid', '$timestamp', '$isoTimestamp', '$randomInt'];
const MAX_SUGGESTIONS = 50;

export interface IHttpVariableField {
	readonly element: HTMLElement;
	readonly input: HTMLInputElement;
	value: string;
	/** Colours the `{{names}}` again (the environment changed). */
	refresh(): void;
}

export interface IHttpVariableFieldOptions {
	readonly value: string;
	readonly placeholder?: string;
	readonly ariaLabel: string;
	/** A secret: masked, with an eye to show it. A value written as a `{{variable}}` is never masked. */
	readonly password?: boolean;
	readonly variables?: HttpVariableLookup;
	readonly onChange: (value: string) => void;
}

/**
 * A one-line field that colours `{{variables}}` as Postman does: known ones in the accent colour,
 * unknown ones in red. The text is drawn by a layer under a see-through input, and only while
 * the value has a variable in it, so a plain value is a plain input.
 */
export function createHttpVariableField(parent: HTMLElement, options: IHttpVariableFieldOptions, store: DisposableStore): IHttpVariableField {
	const element = append(parent, $('.volt-http-field-box'));
	const layer = append(element, $('.volt-http-field-layer'));
	layer.setAttribute('aria-hidden', 'true');
	const input = append(element, $('input.volt-http-field-input')) as HTMLInputElement;
	input.spellcheck = false;
	input.autocomplete = 'off';
	input.setAttribute('aria-label', options.ariaLabel);
	if (options.placeholder) {
		input.placeholder = options.placeholder;
	}
	input.value = options.value;
	let revealed = false;
	let eye: HTMLButtonElement | undefined;
	/** A secret is dots until it is shown or written as a variable: `{{token}}` is a name, not the secret. */
	const applyMask = () => {
		const masked = !!options.password && !revealed && !input.value.includes('{{');
		const type = masked ? 'password' : 'text';
		if (input.type !== type) {
			const start = input.selectionStart;
			const end = input.selectionEnd;
			input.type = type;
			if (input.ownerDocument.activeElement === input && start !== null && end !== null) {
				input.setSelectionRange(start, end);
			}
		}
		return masked;
	};
	const refresh = () => {
		const text = input.value;
		const masked = applyMask();
		// A variable's name is shown as it is: there is nothing for the eye to reveal.
		eye?.classList.toggle('hidden', text.includes('{{'));
		const marked = !masked && text.includes('{{');
		element.classList.toggle('has-variables', marked);
		clearNode(layer);
		setAgentTooltip(input, '');
		if (!marked) {
			return;
		}
		const known = options.variables?.();
		for (const part of text.split(/(\{\{[^{}]*\}\})/)) {
			if (!part) {
				continue;
			}
			const name = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(part)?.[1];
			if (name === undefined) {
				layer.appendChild(document.createTextNode(part));
				continue;
			}
			const found = known?.get(name);
			const dynamic = DYNAMIC_VARIABLE.test(name) || /\.response\.(?:body|headers)/.test(name);
			const span = append(layer, $('span.volt-http-variable'));
			span.textContent = part;
			span.classList.toggle('unresolved', !found && !dynamic && !!known);
			span.dataset.name = name;
		}
		layer.scrollLeft = input.scrollLeft;
	};
	if (options.password) {
		element.classList.add('secret');
		const button = eye = append(element, $('button.volt-http-field-eye')) as HTMLButtonElement;
		button.type = 'button';
		button.tabIndex = -1;
		const paint = () => {
			const label = revealed ? localize('voltHttp.hideSecret', "Hide") : localize('voltHttp.showSecret', "Show");
			setAgentTooltip(button, label);
			button.setAttribute('aria-label', label);
			button.setAttribute('aria-pressed', String(revealed));
			clearNode(button);
			button.appendChild(renderIcon(revealed ? Codicon.eyeClosed : Codicon.eye));
		};
		paint();
		// The press must not take the caret out of the field.
		button.addEventListener('mousedown', event => event.preventDefault());
		button.addEventListener('click', event => {
			event.stopPropagation();
			revealed = !revealed;
			paint();
			refresh();
		});
	}
	attachVariableHover(input, layer, options.variables, store);
	const suggest = attachVariableSuggest(input, options.variables, store, () => {
		refresh();
		options.onChange(input.value);
	});
	store.add(addDisposableListener(input, EventType.INPUT, () => {
		refresh();
		options.onChange(input.value);
		suggest.update();
	}));
	store.add(addDisposableListener(input, 'scroll', () => layer.scrollLeft = input.scrollLeft));
	refresh();
	return {
		element,
		input,
		get value() { return input.value; },
		set value(next: string) {
			if (input.value !== next) {
				input.value = next;
				refresh();
			}
		},
		refresh,
	};
}

const VARIABLE_HOVER_DELAY = 350;
const VARIABLE_LEAVE_DELAY = 250;

/**
 * Postman's variable card: resting the pointer on a `{{name}}` shows its value and where it comes
 * from, in a card under the field. The value can be changed there (Enter or leaving the box saves
 * it where the variable is defined; Escape gives up). The field's input lies over the coloured
 * names, so the name under the pointer is found by its box.
 */
function attachVariableHover(input: HTMLInputElement, layer: HTMLElement, variables: HttpVariableLookup | undefined, store: DisposableStore): void {
	let card: HTMLElement | undefined;
	let shownFor: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cardStore = store.add(new DisposableStore());
	const cancel = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	const close = () => {
		cancel();
		cardStore.clear();
		card?.remove();
		card = undefined;
		shownFor = undefined;
	};
	const closeSoon = () => {
		cancel();
		timer = setTimeout(() => {
			// A value being typed keeps its card until the box is left.
			if (card && !card.contains(card.ownerDocument.activeElement)) {
				close();
			}
		}, VARIABLE_LEAVE_DELAY);
	};
	const nameAt = (event: MouseEvent): HTMLElement | undefined => {
		if (input.type === 'password') {
			return undefined;
		}
		for (const span of layer.querySelectorAll<HTMLElement>('.volt-http-variable')) {
			const rect = span.getBoundingClientRect();
			if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top - 4 && event.clientY <= rect.bottom + 4) {
				return span;
			}
		}
		return undefined;
	};
	const show = (span: HTMLElement) => {
		const name = span.dataset.name ?? '';
		close();
		const found = variables?.()?.get(name);
		const dynamic = DYNAMIC_VARIABLE.test(name) || /\.response\.(?:body|headers)/.test(name);
		const box = card = append(input.closest<HTMLElement>('.monaco-workbench') ?? input.ownerDocument.body, $('.volt-http-variable-card'));
		shownFor = name;
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-label', localize('voltHttp.variableCard', "Variable {0}", name));
		const head = append(box, $('.volt-http-variable-card-head'));
		append(head, $('span.volt-http-variable-card-name')).textContent = name;
		append(head, $('span.volt-http-variable-card-source')).textContent = found ? found.source : dynamic ? localize('voltHttp.suggestDynamic', "Dynamic") : localize('voltHttp.variableNotSet', "Not set");
		if (found) {
			const value = append(box, $('input.volt-http-variable-card-value')) as HTMLInputElement;
			value.type = 'text';
			value.spellcheck = false;
			value.value = found.value;
			value.placeholder = localize('voltHttp.variableEmpty', "Empty");
			value.setAttribute('aria-label', localize('voltHttp.variableValue', "Value of {0}", name));
			const update = variables?.update;
			value.readOnly = !update;
			const note = append(box, $('.volt-http-variable-card-note'));
			const idle = update ? localize('voltHttp.variableEditHint', "Edit the value and press Enter to save it.") : '';
			note.textContent = idle;
			let saved = found.value;
			const save = async () => {
				if (!update || value.value === saved) {
					return;
				}
				const next = value.value;
				try {
					const done = await update(name, next);
					saved = done ? next : saved;
					note.textContent = done ? localize('voltHttp.variableSaved', "Saved to {0}.", found.source) : localize('voltHttp.variableNotSaved', "This value is set by a script and is not kept in a file.");
				} catch (err) {
					note.textContent = err instanceof Error ? err.message : String(err);
				}
			};
			cardStore.add(addDisposableListener(value, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				event.stopPropagation();
				if (event.key === 'Enter') {
					event.preventDefault();
					void save();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					close();
					input.focus();
				}
			}));
			cardStore.add(addDisposableListener(value, EventType.INPUT, () => note.textContent = value.value === saved ? idle : localize('voltHttp.variableEnterToSave', "Press Enter to save, Escape to cancel.")));
			cardStore.add(addDisposableListener(value, EventType.BLUR, () => void save().then(() => closeSoon())));
		} else {
			append(box, $('.volt-http-variable-card-note')).textContent = dynamic
				? localize('voltHttp.variableDynamic', "Made fresh for every send.")
				: localize('voltHttp.variableUnresolved', "{0} is not set in the collection or the selected environment", name);
		}
		cardStore.add(addDisposableListener(box, EventType.MOUSE_ENTER, cancel));
		cardStore.add(addDisposableListener(box, EventType.MOUSE_LEAVE, closeSoon));
		const view = input.ownerDocument.defaultView;
		const at = span.getBoundingClientRect();
		const field = input.getBoundingClientRect();
		const width = 280;
		box.style.width = `${width}px`;
		box.style.left = `${Math.max(4, Math.min(Math.max(at.left, field.left), (view?.innerWidth ?? width) - width - 4))}px`;
		const height = box.offsetHeight;
		box.style.top = (view?.innerHeight ?? 0) - field.bottom >= height + 8 || field.top < height + 8 ? `${field.bottom + 4}px` : `${field.top - height - 4}px`;
	};
	store.add(addDisposableListener(input, EventType.MOUSE_MOVE, (event: MouseEvent) => {
		const span = nameAt(event);
		if (!span) {
			if (card) {
				closeSoon();
			} else {
				cancel();
			}
			return;
		}
		if (card && shownFor === span.dataset.name) {
			cancel();
			return;
		}
		cancel();
		timer = setTimeout(() => show(span), VARIABLE_HOVER_DELAY);
	}));
	store.add(addDisposableListener(input, EventType.MOUSE_LEAVE, () => card ? closeSoon() : cancel()));
	// Typing in the field is not reading a value: the card steps aside.
	store.add(addDisposableListener(input, EventType.INPUT, close));
	store.add(toDisposable(close));
}

interface IVariableSuggestion {
	readonly name: string;
	readonly value: string;
	readonly source: string;
}

/**
 * Postman's variable list: typing `{{` in a field offers the variables in reach (and the built-in
 * dynamic ones), narrowed as the name is typed. Up/Down choose, Enter or Tab inserts `{{name}}`,
 * Escape closes. The list hangs under the field from the window's body, so no pane clips it.
 */
function attachVariableSuggest(input: HTMLInputElement, variables: HttpVariableLookup | undefined, store: DisposableStore, changed: () => void): { update(): void } {
	let popup: HTMLElement | undefined;
	let items: IVariableSuggestion[] = [];
	let active = 0;
	let range: { start: number; end: number } | undefined;
	const close = () => {
		popup?.remove();
		popup = undefined;
		range = undefined;
	};
	/** The `{{` the caret is typing a name after, when it is not closed yet. */
	const context = (): { start: number; end: number; typed: string } | undefined => {
		if (input.type === 'password' || input.ownerDocument.activeElement !== input) {
			return undefined;
		}
		const caret = input.selectionStart;
		if (caret === null || caret !== input.selectionEnd) {
			return undefined;
		}
		const before = input.value.slice(0, caret);
		const open = before.lastIndexOf('{{');
		if (open < 0) {
			return undefined;
		}
		const typed = before.slice(open + 2);
		if (/[{}]/.test(typed) || typed.length > 60) {
			return undefined;
		}
		return { start: open, end: caret, typed: typed.trim() };
	};
	const accept = (index: number) => {
		const item = items[index];
		if (!item || !range) {
			return;
		}
		const value = input.value;
		// A name being replaced runs to its closing braces when they are there already.
		const rest = value.slice(range.end);
		const closing = /^[^{}]*\}\}/.exec(rest);
		const after = closing ? rest.slice(closing[0].length) : rest;
		const insert = `{{${item.name}}}`;
		input.value = value.slice(0, range.start) + insert + after;
		const caret = range.start + insert.length;
		input.setSelectionRange(caret, caret);
		close();
		changed();
	};
	const paint = () => {
		if (!popup) {
			return;
		}
		clearNode(popup);
		items.forEach((item, index) => {
			const row = append(popup!, $('.volt-http-suggest-row'));
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', String(index === active));
			row.classList.toggle('active', index === active);
			append(row, $('span.volt-http-suggest-name')).textContent = item.name;
			append(row, $('span.volt-http-suggest-value')).textContent = item.value;
			append(row, $('span.volt-http-suggest-source')).textContent = item.source;
			// The press must not blur the field: the pick is made on it.
			row.addEventListener('mousedown', event => {
				event.preventDefault();
				accept(index);
			});
			if (index === active) {
				row.scrollIntoView({ block: 'nearest' });
			}
		});
	};
	const place = () => {
		if (!popup) {
			return;
		}
		const view = input.ownerDocument.defaultView;
		const rect = input.getBoundingClientRect();
		const width = Math.max(260, Math.min(420, rect.width));
		const height = Math.min(items.length, 8) * 26 + 8;
		const below = (view?.innerHeight ?? 0) - rect.bottom;
		popup.style.width = `${width}px`;
		popup.style.left = `${Math.max(4, Math.min(rect.left, (view?.innerWidth ?? width) - width - 4))}px`;
		popup.style.top = below >= height + 6 || rect.top < height + 6 ? `${rect.bottom + 3}px` : `${rect.top - height - 3}px`;
	};
	const update = () => {
		const found = context();
		if (!found) {
			close();
			return;
		}
		const known = variables?.();
		const needle = found.typed.toLowerCase();
		const all: IVariableSuggestion[] = [
			...(known ? [...known].map(([name, entry]) => ({ name, value: entry.value, source: entry.source })) : []),
			...DYNAMIC_NAMES.map(name => ({ name, value: '', source: localize('voltHttp.suggestDynamic', "Dynamic") })),
		];
		items = all
			.filter(item => item.name.toLowerCase().includes(needle))
			.sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)) || a.name.localeCompare(b.name))
			.slice(0, MAX_SUGGESTIONS);
		if (!items.length) {
			close();
			return;
		}
		range = { start: found.start, end: found.end };
		active = Math.min(active, items.length - 1);
		if (!popup) {
			// Inside the workbench, not the body: the theme's colours and the UI font are set on it.
			const host = input.closest<HTMLElement>('.monaco-workbench') ?? input.ownerDocument.body;
			popup = append(host, $('.volt-http-suggest'));
			popup.setAttribute('role', 'listbox');
			popup.setAttribute('aria-label', localize('voltHttp.suggestVariables', "Variables"));
			active = 0;
		}
		paint();
		place();
	};
	store.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
		if (!popup) {
			return;
		}
		const handled = () => {
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		switch (event.key) {
			case 'ArrowDown': handled(); active = (active + 1) % items.length; paint(); break;
			case 'ArrowUp': handled(); active = (active - 1 + items.length) % items.length; paint(); break;
			case 'Enter':
			case 'Tab': handled(); accept(active); break;
			case 'Escape': handled(); close(); break;
		}
	}, true));
	// The caret moved without typing (arrows, a click): the list follows it or closes.
	store.add(addDisposableListener(input, EventType.KEY_UP, (event: KeyboardEvent) => {
		if (popup && (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End')) {
			update();
		}
	}));
	store.add(addDisposableListener(input, EventType.MOUSE_UP, () => popup && update()));
	store.add(addDisposableListener(input, EventType.BLUR, () => close()));
	store.add(toDisposable(close));
	return { update };
}

/** A square check box drawn in the theme's colours. */
export function createHttpCheck(parent: HTMLElement, checked: boolean, label: string, onChange: (checked: boolean) => void): { readonly element: HTMLButtonElement; checked: boolean } {
	const element = append(parent, $('button.volt-http-check')) as HTMLButtonElement;
	element.type = 'button';
	element.setAttribute('role', 'checkbox');
	element.setAttribute('aria-label', label);
	element.appendChild(renderIcon(Codicon.check));
	const set = (next: boolean) => {
		element.setAttribute('aria-checked', String(next));
		element.classList.toggle('checked', next);
	};
	set(checked);
	element.addEventListener('click', () => {
		const next = element.getAttribute('aria-checked') !== 'true';
		set(next);
		onChange(next);
	});
	return {
		element,
		get checked() { return element.getAttribute('aria-checked') === 'true'; },
		set checked(next: boolean) { set(next); },
	};
}

/** A small icon-only button (the tables' delete, the toolbars' actions). */
export function createHttpIconButton(parent: HTMLElement, icon: ThemeIcon | (() => Element), title: string, run: (element: HTMLButtonElement, event: MouseEvent) => void): HTMLButtonElement {
	const button = append(parent, $('button.volt-http-icon-button')) as HTMLButtonElement;
	button.type = 'button';
	// Volt's own tooltip, not the system's: the same card as everywhere else in the window.
	setAgentTooltip(button, title);
	button.setAttribute('aria-label', title);
	button.appendChild(ThemeIcon.isThemeIcon(icon) ? renderIcon(icon) : icon());
	button.addEventListener('click', event => {
		event.stopPropagation();
		run(button, event);
	});
	return button;
}

/**
 * A quiet button of a tab's head (Analyze with AI, Triage with AI): its mark, then its name. In a
 * tight head the name goes and the mark stays, with the name as the tooltip.
 */
export function decorateHttpHeadButton(button: { readonly element: HTMLElement }, icon: Element, label: string): void {
	const element = button.element;
	element.classList.add('volt-http-head-button');
	setAgentTooltip(element, label);
	element.setAttribute('aria-label', label);
	const name = $('span');
	name.textContent = label;
	element.replaceChildren(icon, name);
}

export interface IHttpTabSpec<T extends string> {
	readonly id: T;
	readonly label: string;
	/** A small mark before the name (Docs). */
	readonly icon?: ThemeIcon;
	/** A green dot: the tab sends something. */
	readonly dot?: boolean;
	readonly count?: number;
	readonly badge?: { readonly text: string; readonly kind: 'ok' | 'error' };
}

/** Postman's underlined tabs, with a dot or count on the ones that carry something. */
const overflowWatched = new WeakSet<HTMLElement>();

/**
 * A strip that scrolls sideways (tabs, the script bar) fades at an end that has more behind it,
 * so a name cut by the pane's edge reads as "more this way" instead of a broken word.
 */
export function watchHttpOverflow(strip: HTMLElement): void {
	if (overflowWatched.has(strip)) {
		return;
	}
	overflowWatched.add(strip);
	const update = () => {
		strip.classList.toggle('more-start', strip.scrollLeft > 1);
		strip.classList.toggle('more-end', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
	};
	strip.addEventListener('scroll', update, { passive: true });
	// The observer lives and dies with the strip: nothing else holds either.
	const view = strip.ownerDocument.defaultView;
	if (view) {
		const observer = new view.ResizeObserver(update);
		observer.observe(strip);
		for (const child of strip.children) {
			observer.observe(child);
		}
	}
	update();
}

export function renderHttpTabs<T extends string>(parent: HTMLElement, tabs: readonly IHttpTabSpec<T>[], active: T, select: (id: T) => void): void {
	clearNode(parent);
	parent.setAttribute('role', 'tablist');
	watchHttpOverflow(parent);
	for (const tab of tabs) {
		const button = append(parent, $('button.volt-http-tab')) as HTMLButtonElement;
		button.type = 'button';
		button.classList.toggle('active', tab.id === active);
		button.setAttribute('role', 'tab');
		button.setAttribute('aria-selected', String(tab.id === active));
		if (tab.icon) {
			append(button, $('span.volt-http-tab-icon')).appendChild(renderIcon(tab.icon));
		}
		append(button, $('span')).textContent = tab.label;
		if (tab.count !== undefined) {
			append(button, $('span.volt-http-tab-count')).textContent = `(${tab.count})`;
		}
		if (tab.badge) {
			const badge = append(button, $('span.volt-http-tab-badge'));
			badge.classList.add(tab.badge.kind);
			badge.textContent = tab.badge.text;
		}
		if (tab.dot) {
			append(button, $('span.volt-http-tab-dot'));
		}
		button.addEventListener('click', () => select(tab.id));
	}
	// The tab in front is never the one cut by the pane's edge. Once now and once after layout:
	// what shares the row (a response's status) is often added after the tabs.
	const reveal = () => {
		const front = parent.querySelector<HTMLElement>('.volt-http-tab.active');
		if (front && parent.clientWidth) {
			const strip = parent.getBoundingClientRect();
			const tab = front.getBoundingClientRect();
			if (tab.left < strip.left + 16) {
				parent.scrollLeft -= strip.left + 16 - tab.left;
			} else if (tab.right > strip.right - 16) {
				parent.scrollLeft += tab.right - (strip.right - 16);
			}
		}
		// The fade at each end is told again.
		parent.dispatchEvent(new Event('scroll'));
	};
	reveal();
	parent.ownerDocument.defaultView?.requestAnimationFrame(reveal);
}

export interface IHttpTableOptions {
	readonly rows: readonly IHttpKeyValue[];
	readonly onChange: (rows: IHttpKeyValue[]) => void;
	readonly keyLabel?: string;
	readonly valueLabel?: string;
	/** A third column for a note on each row. */
	readonly description?: boolean;
	/** Each row picks Text or File (form-data); `pickFile` chooses the file. */
	readonly pickFile?: () => Promise<string | undefined>;
	/** The rows are given (path variables): no check boxes, no adding or removing, the keys are fixed. */
	readonly fixedKeys?: boolean;
	/** Rows can be marked secret: their values are masked (environments). */
	readonly secrets?: boolean;
	readonly bulkEdit?: boolean;
	readonly variables?: HttpVariableLookup;
}

/** The Key column's share of the key+value width, shared by every table so they line up. */
let keyShare = 0.34;

/**
 * Postman's key/value table. Rows are edited in place and never redrawn while typing (the caret
 * and focus stay put); a blank row at the end always waits for the next entry and becomes a real
 * row on its first character. Rows are reordered by their grip, columns resized by the divider,
 * and Bulk Edit swaps the table for `key:value` lines.
 */
export class HttpKeyValueTable extends Disposable {

	readonly element: HTMLElement;
	private readonly rows: IHttpKeyValue[];
	private readonly body: HTMLElement;
	private readonly rowStore = this._register(new DisposableStore());
	private bulk = false;
	private allCheck: { checked: boolean; element: HTMLElement } | undefined;
	private fields: IHttpVariableField[] = [];

	constructor(parent: HTMLElement, private readonly options: IHttpTableOptions) {
		super();
		this.rows = options.rows.map(row => ({ ...row }));
		this.element = append(parent, $('.volt-http-kv'));
		this.element.classList.toggle('with-description', !!options.description);
		this.element.classList.toggle('fixed', !!options.fixedKeys);
		this.applyShare();
		this.body = append(this.element, $('.volt-http-kv-body'));
		this.draw();
	}

	/** The Key and Value columns as shares of the room they split (a grid track cannot compute one from a number). */
	private applyShare(): void {
		this.element.style.setProperty('--volt-http-key-col', `${keyShare}fr`);
		this.element.style.setProperty('--volt-http-value-col', `${1 - keyShare}fr`);
	}

	/** Colours the `{{variables}}` again after the environment changed. */
	refreshVariables(): void {
		for (const field of this.fields) {
			field.refresh();
		}
	}

	private commit(): void {
		this.options.onChange(this.rows.filter(row => row.key || row.value || row.description).map(row => ({ ...row })));
	}

	private draw(): void {
		this.rowStore.clear();
		this.fields = [];
		clearNode(this.body);
		this.element.classList.toggle('bulk', this.bulk);
		if (this.bulk) {
			this.drawBulk();
			return;
		}
		const options = this.options;
		const head = append(this.body, $('.volt-http-tr.head'));
		head.setAttribute('role', 'row');
		const grip = append(head, $('.volt-http-td.grip'));
		grip.setAttribute('aria-hidden', 'true');
		const allCell = append(head, $('.volt-http-td.check'));
		this.allCheck = undefined;
		if (!options.fixedKeys) {
			this.allCheck = createHttpCheck(allCell, this.rows.length > 0 && this.rows.every(row => row.enabled), localize('voltHttp.toggleAll', "Enable all"), checked => {
				for (const row of this.rows) {
					row.enabled = checked;
				}
				this.commit();
				this.draw();
			});
			this.allCheck.element.classList.toggle('hidden', !this.rows.length);
		}
		const keyHead = append(head, $('.volt-http-td.label'));
		keyHead.textContent = options.keyLabel ?? localize('voltHttp.key', "Key");
		const divider = append(keyHead, $('.volt-http-col-resize'));
		setAgentTooltip(divider, localize('voltHttp.resizeColumn', "Drag to resize"));
		// Its line runs down the whole table, not only the head: the head's cell cannot know that height.
		const measure = () => divider.style.setProperty('--volt-http-col-line', `${this.body.clientHeight}px`);
		this.rowStore.add(addDisposableListener(divider, 'pointerenter', measure));
		this.rowStore.add(addDisposableListener(divider, EventType.POINTER_DOWN, (event: PointerEvent) => {
			measure();
			this.resize(event, divider);
		}));
		append(head, $('.volt-http-td.label')).textContent = options.valueLabel ?? localize('voltHttp.value', "Value");
		if (options.description) {
			append(head, $('.volt-http-td.label.description')).textContent = localize('voltHttp.description', "Description");
		}
		const tail = append(head, $('.volt-http-td.tail'));
		if (options.bulkEdit !== false && !options.fixedKeys) {
			const bulk = append(tail, $('button.volt-http-link.muted')) as HTMLButtonElement;
			bulk.type = 'button';
			bulk.textContent = localize('voltHttp.bulkEdit', "Bulk Edit");
			bulk.addEventListener('click', () => {
				this.bulk = true;
				this.draw();
			});
		}
		for (const row of this.rows) {
			this.drawRow(row, false);
		}
		if (!options.fixedKeys) {
			this.drawRow({ key: '', value: '', enabled: true }, true);
		}
	}

	private drawRow(row: IHttpKeyValue, blank: boolean): void {
		const options = this.options;
		const line = append(this.body, $('.volt-http-tr'));
		line.setAttribute('role', 'row');
		line.classList.toggle('disabled', !row.enabled);
		line.classList.toggle('blank', blank);
		const grip = append(line, $('.volt-http-td.grip'));
		const checkCell = append(line, $('.volt-http-td.check'));
		const keyCell = append(line, $('.volt-http-td.cell'));
		const valueCell = append(line, $('.volt-http-td.cell.value'));
		const descriptionCell = options.description ? append(line, $('.volt-http-td.cell.description')) : undefined;
		const tail = append(line, $('.volt-http-td.tail'));
		let live = !blank;

		/** What a real row has and the waiting blank row does not: its grip, check box and delete. */
		const dress = () => {
			if (options.fixedKeys) {
				return;
			}
			grip.appendChild(renderIcon(Codicon.gripper));
			grip.draggable = true;
			setAgentTooltip(grip, localize('voltHttp.dragRow', "Drag to reorder"));
			grip.addEventListener('dragstart', event => {
				event.dataTransfer?.setData('application/x-volt-http-row', String(this.rows.indexOf(row)));
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setDragImage(line, 12, 12);
				}
				line.classList.add('dragging');
			});
			grip.addEventListener('dragend', () => line.classList.remove('dragging'));
			createHttpCheck(checkCell, row.enabled, localize('voltHttp.enabled', "Enabled"), checked => {
				row.enabled = checked;
				line.classList.toggle('disabled', !checked);
				if (this.allCheck) {
					this.allCheck.checked = this.rows.every(item => item.enabled);
				}
				this.commit();
			});
			if (options.secrets) {
				const secret = createHttpIconButton(tail, row.secret ? Codicon.eyeClosed : Codicon.eye, localize('voltHttp.secret', "Mask the value"), button => {
					row.secret = !row.secret || undefined;
					valueField.input.type = row.secret ? 'password' : 'text';
					clearNode(button);
					button.appendChild(renderIcon(row.secret ? Codicon.eyeClosed : Codicon.eye));
					this.commit();
				});
				secret.classList.add('quiet');
			}
			const remove = createHttpIconButton(tail, Codicon.trash, localize('voltHttp.remove', "Remove"), () => {
				const at = this.rows.indexOf(row);
				if (at >= 0) {
					this.rows.splice(at, 1);
				}
				line.remove();
				if (this.allCheck) {
					this.allCheck.element.classList.toggle('hidden', !this.rows.length);
					this.allCheck.checked = this.rows.length > 0 && this.rows.every(item => item.enabled);
				}
				this.commit();
			});
			remove.classList.add('quiet');
		};

		const edited = () => {
			if (!live && (row.key || row.value || row.description)) {
				// The waiting row's first character makes it a row; a new blank one waits under it.
				live = true;
				this.rows.push(row);
				line.classList.remove('blank');
				dress();
				if (this.allCheck) {
					this.allCheck.element.classList.remove('hidden');
					this.allCheck.checked = this.rows.every(item => item.enabled);
				}
				this.drawRow({ key: '', value: '', enabled: true }, true);
			}
			this.commit();
		};

		const keyField = createHttpVariableField(keyCell, {
			value: row.key,
			placeholder: options.keyLabel ?? localize('voltHttp.key', "Key"),
			ariaLabel: options.keyLabel ?? localize('voltHttp.key', "Key"),
			variables: options.variables,
			onChange: value => {
				row.key = value;
				edited();
			},
		}, this.rowStore);
		keyField.input.readOnly = !!options.fixedKeys;
		const valueField = createHttpVariableField(valueCell, {
			value: row.value,
			placeholder: options.valueLabel ?? localize('voltHttp.value', "Value"),
			ariaLabel: options.valueLabel ?? localize('voltHttp.value', "Value"),
			password: !!row.secret,
			variables: options.variables,
			onChange: value => {
				row.value = value;
				edited();
			},
		}, this.rowStore);
		this.fields.push(keyField, valueField);
		if (options.pickFile) {
			const pickFile = options.pickFile;
			const kind = append(valueCell, $('button.volt-http-cell-kind')) as HTMLButtonElement;
			kind.type = 'button';
			const showKind = () => {
				kind.textContent = row.type === 'file' ? localize('voltHttp.partFile', "File") : localize('voltHttp.partText', "Text");
				valueField.input.placeholder = row.type === 'file' ? localize('voltHttp.partFilePath', "Path to a file") : localize('voltHttp.value', "Value");
			};
			showKind();
			setAgentTooltip(kind, localize('voltHttp.partKind', "Switch between text and a file"));
			kind.addEventListener('click', async () => {
				if (row.type === 'file') {
					row.type = undefined;
				} else {
					row.type = 'file';
					const path = await pickFile();
					if (path !== undefined) {
						row.value = path;
						valueField.value = path;
					}
				}
				showKind();
				edited();
			});
		}
		if (descriptionCell) {
			const description = append(descriptionCell, $('input.volt-http-field-input.plain')) as HTMLInputElement;
			description.type = 'text';
			description.placeholder = localize('voltHttp.description', "Description");
			description.setAttribute('aria-label', localize('voltHttp.description', "Description"));
			description.value = row.description ?? '';
			description.addEventListener('input', () => {
				row.description = description.value || undefined;
				edited();
			});
		}
		// Enter moves down the column, as in a spreadsheet.
		line.addEventListener('keydown', event => {
			const target = event.target;
			if (event.key !== 'Enter' || !isHTMLInputElement(target)) {
				return;
			}
			const inputs = [...line.querySelectorAll<HTMLInputElement>('input')];
			const next = line.nextElementSibling?.querySelectorAll<HTMLInputElement>('input')[inputs.indexOf(target)];
			if (next) {
				event.preventDefault();
				next.focus();
			}
		});
		line.addEventListener('dragover', event => {
			if (live && event.dataTransfer?.types.includes('application/x-volt-http-row')) {
				event.preventDefault();
				const rect = line.getBoundingClientRect();
				line.classList.toggle('drop-before', event.clientY < rect.top + rect.height / 2);
				line.classList.toggle('drop-after', event.clientY >= rect.top + rect.height / 2);
			}
		});
		line.addEventListener('dragleave', () => line.classList.remove('drop-before', 'drop-after'));
		line.addEventListener('drop', event => {
			const from = Number(event.dataTransfer?.getData('application/x-volt-http-row'));
			const after = line.classList.contains('drop-after');
			line.classList.remove('drop-before', 'drop-after');
			const to = this.rows.indexOf(row);
			if (!Number.isInteger(from) || from < 0 || from >= this.rows.length || to < 0) {
				return;
			}
			event.preventDefault();
			const [moved] = this.rows.splice(from, 1);
			let at = this.rows.indexOf(row) + (after ? 1 : 0);
			at = Math.max(0, Math.min(at, this.rows.length));
			this.rows.splice(at, 0, moved);
			this.commit();
			this.draw();
		});
		if (live) {
			dress();
		}
	}

	private drawBulk(): void {
		const head = append(this.body, $('.volt-http-bulk-head'));
		append(head, $('span')).textContent = localize('voltHttp.bulkHint', "One row per line as key:value. Start a line with // to turn it off.");
		const back = append(head, $('button.volt-http-link')) as HTMLButtonElement;
		back.type = 'button';
		back.textContent = localize('voltHttp.keyValueEdit', "Key-Value Edit");
		const area = append(this.body, $('textarea.volt-http-bulk')) as HTMLTextAreaElement;
		area.spellcheck = false;
		area.setAttribute('aria-label', localize('voltHttp.bulkEdit', "Bulk Edit"));
		area.value = this.rows.map(row => `${row.enabled ? '' : '//'}${row.key}:${row.value}`).join('\n');
		area.addEventListener('input', () => {
			const before = this.rows.splice(0, this.rows.length);
			for (const row of parseHttpBulk(area.value)) {
				const known = before.find(item => item.key === row.key && item.description);
				this.rows.push(known?.description ? { ...row, description: known.description } : row);
			}
			this.commit();
		});
		back.addEventListener('click', () => {
			this.bulk = false;
			this.draw();
		});
	}

	private resize(event: PointerEvent, divider: HTMLElement): void {
		event.preventDefault();
		const head = divider.closest<HTMLElement>('.volt-http-tr');
		const cells = head?.querySelectorAll<HTMLElement>('.volt-http-td.label');
		if (!head || !cells || cells.length < 2) {
			return;
		}
		const left = cells[0].getBoundingClientRect().left;
		const width = cells[0].getBoundingClientRect().width + cells[1].getBoundingClientRect().width;
		divider.setPointerCapture(event.pointerId);
		divider.classList.add('active');
		const move = (next: PointerEvent) => {
			keyShare = Math.max(0.15, Math.min(0.75, (next.clientX - left) / width));
			this.applyShare();
		};
		const up = () => {
			divider.classList.remove('active');
			divider.removeEventListener('pointermove', move);
			divider.removeEventListener('pointerup', up);
			divider.removeEventListener('pointercancel', up);
		};
		divider.addEventListener('pointermove', move);
		divider.addEventListener('pointerup', up);
		divider.addEventListener('pointercancel', up);
	}
}

/** Bulk Edit's lines: `key:value`, `//` in front of a row that is off. */
export function parseHttpBulk(text: string): IHttpKeyValue[] {
	const rows: IHttpKeyValue[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const disabled = /^\s*\/\//.test(raw);
		const line = disabled ? raw.replace(/^\s*\/\//, '') : raw;
		if (!line.trim()) {
			continue;
		}
		const at = line.indexOf(':');
		rows.push(at < 0 ? { key: line.trim(), value: '', enabled: !disabled } : { key: line.slice(0, at).trim(), value: line.slice(at + 1).trimStart(), enabled: !disabled });
	}
	return rows;
}

/** A read-only two-column table (response headers, cookies). */
export function renderHttpReadOnlyTable(parent: HTMLElement, columns: readonly string[], rows: readonly (readonly string[])[]): HTMLElement {
	const table = append(parent, $('.volt-http-kv.readonly'));
	table.style.setProperty('--volt-http-columns', String(columns.length));
	const body = append(table, $('.volt-http-kv-body'));
	const head = append(body, $('.volt-http-tr.head'));
	for (const column of columns) {
		append(head, $('.volt-http-td.label')).textContent = column;
	}
	for (const row of rows) {
		const line = append(body, $('.volt-http-tr'));
		line.setAttribute('role', 'row');
		for (const value of row) {
			append(line, $('.volt-http-td.text')).textContent = value;
		}
	}
	return table;
}

export function formatHttpBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export function formatHttpDuration(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function httpStatusClass(status: number | undefined): 'ok' | 'info' | 'warn' | 'error' {
	return !status || status >= 500 ? 'error' : status >= 400 ? 'warn' : status >= 300 ? 'info' : 'ok';
}

const renderedAnswers = new WeakMap<HTMLElement, IDisposable>();

/**
 * A model's answer (Markdown) drawn into `target`, replacing what was there; called again on every
 * streamed chunk. Links are shown, not followed. With no answer yet, `placeholder` is shown as text.
 */
export function renderHttpAiAnswer(target: HTMLElement, markdown: string, placeholder = ''): void {
	renderedAnswers.get(target)?.dispose();
	renderedAnswers.delete(target);
	target.classList.add('volt-http-ai-answer');
	if (!markdown.trim()) {
		clearNode(target);
		target.textContent = placeholder;
		target.classList.remove('rendered');
		return;
	}
	target.classList.add('rendered');
	const rendered = renderMarkdown(new MarkdownString(markdown), { fillInIncompleteTokens: true, actionHandler: () => { } }, target);
	renderedAnswers.set(target, rendered);
}
