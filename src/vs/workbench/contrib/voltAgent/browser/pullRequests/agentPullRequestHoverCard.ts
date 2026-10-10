/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltPullRequest } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { blockedReason, IAgentPrLink, isOpenState, isReadyToMerge } from '../../common/agentPullRequests.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { CHANGES_ICON_PATH, createSurfaceStrokeIcon } from '../workspace/agentSurfaceMenu.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';
import { checkIcon, checksLabel, iconSpan, mergePullRequest, prStateIcon, prStateLabel } from './agentPullRequestUi.js';

/** The pointer rests on the chip this long before the card opens. */
const SHOW_DELAY_MS = 250;
/** Time to cross the gap from the chip to the card (and back) before it closes. */
const HIDE_DELAY_MS = 160;

/**
 * A pull request at a glance over the chip that stands for it: state, checks, size, and a Merge
 * button when nothing blocks it. Opaque, like the menus (see volt-transparent-window).
 */
export class AgentPullRequestHoverCard extends Disposable {

	private readonly card: HTMLElement;
	private readonly content = this._register(new DisposableStore());
	private readonly visibleStore = this._register(new MutableDisposable<DisposableStore>());
	private showHandle: number | undefined;
	private hideHandle: number | undefined;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly getLink: () => IAgentPrLink | undefined,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.card = $('.volt-pr-hover-card');
		this.card.setAttribute('role', 'dialog');
		this._register(toDisposable(() => {
			this.clearTimers();
			this.card.remove();
		}));
		this._register(addDisposableListener(anchor, 'mouseenter', () => this.scheduleShow()));
		this._register(addDisposableListener(anchor, 'mouseleave', () => this.scheduleHide()));
		// Clicking the chip opens the pull request: the card would cover where it goes.
		this._register(addDisposableListener(anchor, 'mousedown', () => this.hide()));
		this._register(addDisposableListener(this.card, 'mouseenter', () => this.cancelHide()));
		this._register(addDisposableListener(this.card, 'mouseleave', () => this.scheduleHide()));
	}

	get visible(): boolean {
		return !!this.visibleStore.value;
	}

	/** The chip changed: follow it, or close when it no longer stands for a pull request. */
	update(): void {
		if (!this.visible) {
			return;
		}
		const pr = this.getLink()?.snapshot;
		if (!pr || !this.anchor.isConnected || this.anchor.classList.contains('hidden')) {
			this.hide();
			return;
		}
		this.render(pr);
	}

	hide(): void {
		this.clearTimers();
		this.visibleStore.clear();
		this.content.clear();
		this.card.remove();
	}

	private scheduleShow(): void {
		this.cancelHide();
		if (this.visible || this.showHandle !== undefined || !this.getLink()?.snapshot) {
			return;
		}
		this.showHandle = getWindow(this.anchor).setTimeout(() => {
			this.showHandle = undefined;
			this.show();
		}, SHOW_DELAY_MS);
	}

	private scheduleHide(): void {
		const win = getWindow(this.anchor);
		if (this.showHandle !== undefined) {
			win.clearTimeout(this.showHandle);
			this.showHandle = undefined;
		}
		if (!this.visible || this.hideHandle !== undefined) {
			return;
		}
		this.hideHandle = win.setTimeout(() => {
			this.hideHandle = undefined;
			this.hide();
		}, HIDE_DELAY_MS);
	}

	private cancelHide(): void {
		if (this.hideHandle !== undefined) {
			getWindow(this.anchor).clearTimeout(this.hideHandle);
			this.hideHandle = undefined;
		}
	}

	private clearTimers(): void {
		const win = getWindow(this.anchor);
		if (this.showHandle !== undefined) {
			win.clearTimeout(this.showHandle);
			this.showHandle = undefined;
		}
		this.cancelHide();
	}

	private show(): void {
		const link = this.getLink();
		const pr = link?.snapshot;
		if (!link || !pr || !this.anchor.isConnected) {
			return;
		}
		const store = new DisposableStore();
		this.visibleStore.value = store;
		const host = this.anchor.closest('.monaco-workbench') ?? getWindow(this.anchor).document.body;
		host.appendChild(this.card);
		store.add(this.pullRequests.onDidChangePullRequest(key => {
			if (key === link.key) {
				this.update();
			}
		}));
		store.add(this.pullRequests.onDidChange(() => this.update()));
		store.add(addDisposableListener(getWindow(this.anchor), 'blur', () => this.hide()));
		this.render(pr);
	}

	private render(pr: IVoltPullRequest): void {
		this.content.clear();
		const card = this.card;
		card.replaceChildren();
		card.setAttribute('aria-label', localize('voltPr.hoverAria', "Pull request #{0}: {1}", pr.number, pr.title));

		const head = append(card, $('.volt-pr-hover-head'));
		iconSpan(head, prStateIcon(pr.state), `state-${pr.state}`);
		const title = append(head, $('.volt-pr-hover-title'));
		append(title, $('span.volt-pr-hover-name')).textContent = pr.title;
		append(title, $('span.volt-pr-hover-number')).textContent = ` #${pr.number}`;

		// base ← head, the same flow the pull request view shows.
		const flow = append(card, $('.volt-pr-hover-flow'));
		append(flow, $('span.volt-pr-hover-branch')).textContent = pr.baseRefName;
		append(flow, $('span.volt-pr-hover-arrow')).appendChild(renderIcon(Codicon.arrowLeft));
		append(flow, $('span.volt-pr-hover-branch')).textContent = pr.crossRepository && pr.headOwner ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName;

		const rows = append(card, $('.volt-pr-hover-rows'));
		const ready = isReadyToMerge(pr);
		const status = append(rows, $('.volt-pr-hover-row'));
		iconSpan(status, prStateIcon(pr.state), `state-${pr.state}`);
		append(status, $('span.volt-pr-hover-label')).textContent = prStateLabel(pr.state);
		const reason = blockedReason(pr);
		if (reason && reason !== prStateLabel(pr.state)) {
			const detail = append(status, $('span.volt-pr-hover-detail'));
			detail.textContent = reason;
			detail.classList.toggle('ready', ready);
		}

		if (isOpenState(pr.state) || pr.checks.state !== 'none') {
			const checks = append(rows, $('.volt-pr-hover-row'));
			iconSpan(checks, checkIcon(pr.checks.state), `check-${pr.checks.state}`);
			append(checks, $('span.volt-pr-hover-label')).textContent = checksLabel(pr);
		}

		const changes = append(rows, $('.volt-pr-hover-row'));
		// The +/- the side panel's Changes row uses.
		const diff = append(changes, $('span.volt-pr-icon.muted'));
		const glyph = diff.appendChild(createSurfaceStrokeIcon(diff.ownerDocument, CHANGES_ICON_PATH));
		glyph.setAttribute('width', '14');
		glyph.setAttribute('height', '14');
		glyph.setAttribute('stroke-width', '1.5');
		const stats = append(changes, $('span.volt-pr-hover-label.volt-pr-hover-stats'));
		append(stats, $('span.add')).textContent = `+${pr.additions}`;
		append(stats, $('span.del')).textContent = `\u2212${pr.deletions}`;
		append(changes, $('span.volt-pr-hover-detail')).textContent = pr.changedFiles === 1
			? localize('voltPr.hoverOneFile', "1 file")
			: localize('voltPr.hoverFiles', "{0} files", pr.changedFiles);

		if (this.getLink()?.watch && isOpenState(pr.state)) {
			const watch = append(rows, $('.volt-pr-hover-row'));
			iconSpan(watch, Codicon.eye, 'watching');
			append(watch, $('span.volt-pr-hover-label.muted')).textContent = localize('voltPr.hoverWatching', "Watching checks, reviews and conflicts");
		}

		if (ready) {
			const actions = append(card, $('.volt-pr-hover-actions'));
			const merge = append(actions, $('button.volt-pr-hover-merge')) as HTMLButtonElement;
			merge.type = 'button';
			merge.appendChild(renderIcon(Codicon.gitMerge));
			append(merge, $('span')).textContent = localize('voltPr.hoverMerge', "Merge");
			setAgentTooltip(merge, localize('voltPr.hoverMergeTip', "Merge into {0}. Hold Shift to skip the confirmation.", pr.baseRefName));
			this.content.add(addDisposableListener(merge, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				const skipConfirm = e.shiftKey;
				this.hide();
				void this.instantiationService.invokeFunction(accessor => mergePullRequest(accessor, pr, skipConfirm));
			}));
		}
		this.place();
	}

	/** Above the chip, its left edge on the chip's, inside the window; below when there is no room above. */
	private place(): void {
		const win = getWindow(this.anchor);
		const rect = this.anchor.getBoundingClientRect();
		const width = this.card.offsetWidth;
		const height = this.card.offsetHeight;
		const gap = 6;
		const left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8));
		const above = rect.top - height - gap;
		this.card.style.left = `${left}px`;
		this.card.style.top = `${above >= 8 ? above : rect.bottom + gap}px`;
	}
}
