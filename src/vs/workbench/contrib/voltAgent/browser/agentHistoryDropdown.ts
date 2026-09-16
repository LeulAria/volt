/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentSessionMeta } from '../../../services/voltRuntime/common/agentHistory.js';
import { AgentHistoryList } from './agentHistoryList.js';

let openAnchor: HTMLElement | undefined;

/**
 * The clock menu: a compact, searchable history list anchored to the tab bar.
 * Calling it again for the same anchor closes the open menu.
 */
export function toggleAgentHistoryDropdown(
	accessor: { contextViewService: IContextViewService; instantiationService: IInstantiationService },
	anchor: HTMLElement,
	onOpen: (session: IAgentSessionMeta) => void,
	activeSessionId?: string,
): void {
	const { contextViewService, instantiationService } = accessor;
	if (openAnchor === anchor) {
		contextViewService.hideContextView();
		return;
	}
	const workbench = anchor.ownerDocument.querySelector('.monaco-workbench') as HTMLElement | null;
	contextViewService.showContextView({
		getAnchor: () => {
			const rect = anchor.getBoundingClientRect();
			return { x: rect.right, y: rect.bottom };
		},
		anchorAlignment: AnchorAlignment.RIGHT,
		anchorPosition: AnchorPosition.BELOW,
		onDOMEvent: (e: globalThis.Event) => {
			if (e.type !== 'click' || !(e.target instanceof Node)) {
				return;
			}
			if (contextViewService.getContextViewElement().contains(e.target) || anchor.contains(e.target)) {
				return;
			}
			contextViewService.hideContextView();
		},
		onHide: () => {
			openAnchor = undefined;
			anchor.classList.remove('volt-agent-history-open');
		},
		render: container => {
			openAnchor = anchor;
			anchor.classList.add('volt-agent-history-open');
			const store = new DisposableStore();
			const menu = append(container, $('.volt-agent-dropdown.history'));
			const list = store.add(instantiationService.createInstance(AgentHistoryList, menu, {
				compact: true,
				search: true,
				pageSize: 12,
				onOpen: session => {
					contextViewService.hideContextView();
					onOpen(session);
				},
			}));
			list.setActiveSession(activeSessionId);
			store.add(addDisposableListener(getWindow(menu).document, EventType.MOUSE_DOWN, e => {
				if (e.target instanceof Node && !menu.contains(e.target) && !anchor.contains(e.target)) {
					contextViewService.hideContextView();
				}
			}, true));
			store.add(addDisposableListener(menu, EventType.KEY_DOWN, e => {
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					contextViewService.hideContextView();
					anchor.focus();
				}
			}));
			queueMicrotask(() => list.focus());
			return store;
		},
	}, workbench ?? undefined);
}
