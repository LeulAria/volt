/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A context menu's actions as Volt menu sections (voltMobileContextMenu.ts shows them in a sheet).

import { $ } from '../../../../../../base/browser/dom.js';
import { IAction, Separator, SubmenuAction } from '../../../../../../base/common/actions.js';
import { IVoltMenuItem, IVoltMenuSection } from '../../ui/menu/voltMenu.js';

/** Separators split the actions into sections; submenus become drill-in rows. */
export function toSections(actions: readonly IAction[], idPrefix: string): IVoltMenuSection<IAction>[] {
	const sections: IVoltMenuSection<IAction>[] = [];
	let items: IVoltMenuItem<IAction>[] = [];
	const flush = () => {
		if (items.length) {
			sections.push({ id: `${idPrefix}${sections.length}`, items });
			items = [];
		}
	};
	actions.forEach((action, index) => {
		if (action instanceof Separator) {
			flush();
			return;
		}
		const id = `${idPrefix}${index}:${action.id}`;
		const label = withoutMnemonic(action.label) || action.tooltip || action.id;
		const icon = iconOf(action);
		if (action instanceof SubmenuAction) {
			const children = toSections(action.actions, `${id}/`);
			if (children.length) {
				items.push({ id, label, icon, disabled: !action.enabled, data: action, submenu: { sections: children } });
			}
			return;
		}
		items.push({ id, label, icon, checked: action.checked, disabled: !action.enabled, tooltip: action.tooltip || undefined, data: action });
	});
	flush();
	return sections;
}

/** "&&Open" and "Open (&&O)" read "Open": a sheet has no access keys. */
export function withoutMnemonic(label: string): string {
	return label.replace(/\s*\(&&\w\)/g, '').replace(/&&/g, '').trim();
}

/** A codicon class on the action (`codicon codicon-x`) becomes the row's icon. */
function iconOf(action: IAction): (() => HTMLElement) | undefined {
	const className = action.class;
	if (!className || !/\bcodicon-/.test(className)) {
		return undefined;
	}
	return () => {
		const span = $('span');
		span.className = className.includes('codicon ') || className.startsWith('codicon') ? className : `codicon ${className}`;
		return span;
	};
}
