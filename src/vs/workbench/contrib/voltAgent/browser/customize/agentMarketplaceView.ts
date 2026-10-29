/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { createCustomizationKindIcon } from '../chrome/agentModeIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { AgentCustomizationKind, kindInfo, safeItemName } from './agentCustomize.js';
import { IAgentCustomizeService } from './agentCustomizeService.js';
import { showCustomizeInputDialog } from './agentCustomizeDialogs.js';
import { formatInstalls, githubLink, IAgentMarketplaceService, IMarketplace, IMarketplacePlugin, IMarketplacePluginDetail, ISkillsShDetail, ISkillsShSkill, MarketplaceLink, MarketplaceScope } from './agentMarketplace.js';

export interface IAgentMarketplaceScope {
	readonly label: string;
	readonly subtitle?: string;
	readonly scope: MarketplaceScope;
}

export interface IAgentMarketplaceViewHost {
	/** Where a skill can be installed: User first, then each workspace folder. */
	scopes(): readonly IAgentMarketplaceScope[];
	/** Opens a file in the right panel. */
	openResource(resource: URI): void;
	/** Opens a web page in the right panel's browser. */
	openUrl(url: string): void;
	/** The element dialogs dim. */
	dialogHost(): HTMLElement;
	/** The body changed height. */
	relayout(): void;
	scrollTop(): number;
	setScrollTop(scrollTop: number): void;
	/** The trail after Customize in the window's title bar: Marketplace, then the open page. */
	setCrumbs(crumbs: readonly IAgentPageCrumb[]): void;
}

/** One step of the title bar's trail; `run` makes it a link. */
export interface IAgentPageCrumb {
	readonly label: string;
	readonly run?: () => void;
}

/** The skill or plugin whose page is open in place of the listing. */
type MarketplaceDetail = { readonly kind: 'skill'; readonly skill: ISkillsShSkill } | { readonly kind: 'plugin'; readonly marketplace: string; readonly name: string };

interface IContentRow {
	readonly kind: AgentCustomizationKind | 'file';
	readonly name: string;
	readonly link: MarketplaceLink;
}

type MarketplaceFilter = { readonly kind: 'all' } | { readonly kind: 'skills' } | { readonly kind: 'personal' } | { readonly kind: 'marketplace'; readonly name: string };

const DISCOVER_COUNT = 8;
const POPULAR_PAGE = 10;
const PLUGIN_PAGE = 4;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 40;
const DETAIL_FILE_PAGE = 8;
/** Widths of placeholder names, in percent, so a loading column looks like varied text. */
const SKELETON_WIDTHS = [58, 44, 66, 50, 72, 40, 62, 54];
const CONTENT_KINDS: readonly AgentCustomizationKind[] = ['mcp', 'skill', 'subagent', 'rule', 'command', 'hook'];

function ownerOf(source: string): string | undefined {
	const match = /^([\w.-]+)\/[\w.-]+$/.exec(source);
	return match ? match[1] : undefined;
}

/** The GitHub avatar of a skill's owner; https images are allowed by the workbench CSP. */
function avatarUrl(source: string): string | undefined {
	const owner = ownerOf(source);
	return owner ? `https://github.com/${encodeURIComponent(owner)}.png?size=96` : undefined;
}

/**
 * Browse Marketplace: skills from skills.sh and plugins from the marketplaces registered with
 * Claude Code or Volt, each with Add. Shown in place of the Customize list.
 */
export class AgentMarketplaceView extends Disposable {

	private readonly chipsEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly chipStore = this._register(new DisposableStore());
	private filter: MarketplaceFilter = { kind: 'all' };
	private query = '';
	private popular: readonly ISkillsShSkill[] | undefined;
	private popularError: string | undefined;
	private searchResults: readonly ISkillsShSkill[] | undefined;
	private searchError: string | undefined;
	private marketplaces: readonly IMarketplace[] | undefined;
	private readonly descriptions = new Map<string, string>();
	/** Sections expanded with Show more: section id to rows shown. */
	private readonly shown = new Map<string, number>();
	/** Skills and plugins being added right now, by id. */
	private readonly busy = new Set<string>();
	private loadCts: CancellationTokenSource | undefined;
	private searchCts: CancellationTokenSource | undefined;
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private visible = false;
	private detail: MarketplaceDetail | undefined;
	private detailCts: CancellationTokenSource | undefined;
	/** Where the listing was scrolled when a page opened, to return there. */
	private listScrollTop = 0;
	/** Found skill folders by skill id; null when the skill's files could not be found. */
	private readonly skillDetails = new Map<string, ISkillsShDetail | null>();
	/** Plugin contents by `marketplace/name`, or the error reading them. */
	private readonly pluginDetails = new Map<string, IMarketplacePluginDetail | { readonly error: string }>();

	constructor(
		private readonly header: HTMLElement,
		body: HTMLElement,
		private readonly host: IAgentMarketplaceViewHost,
		@IAgentMarketplaceService private readonly marketplace: IAgentMarketplaceService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.chipsEl = append(header, $('.volt-customize-filters.volt-marketplace-chips'));
		this.bodyEl = append(body, $('.volt-marketplace'));
		this._register(this.marketplace.onDidChange(() => {
			this.marketplaces = undefined;
			if (this.visible) {
				void this.loadMarketplaces();
			}
		}));
		// The listing showed from the cache and a refetch behind it brought new data: take it.
		this._register(this.marketplace.onDidRefresh(() => {
			this.popular = undefined;
			if (this.visible) {
				this.load();
				if (this.query.length >= 2) {
					this.search(this.query);
				}
			} else {
				this.searchResults = undefined;
			}
		}));
		this._register(this.customize.onDidChange(() => {
			if (this.visible) {
				this.render();
			}
		}));
		this._register({
			dispose: () => {
				clearTimeout(this.searchTimer);
				this.loadCts?.dispose(true);
				this.searchCts?.dispose(true);
				this.detailCts?.dispose(true);
			}
		});
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.chipsEl.classList.toggle('hidden', !visible);
		this.bodyEl.classList.toggle('hidden', !visible);
		if (!visible) {
			// Manage and back lands on the listing, like Cursor.
			this.detail = undefined;
			this.detailCts?.dispose(true);
			this.detailCts = undefined;
			this.syncDetailChrome();
			this.loadCts?.dispose(true);
			this.loadCts = undefined;
			this.searchCts?.dispose(true);
			this.searchCts = undefined;
			clearTimeout(this.searchTimer);
			return;
		}
		this.load();
		this.render();
	}

	setQuery(query: string): void {
		const next = query.trim();
		if (next === this.query) {
			return;
		}
		this.query = next;
		this.searchResults = undefined;
		this.searchError = undefined;
		clearTimeout(this.searchTimer);
		this.searchCts?.dispose(true);
		this.searchCts = undefined;
		if (this.visible && next.length >= 2) {
			this.searchTimer = setTimeout(() => this.search(next), SEARCH_DEBOUNCE_MS);
		}
		this.render();
	}

	/** Opens a skill's page in place of the listing. */
	openSkill(skill: ISkillsShSkill): void {
		this.openDetail({ kind: 'skill', skill });
	}

	/** Opens a plugin's page in place of the listing. */
	openPlugin(plugin: IMarketplacePlugin): void {
		this.openDetail({ kind: 'plugin', marketplace: plugin.marketplace, name: plugin.name });
	}

	private openDetail(detail: MarketplaceDetail): void {
		if (!this.detail) {
			this.listScrollTop = this.host.scrollTop();
		}
		this.detail = detail;
		this.loadDetail(detail);
		this.render();
		this.host.setScrollTop(0);
	}

	private closeDetail(): void {
		if (!this.detail) {
			return;
		}
		this.detail = undefined;
		this.detailCts?.dispose(true);
		this.detailCts = undefined;
		this.render();
		this.host.setScrollTop(this.listScrollTop);
	}

	private loadDetail(detail: MarketplaceDetail): void {
		this.detailCts?.dispose(true);
		const cts = this.detailCts = new CancellationTokenSource();
		const done = () => {
			if (!cts.token.isCancellationRequested && this.visible) {
				this.render();
			}
		};
		if (detail.kind === 'skill') {
			const id = detail.skill.id;
			// A skill that was not found is asked again: GitHub may have been rate limited.
			if (this.skillDetails.get(id)) {
				return;
			}
			this.skillDetails.delete(id);
			this.marketplace.skillDetail(detail.skill, cts.token).then(found => {
				this.skillDetails.set(id, found ?? null);
				if (found?.description) {
					this.descriptions.set(id, found.description);
				}
			}, () => this.skillDetails.set(id, null)).finally(done);
			return;
		}
		const key = `${detail.marketplace}/${detail.name}`;
		const cached = this.pluginDetails.get(key);
		if (cached && !('error' in cached)) {
			return;
		}
		this.pluginDetails.delete(key);
		const plugin = this.pluginOf(detail);
		if (!plugin) {
			// The marketplaces are still loading; render() asks again once they are in.
			return;
		}
		this.marketplace.pluginDetail(plugin, cts.token).then(
			result => this.pluginDetails.set(key, result),
			err => this.pluginDetails.set(key, { error: err instanceof Error ? err.message : String(err) }),
		).finally(done);
	}

	/** The plugin as listed now: Add changes it, and the marketplaces are read again. */
	private pluginOf(detail: Extract<MarketplaceDetail, { kind: 'plugin' }>): IMarketplacePlugin | undefined {
		return this.marketplaces?.find(marketplace => marketplace.name === detail.marketplace)?.plugins.find(plugin => plugin.name === detail.name);
	}

	private openLink(link: MarketplaceLink): void {
		if (link.kind === 'url') {
			this.host.openUrl(link.url);
		} else {
			this.host.openResource(link.resource);
		}
	}

	private load(): void {
		if (!this.popular && !this.loadCts) {
			const cts = this.loadCts = new CancellationTokenSource();
			this.marketplace.popularSkills(cts.token).then(skills => {
				if (cts.token.isCancellationRequested) {
					return;
				}
				this.popular = skills;
				this.popularError = skills.length ? undefined : localize('voltMarketplace.offline', "Couldn't reach skills.sh. Check your connection and try again.");
				this.render();
				void this.loadDescriptions(skills.slice(0, DISCOVER_COUNT));
			}, err => {
				if (!cts.token.isCancellationRequested) {
					this.popularError = err instanceof Error ? err.message : String(err);
					this.render();
				}
			}).finally(() => {
				if (this.loadCts === cts) {
					this.loadCts = undefined;
				}
			});
		}
		if (!this.marketplaces) {
			void this.loadMarketplaces();
		}
		if (this.query.length >= 2 && !this.searchResults) {
			this.search(this.query);
		}
	}

	private async loadMarketplaces(): Promise<void> {
		try {
			this.marketplaces = await this.marketplace.listMarketplaces();
		} catch {
			this.marketplaces = [];
		}
		if (this.filter.kind === 'marketplace' && !this.marketplaces.some(candidate => candidate.name === (this.filter as { name: string }).name)) {
			this.filter = { kind: 'all' };
		}
		if (this.detail?.kind === 'plugin' && !this.pluginDetails.has(`${this.detail.marketplace}/${this.detail.name}`)) {
			this.loadDetail(this.detail);
		}
		if (this.visible) {
			this.render();
		}
	}

	/** Descriptions come from each skill's SKILL.md; only the few cards on screen ask GitHub. */
	private async loadDescriptions(skills: readonly ISkillsShSkill[]): Promise<void> {
		const cts = new CancellationTokenSource();
		this._register({ dispose: () => cts.dispose(true) });
		for (const skill of skills) {
			if (this.descriptions.has(skill.id)) {
				continue;
			}
			const detail = await this.marketplace.skillDetail(skill, cts.token).catch(() => undefined);
			if (cts.token.isCancellationRequested) {
				return;
			}
			if (detail?.description) {
				this.descriptions.set(skill.id, detail.description);
				const card = this.bodyEl.querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(skill.id)}"] .volt-marketplace-card-description`);
				if (card) {
					card.textContent = detail.description;
				}
			}
		}
	}

	private search(query: string): void {
		this.searchCts?.dispose(true);
		const cts = this.searchCts = new CancellationTokenSource();
		this.marketplace.searchSkills(query, SEARCH_LIMIT, cts.token).then(skills => {
			if (cts.token.isCancellationRequested || query !== this.query) {
				return;
			}
			this.searchResults = skills;
			this.searchError = undefined;
			this.render();
		}, err => {
			if (!cts.token.isCancellationRequested && query === this.query) {
				this.searchResults = [];
				this.searchError = err instanceof Error ? err.message : String(err);
				this.render();
			}
		});
	}

	//#region Rendering

	private render(): void {
		if (!this.visible) {
			return;
		}
		// Emptying the body clamps the scroll position to 0; restore it once the rows are back.
		const scrollTop = this.host.scrollTop();
		this.renderStore.clear();
		clearNode(this.bodyEl);
		this.syncDetailChrome();
		if (this.detail) {
			this.renderDetail(this.detail);
			this.host.relayout();
			this.host.setScrollTop(scrollTop);
			return;
		}
		this.renderChips();
		const searching = this.query.length > 0;
		const filter = this.filter;
		if (searching) {
			this.renderSearch();
		} else if (filter.kind === 'all') {
			this.renderDiscover();
			this.renderPopular(POPULAR_PAGE);
			for (const marketplace of this.marketplaces ?? []) {
				this.renderMarketplace(marketplace, PLUGIN_PAGE);
			}
			if (!this.marketplaces) {
				this.skeletonSection(PLUGIN_PAGE, localize('voltMarketplace.loadingPlugins', "Loading plugin marketplaces…"));
			}
		} else if (filter.kind === 'skills') {
			this.renderPopular(POPULAR_PAGE * 3);
		} else if (!this.marketplaces) {
			this.skeletonSection(PLUGIN_PAGE * 2, localize('voltMarketplace.loadingPlugins', "Loading plugin marketplaces…"));
		} else if (filter.kind === 'personal') {
			const personal = this.marketplaces.filter(marketplace => marketplace.registry === 'volt');
			if (!personal.length) {
				this.emptyState(
					localize('voltMarketplace.noPersonal', "No personal marketplaces yet"),
					localize('voltMarketplace.noPersonalHint', "Create a team marketplace or import one from GitHub or disk with Add Marketplace."),
				);
			}
			for (const marketplace of personal) {
				this.renderMarketplace(marketplace, PLUGIN_PAGE * 3);
			}
		} else {
			const marketplace = this.marketplaces.find(candidate => candidate.name === filter.name);
			if (marketplace) {
				this.renderMarketplace(marketplace, PLUGIN_PAGE * 4);
			}
		}
		this.host.relayout();
		this.host.setScrollTop(scrollTop);
	}

	private renderChips(): void {
		const scrollLeft = this.chipsEl.querySelector('.volt-customize-chips')?.scrollLeft ?? 0;
		this.chipStore.clear();
		clearNode(this.chipsEl);
		const chips = append(this.chipsEl, $('.volt-customize-chips'));
		const add = (label: string, filter: MarketplaceFilter) => {
			const chip = append(chips, $('button.volt-customize-chip')) as HTMLButtonElement;
			chip.type = 'button';
			chip.textContent = label;
			chip.classList.toggle('active', sameFilter(filter, this.filter));
			chip.setAttribute('aria-pressed', String(sameFilter(filter, this.filter)));
			this.chipStore.add(addDisposableListener(chip, 'click', () => {
				this.filter = filter;
				this.render();
			}));
		};
		add(localize('voltMarketplace.all', "All"), { kind: 'all' });
		add('skills.sh', { kind: 'skills' });
		for (const marketplace of (this.marketplaces ?? []).filter(candidate => candidate.registry !== 'volt')) {
			add(marketplace.shortName ?? marketplace.displayName, { kind: 'marketplace', name: marketplace.name });
		}
		add(localize('voltMarketplace.personal', "Personal"), { kind: 'personal' });
		const addMarketplace = append(chips, $('button.volt-customize-chip.add')) as HTMLButtonElement;
		addMarketplace.type = 'button';
		addMarketplace.appendChild(renderIcon(Codicon.add));
		append(addMarketplace, $('span')).textContent = localize('voltMarketplace.addMarketplace', "Add Marketplace");
		this.chipStore.add(addDisposableListener(addMarketplace, 'click', () => this.showAddMarketplaceMenu(addMarketplace)));
		chips.scrollLeft = scrollLeft;
	}

	private section(title: string, count: number | undefined, actions?: (header: HTMLElement) => void): HTMLElement {
		const section = append(this.bodyEl, $('section.volt-customize-section'));
		const header = append(section, $('.volt-customize-section-header'));
		const heading = append(header, $('h3.volt-customize-section-title'));
		append(heading, $('span')).textContent = title;
		if (count !== undefined) {
			append(heading, $('span.count')).textContent = String(count);
		}
		actions?.(append(header, $('.volt-customize-section-actions')));
		return section;
	}

	private message(text: string, error = false): void {
		const message = append(this.bodyEl, $('.volt-customize-message'));
		message.classList.toggle('error', error);
		message.textContent = text;
	}

	private emptyState(title: string, hint: string): void {
		const box = append(this.bodyEl, $('.volt-customize-empty-box'));
		append(box, $('.title')).textContent = title;
		append(box, $('.hint')).textContent = hint;
	}

	//#region Skeletons

	/** While something loads, still grey blocks in its shape stand in for it; `label` is what a screen reader hears. */
	private skeleton(element: HTMLElement, label: string): HTMLElement {
		element.classList.add('skeleton');
		element.setAttribute('role', 'status');
		element.setAttribute('aria-busy', 'true');
		element.setAttribute('aria-label', label);
		return element;
	}

	/** A block of placeholder text; a number width is a percent of the line. */
	private bar(parent: HTMLElement, kind: string, width?: number | string): HTMLElement {
		const bar = append(parent, $(`.volt-marketplace-skeleton.${kind}`));
		if (width !== undefined) {
			bar.style.width = typeof width === 'number' ? `${width}%` : width;
		}
		return bar;
	}

	private skeletonCards(parent: HTMLElement, label: string): void {
		const track = append(append(parent, $('.volt-marketplace-carousel')), $('.volt-marketplace-carousel-track'));
		this.skeleton(track, label);
		for (let i = 0; i < 3; i++) {
			const card = append(track, $('.volt-marketplace-card'));
			append(card, $('.volt-marketplace-icon'));
			const copy = append(card, $('.volt-marketplace-card-copy'));
			this.bar(copy, 'name', SKELETON_WIDTHS[i]);
			this.bar(copy, 'text', 88);
			this.bar(copy, 'meta', 36);
		}
	}

	private skeletonGrid(parent: HTMLElement, rows: number, label: string): void {
		const grid = this.skeleton(append(parent, $('.volt-marketplace-grid')), label);
		for (let i = 0; i < rows; i++) {
			const row = append(grid, $('.volt-marketplace-row'));
			append(row, $('.volt-marketplace-icon'));
			const copy = append(row, $('.volt-marketplace-row-copy'));
			this.bar(copy, 'name', SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]);
			this.bar(copy, 'text', SKELETON_WIDTHS[(i + 3) % SKELETON_WIDTHS.length] + 24);
			this.bar(row, 'pill');
		}
	}

	/** A plugin marketplace whose name is not known yet. */
	private skeletonSection(rows: number, label: string): void {
		const section = append(this.bodyEl, $('section.volt-customize-section'));
		this.bar(append(section, $('.volt-customize-section-header')), 'heading', '140px');
		this.skeletonGrid(section, rows, label);
	}

	private skeletonLines(parent: HTMLElement, label: string): void {
		const lines = this.skeleton(append(parent, $('.volt-marketplace-detail-description')), label);
		for (const width of [100, 94, 58]) {
			this.bar(lines, 'line', width);
		}
	}

	/** What a skill or plugin brings, while it is read from GitHub. */
	private skeletonContents(parent: HTMLElement, label: string): void {
		const section = append(parent, $('section.volt-customize-section'));
		this.bar(append(section, $('.volt-customize-section-header')), 'heading', '72px');
		const card = this.skeleton(append(section, $('.volt-customize-card.volt-marketplace-contents')), label);
		for (const width of [34, 48, 26]) {
			const row = append(card, $('.volt-customize-row.single'));
			append(row, $('.volt-customize-tile'));
			this.bar(row, 'name', width);
		}
	}

	//#endregion

	private showMore(parent: HTMLElement, id: string, total: number, page: number): void {
		const shown = this.shown.get(id) ?? page;
		if (total <= shown) {
			return;
		}
		const more = append(parent, $('button.volt-customize-show-more')) as HTMLButtonElement;
		more.type = 'button';
		append(more, $('span')).textContent = localize('voltCustomize.showMore', "Show {0} more", total - shown);
		more.appendChild(renderIcon(Codicon.chevronDown));
		this.renderStore.add(addDisposableListener(more, 'click', () => {
			this.shown.set(id, shown + Math.max(page, 20));
			this.render();
		}));
	}

	private renderDiscover(): void {
		if (!this.popular && !this.popularError) {
			this.skeletonCards(this.section(localize('voltMarketplace.discover', "Discover"), undefined), localize('voltMarketplace.loadingSkills', "Loading skills from skills.sh…"));
			return;
		}
		const skills = this.popular?.slice(0, DISCOVER_COUNT) ?? [];
		if (!skills.length) {
			return;
		}
		const section = this.section(localize('voltMarketplace.discover', "Discover"), undefined);
		const wrap = append(section, $('.volt-marketplace-carousel'));
		const track = append(wrap, $('.volt-marketplace-carousel-track'));
		for (const skill of skills) {
			const card = append(track, $('.volt-marketplace-card'));
			card.dataset.skillId = skill.id;
			card.tabIndex = 0;
			card.setAttribute('role', 'button');
			this.icon(card, skill);
			const copy = append(card, $('.volt-marketplace-card-copy'));
			append(copy, $('.volt-marketplace-card-name')).textContent = skill.name;
			append(copy, $('.volt-marketplace-card-description')).textContent = this.descriptions.get(skill.id) ?? localize('voltMarketplace.installs', "{0} installs", formatInstalls(skill.installs));
			const publisher = append(copy, $('.volt-marketplace-card-publisher'));
			publisher.appendChild(renderIcon(Codicon.verified));
			append(publisher, $('span')).textContent = ownerOf(skill.source) ?? skill.source;
			this.renderStore.add(addDisposableListener(card, 'click', () => this.openSkill(skill)));
			this.renderStore.add(addDisposableListener(card, 'keydown', e => {
				if (e.key === 'Enter') {
					this.openSkill(skill);
				}
			}));
		}
		const next = append(wrap, $('button.volt-marketplace-carousel-next')) as HTMLButtonElement;
		next.type = 'button';
		next.appendChild(renderIcon(Codicon.chevronRight));
		next.setAttribute('aria-label', localize('voltMarketplace.next', "More"));
		const prev = append(wrap, $('button.volt-marketplace-carousel-prev')) as HTMLButtonElement;
		prev.type = 'button';
		prev.appendChild(renderIcon(Codicon.chevronLeft));
		prev.setAttribute('aria-label', localize('voltMarketplace.previous', "Back"));
		const syncArrows = () => {
			prev.classList.toggle('hidden', track.scrollLeft <= 2);
			next.classList.toggle('hidden', track.scrollLeft + track.clientWidth >= track.scrollWidth - 2);
		};
		this.renderStore.add(addDisposableListener(track, 'scroll', syncArrows));
		this.renderStore.add(addDisposableListener(next, 'click', () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' })));
		this.renderStore.add(addDisposableListener(prev, 'click', () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: 'smooth' })));
		getWindow(track).requestAnimationFrame(syncArrows);
	}

	private renderPopular(page: number): void {
		if (!this.popular && this.popularError) {
			this.message(this.popularError, true);
			return;
		}
		const section = this.section(localize('voltMarketplace.popular', "Popular on skills.sh"), undefined, actions => {
			const link = append(actions, $('button.volt-customize-text-button')) as HTMLButtonElement;
			link.type = 'button';
			link.textContent = localize('voltMarketplace.openSite', "skills.sh");
			link.appendChild(renderIcon(Codicon.linkExternal));
			this.renderStore.add(addDisposableListener(link, 'click', () => this.host.openUrl('https://skills.sh')));
		});
		const skills = this.popular;
		if (!skills) {
			this.skeletonGrid(section, POPULAR_PAGE, localize('voltMarketplace.loadingSkills', "Loading skills from skills.sh…"));
			return;
		}
		const id = `popular:${page}`;
		this.skillGrid(section, skills.slice(0, this.shown.get(id) ?? page));
		this.showMore(section, id, skills.length, page);
	}

	private renderSearch(): void {
		const query = this.query;
		const plugins = rankPlugins((this.marketplaces ?? []).flatMap(marketplace => marketplace.plugins), query);
		if (query.length < 2) {
			this.message(localize('voltMarketplace.typeMore', "Type at least two characters to search skills.sh."));
		} else if (!this.searchResults) {
			this.skeletonGrid(this.section(localize('voltMarketplace.skillsSh', "Skills on skills.sh"), undefined), 6, localize('voltMarketplace.searching', "Searching skills.sh…"));
		} else if (this.searchError) {
			this.message(this.searchError, true);
		} else {
			const section = this.section(localize('voltMarketplace.skillsSh', "Skills on skills.sh"), this.searchResults.length);
			if (this.searchResults.length) {
				const id = `search-skills:${query}`;
				this.skillGrid(section, this.searchResults.slice(0, this.shown.get(id) ?? POPULAR_PAGE));
				this.showMore(section, id, this.searchResults.length, POPULAR_PAGE);
			} else {
				append(section, $('.volt-customize-message')).textContent = localize('voltMarketplace.noSkills', "No skills match \"{0}\".", query);
			}
		}
		if (plugins.length) {
			const section = this.section(localize('voltMarketplace.plugins', "Plugins"), plugins.length);
			const id = `search-plugins:${query}`;
			this.pluginGrid(section, plugins.slice(0, this.shown.get(id) ?? PLUGIN_PAGE * 2));
			this.showMore(section, id, plugins.length, PLUGIN_PAGE * 2);
		}
	}

	private renderMarketplace(marketplace: IMarketplace, page: number): void {
		const section = this.section(marketplace.displayName, undefined, actions => {
			const more = append(actions, $('button.volt-customize-icon-button')) as HTMLButtonElement;
			more.type = 'button';
			more.appendChild(renderIcon(Codicon.ellipsis));
			more.setAttribute('aria-label', localize('voltMarketplace.marketplaceActions', "Marketplace actions"));
			this.renderStore.add(addDisposableListener(more, 'click', () => this.showMarketplaceMenu(more, marketplace)));
		});
		if (!marketplace.plugins.length) {
			append(section, $('.volt-customize-message')).textContent = localize('voltMarketplace.emptyMarketplace', "This marketplace lists no plugins yet.");
			return;
		}
		const id = `marketplace:${marketplace.name}:${page}`;
		this.pluginGrid(section, marketplace.plugins.slice(0, this.shown.get(id) ?? page));
		this.showMore(section, id, marketplace.plugins.length, page);
	}

	//#region Detail page

	/** While a page is open the search row goes away and the title bar reads Customize / Marketplace / name. */
	private syncDetailChrome(): void {
		const detail = this.visible ? this.detail : undefined;
		this.header.classList.toggle('volt-marketplace-detail-open', !!detail);
		this.chipsEl.classList.toggle('hidden', !this.visible || !!detail);
		this.host.setCrumbs(detail ? [
			{ label: localize('voltMarketplace.marketplace', "Marketplace"), run: () => this.closeDetail() },
			{ label: detail.kind === 'skill' ? detail.skill.name : detail.name },
		] : []);
	}

	/** The page's link beside Add: the skill on skills.sh, the plugin's repository or folder. */
	private pageLink(head: HTMLElement, detail: MarketplaceDetail): void {
		const page = this.detailPage(detail);
		if (!page) {
			return;
		}
		const link = append(head, $('button.volt-marketplace-page-link')) as HTMLButtonElement;
		link.type = 'button';
		append(link, $('span')).textContent = page.label;
		link.appendChild(renderIcon(Codicon.arrowRight));
		setAgentTooltip(link, page.link.kind === 'url' ? page.link.url : page.link.resource.fsPath);
		this.renderStore.add(addDisposableListener(link, 'click', () => this.openLink(page.link)));
	}

	/** Where the page's link goes: the skill on skills.sh, the plugin's repository or folder. */
	private detailPage(detail: MarketplaceDetail): { label: string; link: MarketplaceLink } | undefined {
		if (detail.kind === 'skill') {
			return { label: 'skills.sh', link: { kind: 'url', url: this.marketplace.skillPage(detail.skill).toString(true) } };
		}
		const found = this.pluginDetails.get(`${detail.marketplace}/${detail.name}`);
		const page = found && !('error' in found) ? found.page : undefined;
		const homepage = this.pluginOf(detail)?.homepage;
		if (page?.kind === 'url') {
			return { label: /^https:\/\/github\.com\//.test(page.url) ? 'GitHub' : localize('voltMarketplace.homepage', "Homepage"), link: page };
		}
		if (homepage) {
			return { label: localize('voltMarketplace.homepage', "Homepage"), link: { kind: 'url', url: homepage } };
		}
		return page ? { label: localize('voltMarketplace.folder', "Folder"), link: page } : undefined;
	}

	private renderDetail(detail: MarketplaceDetail): void {
		const page = append(this.bodyEl, $('.volt-marketplace-detail'));
		const head = append(page, $('.volt-marketplace-detail-head'));
		if (detail.kind === 'skill') {
			this.renderSkillDetail(page, head, detail.skill);
			return;
		}
		const plugin = this.pluginOf(detail);
		append(head, $('.volt-marketplace-icon.box.large')).appendChild(createCustomizationKindIcon('plugin'));
		append(head, $('h2.volt-marketplace-detail-title')).textContent = detail.name;
		this.pageLink(head, detail);
		if (!plugin) {
			if (this.marketplaces) {
				this.detailMessage(page, localize('voltMarketplace.pluginGone', "{0} is no longer listed in {1}.", detail.name, detail.marketplace));
				return;
			}
			const loading = localize('voltMarketplace.loadingPlugin', "Loading…");
			this.bar(head, 'button');
			this.skeletonLines(page, loading);
			const meta = append(page, $('.volt-marketplace-detail-meta'));
			for (const width of ['84px', '120px', '72px']) {
				this.bar(meta, 'meta-item', width);
			}
			this.skeletonContents(page, loading);
			return;
		}
		const id = `${plugin.marketplace}/${plugin.name}`;
		const button = this.addButton(head, plugin.installed, this.busy.has(id), true);
		if (plugin.source.kind === 'unsupported' && !plugin.installed) {
			button.disabled = true;
			setAgentTooltip(button, localize('voltMarketplace.unsupportedTip', "Volt can't install plugins from {0} sources yet.", plugin.source.label));
		}
		this.renderStore.add(addDisposableListener(button, 'click', () => {
			if (this.busy.has(id)) {
				return;
			}
			if (plugin.installed) {
				if (plugin.installedInVolt) {
					this.showInstalledPluginMenu(button, plugin);
				}
				return;
			}
			void this.installPlugin(plugin, id);
		}));
		if (plugin.description) {
			append(page, $('p.volt-marketplace-detail-description')).textContent = plugin.description;
		}
		const meta = append(page, $('.volt-marketplace-detail-meta'));
		if (plugin.author) {
			this.metaItem(meta, Codicon.briefcase, plugin.author);
		}
		const marketplace = this.marketplaces?.find(candidate => candidate.name === plugin.marketplace);
		this.metaItem(meta, Codicon.verified, marketplace?.displayName ?? plugin.marketplace);
		if (plugin.category) {
			this.metaItem(meta, Codicon.tag, plugin.category);
		}
		const found = this.pluginDetails.get(id);
		if (!found) {
			this.skeletonContents(page, localize('voltMarketplace.loadingContents', "Reading what the plugin includes…"));
		} else if ('error' in found) {
			this.detailMessage(page, localize('voltMarketplace.contentsFailed', "Couldn't read the plugin: {0}", found.error), true);
		} else if (!found.contents.length) {
			this.detailMessage(page, plugin.source.kind === 'unsupported'
				? localize('voltMarketplace.contentsUnsupported', "Volt can't read plugins from {0} sources yet.", plugin.source.label)
				: localize('voltMarketplace.noContents', "This plugin has no MCP servers, skills, subagents, rules, commands or hooks Volt can list."));
		} else {
			for (const kind of CONTENT_KINDS) {
				const rows = found.contents.filter(content => content.kind === kind);
				if (rows.length) {
					this.contentSection(page, `plugin:${id}:${kind}`, kindInfo(kind).plural, rows);
				}
			}
		}
	}

	private renderSkillDetail(page: HTMLElement, head: HTMLElement, skill: ISkillsShSkill): void {
		this.icon(head, skill);
		head.lastElementChild?.classList.add('large');
		append(head, $('h2.volt-marketplace-detail-title')).textContent = skill.name;
		this.pageLink(head, { kind: 'skill', skill });
		const added = this.installedSkillNames().has(skill.name.toLowerCase()) || this.installedSkillNames().has(skill.skillId.toLowerCase());
		const button = this.addButton(head, added, this.busy.has(skill.id), true);
		this.renderStore.add(addDisposableListener(button, 'click', () => {
			if (!added && !this.busy.has(skill.id)) {
				this.pickSkillScope(button, skill);
			}
		}));
		const loaded = this.skillDetails.has(skill.id);
		const found = this.skillDetails.get(skill.id);
		const description = found?.description || this.descriptions.get(skill.id);
		if (description || loaded) {
			append(page, $('p.volt-marketplace-detail-description')).textContent = description ?? '';
		} else {
			this.skeletonLines(page, localize('voltMarketplace.loadingDescription', "Loading…"));
		}
		const meta = append(page, $('.volt-marketplace-detail-meta'));
		const owner = /^([\w.-]+)\/[\w.-]+$/.exec(skill.source)?.[1];
		this.metaItem(meta, Codicon.briefcase, owner ?? skill.source);
		this.metaItem(meta, Codicon.github, found?.repo ?? skill.source, owner ? () => this.host.openUrl(`https://github.com/${found?.repo ?? skill.source}`) : undefined);
		this.metaItem(meta, Codicon.cloudDownload, localize('voltMarketplace.installs', "{0} installs", formatInstalls(skill.installs)));
		if (!loaded) {
			this.skeletonContents(page, localize('voltMarketplace.loadingFiles', "Finding the skill on GitHub…"));
			return;
		}
		if (!found) {
			this.detailMessage(page, localize('voltMarketplace.skillFilesMissing', "Couldn't find this skill's files on GitHub. Open it on skills.sh to see its source."));
			this.contentSection(page, `skill:${skill.id}:page`, 'skills.sh', [{ kind: 'skill', name: skill.name, link: { kind: 'url', url: this.marketplace.skillPage(skill).toString(true) } }]);
			return;
		}
		const prefix = found.folder ? `${found.folder}/` : '';
		const manifest = found.files.find(file => file.slice(prefix.length).toLowerCase() === 'skill.md') ?? `${prefix}SKILL.md`;
		this.contentSection(page, `skill:${skill.id}:skill`, kindInfo('skill').plural, [{ kind: 'skill', name: skill.name, link: githubLink(found.repo, found.ref, manifest) }]);
		const others = found.files.filter(file => file !== manifest).map((file): IContentRow => ({ kind: 'file', name: file.slice(prefix.length), link: githubLink(found.repo, found.ref, file) }));
		if (others.length) {
			this.contentSection(page, `skill:${skill.id}:files`, localize('voltMarketplace.files', "Files"), others, DETAIL_FILE_PAGE);
		}
	}

	private metaItem(parent: HTMLElement, icon: ThemeIcon, label: string, open?: () => void): void {
		const item = append(parent, open ? $('button.volt-marketplace-detail-meta-item.link') : $('span.volt-marketplace-detail-meta-item'));
		item.appendChild(renderIcon(icon));
		append(item, $('span')).textContent = label;
		if (open) {
			(item as HTMLButtonElement).type = 'button';
			this.renderStore.add(addDisposableListener(item, 'click', open));
		}
	}

	private detailMessage(parent: HTMLElement, text: string, error = false): void {
		const message = append(parent, $('.volt-customize-message.volt-marketplace-detail-message'));
		message.classList.toggle('error', error);
		message.textContent = text;
	}

	/** A titled card of rows, each opening its file on GitHub in the browser beside the page. */
	private contentSection(parent: HTMLElement, id: string, title: string, rows: readonly IContentRow[], page?: number): void {
		const section = append(parent, $('section.volt-customize-section'));
		const heading = append(append(section, $('.volt-customize-section-header')), $('h3.volt-customize-section-title'));
		append(heading, $('span')).textContent = title;
		append(heading, $('span.count')).textContent = String(rows.length);
		const card = append(section, $('.volt-customize-card.volt-marketplace-contents'));
		const shown = page ? rows.slice(0, this.shown.get(id) ?? page) : rows;
		for (const content of shown) {
			const row = append(card, $('.volt-customize-row.single.clickable'));
			row.tabIndex = 0;
			row.setAttribute('role', 'link');
			const tile = append(row, $('.volt-customize-tile'));
			tile.appendChild(createCustomizationKindIcon(content.kind));
			append(append(row, $('.volt-customize-row-copy')), $('span.name')).textContent = content.name;
			append(row, $('.volt-marketplace-open-arrow')).appendChild(renderIcon(Codicon.arrowRight));
			setAgentTooltip(row, content.link.kind === 'url' ? content.link.url : content.link.resource.fsPath);
			this.renderStore.add(addDisposableListener(row, 'click', () => this.openLink(content.link)));
			this.renderStore.add(addDisposableListener(row, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.openLink(content.link);
				}
			}));
		}
		if (page) {
			this.showMore(section, id, rows.length, page);
		}
	}

	//#endregion

	private icon(parent: HTMLElement, skill: ISkillsShSkill): void {
		const tile = append(parent, $('.volt-marketplace-icon'));
		const url = avatarUrl(skill.source);
		if (url) {
			const image = append(tile, $('img')) as HTMLImageElement;
			image.alt = '';
			image.loading = 'lazy';
			image.referrerPolicy = 'no-referrer';
			image.src = url;
			this.renderStore.add(addDisposableListener(image, 'error', () => {
				image.remove();
				tile.appendChild(createCustomizationKindIcon('skill'));
			}));
		} else {
			tile.appendChild(createCustomizationKindIcon('skill'));
		}
	}

	private installedSkillNames(): Set<string> {
		return new Set(this.customize.items.filter(item => item.kind === 'skill' && !item.plugin).map(item => item.name.toLowerCase()));
	}

	/** The whole row opens the page, as Enter does once it has focus; Add stops its own clicks. */
	private opensPage(row: HTMLElement, open: () => void): void {
		row.classList.add('clickable');
		row.tabIndex = 0;
		this.renderStore.add(addDisposableListener(row, 'click', open));
		this.renderStore.add(addDisposableListener(row, 'keydown', e => {
			if (e.key === 'Enter' && e.target === row) {
				e.preventDefault();
				open();
			}
		}));
	}

	private skillGrid(parent: HTMLElement, skills: readonly ISkillsShSkill[]): void {
		const grid = append(parent, $('.volt-marketplace-grid'));
		const installed = this.installedSkillNames();
		for (const skill of skills) {
			const row = append(grid, $('.volt-marketplace-row'));
			row.dataset.skillId = skill.id;
			this.icon(row, skill);
			const copy = append(row, $('.volt-marketplace-row-copy'));
			append(copy, $('.name')).textContent = skill.name;
			const description = append(copy, $('.description'));
			description.textContent = this.descriptions.get(skill.id) ?? `${skill.source} · ${localize('voltMarketplace.installs', "{0} installs", formatInstalls(skill.installs))}`;
			const added = installed.has(skill.name.toLowerCase()) || installed.has(skill.skillId.toLowerCase());
			const button = this.addButton(row, added, this.busy.has(skill.id));
			this.opensPage(row, () => this.openSkill(skill));
			this.renderStore.add(addDisposableListener(button, 'click', e => {
				e.stopPropagation();
				if (!added && !this.busy.has(skill.id)) {
					this.pickSkillScope(button, skill);
				}
			}));
		}
	}

	private pluginGrid(parent: HTMLElement, plugins: readonly IMarketplacePlugin[]): void {
		const grid = append(parent, $('.volt-marketplace-grid'));
		for (const plugin of plugins) {
			const id = `${plugin.marketplace}/${plugin.name}`;
			const row = append(grid, $('.volt-marketplace-row'));
			append(row, $('.volt-marketplace-icon.box')).appendChild(createCustomizationKindIcon('plugin'));
			const copy = append(row, $('.volt-marketplace-row-copy'));
			append(copy, $('.name')).textContent = plugin.name;
			append(copy, $('.description')).textContent = plugin.description || plugin.author;
			const button = this.addButton(row, plugin.installed, this.busy.has(id));
			if (plugin.source.kind === 'unsupported' && !plugin.installed) {
				button.disabled = true;
				setAgentTooltip(button, localize('voltMarketplace.unsupportedTip', "Volt can't install plugins from {0} sources yet.", plugin.source.label));
			}
			this.opensPage(row, () => this.openPlugin(plugin));
			this.renderStore.add(addDisposableListener(button, 'click', e => {
				e.stopPropagation();
				if (this.busy.has(id)) {
					return;
				}
				if (plugin.installed) {
					if (plugin.installedInVolt) {
						this.showInstalledPluginMenu(button, plugin);
					}
					return;
				}
				void this.installPlugin(plugin, id);
			}));
		}
	}

	private addButton(parent: HTMLElement, added: boolean, busy: boolean, primary = false): HTMLButtonElement {
		const button = append(parent, $(primary ? 'button.volt-marketplace-detail-add' : 'button.volt-customize-add-button')) as HTMLButtonElement;
		button.type = 'button';
		button.classList.toggle('added', added);
		button.classList.toggle('busy', busy);
		if (busy) {
			button.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			append(button, $('span')).textContent = localize('voltMarketplace.adding', "Adding");
		} else if (added) {
			button.appendChild(renderIcon(Codicon.check));
			append(button, $('span')).textContent = localize('voltMarketplace.added', "Added");
		} else {
			button.textContent = primary ? localize('voltMarketplace.addToVolt', "Add to Volt") : localize('voltMarketplace.add', "Add");
		}
		return button;
	}

	//#endregion

	//#region Actions

	private pickSkillScope(anchor: HTMLElement, skill: ISkillsShSkill): void {
		const scopes = this.host.scopes();
		const user = scopes.filter(scope => scope.scope.kind === 'user');
		const workspaces = scopes.filter(scope => scope.scope.kind === 'workspace');
		const toItem = (scope: IAgentMarketplaceScope): IVoltMenuItem<IAgentMarketplaceScope> => ({
			id: scope.scope.kind === 'user' ? 'user' : scope.scope.folder.toString(),
			label: scope.label,
			subtitle: scope.subtitle,
			icon: scope.scope.kind === 'user' ? Codicon.person : Codicon.folder,
			data: scope,
		});
		const sections: IVoltMenuSection<IAgentMarketplaceScope>[] = [{ id: 'user', items: user.map(toItem) }];
		if (workspaces.length) {
			sections.push({ id: 'workspaces', title: localize('voltCustomize.workspaces', "Workspaces"), items: workspaces.map(toItem) });
		}
		showVoltMenu<IAgentMarketplaceScope>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			width: 280,
			className: 'volt-customize-menu',
			ariaLabel: localize('voltMarketplace.installWhere', "Add the skill for"),
			sections,
			onPick: item => void this.installSkill(skill, item.data),
		});
	}

	private async installSkill(skill: ISkillsShSkill, scope: IAgentMarketplaceScope): Promise<void> {
		this.busy.add(skill.id);
		this.render();
		const cts = new CancellationTokenSource();
		try {
			const resource = await this.marketplace.installSkill(skill, scope.scope, cts.token);
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize('voltMarketplace.skillAdded', "Added {0} to {1}. Use it with /{2} in the composer.", skill.name, scope.label, safeItemName(skill.skillId) || skill.name),
			});
			this.host.openResource(resource);
		} catch (err) {
			this.notificationService.error(localize('voltMarketplace.skillFailed', "Couldn't add {0}: {1}", skill.name, err instanceof Error ? err.message : String(err)));
		} finally {
			cts.dispose();
			this.busy.delete(skill.id);
			await this.customize.refresh().catch(() => undefined);
			this.render();
		}
	}

	private async installPlugin(plugin: IMarketplacePlugin, id: string): Promise<void> {
		this.busy.add(id);
		this.render();
		const cts = new CancellationTokenSource();
		try {
			const root = await this.marketplace.installPlugin(plugin, cts.token);
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize('voltMarketplace.pluginAdded', "Added the {0} plugin. Its skills, rules and commands are available in new chats.", plugin.name),
				actions: {
					primary: [{
						id: 'volt.marketplace.reveal',
						label: localize('voltMarketplace.reveal', "Show Folder"),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => this.commandService.executeCommand('revealFileInOS', root),
					}],
				},
			});
		} catch (err) {
			this.notificationService.error(localize('voltMarketplace.pluginFailed', "Couldn't add {0}: {1}", plugin.name, err instanceof Error ? err.message : String(err)));
		} finally {
			cts.dispose();
			this.busy.delete(id);
			this.marketplaces = undefined;
			await this.loadMarketplaces();
		}
	}

	private showInstalledPluginMenu(anchor: HTMLElement, plugin: IMarketplacePlugin): void {
		showVoltMenu<string>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			className: 'volt-customize-menu',
			ariaLabel: plugin.name,
			sections: [{ id: 'actions', items: [{ id: 'remove', label: localize('voltMarketplace.remove', "Remove from Volt"), icon: Codicon.trash, data: 'remove' }] }],
			onPick: async () => {
				try {
					await this.marketplace.uninstallPlugin(plugin.name);
				} catch (err) {
					this.notificationService.error(err instanceof Error ? err.message : String(err));
				}
			},
		});
	}

	private showMarketplaceMenu(anchor: HTMLElement, marketplace: IMarketplace): void {
		if (marketplace.registry === 'builtin') {
			// Read from GitHub, nothing on disk: its repository is the only place to go.
			showVoltMenu<string>(this.contextViewService, {
				anchor,
				align: 'right',
				gap: 4,
				className: 'volt-customize-menu',
				ariaLabel: marketplace.displayName,
				sections: [{ id: 'actions', items: [{ id: 'github', label: localize('voltMarketplace.openGithub', "Open on GitHub"), icon: Codicon.github, data: 'github' }] }],
				onPick: () => this.host.openUrl(marketplace.root.toString(true)),
			});
			return;
		}
		const items: IVoltMenuItem<string>[] = [
			{ id: 'reveal', label: localize('voltMarketplace.revealFolder', "Reveal in Finder"), icon: Codicon.folderOpened, data: 'reveal' },
			{ id: 'manifest', label: localize('voltMarketplace.openManifest', "Open marketplace.json"), icon: Codicon.json, data: 'manifest' },
		];
		if (marketplace.registry === 'volt') {
			items.push({ id: 'remove', label: localize('voltMarketplace.removeMarketplace', "Remove Marketplace"), icon: Codicon.trash, data: 'remove' });
		}
		showVoltMenu<string>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			className: 'volt-customize-menu',
			ariaLabel: marketplace.displayName,
			sections: [{ id: 'actions', items }],
			onPick: async item => {
				if (item.data === 'reveal') {
					await this.commandService.executeCommand('revealFileInOS', marketplace.root);
				} else if (item.data === 'manifest') {
					this.host.openResource(joinPath(marketplace.root, '.claude-plugin', 'marketplace.json'));
				} else {
					try {
						await this.marketplace.removeMarketplace(marketplace.name);
					} catch (err) {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					}
				}
			},
		});
	}

	private showAddMarketplaceMenu(anchor: HTMLElement): void {
		type Action = 'create' | 'github' | 'disk';
		showVoltMenu<Action>(this.contextViewService, {
			anchor,
			align: 'left',
			gap: 6,
			width: 320,
			className: 'volt-customize-menu volt-customize-menu-large',
			ariaLabel: localize('voltMarketplace.addMarketplace', "Add Marketplace"),
			sections: [{
				id: 'add',
				items: [
					{ id: 'create', label: localize('voltMarketplace.createNew', "Create New"), subtitle: localize('voltMarketplace.createNewHint', "Set up a team marketplace"), icon: Codicon.add, data: 'create' },
					{ id: 'github', label: localize('voltMarketplace.importGithub', "Import from GitHub"), subtitle: localize('voltMarketplace.importGithubHint', "Add a marketplace from a repository"), icon: Codicon.github, data: 'github' },
					{ id: 'disk', label: localize('voltMarketplace.importDisk', "Import from Disk"), subtitle: localize('voltMarketplace.importDiskHint', "Add a marketplace from your local computer"), icon: Codicon.folder, data: 'disk' },
				],
			}],
			onPick: item => void this.addMarketplace(item.data),
		});
	}

	private async addMarketplace(action: 'create' | 'github' | 'disk'): Promise<void> {
		try {
			if (action === 'github') {
				let added: IMarketplace | undefined;
				await showCustomizeInputDialog(this.host.dialogHost(), {
					title: localize('voltMarketplace.importGithubTitle', "Import Marketplace from GitHub"),
					subtitle: localize('voltMarketplace.importGithubSubtitle', "Enter a repository that has a .claude-plugin/marketplace.json"),
					placeholder: localize('voltMarketplace.importGithubPlaceholder', "e.g., owner/repo or https://github.com/owner/repo"),
					confirmLabel: localize('voltMarketplace.import', "Import"),
					validate: value => !value || /^(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+|^[\w.-]+\/[\w.-]+$/i.test(value)
						? undefined
						: localize('voltMarketplace.badRepo', "Enter a GitHub repository as owner/repo or its URL."),
					onConfirm: async value => {
						const cts = new CancellationTokenSource();
						try {
							added = await this.marketplace.addMarketplaceFromGitHub(value, cts.token);
						} finally {
							cts.dispose();
						}
					},
				});
				if (added) {
					this.selectAdded(added);
				}
				return;
			}
			const picked = await this.fileDialogService.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				title: action === 'disk' ? localize('voltMarketplace.pickMarketplace', "Pick a Marketplace Folder") : localize('voltMarketplace.pickNewFolder', "Pick a Folder for the Marketplace"),
				openLabel: action === 'disk' ? localize('voltMarketplace.import', "Import") : localize('voltMarketplace.choose', "Choose"),
			});
			const folder = picked?.[0];
			if (!folder) {
				return;
			}
			if (action === 'disk') {
				this.selectAdded(await this.marketplace.addMarketplaceFromDisk(folder));
				return;
			}
			let manifest: URI | undefined;
			await showCustomizeInputDialog(this.host.dialogHost(), {
				title: localize('voltMarketplace.createTitle', "New Team Marketplace"),
				subtitle: localize('voltMarketplace.createSubtitle', "Enter a name for the new marketplace"),
				placeholder: localize('voltMarketplace.createPlaceholder', "e.g., my-team-plugins"),
				value: safeItemName(folder.path.split('/').pop() ?? ''),
				validate: value => !value || safeItemName(value) === value ? undefined : localize('voltCustomize.nameRule', "Use lowercase letters, numbers, and hyphens (must start with a letter or number)"),
				onConfirm: async value => {
					manifest = await this.marketplace.createMarketplace(folder, value);
				},
			});
			if (manifest) {
				this.host.openResource(manifest);
				this.filter = { kind: 'personal' };
				this.marketplaces = undefined;
				await this.loadMarketplaces();
			}
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private selectAdded(marketplace: IMarketplace): void {
		this.notificationService.info(localize('voltMarketplace.marketplaceAdded', "Added the {0} marketplace with {1} plugins.", marketplace.displayName, marketplace.plugins.length));
		this.filter = marketplace.registry === 'volt' ? { kind: 'personal' } : { kind: 'marketplace', name: marketplace.name };
		this.marketplaces = undefined;
		void this.loadMarketplaces();
	}

	//#endregion
}

function sameFilter(a: MarketplaceFilter, b: MarketplaceFilter): boolean {
	return a.kind === b.kind && (a.kind !== 'marketplace' || a.name === (b as { name: string }).name);
}

/**
 * The plugins that match `query`, best first: the name itself, a name that starts with it, a name
 * that holds it, then the category, then the description or author. A marketplace of 300 plugins
 * mentions "review" in dozens of descriptions; code-review and pr-review-toolkit come first.
 */
export function rankPlugins(plugins: readonly IMarketplacePlugin[], query: string): IMarketplacePlugin[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return [];
	}
	const score = (plugin: IMarketplacePlugin): number => {
		const name = plugin.name.toLowerCase();
		if (name === q) {
			return 0;
		}
		if (name.startsWith(q)) {
			return 1;
		}
		if (name.split(/[-_\s]+/).some(word => word.startsWith(q))) {
			return 2;
		}
		if (name.includes(q)) {
			return 3;
		}
		if ((plugin.category ?? '').toLowerCase().includes(q)) {
			return 4;
		}
		return `${plugin.description} ${plugin.author}`.toLowerCase().includes(q) ? 5 : -1;
	};
	return plugins
		.map((plugin, index) => ({ plugin, index, score: score(plugin) }))
		.filter(entry => entry.score >= 0)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map(entry => entry.plugin);
}
