/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IVoltPrCheck, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { blockedReason, currentLink, IAgentPrLink, isOpenState, isReadyToMerge, visibleLinks } from '../../common/agentPullRequests.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { OPEN_PULL_REQUEST_COMMAND_ID } from './agentPullRequestCommands.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { checkDuration, checkIcon, checksLabel, iconSpan, mergePullRequest, prStateIcon, prStateLabel } from './agentPullRequestUi.js';

export interface IAgentPullRequestDockOptions {
	/** Run with the chat's session id when the row's title part is clicked. */
	readonly openCommandId: string;
	/** The row's label while the chat has no pull request. */
	readonly emptyLabel: string;
}

const LINK_ROW_HEIGHT = 26;

class LinkDelegate implements IListVirtualDelegate<IAgentPrLink> {
	getHeight(): number {
		return LINK_ROW_HEIGHT;
	}
	getTemplateId(): string {
		return LinkRenderer.TEMPLATE_ID;
	}
}

interface ILinkTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
}

/** One of the chat's other pull requests: its state and "#8: title". */
class LinkRenderer implements IListRenderer<IAgentPrLink, ILinkTemplate> {
	static readonly TEMPLATE_ID = 'voltPrDockLink';
	readonly templateId = LinkRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): ILinkTemplate {
		container.classList.add('volt-pr-dock-link');
		const icon = append(container, $('span.volt-pr-dock-icon'));
		const label = append(container, $('span.volt-pr-dock-label'));
		return { icon, label };
	}

	renderElement(link: IAgentPrLink, _index: number, template: ILinkTemplate): void {
		const pr = link.snapshot;
		template.icon.replaceChildren();
		if (pr) {
			iconSpan(template.icon, prStateIcon(pr.state), `state-${pr.state}`);
		} else {
			template.icon.appendChild(renderIcon(Codicon.gitPullRequest));
		}
		template.label.textContent = pr ? `#${pr.number}: ${pr.title}` : localize('voltPr.dockNumber', "#{0}", link.number);
	}

	disposeTemplate(): void { }
}

/**
 * The chat's pull request in the side panel's Pull requests group, the way Cursor shows it: the
 * state and "#8: title" (opens it), its checks (the list drops down), and Merge when nothing blocks
 * it. Without a linked pull request it is a plain row with `emptyLabel`. The chat's other pull
 * requests (merged ones, a stack's lower layers) list under it; each opens its pull request.
 */
export class AgentPullRequestDockControl extends Disposable {

	readonly element: HTMLElement;
	private readonly main: HTMLButtonElement;
	private readonly icon: HTMLElement;
	private readonly label: HTMLElement;
	private readonly checksSep: HTMLElement;
	private readonly checks: HTMLButtonElement;
	private readonly checksIcon: HTMLElement;
	private readonly mergeSep: HTMLElement;
	private readonly merge: HTMLButtonElement;
	private readonly othersHost: HTMLElement;
	private readonly others: WorkbenchList<IAgentPrLink>;
	private sessionId: string | undefined;
	private link: IAgentPrLink | undefined;
	private merging = false;
	private _linkCount = 0;

	private readonly _onDidRender = this._register(new Emitter<void>());
	/** The chat's pull requests changed: the group heading's count follows. */
	readonly onDidRender: Event<void> = this._onDidRender.event;

	constructor(
		parent: HTMLElement,
		private readonly pullRequests: IAgentPullRequestService | undefined,
		private readonly options: IAgentPullRequestDockOptions,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.element = append(parent, $('.volt-agent-dock-row.volt-pr-dock'));
		this.main = append(this.element, $('button.volt-pr-dock-main')) as HTMLButtonElement;
		this.main.type = 'button';
		this.icon = append(this.main, $('span.volt-pr-dock-icon'));
		this.label = append(this.main, $('span.volt-pr-dock-label'));
		this.checksSep = append(this.element, $('span.volt-pr-dock-sep'));
		this.checks = append(this.element, $('button.volt-pr-dock-checks')) as HTMLButtonElement;
		this.checks.type = 'button';
		this.checksIcon = append(this.checks, $('span.volt-pr-dock-checks-icon'));
		append(this.checks, renderIcon(Codicon.chevronDown)).classList.add('volt-pr-dock-chevron');
		this.mergeSep = append(this.element, $('span.volt-pr-dock-sep'));
		this.merge = append(this.element, $('button.volt-pr-dock-merge')) as HTMLButtonElement;
		this.merge.type = 'button';
		this.merge.textContent = localize('voltPr.dockMerge', "Merge");
		this.othersHost = append(parent, $('.volt-pr-dock-links'));
		this.others = this._register(instantiationService.createInstance(WorkbenchList<IAgentPrLink>, 'VoltAgentDockPullRequests', this.othersHost, new LinkDelegate(), [new LinkRenderer()], {
			identityProvider: { getId: (link: IAgentPrLink) => link.key },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltPr.dockOthersAria', "Other pull requests of this chat"),
				getAriaLabel: (link: IAgentPrLink) => link.snapshot ? `${prStateLabel(link.snapshot.state)}, #${link.number}: ${link.snapshot.title}` : `#${link.number}`,
			},
		}));
		this._register(this.others.onDidOpen(e => {
			const link = e.element;
			if (link) {
				void this.commandService.executeCommand(OPEN_PULL_REQUEST_COMMAND_ID, { host: link.repo.host, owner: link.repo.owner, name: link.repo.name, number: link.number }, this.sessionId);
			}
		}));

		this._register(addDisposableListener(this.main, 'click', () => {
			void this.commandService.executeCommand(this.options.openCommandId, this.sessionId);
		}));
		this._register(addDisposableListener(this.checks, 'click', e => {
			e.stopPropagation();
			void this.showChecks();
		}));
		this._register(addDisposableListener(this.merge, 'click', e => {
			e.stopPropagation();
			void this.runMerge(e.shiftKey);
		}));
		if (pullRequests) {
			this._register(pullRequests.onDidChange(sessionIds => {
				if (this.sessionId && sessionIds.includes(this.sessionId)) {
					this.render();
				}
			}));
			this._register(pullRequests.onDidChangePullRequest(key => {
				if (key === this.link?.key) {
					this.render();
				}
			}));
		}
		this.render();
	}

	setSession(sessionId: string | undefined): void {
		if (sessionId === this.sessionId) {
			return;
		}
		this.sessionId = sessionId;
		this.render();
	}

	/** The chat's pull requests (dismissed ones aside). */
	get linkCount(): number {
		return this._linkCount;
	}

	private render(): void {
		this.renderRow();
		this.renderOthers();
		this._onDidRender.fire();
	}

	private renderOthers(): void {
		const links = this.sessionId && this.pullRequests ? visibleLinks(this.pullRequests.links(this.sessionId)) : [];
		this._linkCount = links.length;
		const others = links
			.filter(link => link.key !== this.link?.key)
			.sort((a, b) => (b.snapshot?.updatedAt ?? b.linkedAt) - (a.snapshot?.updatedAt ?? a.linkedAt));
		const height = others.length * LINK_ROW_HEIGHT;
		this.othersHost.style.height = `${height}px`;
		this.othersHost.style.display = height ? '' : 'none';
		this.others.layout(height);
		this.others.splice(0, this.others.length, others);
	}

	private renderRow(): void {
		const link = this.sessionId && this.pullRequests ? currentLink(this.pullRequests.links(this.sessionId)) : undefined;
		this.link = link;
		const pr = link?.snapshot;
		this.element.classList.toggle('linked', !!pr);
		this.icon.replaceChildren();
		this.icon.className = 'volt-pr-dock-icon';
		if (!link || !pr) {
			this.icon.appendChild(renderIcon(Codicon.gitPullRequest));
			this.label.textContent = link
				? localize('voltPr.dockNumber', "#{0}", link.number)
				: this.options.emptyLabel;
			setAgentTooltip(this.main, undefined);
			this.setVisible(this.checksSep, this.checks, false);
			this.setVisible(this.mergeSep, this.merge, false);
			return;
		}
		iconSpan(this.icon, prStateIcon(pr.state), `state-${pr.state}`);
		this.label.textContent = `#${pr.number}: ${pr.title}`;
		setAgentTooltip(this.main, localize('voltPr.dockOpenTip', "{0}: open #{1} {2}", prStateLabel(pr.state), pr.number, pr.title));

		const showChecks = pr.checks.state !== 'none';
		this.setVisible(this.checksSep, this.checks, showChecks);
		this.checksIcon.replaceChildren();
		if (showChecks) {
			// Cursor's passing checks are a ring with a tick, not a filled disc.
			iconSpan(this.checksIcon, pr.checks.state === 'success' ? Codicon.pass : checkIcon(pr.checks.state), `check-${pr.checks.state}`);
			setAgentTooltip(this.checks, checksLabel(pr));
		}

		const open = isOpenState(pr.state);
		this.setVisible(this.mergeSep, this.merge, open);
		const ready = isReadyToMerge(pr);
		this.merge.classList.toggle('ready', ready && !this.merging);
		this.merge.disabled = !ready || this.merging;
		this.merge.textContent = this.merging ? localize('voltPr.dockMerging', "Merging…") : localize('voltPr.dockMerge', "Merge");
		setAgentTooltip(this.merge, ready
			? localize('voltPr.dockMergeTip', "Merge into {0}. Hold Shift to skip the confirmation.", pr.baseRefName)
			: blockedReason(pr) ?? localize('voltPr.dockNotReady', "Not ready to merge"));
	}

	private setVisible(sep: HTMLElement, part: HTMLElement, visible: boolean): void {
		sep.classList.toggle('hidden', !visible);
		part.classList.toggle('hidden', !visible);
	}

	private async runMerge(skipConfirm: boolean): Promise<void> {
		const pr = this.link?.snapshot;
		if (!pr || this.merging) {
			return;
		}
		this.merging = true;
		this.render();
		try {
			await this.instantiationService.invokeFunction(accessor => mergePullRequest(accessor, pr, skipConfirm));
		} finally {
			this.merging = false;
			this.render();
		}
	}

	/** The checks of the latest commit, from a fresh read; picking one opens its run. */
	private async showChecks(): Promise<void> {
		const link = this.link;
		const pr = link?.snapshot;
		if (!link || !pr || !this.pullRequests) {
			return;
		}
		type Pick = { readonly url?: string; readonly open?: boolean };
		let runs: readonly IVoltPrCheck[] = [];
		let problem: string | undefined;
		try {
			runs = (await this.pullRequests.detail({ repo: link.repo, number: link.number })).checkRuns;
		} catch (err) {
			problem = voltPrErrorMessage(err);
		}
		if (link !== this.link) {
			return;
		}
		const items: IVoltMenuItem<Pick>[] = runs.map((check, index) => ({
			id: `check-${index}`,
			label: check.name,
			detail: [check.workflow, checkDuration(check)].filter(Boolean).join(' · ') || undefined,
			icon: () => {
				const holder = $('span');
				iconSpan(holder, checkIcon(check.state), `check-${check.state}`);
				return holder.firstElementChild as HTMLElement;
			},
			disabled: !check.url,
			tooltip: check.summary,
			data: { url: check.url },
		}));
		const sections = [
			{ id: 'checks', title: problem ?? checksLabel(pr), items },
			{ id: 'open', items: [{ id: 'open', label: localize('voltPr.dockOpenPr', "Open Pull Request"), icon: Codicon.gitPullRequest, data: { open: true } } satisfies IVoltMenuItem<Pick>] },
		];
		showVoltMenu<Pick>(this.contextViewService, {
			anchor: this.checks,
			align: 'right',
			className: 'volt-pr-checks-menu',
			ariaLabel: localize('voltPr.dockChecksAria', "Checks"),
			width: 300,
			sections,
			onPick: item => {
				if (item.data.open) {
					void this.commandService.executeCommand(OPEN_PULL_REQUEST_COMMAND_ID, { host: link.repo.host, owner: link.repo.owner, name: link.repo.name, number: link.number }, this.sessionId);
				} else if (item.data.url) {
					void this.openerService.open(URI.parse(item.data.url));
				}
			},
		});
	}
}
