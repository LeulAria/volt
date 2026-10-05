/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './voltSegmented.css';
import { $, addDisposableListener, append, EventType } from '../../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';

export interface IVoltSegmented<T extends string> {
	readonly element: HTMLElement;
	readonly value: T;
	set(value: T, animate?: boolean): void;
	/** Places the thumb again once the control has a size (it measures the active pill). */
	sync(): void;
}

/**
 * Pill buttons with one thumb that slides to the active option: the Usage page's Limits / Cost /
 * Tokens switch. `extraClass` adds variants: `small`, and `fill` for equal pills across the row.
 */
export function createVoltSegmented<T extends string>(
	parent: HTMLElement,
	options: readonly { readonly id: T; readonly label: string }[],
	active: T,
	onChange: (value: T) => void,
	store: DisposableStore,
	extraClass = '',
): IVoltSegmented<T> {
	const element = append(parent, $(`.volt-segmented${extraClass ? `.${extraClass.split(' ').join('.')}` : ''}`));
	element.setAttribute('role', 'tablist');
	const thumb = append(element, $('span.volt-segmented-thumb'));
	const buttons = new Map<T, HTMLButtonElement>();
	let current = active;
	for (const option of options) {
		const button = append(element, $('button.volt-segment')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('role', 'tab');
		button.textContent = option.label;
		buttons.set(option.id, button);
		store.add(addDisposableListener(button, EventType.CLICK, () => {
			if (option.id !== current) {
				segment.set(option.id, true);
				onChange(option.id);
			}
		}));
	}
	// Left and right walk the pills like a native segmented control.
	store.add(addDisposableListener(element, EventType.KEY_DOWN, e => {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
			return;
		}
		const ids = [...buttons.keys()];
		const next = ids[(ids.indexOf(current) + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
		e.preventDefault();
		segment.set(next, true);
		buttons.get(next)?.focus();
		onChange(next);
	}));
	const place = (animate: boolean) => {
		const button = buttons.get(current);
		if (!button || !button.offsetWidth) {
			return;
		}
		thumb.classList.toggle('animate', animate);
		thumb.style.width = `${button.offsetWidth}px`;
		thumb.style.transform = `translateX(${button.offsetLeft}px)`;
		thumb.classList.add('placed');
	};
	const segment: IVoltSegmented<T> = {
		element,
		get value() {
			return current;
		},
		set(value, animate = false) {
			current = value;
			for (const [id, button] of buttons) {
				button.classList.toggle('active', id === value);
				button.setAttribute('aria-selected', String(id === value));
				button.tabIndex = id === value ? 0 : -1;
			}
			place(animate);
		},
		sync() {
			place(false);
		},
	};
	segment.set(active);
	return segment;
}
