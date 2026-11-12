/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Every VS Code context menu (a file's, a tab's, an editor's, a toolbar's "…") on a phone: the same
// actions, run the same way, in a bottom sheet instead of a small menu at the finger. Submenus slide
// over their parent. The actions and their runners are the menu's own; only the presentation changes.

import { isHTMLElement } from '../../../../../../base/browser/dom.js';
import { IContextMenuDelegate } from '../../../../../../base/browser/contextmenu.js';
import { isVoltCompact } from '../../../../../../base/browser/ui/voltMobile/voltViewport.js';
import { ActionRunner, IAction } from '../../../../../../base/common/actions.js';
import { IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { setContextMenuPresenter } from '../../../../../../platform/contextview/browser/contextMenuService.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { showVoltMenu } from '../../ui/menu/voltMenu.js';
import { toSections } from './voltMobileActions.js';

/** Shows context menus as bottom sheets while the window is phone-sized; the anchored menu otherwise. */
export function installMobileContextMenus(container: HTMLElement, contextViewService: IContextViewService, notificationService: INotificationService): IDisposable {
	setContextMenuPresenter(delegate => isVoltCompact() && presentAsSheet(delegate, container, contextViewService, notificationService));
	return toDisposable(() => setContextMenuPresenter(undefined));
}

function presentAsSheet(delegate: IContextMenuDelegate, container: HTMLElement, contextViewService: IContextViewService, notificationService: INotificationService): boolean {
	const actions = delegate.getActions();
	const sections = toSections(actions, '');
	if (!sections.length) {
		return false;
	}
	// An element anchor keeps its open state (aria-expanded) while the sheet is up; a point gets a stand-in.
	const given = delegate.getAnchor();
	let anchor: HTMLElement;
	let standIn: HTMLElement | undefined;
	if (isHTMLElement(given)) {
		anchor = given;
	} else {
		anchor = standIn = container.ownerDocument.createElement('div');
		standIn.style.display = 'none';
		container.appendChild(standIn);
	}
	const ownRunner = delegate.actionRunner ? undefined : new ActionRunner();
	const runner = delegate.actionRunner ?? ownRunner!;
	let picked = false;
	showVoltMenu<IAction>(contextViewService, {
		anchor,
		ariaLabel: localize('voltMobile.contextMenu', "Actions"),
		sections,
		onPick: item => {
			picked = true;
			// After the sheet starts closing, so a menu the action opens lands on top.
			setTimeout(() => {
				Promise.resolve(runner.run(item.data, delegate.getActionsContext?.())).catch((error: unknown) => notificationService.error(error instanceof Error ? error : String(error)));
			});
		},
		onHide: () => {
			standIn?.remove();
			delegate.onHide?.(!picked);
			// The run above is queued; dispose our runner after it.
			setTimeout(() => ownRunner?.dispose());
		},
	});
	return true;
}
