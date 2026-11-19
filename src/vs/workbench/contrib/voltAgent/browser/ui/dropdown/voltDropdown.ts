/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './voltDropdown.css';
import { $, addDisposableListener, append, EventType } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { createHomeSearchIcon } from '../../home/agentHomeIcons.js';
import { showVoltMenu } from '../menu/voltMenu.js';

export interface IVoltDropdownOption<T extends string> {
	readonly id: T;
	readonly label: string;
	/** Muted second line in the menu. */
	readonly description?: string;
	/** Leading glyph, in the trigger and the menu. */
	readonly icon?: ThemeIcon | (() => HTMLElement | SVGElement);
	readonly danger?: boolean;
}

export interface IVoltDropdownOptions<T extends string> {
	readonly options: readonly IVoltDropdownOption<T>[];
	readonly value: T;
	readonly ariaLabel: string;
	readonly onChange: (value: T) => void;
	/** Shows a search field when there are this many options or more. Defaults to 9. */
	readonly searchFrom?: number;
	readonly align?: 'left' | 'right';
	/** Menu width; defaults to the trigger's width, at least 220. */
	readonly width?: number;
	/** A fixed glyph at the start of the trigger, whatever is picked (a filter's funnel). */
	readonly leadingIcon?: IVoltDropdownOption<string>['icon'];
	/** Extra classes on the menu, for a surface that draws its dropdowns its own way. */
	readonly menuClassName?: string;
}

export interface IVoltDropdown<T extends string> {
	readonly element: HTMLButtonElement;
	readonly value: T;
	set(value: T): void;
}

function drawIcon(parent: HTMLElement, icon: IVoltDropdownOption<string>['icon']): void {
	if (!icon) {
		return;
	}
	const glyph = ThemeIcon.isThemeIcon(icon) ? renderIcon(icon) : icon();
	glyph.classList.add('volt-dropdown-icon');
	parent.appendChild(glyph);
}

/**
 * Volt's dropdown: a pill trigger (the composer's model button) that opens the Volt menu with a
 * check on the current choice. Every choice in Volt's own UI uses it instead of a <select>.
 */
export function createVoltDropdown<T extends string>(parent: HTMLElement, contextViewService: IContextViewService, options: IVoltDropdownOptions<T>, store: DisposableStore): IVoltDropdown<T> {
	const element = append(parent, $('button.volt-dropdown')) as HTMLButtonElement;
	element.type = 'button';
	element.setAttribute('aria-haspopup', 'menu');
	element.setAttribute('aria-label', options.ariaLabel);
	let current = options.value;

	const render = () => {
		element.replaceChildren();
		const option = options.options.find(o => o.id === current) ?? options.options[0];
		element.classList.toggle('danger', !!option?.danger);
		drawIcon(element, options.leadingIcon ?? option?.icon);
		append(element, $('span.volt-dropdown-label')).textContent = option?.label ?? '';
		const chevron = renderIcon(Codicon.chevronDown);
		chevron.classList.add('volt-dropdown-chevron');
		element.appendChild(chevron);
	};
	render();

	// The menu closes with its page (a settings page re-renders or is left while it is open).
	const menu = store.add(new MutableDisposable());
	store.add(addDisposableListener(element, EventType.CLICK, () => {
		element.classList.add('open');
		const searchFrom = options.searchFrom ?? 9;
		// Choices that explain themselves need the room to say it: a narrow menu cuts every description short.
		const width = options.width ?? Math.max(options.options.some(option => option.description) ? 420 : 220, element.offsetWidth);
		// A menu wider than its button hangs from the button's left edge when the window has the room, so it opens over its own field.
		const box = element.getBoundingClientRect();
		const align = options.align ?? (width > box.width + 1 && box.left + width <= element.ownerDocument.documentElement.clientWidth - 8 ? 'left' : 'right');
		menu.value = showVoltMenu<T>(contextViewService, {
			anchor: element,
			position: 'below',
			align,
			width,
			ariaLabel: options.ariaLabel,
			className: options.menuClassName,
			search: options.options.length >= searchFrom ? { placeholder: options.ariaLabel, icon: () => createHomeSearchIcon() } : undefined,
			sections: [{
				id: 'options',
				items: options.options.map(option => ({
					id: option.id,
					label: option.label,
					subtitle: option.description,
					icon: option.icon,
					checked: option.id === current,
					data: option.id,
				})),
			}],
			onPick: item => {
				if (item.data !== current) {
					current = item.data;
					render();
					options.onChange(current);
				}
			},
			onHide: () => element.classList.remove('open'),
		});
	}));

	return {
		element,
		get value() { return current; },
		set(value: T) {
			current = value;
			render();
		},
	};
}
