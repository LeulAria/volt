/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentUpdate.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IsDevelopmentContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IUpdateService, State, StateType } from '../../../../../platform/update/common/update.js';
import { IVoltUpdate, voltReleaseTag } from '../../../../../platform/update/common/voltUpdateFeed.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { summarizeReleaseNotes } from '../../common/agentUpdateNotes.js';
import { createRefreshSpinner } from '../usage/agentUsageIcons.js';

/** States worth a button in the agent sidebar footer. */
function isActionable(state: State): boolean {
	switch (state.type) {
		case StateType.AvailableForDownload:
		case StateType.Downloading:
		case StateType.Downloaded:
		case StateType.Updating:
		case StateType.Ready:
			return true;
		default:
			return false;
	}
}

function updateOf(state: State): IVoltUpdate | undefined {
	return 'update' in state ? state.update as IVoltUpdate | undefined : undefined;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 12.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Tray-and-arrow glyph inside a progress ring. */
function createUpdateGlyph(): { readonly root: SVGSVGElement; readonly progress: SVGCircleElement } {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 28 28');
	svg.setAttribute('width', '28');
	svg.setAttribute('height', '28');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('volt-agent-update-glyph');
	const ring = (className: string) => {
		const circle = document.createElementNS(SVG_NS, 'circle');
		circle.setAttribute('cx', '14');
		circle.setAttribute('cy', '14');
		circle.setAttribute('r', String(RING_RADIUS));
		circle.classList.add(className);
		svg.appendChild(circle);
		return circle;
	};
	ring('volt-agent-update-track');
	const progress = ring('volt-agent-update-progress');
	progress.setAttribute('stroke-dasharray', String(RING_LENGTH));
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', 'M14 8.5v7.5M10.75 12.75 14 16l3.25-3.25M9 17.5v1.25c0 .69.56 1.25 1.25 1.25h7.5c.69 0 1.25-.56 1.25-1.25V17.5');
	path.classList.add('volt-agent-update-arrow');
	svg.appendChild(path);
	return { root: svg, progress };
}

/**
 * The update button in the agent sidebar footer, next to Settings and Usage. It shows while an
 * update is available, downloading or ready, with the download progress as a ring, and opens a
 * popover with the state, "What's changed" from the release notes, and the next step
 * (Download, Install or Restart to Update).
 */
export class AgentUpdateButtonContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentUpdateButton';

	private static instance: AgentUpdateButtonContribution | undefined;

	private state: State;
	/** Developer: Simulate Update State overrides the service's state. */
	private simulated: State | undefined;
	private button: HTMLButtonElement | undefined;
	private glyph: ReturnType<typeof createUpdateGlyph> | undefined;
	/** The user asked for a check; cleared when the service answers. */
	private checking = false;
	/** What an explicit check found when nothing new came of it, shown until `resultUntil`. */
	private result: 'upToDate' | 'unavailable' | undefined;
	private resultUntil = 0;
	private readonly resultTimer = this._register(new MutableDisposable());
	/** Ends a check the service never answers (it only checks from Idle; builds from sources never do). */
	private readonly checkTimeout = this._register(new MutableDisposable());
	/** Refresh glyph, the Usage page's spinner and a check, built once: the spinner's SMIL clock keeps running. */
	private idleGlyph: Element[] | undefined;
	private readonly attachment = this._register(new MutableDisposable<DisposableStore>());
	private renderPopover: (() => void) | undefined;
	private hidePopover: (() => void) | undefined;

	constructor(
		@IUpdateService private readonly updateService: IUpdateService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IProductService private readonly productService: IProductService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		AgentUpdateButtonContribution.instance = this;
		this._register(toDisposable(() => AgentUpdateButtonContribution.instance = undefined));
		this.state = updateService.state;
		this._register(updateService.onStateChange(state => {
			this.state = state;
			this.sync();
		}));
		this.sync();
	}

	static simulate(state: State | undefined): void {
		const instance = AgentUpdateButtonContribution.instance;
		if (instance) {
			instance.simulated = state;
			instance.sync();
		}
	}

	private get current(): State {
		return this.simulated ?? this.state;
	}

	private sync(): void {
		const state = this.current;
		if (!isActionable(state)) {
			this.hidePopover?.();
			// An explicit check came back with nothing new: say so briefly.
			if (this.checking && state.type === StateType.Idle) {
				this.showResult('upToDate');
			}
			this.checking = this.checking && state.type === StateType.CheckingForUpdates;
		} else {
			this.checking = false;
		}
		if (!this.checking) {
			this.checkTimeout.clear();
		}
		if (!this.attachment.value) {
			this.attach();
		}
		this.renderButton();
		this.renderPopover?.();
	}

	/**
	 * The footer belongs to the agent list (agentHomePane), which can be rebuilt. While an update is
	 * pending, look for it every couple of seconds and re-attach when it was replaced.
	 */
	private attach(): void {
		const store = new DisposableStore();
		this.attachment.value = store;
		const tryAttach = () => {
			if (this.button?.isConnected) {
				return;
			}
			const footer = this.layoutService.mainContainer.querySelector<HTMLElement>('.volt-agent-home-footer');
			if (!footer) {
				return;
			}
			this.button?.remove();
			this.createButton(footer, store);
			this.renderButton();
		};
		tryAttach();
		const window = getWindow(this.layoutService.mainContainer);
		const handle = window.setInterval(tryAttach, 2000);
		store.add(toDisposable(() => {
			window.clearInterval(handle);
			this.button?.remove();
			this.button = undefined;
			this.glyph = undefined;
		}));
	}

	private createButton(footer: HTMLElement, store: DisposableStore): void {
		const button = append(footer, $('button.volt-agent-home-settings.volt-agent-update-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'dialog');
		button.setAttribute('aria-expanded', 'false');
		this.glyph = createUpdateGlyph();
		button.appendChild(this.glyph.root);
		store.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (isActionable(this.current)) {
				if (this.hidePopover) {
					this.hidePopover();
				} else {
					this.showPopover(button);
				}
			} else if (!this.checking && this.current.type !== StateType.CheckingForUpdates) {
				this.checking = true;
				this.result = undefined;
				this.renderButton();
				const idle = this.current.type === StateType.Idle;
				void this.updateService.checkForUpdates(true);
				this.checkTimeout.value = disposableTimeout(() => {
					if (this.checking) {
						this.checking = false;
						this.showResult(idle ? undefined : 'unavailable');
					}
				}, idle ? 60_000 : 900);
			}
		}));
		this.button = button;
	}

	private renderButton(): void {
		const button = this.button;
		const glyph = this.glyph;
		if (!button || !glyph) {
			return;
		}
		const state = this.current;
		// Nothing pending: a round refresh button that checks for the latest release.
		if (!isActionable(state)) {
			const checking = this.checking || state.type === StateType.CheckingForUpdates;
			const result = !checking && Date.now() < this.resultUntil ? this.result : undefined;
			this.idleGlyph ??= [renderIcon(Codicon.refresh), createRefreshSpinner(), renderIcon(Codicon.check)];
			this.idleGlyph[2].classList.add('volt-agent-update-done');
			if (this.idleGlyph[0].parentElement !== button) {
				button.replaceChildren(...this.idleGlyph);
			}
			button.classList.add('idle');
			button.classList.toggle('checking', checking);
			button.classList.toggle('up-to-date', result === 'upToDate');
			button.classList.remove('downloading', 'indeterminate', 'ready');
			const label = checking
				? localize('voltUpdate.checking', "Checking for updates…")
				: result === 'upToDate'
					? localize('voltUpdate.upToDate', "You're on the latest version")
					: result === 'unavailable'
						? localize('voltUpdate.unavailable', "Updates are off in this build")
						: localize('voltUpdate.check', "Check for Updates");
			button.setAttribute('aria-label', label);
			button.toggleAttribute('aria-busy', checking);
			// While it checks, the spinner is all it shows: no tooltip over it.
			setAgentTooltip(button, checking ? undefined : label);
			return;
		}
		button.classList.remove('idle', 'checking', 'up-to-date');
		button.removeAttribute('aria-busy');
		if (glyph.root.parentElement !== button) {
			button.replaceChildren(glyph.root);
		}
		const progress = state.type === StateType.Downloading ? state.progress : undefined;
		button.classList.toggle('downloading', state.type === StateType.Downloading || state.type === StateType.Updating);
		button.classList.toggle('indeterminate', (state.type === StateType.Downloading && progress === undefined) || state.type === StateType.Updating);
		button.classList.toggle('ready', state.type === StateType.Ready || state.type === StateType.Downloaded);
		glyph.progress.setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - (progress ?? 0.25))));
		const label = this.title(state);
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label);
	}

	/** Holds what a check found for a few seconds, then back to the plain refresh button. */
	private showResult(result: 'upToDate' | 'unavailable' | undefined): void {
		this.result = result;
		this.resultUntil = result ? Date.now() + 4_000 : 0;
		this.resultTimer.value = result ? disposableTimeout(() => this.renderButton(), 4_050) : undefined;
		this.renderButton();
	}

	private title(state: State): string {
		const update = updateOf(state);
		const version = update?.productVersion ?? '';
		switch (state.type) {
			case StateType.AvailableForDownload:
				return update?.voltChannel
					? localize('voltUpdate.otherChannel', "{0} {1} is available", channelName(update.voltChannel), version)
					: localize('voltUpdate.available', "{0} {1} is available", this.productService.nameLong, version);
			case StateType.Downloading:
				return state.progress !== undefined
					? localize('voltUpdate.downloadingProgress', "Downloading update ({0}%)", Math.round(state.progress * 100))
					: localize('voltUpdate.downloading', "Downloading update…");
			case StateType.Downloaded:
				return localize('voltUpdate.downloaded', "Update downloaded");
			case StateType.Updating:
				return localize('voltUpdate.installing', "Installing update…");
			case StateType.Ready:
				return localize('voltUpdate.ready', "Restart to update");
			default:
				return '';
		}
	}

	private showPopover(anchor: HTMLButtonElement): void {
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorPosition: AnchorPosition.ABOVE,
			anchorAlignment: AnchorAlignment.LEFT,
			canRelayout: true,
			render: container => {
				const store = new DisposableStore();
				const root = append(container, $('.volt-menu.volt-update-popover'));
				root.setAttribute('role', 'dialog');
				root.tabIndex = -1;
				const content = new DisposableStore();
				store.add(content);
				this.renderPopover = () => {
					content.clear();
					root.replaceChildren();
					this.renderPopoverContent(root, content);
					this.contextViewService.layout();
				};
				this.hidePopover = () => this.contextViewService.hideContextView();
				this.renderPopover();
				anchor.classList.add('open');
				anchor.setAttribute('aria-expanded', 'true');
				store.add(addDisposableListener(getWindow(anchor).document, 'mousedown', e => {
					if (e.target instanceof Node && (root.contains(e.target) || anchor.contains(e.target))) {
						return;
					}
					this.hidePopover?.();
				}, true));
				store.add(addDisposableListener(root, 'keydown', e => {
					if (e.key === 'Escape') {
						e.preventDefault();
						this.hidePopover?.();
						anchor.focus();
					}
				}));
				store.add(toDisposable(() => {
					anchor.classList.remove('open');
					anchor.setAttribute('aria-expanded', 'false');
				}));
				return store;
			},
			onHide: () => {
				this.renderPopover = undefined;
				this.hidePopover = undefined;
			},
		});
	}

	private renderPopoverContent(root: HTMLElement, store: DisposableStore): void {
		const state = this.current;
		const update = updateOf(state);

		const head = append(root, $('.volt-update-popover-head'));
		append(head, $('.volt-update-popover-title')).textContent = this.title(state);
		const detail = this.detail(state, update);
		if (detail) {
			append(head, $('.volt-update-popover-detail')).textContent = detail;
		}
		if (state.type === StateType.Downloading || state.type === StateType.Updating) {
			const bar = append(head, $('.volt-update-popover-bar'));
			const fill = append(bar, $('.volt-update-popover-bar-fill'));
			const progress = state.type === StateType.Downloading ? state.progress : undefined;
			bar.classList.toggle('indeterminate', progress === undefined);
			if (progress !== undefined) {
				fill.style.width = `${Math.round(progress * 100)}%`;
			}
		}

		const notes = summarizeReleaseNotes(update?.notes);
		const releaseUrl = update?.releaseUrl ?? (update?.productVersion && this.productService.voltRelease
			? `https://github.com/${this.productService.voltRelease.repository}/releases/tag/${voltReleaseTag(update.productVersion)}`
			: undefined);
		if (notes.items.length) {
			const body = append(root, $('.volt-update-popover-body'));
			append(body, $('.volt-update-popover-heading')).textContent = localize('voltUpdate.whatsChanged', "What's changed");
			const list = append(body, $('ul.volt-update-popover-list'));
			for (const item of notes.items) {
				append(list, $('li')).textContent = item;
			}
			const more = notes.total - notes.items.length;
			if (releaseUrl) {
				const link = append(append(root, $('.volt-update-popover-footer')), $('a.volt-update-popover-more')) as HTMLAnchorElement;
				link.href = releaseUrl;
				link.textContent = more > 0
					? localize('voltUpdate.moreChanges', "{0} more changes on GitHub", more)
					: localize('voltUpdate.viewOnGitHub', "View the release on GitHub");
				store.add(addDisposableListener(link, 'click', e => {
					e.preventDefault();
					void this.openerService.open(URI.parse(releaseUrl));
				}));
			}
		}

		const actions = append(root, $('.volt-update-popover-actions'));
		if (!notes.items.length && releaseUrl) {
			const notesButton = store.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			notesButton.label = localize('voltUpdate.releaseNotes', "Release Notes");
			store.add(notesButton.onDidClick(() => void this.openerService.open(URI.parse(releaseUrl))));
		}
		const primary = this.primaryAction(state);
		if (primary) {
			const button = store.add(new Button(actions, defaultButtonStyles));
			button.label = primary.label;
			store.add(button.onDidClick(() => {
				this.hidePopover?.();
				void primary.run();
			}));
		}
		if (!actions.childElementCount) {
			actions.remove();
		}
	}

	private detail(state: State, update: IVoltUpdate | undefined): string | undefined {
		const version = update?.productVersion;
		switch (state.type) {
			case StateType.AvailableForDownload:
				return update?.voltChannel
					? localize('voltUpdate.otherChannelDetail', "Installs next to {0} and keeps its own settings.", this.productService.nameLong)
					: localize('voltUpdate.availableDetail', "Download the new version from GitHub.");
			case StateType.Downloading:
			case StateType.Downloaded:
			case StateType.Updating:
				return version ? localize('voltUpdate.toVersion', "{0} {1}", this.productService.nameLong, version) : undefined;
			case StateType.Ready:
				return version
					? localize('voltUpdate.readyDetail', "{0} {1} is installed and starts after a restart.", this.productService.nameLong, version)
					: undefined;
			default:
				return undefined;
		}
	}

	private primaryAction(state: State): { label: string; run: () => Promise<void> } | undefined {
		if (this.simulated) {
			return state.type === StateType.Ready
				? { label: localize('voltUpdate.restart', "Restart to Update"), run: async () => AgentUpdateButtonContribution.simulate(undefined) }
				: undefined;
		}
		switch (state.type) {
			case StateType.AvailableForDownload:
				return { label: localize('voltUpdate.download', "Download"), run: () => this.updateService.downloadUpdate() };
			case StateType.Downloaded:
				return { label: localize('voltUpdate.install', "Install Update"), run: () => this.updateService.applyUpdate() };
			case StateType.Ready:
				return { label: localize('voltUpdate.restart', "Restart to Update"), run: () => this.updateService.quitAndInstall() };
			default:
				return undefined;
		}
	}
}

function channelName(channel: string): string {
	switch (channel) {
		case 'beta': return localize('voltUpdate.beta', "Volt Beta");
		case 'nightly': return localize('voltUpdate.nightly', "Volt Nightly");
		default: return localize('voltUpdate.stable', "Volt");
	}
}

const SAMPLE_NOTES = [
	'## What\'s Changed',
	'* fix(release): unblock nightly browser tests and cli builds in https://github.com/LeulAria/VOLT/pull/16515',
	'* fix(mcp): mark declared tool failures as errors in https://github.com/LeulAria/VOLT/pull/15617',
	'* feat(preview): run the browser on the environment server in https://github.com/LeulAria/VOLT/pull/15328',
	'* fix(shared): find versioned JetBrains macOS app bundles in https://github.com/LeulAria/VOLT/pull/16246',
	'* fix: restore desktop and server typechecks on main in https://github.com/LeulAria/VOLT/pull/16415',
	'* fix(server): reject invalid explicit Bitbucket repositories in https://github.com/LeulAria/VOLT/pull/15876',
	'* feat(agent): compact sidebar rail',
	'* feat(agent): thread notifications with sounds',
	'* feat(update): over-the-air updates from GitHub Releases',
	'* chore: version Volt 0.0.2',
].join('\n');

registerAction2(class SimulateUpdateStateAction extends Action2 {
	constructor() {
		super({
			id: 'volt.update.simulateState',
			title: localize2('voltUpdate.simulate', "Simulate Update State"),
			category: Categories.Developer,
			f1: true,
			precondition: IsDevelopmentContext,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const update: IVoltUpdate = { version: 'simulated', productVersion: '0.0.2', notes: SAMPLE_NOTES, releaseUrl: 'https://github.com/LeulAria/VOLT/releases' };
		const otherChannel: IVoltUpdate = { ...update, productVersion: '0.0.2-nightly.202610070300', voltChannel: 'nightly' };
		const states: { label: string; state: State | undefined }[] = [
			{ label: 'Available for download', state: State.AvailableForDownload(update) },
			{ label: 'Another channel available', state: State.AvailableForDownload(otherChannel) },
			{ label: 'Downloading (no progress)', state: State.DownloadingUpdate(update) },
			{ label: 'Downloading 42%', state: State.DownloadingUpdate(update, 0.42) },
			{ label: 'Ready to restart', state: State.Ready(update) },
			{ label: 'Clear', state: undefined },
		];
		const pick = await quickInputService.pick(states.map(s => ({ label: s.label, state: s.state })), { placeHolder: 'Update state to show in the agent sidebar' });
		if (pick) {
			AgentUpdateButtonContribution.simulate(pick.state);
		}
	}
});
