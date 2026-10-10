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
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { safeItemName } from './agentCustomize.js';
import { IAgentCustomizeService } from './agentCustomizeService.js';
import { showCustomizeInputDialog } from './agentCustomizeDialogs.js';
import { formatInstalls, IAgentMarketplaceService, IMarketplace, IMarketplacePlugin, ISkillsShSkill, MarketplaceScope } from './agentMarketplace.js';

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
	/** The element dialogs dim. */
	dialogHost(): HTMLElement;
	/** The body changed height. */
	relayout(): void;
}

type MarketplaceFilter = { readonly kind: 'all' } | { readonly kind: 'skills' } | { readonly kind: 'personal' } | { readonly kind: 'marketplace'; readonly name: string };

const DISCOVER_COUNT = 8;
const POPULAR_PAGE = 10;
const PLUGIN_PAGE = 4;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 40;

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

	constructor(
		header: HTMLElement,
		body: HTMLElement,
		private readonly host: IAgentMarketplaceViewHost,
		@IAgentMarketplaceService private readonly marketplace: IAgentMarketplaceService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
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
			}
		});
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.chipsEl.classList.toggle('hidden', !visible);
		this.bodyEl.classList.toggle('hidden', !visible);
		if (!visible) {
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
		this.renderChips();
		this.renderStore.clear();
		clearNode(this.bodyEl);
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
				this.message(localize('voltMarketplace.loadingPlugins', "Loading plugin marketplaces…"));
			}
		} else if (filter.kind === 'skills') {
			this.renderPopular(POPULAR_PAGE * 3);
		} else if (filter.kind === 'personal') {
			const personal = (this.marketplaces ?? []).filter(marketplace => marketplace.registry === 'volt');
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
			const marketplace = (this.marketplaces ?? []).find(candidate => candidate.name === filter.name);
			if (marketplace) {
				this.renderMarketplace(marketplace, PLUGIN_PAGE * 4);
			}
		}
		this.host.relayout();
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
		for (const marketplace of (this.marketplaces ?? []).filter(candidate => candidate.registry === 'claude')) {
			add(marketplace.displayName, { kind: 'marketplace', name: marketplace.name });
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
			this.renderStore.add(addDisposableListener(card, 'click', () => void this.openerService.open(this.marketplace.skillPage(skill), { openExternal: true })));
			this.renderStore.add(addDisposableListener(card, 'keydown', e => {
				if (e.key === 'Enter') {
					void this.openerService.open(this.marketplace.skillPage(skill), { openExternal: true });
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
		if (!this.popular) {
			if (this.popularError) {
				this.message(this.popularError, true);
			} else {
				this.message(localize('voltMarketplace.loadingSkills', "Loading skills from skills.sh…"));
			}
			return;
		}
		const skills = this.popular;
		const section = this.section(localize('voltMarketplace.popular', "Popular on skills.sh"), undefined, actions => {
			const link = append(actions, $('button.volt-customize-text-button')) as HTMLButtonElement;
			link.type = 'button';
			link.textContent = localize('voltMarketplace.openSite', "skills.sh");
			link.appendChild(renderIcon(Codicon.linkExternal));
			this.renderStore.add(addDisposableListener(link, 'click', () => void this.openerService.open(URI.parse('https://skills.sh'), { openExternal: true })));
		});
		const id = `popular:${page}`;
		this.skillGrid(section, skills.slice(0, this.shown.get(id) ?? page));
		this.showMore(section, id, skills.length, page);
	}

	private renderSearch(): void {
		const query = this.query;
		const plugins = (this.marketplaces ?? []).flatMap(marketplace => marketplace.plugins.filter(plugin =>
			`${plugin.name} ${plugin.description} ${plugin.author} ${plugin.category ?? ''}`.toLowerCase().includes(query.toLowerCase())));
		if (query.length < 2) {
			this.message(localize('voltMarketplace.typeMore', "Type at least two characters to search skills.sh."));
		} else if (!this.searchResults) {
			this.message(localize('voltMarketplace.searching', "Searching skills.sh…"));
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
				tile.appendChild(renderIcon(Codicon.zap));
			}));
		} else {
			tile.appendChild(renderIcon(Codicon.zap));
		}
	}

	private installedSkillNames(): Set<string> {
		return new Set(this.customize.items.filter(item => item.kind === 'skill' && !item.plugin).map(item => item.name.toLowerCase()));
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
			setAgentTooltip(copy, `${skill.source}/${skill.skillId}`);
			const added = installed.has(skill.name.toLowerCase()) || installed.has(skill.skillId.toLowerCase());
			const button = this.addButton(row, added, this.busy.has(skill.id));
			this.renderStore.add(addDisposableListener(copy, 'click', () => void this.openerService.open(this.marketplace.skillPage(skill), { openExternal: true })));
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
			append(row, $('.volt-marketplace-icon.box')).appendChild(renderIcon(Codicon.package));
			const copy = append(row, $('.volt-marketplace-row-copy'));
			append(copy, $('.name')).textContent = plugin.name;
			append(copy, $('.description')).textContent = plugin.description || plugin.author;
			if (plugin.description) {
				setAgentTooltip(copy, plugin.description);
			}
			const button = this.addButton(row, plugin.installed, this.busy.has(id));
			if (plugin.source.kind === 'unsupported' && !plugin.installed) {
				button.disabled = true;
				setAgentTooltip(button, localize('voltMarketplace.unsupportedTip', "Volt can't install plugins from {0} sources yet.", plugin.source.label));
			}
			if (plugin.homepage) {
				const homepage = plugin.homepage;
				this.renderStore.add(addDisposableListener(copy, 'click', () => void this.openerService.open(URI.parse(homepage), { openExternal: true })));
				copy.classList.add('link');
			}
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

	private addButton(parent: HTMLElement, added: boolean, busy: boolean): HTMLButtonElement {
		const button = append(parent, $('button.volt-customize-add-button')) as HTMLButtonElement;
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
			button.textContent = localize('voltMarketplace.add', "Add");
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
