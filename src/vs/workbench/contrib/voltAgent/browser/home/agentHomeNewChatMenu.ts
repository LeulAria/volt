/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHomeWorkspaceMenu.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { createHomeFolderIcon } from './agentHomeIcons.js';

export interface IAgentHomeNewChatProject {
	readonly root: URI;
	readonly name: string;
	/** The selected project: a trailing check. */
	readonly current: boolean;
}

/** Where the new chat goes: a project, or none (the composer asks for one before Send). */
export type AgentHomeNewChatChoice =
	| { readonly kind: 'folder'; readonly root: URI; readonly name: string }
	| { readonly kind: 'none' };

/**
 * The + on a group header: pick one of the active projects, or No Project, for a new chat.
 * Same panel look as the filter and Open Workspace menus. A second click on the anchor closes it.
 */
export function showAgentHomeNewChatMenu(
	contextViewService: IContextViewService,
	anchor: HTMLElement,
	projects: readonly IAgentHomeNewChatProject[],
	choose: (choice: AgentHomeNewChatChoice) => void,
): void {
	if (anchor.classList.contains('open')) {
		contextViewService.hideContextView();
		return;
	}
	contextViewService.showContextView({
		getAnchor: () => anchor,
		anchorAlignment: AnchorAlignment.RIGHT,
		render: container => {
			const close = () => contextViewService.hideContextView();
			const store = new DisposableStore();
			const pick = (choice: AgentHomeNewChatChoice) => {
				close();
				choose(choice);
			};
			container.classList.add('volt-agent-home-filter-menu-host', 'volt-agent-home-workspace-menu-host');
			const menu = append(container, $('.volt-agent-home-filter-menu.volt-agent-home-workspace-menu.volt-agent-home-new-chat-menu'));
			menu.setAttribute('role', 'menu');

			if (projects.length) {
				append(menu, $('.volt-agent-home-filter-heading')).textContent = localize('voltAgent.home.newChat.projects', "Projects");
				const list = append(menu, $('.volt-agent-home-workspace-list'));
				for (const project of projects) {
					const row = menuRow(list, store, project.name, createHomeFolderIcon(), () => pick({ kind: 'folder', root: project.root, name: project.name }));
					if (project.current) {
						row.classList.add('current');
						row.setAttribute('aria-current', 'true');
						row.querySelector('.trailing')?.appendChild(renderIcon(Codicon.check));
					}
				}
				append(menu, $('.volt-agent-home-filter-sep'));
			}
			menuRow(menu, store, localize('voltAgent.home.newChat.noProject', "No Project"), renderIcon(Codicon.commentDiscussion), () => pick({ kind: 'none' }));

			anchor.classList.add('open');
			store.add(toDisposable(() => anchor.classList.remove('open')));
			store.add(addDisposableListener(getWindow(anchor).document, 'mousedown', e => {
				if (!(e.target instanceof Node)) {
					return;
				}
				if (contextViewService.getContextViewElement().contains(e.target) || anchor.contains(e.target)) {
					return;
				}
				close();
			}, true));
			store.add(addDisposableListener(container, 'keydown', e => {
				switch (e.key) {
					case 'Escape':
						e.preventDefault();
						close();
						anchor.focus();
						return;
					case 'ArrowDown':
					case 'ArrowUp': {
						const rows = [...menu.querySelectorAll<HTMLElement>('button.volt-agent-home-workspace-row')];
						const index = isHTMLElement(e.target) ? rows.indexOf(e.target) : -1;
						const step = e.key === 'ArrowDown' ? 1 : -1;
						const next = rows[index < 0 ? 0 : (index + step + rows.length) % rows.length];
						e.preventDefault();
						next?.focus();
						next?.scrollIntoView({ block: 'nearest' });
						return;
					}
				}
			}));
			// The selected project first, so Enter starts a chat where the user already is.
			const first = menu.querySelector<HTMLElement>('button.volt-agent-home-workspace-row.current') ?? menu.querySelector<HTMLElement>('button.volt-agent-home-workspace-row');
			first?.focus();
			return store;
		},
	});
}

function menuRow(parent: HTMLElement, store: DisposableStore, label: string, icon: HTMLElement, run: () => void): HTMLButtonElement {
	const row = append(parent, $('button.volt-agent-home-filter-row.volt-agent-home-workspace-row')) as HTMLButtonElement;
	row.type = 'button';
	row.setAttribute('role', 'menuitem');
	append(row, $('span.leading')).appendChild(icon);
	append(row, $('span.label')).textContent = label;
	append(row, $('span.trailing'));
	store.add(addDisposableListener(row, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		run();
	}));
	return row;
}
