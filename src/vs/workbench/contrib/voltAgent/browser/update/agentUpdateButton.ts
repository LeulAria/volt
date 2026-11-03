/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentUpdate.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isLinux, language } from '../../../../../base/common/platform.js';
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
import { IUpdateService, State, StateType } from '../../../../../platform/update/common/update.js';
import { IVoltUpdate, voltReleaseTag } from '../../../../../platform/update/common/voltUpdateFeed.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { summarizeReleaseNotes } from '../../common/agentUpdateNotes.js';
import { createRefreshSpinner, setRefreshSpinnerRunning } from '../usage/agentUsageIcons.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createHomeRefreshIcon } from '../home/agentHomeIcons.js';

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
	// Lucide download on the 24px grid, scaled to the 15px the footer's other icons draw at and centered.
	const arrow = document.createElementNS(SVG_NS, 'g');
	arrow.setAttribute('transform', 'translate(6.5 6.5) scale(0.625)');
	arrow.classList.add('volt-agent-update-arrow');
	for (const d of ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5']) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		arrow.appendChild(path);
	}
	svg.appendChild(arrow);
	return { root: svg, progress };
}

/** The title bar entry: VS Code's "Downloading..." over a thin progress line. */
interface ITitleEntry {
	readonly root: HTMLButtonElement;
	readonly label: HTMLElement;
	readonly fill: HTMLElement;
}

/**
 * Updates in two places. While one is available, downloading or ready, the title bar shows it in
 * words ("Downloading…" over its progress, "Restart to Update") and opens a popover below: the
 * product and its current version, what is happening, "What's changed" from the release notes,
 * and the next step (Download, Install or Restart to Update). The update button in the agent
 * sidebar footer, next to Settings and Usage, checks for updates; it shows the update itself
 * (a progress ring, the same popover above it) only where the title bar has no room for it,
 * such as a native title bar.
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
	/** Refresh glyph, the Usage page's spinner and a check, built once; the spinner's SMIL clock runs only while checking. */
	private idleGlyph: Element[] | undefined;
	private readonly attachment = this._register(new MutableDisposable<DisposableStore>());
	private titleEntry: ITitleEntry | undefined;
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
		// The title bar's right column is rebuilt with the layout; the entry finds its place again.
		this._register(layoutService.onDidLayoutMainContainer(() => this.mountTitleEntry()));
		this._register(onDidChangeLayoutMode(() => this.sync()));
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
		this.mountTitleEntry();
		this.renderTitleEntry();
		this.renderButton();
		this.renderPopover?.();
	}

	/** Left of the agent window's title bar toggles (agentViewSidebars), else first in the bar's right column. */
	private mountTitleEntry(): void {
		const right = this.layoutService.mainContainer.querySelector<HTMLElement>('.part.titlebar > .titlebar-container > .titlebar-right');
		if (!right) {
			return;
		}
		const entry = this.titleEntry ??= this.createTitleEntry();
		const toggles = right.querySelector<HTMLElement>(':scope > .volt-agent-titlebar-toggles');
		if (toggles) {
			if (entry.root.nextElementSibling !== toggles) {
				toggles.before(entry.root);
			}
		} else if (right.firstElementChild !== entry.root) {
			right.prepend(entry.root);
		}
	}

	private createTitleEntry(): ITitleEntry {
		const root = $('button.volt-update-titlebar-entry.volt-titlebar-control') as HTMLButtonElement;
		root.type = 'button';
		root.hidden = true;
		root.setAttribute('aria-haspopup', 'dialog');
		root.setAttribute('aria-expanded', 'false');
		const label = append(root, $('span.volt-update-titlebar-label'));
		const fill = append(append(root, $('span.volt-update-titlebar-line')), $('span.volt-update-titlebar-fill'));
		this._register(addDisposableListener(root, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.hidePopover) {
				this.hidePopover();
			} else if (isActionable(this.current)) {
				this.showPopover(root, 'below');
			}
		}));
		this._register(toDisposable(() => root.remove()));
		return { root, label, fill };
	}

	private renderTitleEntry(): void {
		const entry = this.titleEntry;
		if (!entry) {
			return;
		}
		const state = this.current;
		entry.root.hidden = !isActionable(state);
		if (entry.root.hidden) {
			return;
		}
		const progress = state.type === StateType.Downloading ? state.progress : undefined;
		const busy = state.type === StateType.Downloading || state.type === StateType.Updating;
		entry.root.classList.toggle('busy', busy);
		entry.root.classList.toggle('indeterminate', busy && progress === undefined);
		entry.root.classList.toggle('ready', !busy);
		entry.label.textContent = this.titleBarLabel(state);
		entry.fill.style.width = progress !== undefined ? `${Math.round(progress * 100)}%` : '';
		const label = this.title(state);
		entry.root.setAttribute('aria-label', label);
		setAgentTooltip(entry.root, label, undefined, undefined, 'below');
	}

	/** The title bar shows the update: the footer button stays a plain Check for Updates. */
	private titleEntryShown(): boolean {
		const root = this.titleEntry?.root;
		return !!root && root.isConnected && !root.hidden && root.getClientRects().length > 0;
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
					this.showPopover(button, 'above');
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
		// The title bar shows the update: nothing to check for meanwhile, so the footer drops the button.
		button.style.display = isActionable(state) && this.titleEntryShown() ? 'none' : '';
		// Nothing pending: a round refresh button that checks for the latest release.
		if (!isActionable(state)) {
			const checking = this.checking || state.type === StateType.CheckingForUpdates;
			const result = !checking && Date.now() < this.resultUntil ? this.result : undefined;
			this.idleGlyph ??= [createHomeRefreshIcon(), createRefreshSpinner(), renderIcon(Codicon.check)];
			this.idleGlyph[2].classList.add('volt-agent-update-done');
			if (this.idleGlyph[0].parentElement !== button) {
				button.replaceChildren(...this.idleGlyph);
			}
			button.classList.add('idle');
			button.classList.toggle('checking', checking);
			setRefreshSpinnerRunning(this.idleGlyph[1], checking);
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
		// Another channel is its own app, installed next to this one rather than over it.
		const other = update?.voltChannel ? channelName(update.voltChannel) : undefined;
		switch (state.type) {
			case StateType.AvailableForDownload:
				return localize('voltUpdate.available', "{0} {1} is available", other ?? this.productService.nameLong, version);
			case StateType.Downloading:
				if (other) {
					return state.progress !== undefined
						? localize('voltUpdate.downloadingOtherProgress', "Downloading {0} ({1}%)", other, Math.round(state.progress * 100))
						: localize('voltUpdate.downloadingOther', "Downloading {0}…", other);
				}
				return state.progress !== undefined
					? localize('voltUpdate.downloadingProgress', "Downloading update ({0}%)", Math.round(state.progress * 100))
					: localize('voltUpdate.downloading', "Downloading update…");
			case StateType.Downloaded:
				return localize('voltUpdate.downloaded', "Update downloaded");
			case StateType.Updating:
				return other
					? localize('voltUpdate.installingOther', "Installing {0}…", other)
					: localize('voltUpdate.installing', "Installing update…");
			case StateType.Ready:
				if (other) {
					return version
						? localize('voltUpdate.installedOtherVersion', "{0} {1} is installed", other, version)
						: localize('voltUpdate.installedOther', "{0} is installed", other);
				}
				return localize('voltUpdate.ready', "Restart to update");
			default:
				return '';
		}
	}

	/** A few words for the title bar, as VS Code's: what is happening, or the step to take. */
	private titleBarLabel(state: State): string {
		const other = updateOf(state)?.voltChannel;
		switch (state.type) {
			case StateType.AvailableForDownload:
				return other
					? localize('voltUpdate.titlebar.otherAvailable', "{0} Available", channelName(other))
					: localize('voltUpdate.titlebar.available', "Update Available");
			case StateType.Downloading:
				return localize('voltUpdate.titlebar.downloading', "Downloading…");
			case StateType.Downloaded:
				return localize('voltUpdate.titlebar.downloaded', "Install Update");
			case StateType.Updating:
				return localize('voltUpdate.titlebar.installing', "Installing…");
			case StateType.Ready:
				return other
					? localize('voltUpdate.titlebar.openOther', "Open {0}", channelName(other))
					: localize('voltUpdate.titlebar.restart', "Restart to Update");
			default:
				return '';
		}
	}

	/** The popover's heading. */
	private heading(state: State): string {
		const other = updateOf(state)?.voltChannel;
		switch (state.type) {
			case StateType.AvailableForDownload:
				return other
					? localize('voltUpdate.heading.otherAvailable', "{0} Available", channelName(other))
					: localize('voltUpdate.heading.available', "Update Available");
			case StateType.Downloading:
				return localize('voltUpdate.heading.downloading', "Downloading Update");
			case StateType.Downloaded:
				return localize('voltUpdate.heading.downloaded', "Update Downloaded");
			case StateType.Updating:
				return localize('voltUpdate.heading.installing', "Installing Update");
			case StateType.Ready:
				return other
					? localize('voltUpdate.heading.otherInstalled', "{0} Installed", channelName(other))
					: localize('voltUpdate.heading.ready', "Update Ready");
			default:
				return '';
		}
	}

	/** This build: "0.0.2 (41dd792)" and the day it was built, as the About sheet says. */
	private currentBuild(): { readonly version: string; readonly released: string | undefined } {
		const product = this.productService;
		const commit = product.commit?.slice(0, 7);
		const version = `${product.voltVersion ?? product.version}${commit ? ` (${commit})` : ''}`;
		const date = product.date ? new Date(product.date) : undefined;
		const released = date && !isNaN(date.getTime())
			? safeIntl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric' }).value.format(date)
			: undefined;
		return { version, released };
	}

	/**
	 * `below` the title bar entry, aligned to its right edge (it sits near the window's right side);
	 * `above` the footer button, aligned to its left.
	 */
	private showPopover(anchor: HTMLButtonElement, side: 'below' | 'above'): void {
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorPosition: side === 'below' ? AnchorPosition.BELOW : AnchorPosition.ABOVE,
			anchorAlignment: side === 'below' ? AnchorAlignment.RIGHT : AnchorAlignment.LEFT,
			canRelayout: true,
			render: container => {
				const store = new DisposableStore();
				const root = append(container, $(`.volt-menu.volt-update-popover.${side}`));
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

		// VS Code's card: the heading, the product with this build's version and date, then what is happening.
		const head = append(root, $('.volt-update-popover-head'));
		append(head, $('.volt-update-popover-title')).textContent = this.heading(state);
		const product = append(head, $('.volt-update-popover-product'));
		append(product, $('.volt-update-popover-icon')).setAttribute('aria-hidden', 'true');
		const about = append(product, $('.volt-update-popover-about'));
		append(about, $('.volt-update-popover-name')).textContent = this.productService.nameLong;
		const build = this.currentBuild();
		append(about, $('.volt-update-popover-meta')).textContent = localize('voltUpdate.currentVersion', "Current Version: {0}", build.version);
		if (build.released) {
			append(about, $('.volt-update-popover-meta')).textContent = localize('voltUpdate.released', "Released {0}", build.released);
		}
		const status = this.status(state, update);
		if (status) {
			append(head, $('.volt-update-popover-detail')).textContent = status;
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
			const notesButton = store.add(createVoltButton(actions));
			notesButton.label = localize('voltUpdate.releaseNotes', "Release Notes");
			store.add(notesButton.onDidClick(() => void this.openerService.open(URI.parse(releaseUrl))));
		}
		const primary = this.primaryAction(state);
		if (primary) {
			const button = store.add(createVoltButton(actions, 'primary'));
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

	/** What is happening, in a sentence under the product. */
	private status(state: State, update: IVoltUpdate | undefined): string | undefined {
		const version = update?.productVersion;
		const other = update?.voltChannel ? channelName(update.voltChannel) : undefined;
		const name = other ?? this.productService.nameLong;
		switch (state.type) {
			case StateType.AvailableForDownload:
				if (other) {
					return localize('voltUpdate.otherChannelDetail2', "Installs next to {0} with its own settings, and keeps itself up to date.", this.productService.nameLong);
				}
				return version
					? localize('voltUpdate.availableVersion', "{0} {1} is ready to download.", name, version)
					: localize('voltUpdate.availableDetail', "Download the new version from GitHub.");
			case StateType.Downloading:
				return state.progress !== undefined && version
					? localize('voltUpdate.downloadingVersion', "Downloading {0} {1}… {2}%", name, version, Math.round(state.progress * 100))
					: localize('voltUpdate.downloadingWait', "Downloading update, please wait…");
			case StateType.Downloaded:
				return version
					? localize('voltUpdate.downloadedVersion', "{0} {1} is downloaded and ready to install.", name, version)
					: localize('voltUpdate.downloadedDetail', "The update is downloaded and ready to install.");
			case StateType.Updating:
				return localize('voltUpdate.installingWait', "Installing update, please wait…");
			case StateType.Ready:
				if (other) {
					return localize('voltUpdate.installedOtherDetail', "It runs next to {0} with its own settings, and keeps itself up to date.", this.productService.nameLong);
				}
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
		const channel = updateOf(state)?.voltChannel;
		switch (state.type) {
			case StateType.AvailableForDownload:
				return channel && !isLinux
					? { label: localize('voltUpdate.installOther', "Install {0}", channelName(channel)), run: () => this.updateService.downloadUpdate() }
					: { label: localize('voltUpdate.download', "Download"), run: () => this.updateService.downloadUpdate() };
			case StateType.Downloaded:
				return { label: localize('voltUpdate.install', "Install Update"), run: () => this.updateService.applyUpdate() };
			case StateType.Ready:
				return channel
					? { label: localize('voltUpdate.openOther', "Open {0}", channelName(channel)), run: () => this.updateService.quitAndInstall() }
					: { label: localize('voltUpdate.restart', "Restart to Update"), run: () => this.updateService.quitAndInstall() };
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
			{ label: 'Downloaded (Windows)', state: State.Downloaded(update) },
			{ label: 'Installing', state: State.Updating(update) },
			{ label: 'Ready to restart', state: State.Ready(update) },
			{ label: 'Clear', state: undefined },
		];
		const pick = await quickInputService.pick(states.map(s => ({ label: s.label, state: s.state })), { placeHolder: 'Update state to show in the title bar and the agent sidebar' });
		if (pick) {
			AgentUpdateButtonContribution.simulate(pick.state);
		}
	}
});
