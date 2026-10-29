/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { currentLink, IAgentPrLink } from '../../common/agentPullRequests.js';
import { iconSpan, prStateIcon } from './agentPullRequestUi.js';

/** The rows of Previous agents (agentLineageDock.ts). */
const ROW_HEIGHT = 26;

interface IPullRequestTemplate {
	readonly icon: HTMLElement;
	readonly number: HTMLElement;
	readonly title: HTMLElement;
}

class PullRequestDelegate implements IListVirtualDelegate<IAgentPrLink> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(): string {
		return PullRequestRenderer.TEMPLATE_ID;
	}
}

class PullRequestRenderer implements IListRenderer<IAgentPrLink, IPullRequestTemplate> {
	static readonly TEMPLATE_ID = 'voltPullRequestLink';
	readonly templateId = PullRequestRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IPullRequestTemplate {
		const row = append(container, $('.volt-pr-link-row'));
		return {
			icon: append(row, $('span.volt-pr-link-icon')),
			number: append(row, $('span.volt-pr-link-number')),
			title: append(row, $('span.volt-pr-link-title')),
		};
	}

	renderElement(link: IAgentPrLink, _index: number, template: IPullRequestTemplate): void {
		const state = link.snapshot?.state;
		template.icon.replaceChildren();
		iconSpan(template.icon, state ? prStateIcon(state) : Codicon.gitPullRequest, state ? `state-${state}` : 'muted');
		template.number.textContent = `#${link.number}`;
		template.title.textContent = link.snapshot?.title ?? '';
	}

	disposeTemplate(): void { }
}

/** The current pull request first, then the latest updated. */
export function orderPullRequestLinks(links: readonly IAgentPrLink[], current = currentLink(links)): IAgentPrLink[] {
	return [...links].sort((a, b) => Number(b.key === current?.key) - Number(a.key === current?.key)
		|| (b.snapshot?.updatedAt ?? b.linkedAt) - (a.snapshot?.updatedAt ?? a.linkedAt));
}

/**
 * A chat's pull requests as a VS Code list inside a hover card: one line each ("#24 title"),
 * rows edge to edge with square corners like Previous agents; opening a row runs `onOpen`.
 */
export function renderPullRequestList(instantiationService: IInstantiationService, parent: HTMLElement, links: readonly IAgentPrLink[], onOpen: (link: IAgentPrLink) => void): IDisposable {
	const store = new DisposableStore();
	const host = append(parent, $('.volt-pr-link-list'));
	host.style.height = `${links.length * ROW_HEIGHT}px`;
	const list = store.add(instantiationService.createInstance(WorkbenchList<IAgentPrLink>, 'voltPullRequestLinks', host, new PullRequestDelegate(), [new PullRequestRenderer()], {
		identityProvider: { getId: (link: IAgentPrLink) => link.key },
		multipleSelectionSupport: false,
		horizontalScrolling: false,
		alwaysConsumeMouseWheel: false,
		accessibilityProvider: {
			getWidgetAriaLabel: () => localize('voltPr.linkListAria', "Pull requests"),
			getAriaLabel: (link: IAgentPrLink) => `#${link.number} ${link.snapshot?.title ?? ''}`.trim(),
		},
	}));
	list.layout(links.length * ROW_HEIGHT);
	list.splice(0, 0, [...links]);
	store.add(list.onDidOpen(e => e.element && onOpen(e.element)));
	store.add(toDisposable(() => host.remove()));
	return store;
}
